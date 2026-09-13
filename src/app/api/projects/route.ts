/**
 * POST /api/projects — create a brand new project (auth + metering required).
 * GET  /api/projects — list the caller's projects only.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { checkProjectCreate } from '@/lib/auth/plans';
import { clientIp, rateLimit, rateLimitHeaders } from '@/lib/auth/rate-limit';
import { AuthError, requireAuth } from '@/lib/auth/session';
import { incrementUsage } from '@/lib/auth/users';
import { BadRequestError, fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { describeError, logger } from '@/lib/logging/logger';
import { env } from '@/lib/validation/env';
import { createProjectRecord, listProjectStates } from '@/lib/mongodb/projects';
import { startIntake } from '@/modules/everflow';
import { startGeneration } from '@/modules/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CreateProjectSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(8, 'Describe the project you want built (at least 8 characters).')
    .max(4000, 'Prompts are limited to 4000 characters.'),
  name: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(['everflow', 'direct']).default('everflow'),
  visibility: z.enum(['private', 'unlisted', 'public']).default('private'),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (!auth) {
      return jsonError(401, { code: 'unauthenticated', message: 'Sign in to create a project.' });
    }

    const limited = rateLimit(
      `project:create:${auth.user.id}`,
      env().auth.rateLimitProjectPerMin,
      60_000,
    );
    if (!limited.allowed) {
      return jsonError(
        429,
        { code: 'rate_limited', message: 'Project creation rate limit hit. Slow down or upgrade.' },
        { headers: rateLimitHeaders(limited) },
      );
    }

    const meter = checkProjectCreate(auth.plan, auth.usage);
    if (!meter.allowed) {
      return jsonError(402, {
        code: meter.code ?? 'quota',
        message: meter.message ?? 'Plan limit reached.',
        details: `plan=${meter.plan.id}; projectsThisMonth=${meter.usage.projectsThisMonth}/${meter.plan.projectsPerMonth}`,
      });
    }

    const body = await readJson(request);
    const parsed = parseBody(CreateProjectSchema, body);

    const project = await createProjectRecord({
      prompt: parsed.prompt,
      ...(parsed.name ? { name: parsed.name } : {}),
      maxIterations: env().agent.maxFixIterations,
      ownerId: auth.user.id,
      orgId: auth.user.orgId,
      visibility: parsed.visibility,
      eventMetadata: { ownerId: auth.user.id, plan: auth.plan.id },
    });

    await incrementUsage(auth.user.id, 'projectsThisMonth', 1);

    if (parsed.mode === 'everflow') {
      startIntake(project.id);
      logger.info({ projectId: project.id, ownerId: auth.user.id }, 'project created, intake started');
      return jsonOk(
        { project, started: false, intake: true, usage: { ...auth.usage, projectsThisMonth: auth.usage.projectsThisMonth + 1 } },
        { status: 201, headers: rateLimitHeaders(limited) },
      );
    }

    startGeneration(project.id);
    logger.info({ projectId: project.id, ownerId: auth.user.id }, 'project created, generation started');

    return jsonOk(
      { project, started: true, usage: { ...auth.usage, projectsThisMonth: auth.usage.projectsThisMonth + 1 } },
      { status: 201, headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(error.status, { code: error.code, message: error.message });
    }
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    }
    const mapped = fromUnknown(error, 'POST /api/projects');
    return jsonError(mapped.status, mapped.error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (!auth) {
      return jsonError(401, { code: 'unauthenticated', message: 'Sign in to list your projects.' });
    }

    const rawLimit = request.nextUrl.searchParams.get('limit') ?? '25';
    const parsedLimit = Number.parseInt(rawLimit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 25;

    const projects = await listProjectStates(limit, auth.user.id);
    return jsonOk({
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        prompt: project.prompt,
        status: project.status,
        stage: project.stage,
        revision: project.revision,
        visibility: project.visibility,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        completedAt: project.completedAt,
        components: project.components.length,
        connections: project.wiring?.connections.length ?? 0,
        validation: project.validation
          ? {
              passed: project.validation.passed,
              errors: project.validation.summary.errors,
              warnings: project.validation.summary.warnings,
            }
          : null,
      })),
      count: projects.length,
      plan: auth.plan.id,
      usage: auth.usage,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(error.status, { code: error.code, message: error.message });
    }
    const described = describeError(error);
    const mapped = fromUnknown(error, 'GET /api/projects');
    logger.warn({ error: described.message }, 'project list failed');
    return jsonError(mapped.status, mapped.error);
  }
}
