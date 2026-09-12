/**
 * GET /api/terminal/sessions/[id]/stream?tail=2000
 *
 * Server-sent events for one session:
 *
 *   event: snapshot   the steps and the last `tail` lines, sent first
 *   event: line       one new line of output
 *   event: state      the steps or the session state changed
 *   event: closed     the session finished (or the server ended it)
 *
 * SSE rather than a WebSocket because the traffic is one-directional and the
 * producer outlives the request: the browser's EventSource reconnects on its
 * own, asks for the snapshot again, and picks up where it left off. Stdin goes
 * over POST /input.
 */

import { jsonError } from '@/lib/http';
import { getSession } from '@/lib/terminal/sessions';
import type { TerminalStreamEvent } from '@/lib/terminal/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const HEARTBEAT_MS = 15_000;

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const session = getSession(id.trim());
  if (!session) {
    return jsonError(404, {
      code: 'not_found',
      message: `No terminal session ${id}.`,
      details: 'The server may have restarted; start the run again from the dock.',
    });
  }

  const tail = Number.parseInt(new URL(request.url).searchParams.get('tail') ?? '2000', 10);
  const keep = Number.isFinite(tail) && tail > 0 ? Math.min(tail, 20_000) : 2000;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: TerminalStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const full = session.snapshot();
      send({ type: 'snapshot', snapshot: { ...full, lines: full.lines.slice(-keep) } });

      if (session.isFinished()) {
        send({ type: 'closed', reason: full.state });
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
        return;
      }

      unsubscribe = session.subscribe((event) => {
        send(event);
        if (event.type === 'closed') {
          closed = true;
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      });

      // Proxies and browsers drop idle connections; a comment frame keeps this
      // one alive without adding noise to the log.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keep-alive ${new Date().toISOString()}\n\n`));
        } catch {
          closed = true;
          cleanup();
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      function cleanup() {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      }

      request.signal.addEventListener('abort', () => {
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer by default, which turns a live log into a
      // log that arrives all at once when the process exits.
      'X-Accel-Buffering': 'no',
    },
  });
}
