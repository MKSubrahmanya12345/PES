/**
 * GET /api/terminal/browse?path=<folder>
 *
 * The folder picker's data source: one directory level at a time, so the user
 * can walk to the folder they unzipped the generated site into (or to any other
 * project they want the dock to run).
 *
 * Every entry is annotated with the three facts the dock needs to be useful
 * before a single command runs: does it have a package.json, does it already
 * have node_modules, and what would `dev` actually do. A folder that is not a
 * project is still selectable — the dock then offers to write the generated
 * site into it first (see /api/projects/[id]/software/write).
 *
 * Containment is enforced here as well as at spawn time: the browser only ever
 * sees directories inside `WIREUP_TERMINAL_ROOTS`.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { NextRequest } from 'next/server';

import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { installCommandFor, resolveFolder, terminalPolicy } from '@/lib/terminal/guard';
import type { BrowseEntry, BrowsePayload } from '@/lib/terminal/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Directories that are never the folder you mean, and are slow to walk. */
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache', '.venv', '__pycache__']);
const MAX_ENTRIES = 400;

function exists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function entryFor(folder: string, name: string): BrowseEntry {
  const full = path.join(folder, name);
  const manifest = path.join(full, 'package.json');
  let devScript: string | null = null;
  if (exists(manifest)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> };
      devScript = parsed.scripts?.dev ?? parsed.scripts?.start ?? null;
    } catch {
      devScript = null;
    }
  }
  return {
    name,
    path: full,
    isProject: exists(manifest),
    hasNodeModules: exists(path.join(full, 'node_modules')),
    devScript,
    installCommand: installCommandFor(full),
  };
}

export async function GET(request: NextRequest) {
  const policy = terminalPolicy();
  if (!policy.enabled) {
    return jsonError(403, {
      code: 'terminal_disabled',
      message: 'The terminal is disabled on this server.',
      details: 'Set WIREUP_TERMINAL_ENABLED=1 to turn it back on.',
    });
  }

  try {
    const requested = request.nextUrl.searchParams.get('path')?.trim();
    const target = requested && requested.length > 0 ? requested : policy.roots[0] ?? process.cwd();
    const check = resolveFolder(target, policy);

    if (!check.ok) {
      // A dead end is not an exception: the picker shows the reason and offers
      // the roots, so the user can carry on from somewhere valid.
      const payload: BrowsePayload = {
        path: target,
        parent: null,
        roots: policy.roots,
        entries: [],
        current: null,
        error: check.message,
      };
      return jsonOk(payload);
    }

    const folder = check.path;
    const entries: BrowseEntry[] = [];

    try {
      const dirents = fs.readdirSync(folder, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        if (dirent.name.startsWith('.') || SKIP.has(dirent.name)) continue;
        entries.push(entryFor(folder, dirent.name));
        if (entries.length >= MAX_ENTRIES) break;
      }
    } catch (error) {
      const payload: BrowsePayload = {
        path: folder,
        parent: null,
        roots: policy.roots,
        entries: [],
        current: null,
        error: `Could not read ${folder}: ${error instanceof Error ? error.message : String(error)}`,
      };
      return jsonOk(payload);
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(folder);
    const parentAllowed = parent !== folder && resolveFolder(parent, policy).ok;

    const payload: BrowsePayload = {
      path: folder,
      parent: parentAllowed ? parent : null,
      roots: policy.roots,
      entries,
      current: entryFor(path.dirname(folder), path.basename(folder)),
      error: null,
    };
    return jsonOk(payload);
  } catch (error) {
    const mapped = fromUnknown(error, 'GET /api/terminal/browse');
    return jsonError(mapped.status, mapped.error);
  }
}
