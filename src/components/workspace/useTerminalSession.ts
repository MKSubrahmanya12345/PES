'use client';

/**
 * The terminal dock's state machine.
 *
 * One hook owns: which folder the user picked (remembered across reloads), the
 * session running in it, and the live output. The dock component is only
 * rendering — everything that decides "are we installing, are we serving, did
 * it fail" lives here so the same logic drives the auto-run.
 *
 * Reattachment is the part that makes it feel like a terminal rather than a
 * log: on mount the hook asks the server what is still running and, if a
 * session belongs to the remembered folder, subscribes to it. Reloading the
 * page does not lose `npm run dev`, and it does not start a second one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  browseFolders,
  fetchSession,
  listSessions,
  sendInput,
  sessionStreamUrl,
  startSession,
  stopSession,
  writeSoftware,
  type TerminalLine,
  type TerminalSessionSnapshot,
  type WriteSoftwareResult,
} from './terminal-api';

const FOLDER_KEY = 'wireup.terminal.folder';
const RECENTS_KEY = 'wireup.terminal.recents';
const MAX_RECENTS = 6;

function readFolder(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(FOLDER_KEY);
  } catch {
    return null;
  }
}

function readRecents(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function persist(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode / quota — the dock still works, it just forgets on reload
  }
}

export interface RunOptions {
  projectId?: string | null;
  /** Write the generated website into the folder before running anything. */
  materialize?: boolean;
  /** Overwrite an existing package.json when materialising. */
  overwrite?: boolean;
  commands?: string[];
}

export interface UseTerminalSession {
  folder: string | null;
  recents: string[];
  session: TerminalSessionSnapshot | null;
  lines: TerminalLine[];
  /** True while the SSE stream is attached. */
  streaming: boolean;
  busy: boolean;
  error: string | null;
  /** What the last materialise wrote, when one happened. */
  written: WriteSoftwareResult | null;
  chooseFolder: (path: string) => void;
  run: (options?: RunOptions) => Promise<void>;
  stop: () => Promise<void>;
  send: (text: string) => Promise<void>;
  clearView: () => void;
  dismissError: () => void;
  /** A session that is still producing output (install running, or serving). */
  active: boolean;
}

