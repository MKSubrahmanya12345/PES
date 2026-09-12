/**
 * POST /api/projects/[id]/software/write  { cwd, overwrite? }
 *
 * Writes the generated website into a folder the user picked, so the terminal
 * dock has something to install and run. The zip and this route serve exactly
 * the same bytes (see `assembleSoftwareFiles`) — one is for people who want to
 * unzip by hand, this one is for people who want the site to do it.
 *
 * Where the files land:
 *   • an empty folder           → into it, as picked;
 *   • anything else             → into `<picked>/<slug>`, so an existing
 *                                 project is never written over;
 *   • a folder that already has a package.json → refused unless `overwrite`.
 *
 * The response carries the derived command sequence for the written folder, so
 * the dock can start the session without a second round trip.
 */

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { getProjectState } from '@/lib/mongodb/projects';
import { buildSimulationBundle } from '@/modules/simulation';
import { resolveFolder, terminalPolicy } from '@/lib/terminal/guard';
import { defaultCommands } from '@/lib/terminal/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const WriteSchema = z.object({
  cwd: z.string().min(1),
  overwrite: z.boolean().optional(),
});

/** A path from the generator, kept inside the target directory. */
function safeJoin(dir: string, relative: string): string | null {
  const normalised = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalised.includes('..')) return null;
  const full = path.resolve(dir, normalised);
  return full.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep) ? full : null;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const policy = terminalPolicy();

  if (!policy.enabled) {
    return jsonError(403, {
      code: 'terminal_disabled',
      message: 'Writing a folder for the terminal is disabled on this server.',
      details: 'Set WIREUP_TERMINAL_ENABLED=1 to turn it back on.',
    });
  }

  try {
    const body = parseBody(WriteSchema, await readJson(request));
    const folder = resolveFolder(body.cwd, policy);
    if (!folder.ok) return jsonError(400, { code: 'folder_not_allowed', message: folder.message });

    const project = await getProjectState(id.trim());
    if (!project) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }

    const bundle = buildSimulationBundle(project);
    const software = bundle.software;
    if (!software) {
      return jsonError(409, {
        code: 'software_not_ready',
        message: 'This project has no generated website yet.',
        details: bundle.blocked.software ?? `Current stage: ${project.stage}.`,
      });
    }

    const picked = folder.path;
    const isEmpty = fs.readdirSync(picked).length === 0;
    const target = isEmpty ? picked : path.join(picked, software.slug);

    if (fs.existsSync(path.join(target, 'package.json')) && !body.overwrite) {
      return jsonError(409, {
        code: 'folder_not_empty',
        message: `${target} already has a package.json.`,
        details: 'Send overwrite: true to write the generated site over it, or pick another folder.',
      });
    }

    let created = 0;
    let overwritten = 0;
    const written: string[] = [];

    for (const file of software.files) {
      const full = safeJoin(target, file.path);
      if (!full) {
        return jsonError(500, {
          code: 'unsafe_path',
          message: `Refusing to write "${file.path}" — it resolves outside ${target}.`,
        });
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const existed = fs.existsSync(full);
      fs.writeFileSync(full, file.content, 'utf8');
      if (existed) overwritten += 1;
      else created += 1;
      written.push(file.path);
    }

    // The .vlx goes with it, so the folder is the same self-contained thing the
    // zip is (see /simulation/software.zip).
    if (bundle.velxio) {
      const simDir = path.join(target, 'simulation');
      fs.mkdirSync(simDir, { recursive: true });
      fs.writeFileSync(path.join(simDir, `${software.slug}.vlx`), bundle.velxio.json, 'utf8');
    }

    return jsonOk({
      projectId: project.id,
      slug: software.slug,
      dir: target,
      picked,
      isEmpty,
      files: written.length,
      created,
      overwritten,
      paths: written,
      surface: software.surface,
      passed: software.passed,
      findings: software.findings,
      devPort: software.devPort,
      commands: defaultCommands(target, false),
    });
  } catch (error) {
    const mapped = fromUnknown(error, `POST /api/projects/${id}/software/write`);
    return jsonError(mapped.status, mapped.error);
  }
}
