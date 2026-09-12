/**
 * POST /api/projects/:id/assembly
 *
 * Re-plan the 3D shape of the build from its current diagram — the model
 * authors a fresh shape (`mode: "model"`), the deterministic planner does
 * (`mode: "heuristic"`), or the server picks (`mode: "auto"`, the default).
 * The plan is persisted on the project and the simulation bundle serves it
 * on the next read, so the 3D scene re-assembles without rebuilding.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { appendEvents, getProjectState, recordLlmCall, saveProjectState } from '@/lib/mongodb/projects';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { planAssembly, rosterFromDiagram, type AssemblyPlanMode } from '@/modules/assembly-planner';
import { buildAssemblyView } from '@/modules/simulation';
import type { AgentEvent } from '@/types/generation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BodySchema = z.object({
  mode: z.enum(['auto', 'model', 'heuristic']).default('auto'),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson(request).catch(() => ({}));
    const parsed = parseBody(BodySchema, body);
    const mode = parsed.mode as AssemblyPlanMode;

    const state = await getProjectState(id);
    if (!state) return jsonError(404, { code: 'not_found', message: 'Project not found.' });
    if (state.status === 'running' || state.status === 'validating' || state.status === 'fixing') {
      return jsonError(409, {
        code: 'build_running',
        message: 'This build is still running — the assembly is planned as part of it.',
      });
    }
    const diagram = state.artifacts.diagram;
    if (!diagram) {
      return jsonError(409, { code: 'no_diagram', message: 'This project has no diagram yet, so there is nothing to seat.' });
    }
    const roster = rosterFromDiagram(diagram);
    if (roster.length === 0) {
      return jsonError(409, { code: 'nothing_seatable', message: 'This project has no seatable parts.' });
    }

    const callStarted = nowIso();
    const startedAt = Date.now();
    const result = await planAssembly({
      prompt: state.prompt,
      goal: state.requirements?.goal ?? state.name,
      roster,
      mode,
    });

    const next = await saveProjectState(state.id, { assembly: result.plan });
    if (!next) return jsonError(404, { code: 'not_found', message: 'Project not found.' });

    if (result.call) {
      await recordLlmCall(state.id, {
        id: createId('llm'),
        op: 'assembly',
        model: result.call.model,
        startedAt: callStarted,
        finishedAt: nowIso(),
        durationMs: Date.now() - startedAt,
        status: result.call.ok ? 'ok' : 'failed',
        ...(result.call.inputTokens !== undefined ? { inputTokens: result.call.inputTokens } : {}),
        ...(result.call.outputTokens !== undefined ? { outputTokens: result.call.outputTokens } : {}),
        ...(result.call.error ? { error: result.call.error } : {}),
      });
    }

    const baseSeq = next.events.reduce((max, candidate) => Math.max(max, candidate.seq), 0);
    const seated = Object.keys(result.plan.placements).length + result.plan.parametric.length;
    const event: AgentEvent = {
      seq: baseSeq + 1,
      id: createId('evt'),
      type: 'assembly_replanned',
      status: 'completed',
      message: `3D shape re-planned as ${result.plan.label} — ${seated} of ${roster.length} part(s) seated (${result.plan.source}).`,
      timestamp: nowIso(),
      stage: 'assembly',
      durationMs: Date.now() - startedAt,
      metadata: { archetype: result.plan.archetype, source: result.plan.source, seated, total: roster.length, mode },
    };
    await appendEvents(state.id, [event]);

    const refreshed = (await getProjectState(state.id)) ?? next;
    return jsonOk({ assembly: buildAssemblyView({ ...refreshed, assembly: result.plan }).view });
  } catch (error) {
    const mapped = fromUnknown(error, 'POST /api/projects/:id/assembly');
    return jsonError(mapped.status, mapped.error);
  }
}
