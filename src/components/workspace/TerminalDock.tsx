'use client';

/**
 * TERMINAL DOCK — the site runs the project for you.
 *
 * The flow this exists for:
 *
 *   1. the build's checks pass;
 *   2. the dock opens itself (no hunting through menus for it);
 *   3. the user picks the folder the generated website should live in — the
 *      picker reads the server's filesystem, because a browser cannot hand a
 *      server a path any other way;
 *   4. the dock writes the generated site into that folder when it is empty,
 *      then runs the install and the dev server, in that order, streaming every
 *      line back into the page;
 *   5. the moment the dev server prints its URL, the dock links it and the
 *      /simulation page's Website half has something to frame.
 *
 * Nothing here is a mock terminal: the commands are real child processes on the
 * machine serving Wireup (see src/lib/terminal), stopping the dock signals the
 * whole process group, and a failing step stops the sequence instead of running
 * the next command against a half-installed folder.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { browseFolders, type BrowseEntry } from './terminal-api';
import { useTerminalSession } from './useTerminalSession';
import { FolderPicker } from './FolderPicker';

export interface TerminalChecks {
  /** Every gate the build has to clear before the site may run anything. */
  passed: boolean;
  /** Plain-language reason, shown when `passed` is false. */
  label: string;
}

export interface TerminalDockProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checks: TerminalChecks;
  /** Let the dock open and start itself once the checks pass. */
  autoRun?: boolean;
}

function dismissedKey(projectId: string): string {
  return `wireup.terminal.dismissed.${projectId}`;
}

function wasDismissed(projectId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(dismissedKey(projectId)) === '1';
  } catch {
    return false;
  }
}

function setDismissed(projectId: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.sessionStorage.setItem(dismissedKey(projectId), '1');
    else window.sessionStorage.removeItem(dismissedKey(projectId));
  } catch {
    // no storage, no persistence — the dock just asks again next load
  }
}

const STEP_GLYPH: Record<string, string> = {
  queued: '○',
  running: '◐',
  done: '✓',
  failed: '✕',
  skipped: '–',
};

