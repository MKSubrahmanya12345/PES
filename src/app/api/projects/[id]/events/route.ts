/**
 * GET /api/projects/[id]/events?after=<seq>
 * Auth + ownership required.
 */

import type { NextRequest } from 'next/server';

import { AuthError, requireAuth } from '@/lib/auth/session';
import { assertCanRead } from '@/lib/auth/project-access';
import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { getProjectEvents, getProjectState } from '@/lib/mongodb/projects';
import { isRunning } from '@/modules/orchestrator';
import { recoverStalledProject } from '@/modules/orchestrator/recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_warnings', 'completed_with_errors', 'failed']);

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

    const rawAfter = request.nextUrl.searchParams.get('after') ?? '0';
    const parsedAfter = Number.parseInt(rawAfter, 10);
    const after = Number.isFinite(parsedAfter) && parsedAfter > 0 ? parsedAfter : 0;

    let result = await getProjectEvents(id.trim(), after);
    if (!result) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }

    const recovered = await recoverStalledProject({
      id: id.trim(),
      status: result.status,
      stage: result.stage,
      events: result.events,
      updatedAt: result.updatedAt,
      latestSeq: result.latestSeq,
    });
    if (recovered) {
      const refreshed = await getProjectEvents(id.trim(), after);
      if (refreshed) result = refreshed;
    }

    return jsonOk({
      events: result.events,
      latestSeq: result.latestSeq,
      status: result.status,
      stage: result.stage,
      revision: result.revision,
      running: isRunning(id.trim()),
      terminal: TERMINAL_STATUSES.has(result.status),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(error.status, { code: error.code, message: error.message });
    }
    const mapped = fromUnknown(error, `GET /api/projects/${id}/events`);
    return jsonError(mapped.status, mapped.error);
  }
}
