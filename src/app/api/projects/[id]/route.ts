/**
 * GET /api/projects/[id] — full project state (owner-scoped).
 * DELETE /api/projects/[id] — owner delete.
 */

import type { NextRequest } from 'next/server';

import { AuthError, requireAuth } from '@/lib/auth/session';
import { assertCanRead, assertCanWrite } from '@/lib/auth/project-access';
import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { deleteProject, getProjectState } from '@/lib/mongodb/projects';
import { isRunning } from '@/modules/orchestrator';
import { recoverStalledProject } from '@/modules/orchestrator/recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id || id.trim().length === 0) {
    return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  }

  try {
    const auth = await requireAuth(_request);
    if (!auth) return jsonError(401, { code: 'unauthenticated', message: 'Sign in required.' });

    let project = await getProjectState(id.trim());
    if (!project) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }

    assertCanRead(project, auth);

    const recovered = await recoverStalledProject(project);
    if (recovered) project = recovered;

    return jsonOk({ project, running: isRunning(project.id) });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(error.status, { code: error.code, message: error.message });
    }
    const mapped = fromUnknown(error, `GET /api/projects/${id}`);
    return jsonError(mapped.status, mapped.error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id?.trim()) {
    return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  }
  try {
    const auth = await requireAuth(request);
    if (!auth) return jsonError(401, { code: 'unauthenticated', message: 'Sign in required.' });
    const project = await getProjectState(id.trim());
    if (!project) return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    assertCanWrite(project, auth);
    if (isRunning(project.id)) {
      return jsonError(409, { code: 'running', message: 'Cannot delete a project while a build is running.' });
    }
    const ok = await deleteProject(project.id);
    return jsonOk({ deleted: ok });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(error.status, { code: error.code, message: error.message });
    }
    const mapped = fromUnknown(error, `DELETE /api/projects/${id}`);
    return jsonError(mapped.status, mapped.error);
  }
}