export function useTerminalSession(): UseTerminalSession {
  const [folder, setFolder] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState<WriteSoftwareResult | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<TerminalSessionSnapshot | null>(null);
  const startingRef = useRef(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  /* -- bootstrap: remembered folder, recents, live sessions ---------------- */
  useEffect(() => {
    const remembered = readFolder();
    if (remembered) setFolder(remembered);
    setRecents(readRecents());

    let cancelled = false;
    void (async () => {
      try {
        const payload = await listSessions();
        if (cancelled) return;
        const live = payload.sessions.find(
          (entry) => entry.state === 'running' || entry.state === 'ready',
        );
        const match = live ?? payload.sessions.find((entry) => remembered && entry.cwd === remembered) ?? null;
        if (match) {
          setSession(match);
          setLines(match.lines);
          if (!remembered) setFolder(match.cwd);
        }
      } catch {
        // The terminal may be disabled or the server may be mid-restart; the
        // dock shows "no session" and the user can start one.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* -- the stream ---------------------------------------------------------- */
  const detach = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setStreaming(false);
  }, []);

  const sessionId = session?.id ?? null;
  useEffect(() => {
    if (!sessionId) {
      detach();
      return;
    }

    let closed = false;
    const source = new EventSource(sessionStreamUrl(sessionId));
    sourceRef.current = source;

    const onSnapshot = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { snapshot: TerminalSessionSnapshot };
        setSession(payload.snapshot);
        setLines(payload.snapshot.lines);
      } catch {
        // a malformed frame is not worth tearing the stream down over
      }
    };

    const onLine = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { line: TerminalLine };
        setLines((current) => {
          if (current.length > 0 && current[current.length - 1]?.seq === payload.line.seq) return current;
          const next = [...current, payload.line];
          return next.length > 4000 ? next.slice(next.length - 4000) : next;
        });
      } catch {
        // ignore
      }
    };

    const onState = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { snapshot: TerminalSessionSnapshot };
        setSession(payload.snapshot);
      } catch {
        // ignore
      }
    };

    const onClosed = () => {
      closed = true;
      detach();
      // One last snapshot so the exit code and the final lines are on screen.
      void fetchSession(sessionId)
        .then((fresh) => {
          if (fresh) {
            setSession(fresh);
            setLines(fresh.lines);
          }
        })
        .catch(() => undefined);
    };

    source.addEventListener('snapshot', onSnapshot as EventListener);
    source.addEventListener('line', onLine as EventListener);
    source.addEventListener('state', onState as EventListener);
    source.addEventListener('closed', onClosed as EventListener);
    source.onopen = () => setStreaming(true);
    source.onerror = () => {
      // EventSource retries by itself while the server is reachable. When the
      // session is simply gone (server restarted), stop retrying and say so.
      if (closed) return;
      setStreaming(false);
      void fetchSession(sessionId)
        .then((fresh) => {
          if (!fresh) {
            detach();
            setError('The terminal session is gone — the server probably restarted. Run it again.');
          } else {
            setSession(fresh);
          }
        })
        .catch(() => undefined);
    };

    return () => {
      closed = true;
      source.removeEventListener('snapshot', onSnapshot as EventListener);
      source.removeEventListener('line', onLine as EventListener);
      source.removeEventListener('state', onState as EventListener);
      source.removeEventListener('closed', onClosed as EventListener);
      detach();
    };
  }, [sessionId, detach]);

  /* -- actions ------------------------------------------------------------- */
  const chooseFolder = useCallback((path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setFolder(trimmed);
    persist(FOLDER_KEY, trimmed);
    setRecents((current) => {
      const next = [trimmed, ...current.filter((entry) => entry !== trimmed)].slice(0, MAX_RECENTS);
      persist(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const run = useCallback(
    async (options: RunOptions = {}) => {
      if (startingRef.current) return;
      const target = folder;
      if (!target) {
        setError('Pick the folder to run in first.');
        return;
      }

      startingRef.current = true;
      setBusy(true);
      setError(null);
      try {
        let cwd = target;
        let commands = options.commands;

        if (options.materialize && options.projectId) {
          const result = await writeSoftware(options.projectId, target, options.overwrite ?? false);
          setWritten(result);
          cwd = result.dir;
          commands = result.commands;
          if (cwd !== target) {
            setFolder(cwd);
            persist(FOLDER_KEY, cwd);
            setRecents((current) => {
              const next = [cwd, ...current.filter((entry) => entry !== cwd)].slice(0, MAX_RECENTS);
              persist(RECENTS_KEY, JSON.stringify(next));
              return next;
            });
          }
        }

        const started = await startSession({ cwd, projectId: options.projectId ?? null, commands });
        setSession(started.session);
        setLines(started.session.lines);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not start the terminal session.');
      } finally {
        startingRef.current = false;
        setBusy(false);
      }
    },
    [folder],
  );

  const stop = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    setBusy(true);
    try {
      const stopped = await stopSession(current.id);
      setSession(stopped);
      setLines(stopped.lines);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not stop the session.');
    } finally {
      setBusy(false);
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const current = sessionRef.current;
      if (!current || text.trim().length === 0) return;
      try {
        await sendInput(current.id, text);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not write to the process.');
      }
    },
    [],
  );

  const clearView = useCallback(() => setLines([]), []);
  const dismissError = useCallback(() => setError(null), []);

  const active = session !== null && (session.state === 'running' || session.state === 'ready');

  return {
    folder,
    recents,
    session,
    lines,
    streaming,
    busy,
    error,
    written,
    chooseFolder,
    run,
    stop,
    send,
    clearView,
    dismissError,
    active,
  };
}

/** One directory level, for the picker. Split out so it can be reused. */
export async function browse(target?: string | null) {
  return browseFolders(target);
}
