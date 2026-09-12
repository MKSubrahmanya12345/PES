'use client';

/**
 * Client-side calls for the terminal dock.
 *
 * Everything here is a relative URL against the Wireup server, which is the
 * machine the dock spawns processes on. That is the whole trick: the browser
 * cannot run `npm install`, and it cannot see the user's filesystem, so the
 * folder picker reads directories through the server and the commands run there
 * too — the page just watches.
 */

import type { BrowsePayload, TerminalSessionSnapshot } from '@/lib/terminal/types';

import { ApiError, unwrap } from './api';

export type { BrowseEntry, BrowsePayload, TerminalLine, TerminalSessionSnapshot, TerminalStep } from '@/lib/terminal/types';

export interface StartSessionInput {
  cwd: string;
  projectId?: string | null;
  commands?: string[];
  skipInstallIfPresent?: boolean;
}

export interface WriteSoftwareResult {
  projectId: string;
  slug: string;
  /** Where the files actually landed — may be `<picked>/<slug>`. */
  dir: string;
  picked: string;
  isEmpty: boolean;
  files: number;
  created: number;
  overwritten: number;
  paths: string[];
  passed: boolean;
  devPort: number;
  /** The sequence the dock should run in `dir`. */
  commands: string[];
  findings: { severity: string; code: string; message: string; file?: string }[];
}

export async function browseFolders(target?: string | null): Promise<BrowsePayload> {
  const query = target ? `?path=${encodeURIComponent(target)}` : '';
  const response = await fetch(`/api/terminal/browse${query}`, { cache: 'no-store' });
  return unwrap<BrowsePayload>(response);
}

export async function startSession(input: StartSessionInput): Promise<{ session: TerminalSessionSnapshot; reused: boolean }> {
  const response = await fetch('/api/terminal/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return unwrap<{ session: TerminalSessionSnapshot; reused: boolean }>(response);
}

export async function listSessions(): Promise<{ enabled: boolean; roots: string[]; sessions: TerminalSessionSnapshot[] }> {
  const response = await fetch('/api/terminal/sessions', { cache: 'no-store' });
  return unwrap(response);
}

export async function fetchSession(id: string): Promise<TerminalSessionSnapshot | null> {
  const response = await fetch(`/api/terminal/sessions/${encodeURIComponent(id)}`, { cache: 'no-store' });
  const payload = await unwrap<{ session: TerminalSessionSnapshot | null }>(response);
  return payload.session;
}

export async function stopSession(id: string): Promise<TerminalSessionSnapshot> {
  const response = await fetch(`/api/terminal/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const payload = await unwrap<{ session: TerminalSessionSnapshot }>(response);
  return payload.session;
}

export async function sendInput(id: string, text: string): Promise<void> {
  const response = await fetch(`/api/terminal/sessions/${encodeURIComponent(id)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    let message = `Input failed with status ${response.status}.`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      message = payload.error?.message ?? message;
    } catch {
      // keep the status-based message
    }
    throw new ApiError(message, 'no_stdin', response.status);
  }
}

/** Write the generated website into a folder so there is something to run. */
export async function writeSoftware(projectId: string, cwd: string, overwrite = false): Promise<WriteSoftwareResult> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/software/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, overwrite }),
  });
  return unwrap<WriteSoftwareResult>(response);
}

export function sessionStreamUrl(id: string, tail = 1500): string {
  return `/api/terminal/sessions/${encodeURIComponent(id)}/stream?tail=${tail}`;
}
