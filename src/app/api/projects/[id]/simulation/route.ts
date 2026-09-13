/**
 * GET /api/projects/[id]/simulation
 *
 * Velxio project + hosted dashboard descriptor for the /simulation page.
 * Auth + ownership required.
 */

import type { NextRequest } from 'next/server';

import { AuthError, requireAuth } from '@/lib/auth/session';
import { assertCanRead } from '@/lib/auth/project-access';
import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { getProjectState } from '@/lib/mongodb/projects';
import { buildSimulationBundle } from '@/modules/simulation';
import { simulationConfig } from '@/lib/simulation/config';
import { incrementUsage } from '@/lib/auth/users';
import { env } from '@/lib/validation/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id || id.trim().length === 0) {
    return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  }

  try {
    const auth = await requireAuth(request);
    if (!auth) return jsonError(401, { code: 'unauthenticated', message: 'Sign in required.' });

    const project = await getProjectState(id.trim());
    if (!project) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }
    assertCanRead(project, auth);

    // Meter hosted sim sessions (best-effort).
    if (env().auth.required && auth.user.id !== 'local-dev') {
      void incrementUsage(auth.user.id, 'simSessionsToday', 1);
    }

    const bundle = buildSimulationBundle(project);
    const config = simulationConfig(project.id);

    return jsonOk({
      projectId: bundle.projectId,
      projectName: bundle.projectName,
      slug: bundle.slug,
      revision: bundle.revision,
      status: project.status,
      stage: project.stage,
      config: {
        velxioUrl: config.velxioUrl,
        websiteUrl: config.websiteUrl,
        defaultView: config.defaultView,
        velxioHosted: config.velxioHosted,
        dashboardHosted: config.dashboardHosted,
      },
      velxio: bundle.velxio
        ? {
            vlx: bundle.velxio.json,
            name: bundle.velxio.project.name,
            boardKind: bundle.velxio.project.boards[0]?.boardKind ?? null,
            fileGroup: bundle.velxio.project.boards[0]?.activeFileGroupId ?? null,
            parts: bundle.velxio.project.components.length,
            wires: bundle.velxio.project.wires.length,
            files:
              bundle.velxio.project.fileGroups[bundle.velxio.project.boards[0]?.activeFileGroupId ?? '']?.map(
                (file) => file.name,
              ) ?? [],
            unsupported: bundle.velxio.unsupported,
            warnings: bundle.velxio.warnings,
            cadBench: bundle.velxio.cadBench,
          }
        : null,
      software: bundle.software
        ? {
            slug: bundle.software.slug,
            devPort: bundle.software.devPort,
            contract: bundle.software.contract,
            files: bundle.software.files.map((file) => ({ path: file.path, bytes: file.content.length })),
            findings: bundle.software.findings,
            passed: bundle.software.passed,
            zipUrl: `/api/projects/${project.id}/simulation/software.zip`,
            hostedPreviewUrl: config.dashboardHosted ? config.websiteUrl : null,
          }
        : null,
      blocked: bundle.blocked,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(error.status, { code: error.code, message: error.message });
    }
    const mapped = fromUnknown(error, `GET /api/projects/${id}/simulation`);
    return jsonError(mapped.status, mapped.error);
  }
}
