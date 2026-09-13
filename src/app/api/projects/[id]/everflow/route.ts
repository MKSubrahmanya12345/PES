/**
 * GET /api/projects/:id/everflow
 *
 * The live project graph: materialised from the current state (never stale),
 * evaluated for goal satisfaction + dangling nodes, with the doubt session
 * and both human-channel columns attached.
 */

import type { NextRequest } from 'next/server';

import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { describeError, logger } from '@/lib/logging/logger';
import { getProjectState } from '@/lib/mongodb/projects';
import { evaluateEverflow, materializeGraph, midTurnSteerEnabled, steerTier } from '@/modules/everflow';
import { AuthError, requireAuth } from '@/lib/auth/session';
import { assertCanRead, assertCanWrite } from '@/lib/auth/project-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(request);
    if (!auth) return jsonError(401, { code: 'unauthenticated', message: 'Sign in required.' });

    const { id } = await params;
    const state = await getProjectState(id);
    if (!state) return jsonError(404, { code: 'not_found', message: 'Project not found.' });
    assertCanRead(state, auth);
    if (!state) return jsonError(404, { code: 'not_found', message: 'Project not found.' });

    // Always materialise live: the graph is a projection, never a copy.
    const graph = materializeGraph(state);
    const evaluation = evaluateEverflow(state, graph, state.everflow?.pass ?? 0);

    return jsonOk({
      projectId: id,
      status: state.status,
      stage: state.stage,
      revision: state.revision,
      graph,
      evaluation,
      doubts: state.doubts,
      humanTasks: state.humanTasks,
      research: state.research,
      expandedBrief: state.expandedBrief,
      brief: evaluation.brief,
      actions: state.everflow?.actions ?? null,
      capabilities: { midTurnSteer: midTurnSteerEnabled(), steerTier: steerTier() },
    });
  } catch (error) {
    const described = describeError(error);
    logger.warn({ error: described.message }, 'everflow read failed');
    const mapped = fromUnknown(error, 'GET /api/projects/[id]/everflow');
    return jsonError(mapped.status, mapped.error);
  }
}
