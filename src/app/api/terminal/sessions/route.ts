/**
 * /api/terminal/sessions
 *
 *   POST { cwd, projectId?, commands?, skipInstallIfPresent? }
 *        → start a session: install, then the dev server, in that folder.
 *   GET  → every session this server has, newest first.
 *
 * The POST is the whole point of the dock: the user picked a folder in the page
 * and the site does the rest. Clicking it twice for the same folder rejoins the
 * running session instead of starting a second `npm install` beside the first.
 */

import { z } from 'zod';

import { fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { resolveFolder, terminalPolicy } from '@/lib/terminal/guard';
import { createSession, listSessions, pruneFinished } from '@/lib/terminal/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CreateSchema = z.object({
  cwd: z.string().min(1),
  projectId: z.string().nullish(),
  commands: z.array(z.string().min(1)).max(6).optional(),
  skipInstallIfPresent: z.boolean().optional(),
});

export async function POST(request: Request) {
  const policy = terminalPolicy();
  if (!policy.enabled) {
    return jsonError(403, {
      code: 'terminal_disabled',
      message: 'The terminal is disabled on this server.',
      details: 'Set WIREUP_TERMINAL_ENABLED=1 to turn it back on.',
    });
  }

  try {
    const body = parseBody(CreateSchema, await readJson(request));
    const folder = resolveFolder(body.cwd, policy);
    if (!folder.ok) {
      return jsonError(400, { code: 'folder_not_allowed', message: folder.message });
    }

    const result = createSession({
      cwd: folder.path,
      projectId: body.projectId ?? null,
      commands: body.commands,
      skipInstallIfPresent: body.skipInstallIfPresent,
    });

    if (!result.ok) {
      return jsonError(409, { code: 'session_not_started', message: result.message });
    }

    pruneFinished();
    return jsonOk(
      { session: result.session.snapshot(), reused: result.reused },
      { status: result.reused ? 200 : 201 },
    );
  } catch (error) {
    const mapped = fromUnknown(error, 'POST /api/terminal/sessions');
    return jsonError(mapped.status, mapped.error);
  }
}

export async function GET() {
  try {
    const policy = terminalPolicy();
    return jsonOk({
      enabled: policy.enabled,
      roots: policy.roots,
      freeform: policy.freeform,
      sessions: policy.enabled ? listSessions() : [],
    });
  } catch (error) {
    const mapped = fromUnknown(error, 'GET /api/terminal/sessions');
    return jsonError(mapped.status, mapped.error);
  }
}
