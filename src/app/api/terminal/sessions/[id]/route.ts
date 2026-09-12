/**
 * /api/terminal/sessions/[id]
 *
 *   GET    → the session snapshot (steps + buffered output).
 *   DELETE → stop it: signals the whole process group, so the dev server that
 *            `npm run dev` forked dies with it.
 *
 * The live stream is a separate route (`/stream`) because it never ends.
 */

import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { getSession, listSessions, pruneFinished } from '@/lib/terminal/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const session = getSession(id.trim());
    if (!session) {
      // Not an error the UI should shout about: a dev-server reload drops the
      // in-memory registry, and the dock recovers by listing what still exists.
      return jsonOk({ session: null, sessions: listSessions() });
    }
    return jsonOk({ session: session.snapshot(), sessions: listSessions() });
  } catch (error) {
    const mapped = fromUnknown(error, 'GET /api/terminal/sessions/[id]');
    return jsonError(mapped.status, mapped.error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const session = getSession(id.trim());
    if (!session) {
      return jsonError(404, { code: 'not_found', message: `No terminal session ${id}.` });
    }
    session.stop();
    pruneFinished();
    return jsonOk({ session: session.snapshot() });
  } catch (error) {
    const mapped = fromUnknown(error, 'DELETE /api/terminal/sessions/[id]');
    return jsonError(mapped.status, mapped.error);
  }
}
