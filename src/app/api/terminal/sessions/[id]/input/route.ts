/**
 * POST /api/terminal/sessions/[id]/input  { text }
 *
 * Writes to the running process's stdin. The dock's sequence needs no input —
 * `npm install` and `npm run dev` are non-interactive here — but a project that
 * prompts anyway ("Ok to proceed? (y)") would otherwise hang with nobody able
 * to answer it, so the one channel that can unblock it is exposed.
 */

import { z } from 'zod';

import { fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { getSession } from '@/lib/terminal/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const InputSchema = z.object({ text: z.string().max(2000) });

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const session = getSession(id.trim());
    if (!session) {
      return jsonError(404, { code: 'not_found', message: `No terminal session ${id}.` });
    }

    const { text } = parseBody(InputSchema, await readJson(request));
    const written = session.write(text);
    if (!written) {
      return jsonError(409, {
        code: 'no_stdin',
        message: 'Nothing is waiting for input right now.',
        details: 'Stdin is only writable while a command in the sequence is running.',
      });
    }

    return jsonOk({ session: session.snapshot() });
  } catch (error) {
    const mapped = fromUnknown(error, 'POST /api/terminal/sessions/[id]/input');
    return jsonError(mapped.status, mapped.error);
  }
}