export function TerminalDock({ projectId, open, onOpenChange, checks, autoRun = true }: TerminalDockProps) {
  const terminal = useTerminalSession();
  const [picking, setPicking] = useState(false);
  /** undefined = not probed yet, null = the folder could not be read. */
  const [probe, setProbe] = useState<BrowseEntry | null | undefined>(undefined);
  const [materialize, setMaterialize] = useState(true);
  const [stick, setStick] = useState(true);

  const autoOpened = useRef(false);
  const autoStarted = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const { folder, session, lines, streaming, busy, error, written, active } = terminal;

  /* What the picked folder already holds — decides whether the generated site
     has to be written into it before `npm install` means anything. */
  useEffect(() => {
    if (!folder) {
      setProbe(undefined);
      return;
    }
    let cancelled = false;
    setProbe(undefined);
    void browseFolders(folder)
      .then((payload) => {
        if (!cancelled) setProbe(payload.current);
      })
      .catch(() => {
        if (!cancelled) setProbe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [folder]);

  const probed = probe !== undefined;
  const isProject = probe?.isProject ?? false;
  const needsMaterialize = Boolean(projectId) && probed && !isProject;

  /* -- 1. open itself when the checks pass --------------------------------- */
  useEffect(() => {
    if (!autoRun || !checks.passed || open || autoOpened.current) return;
    if (wasDismissed(projectId)) return;
    autoOpened.current = true;
    onOpenChange(true);
  }, [autoRun, checks.passed, open, projectId, onOpenChange]);

  /* -- 2. and start the sequence, when we already know the folder ---------- */
  const run = terminal.run;
  useEffect(() => {
    // The probe has to land first: guessing "not a project" before the folder
    // has been read would write the generated site over a real one.
    if (!open || !checks.passed || !folder || !probed || active || busy) return;
    if (autoStarted.current) return;
    if (session && (session.state === 'running' || session.state === 'ready')) return;
    autoStarted.current = true;
    void run({ projectId, materialize: needsMaterialize });
  }, [open, checks.passed, folder, probed, active, busy, session, needsMaterialize, projectId, run]);

  /* -- keep the log pinned to the newest line ------------------------------ */
  useEffect(() => {
    if (!stick) return;
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines, stick]);

  const onScroll = useCallback(() => {
    const node = logRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    setStick(atBottom);
  }, []);

  const close = useCallback(() => {
    setDismissed(projectId, true);
    onOpenChange(false);
  }, [projectId, onOpenChange]);

  const reopen = useCallback(() => {
    setDismissed(projectId, false);
    onOpenChange(true);
  }, [projectId, onOpenChange]);

  const pick = useCallback(
    (path: string) => {
      terminal.chooseFolder(path);
      setPicking(false);
      autoStarted.current = false; // a new folder is allowed to auto-run again
    },
    [terminal],
  );

  const headline = useMemo(() => {
    if (!folder) return checks.passed ? 'pick a folder to run this in' : checks.label;
    const step = session?.steps.find((entry) => entry.state === 'running');
    if (step) return `${step.label} · ${step.command}`;
    if (session?.state === 'ready' && session.url) return `serving at ${session.url}`;
    if (session?.state === 'failed') return 'a step failed — the log has the reason';
    if (session?.state === 'stopped') return 'stopped';
    return checks.passed ? 'ready to run' : checks.label;
  }, [folder, session, checks]);

  const tone = session?.state === 'failed' ? 'err' : session?.state === 'ready' ? 'ok' : active || busy ? 'work' : 'idle';

  if (!open) {
    return (
      <button type="button" className={`dock-tab dock-tab--${tone}`} onClick={reopen} title={headline}>
        <span className="dock-tab__glyph" aria-hidden>
          ›_
        </span>
        <span className="dock-tab__label">terminal</span>
        <span className="dock-tab__state">{session?.state ?? (folder ? 'ready' : 'no folder')}</span>
      </button>
    );
  }

  return (
    <section className={`dock dock--${tone}`} aria-label="Terminal">
      <header className="dock__bar">
        <span className={`dock__dot dock__dot--${tone}`} aria-hidden />
        <div className="dock__title">
          <strong>terminal</strong>
          <span className="dock__headline">{headline}</span>
        </div>

        <div className="dock__steps">
          {(session?.steps ?? []).map((step) => (
            <span key={step.id} className={`step step--${step.state}`} title={`${step.command} · ${step.state}`}>
              <span className="step__glyph" aria-hidden>
                {STEP_GLYPH[step.state] ?? '○'}
              </span>
              {step.command}
            </span>
          ))}
        </div>

        <span className="dock__spacer" />

        {session?.url ? (
          <a className="btn btn--sm btn--primary" href={session.url} target="_blank" rel="noreferrer">
            open {session.url.replace(/^https?:\/\//, '')}
          </a>
        ) : null}

        {streaming ? <span className="dock__live">live</span> : null}

        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPicking((value) => !value)}>
          {picking ? 'hide folders' : folder ? 'change folder' : 'choose folder'}
        </button>
        <button type="button" className="btn btn--sm" onClick={close} title="Close the dock (the process keeps running)">
          close
        </button>
      </header>

      {picking ? (
        <div className="dock__picker">
          <FolderPicker
            initial={folder}
            recents={terminal.recents}
            busy={busy}
            onPick={pick}
            onCancel={() => setPicking(false)}
          />
        </div>
      ) : null}

      {!folder ? (
        <div className="dock__empty">
          <p>
            <strong>Pick the folder to run this in.</strong> The commands run on the machine serving Wireup, so the
            picker reads that filesystem: walk to the folder you unzipped the generated website into, or paste its path.
          </p>
          {!checks.passed ? <p className="dock__warn">The build's checks have not all passed yet — {checks.label}.</p> : null}
        </div>
      ) : null}

      {error ? (
        <div className="dock__error">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={terminal.dismissError}>
            dismiss
          </button>
        </div>
      ) : null}

      {written ? (
        <div className="dock__note">
          wrote {written.files} file(s) into <code>{written.dir}</code>
          {written.overwritten > 0 ? ` (${written.overwritten} replaced)` : ''} — the skeleton spec is{' '}
          <code>src/surface.ts</code> in there.
        </div>
      ) : null}

      <div className="dock__log" ref={logRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <p className="dock__log-empty">
            {active ? 'waiting for output…' : 'Nothing has run yet. Pick a folder and press run.'}
          </p>
        ) : (
          lines.map((line) => (
            <div key={line.seq} className={`line line--${line.stream}`}>
              <span className="line__text">{line.text}</span>
            </div>
          ))
        )}
      </div>

      <footer className="dock__foot">
        <code className="dock__cwd" title={folder ?? ''}>
          {folder ?? 'no folder'}
        </code>
        {needsMaterialize ? (
          <label className="dock__check">
            <input
              type="checkbox"
              checked={materialize}
              onChange={(event) => setMaterialize(event.target.checked)}
            />
            write the generated site here first
          </label>
        ) : null}
        {probe?.hasNodeModules && isProject ? <span className="dock__hint mono-sm">node_modules present</span> : null}
        {probed && probe === null ? <span className="dock__hint dock__hint--err mono-sm">folder unreadable</span> : null}

        <span className="dock__spacer" />

        <input
          className="dock__stdin mono-sm"
          placeholder={active ? 'send a line to the process (rarely needed)' : 'not running'}
          disabled={!active}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            const value = event.currentTarget.value;
            event.currentTarget.value = '';
            void terminal.send(value);
          }}
        />

        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            autoStarted.current = true; // a manual run is not an auto-run
            void terminal.run({ projectId, materialize: materialize && needsMaterialize });
          }}
          disabled={busy || !folder}
        >
          {busy ? 'starting…' : session ? 'run again' : 'run'}
        </button>

        <button type="button" className="btn btn--sm" onClick={() => void terminal.stop()} disabled={!active}>
          stop
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={terminal.clearView} disabled={lines.length === 0}>
          clear view
        </button>
      </footer>
    </section>
  );
}
