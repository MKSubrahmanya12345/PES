'use client';

/**
 * Folder picker — "where should the terminal run?"
 *
 * A browser cannot read a path off the user's disk, and `showDirectoryPicker`
 * would hand back a name with no location, which is useless to a server that
 * has to `cd` somewhere. So the picker reads the server's filesystem one level
 * at a time through /api/terminal/browse — the same machine the dev server will
 * run on — and the user either walks to the folder or pastes its path.
 *
 * Every row says what the dock needs to know before anything runs: is this a
 * project (package.json), is it already installed (node_modules), and what
 * would `dev` do. That is what makes "pick a folder, we handle the rest" a
 * decision the user can actually make.
 */

import { useCallback, useEffect, useState } from 'react';

import { browseFolders, type BrowseEntry, type BrowsePayload } from './terminal-api';

const SKIP_HINT = 'node_modules, .git and build output are hidden.';

export interface FolderPickerProps {
  /** Where to start: the remembered folder, or the first allowed root. */
  initial?: string | null;
  recents?: string[];
  onPick: (path: string, entry: BrowseEntry | null) => void;
  onCancel?: () => void;
  busy?: boolean;
}

export function FolderPicker({ initial, recents = [], onPick, onCancel, busy }: FolderPickerProps) {
  const [target, setTarget] = useState<string>(initial ?? '');
  const [payload, setPayload] = useState<BrowsePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (path: string | null | undefined) => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await browseFolders(path ?? undefined);
      setPayload(next);
      setTarget(next.path);
      if (next.error) setLoadError(next.error);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not read that folder.');
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initial ?? null);
    // Only on mount / when the remembered folder changes from outside.
  }, [initial, load]);

  const segments = (payload?.path ?? target).split('/').filter(Boolean);
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(payload?.path ?? target);

  return (
    <div className="picker">
      <div className="picker__row">
        <input
          className="picker__input mono-sm"
          value={target}
          spellCheck={false}
          placeholder="/path/to/the/folder/you/unzipped/into"
          onChange={(event) => setTarget(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void load(target);
          }}
        />
        <button type="button" className="btn btn--sm" onClick={() => void load(target)} disabled={loading}>
          {loading ? 'reading…' : 'go'}
        </button>
        {payload?.parent ? (
          <button type="button" className="btn btn--sm" onClick={() => void load(payload.parent)} disabled={loading}>
            ↑ up
          </button>
        ) : null}
        {onCancel ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
            cancel
          </button>
        ) : null}
      </div>

      {/* Breadcrumb — each prefix is a folder you can jump back to. */}
      <div className="picker__crumbs mono-sm">
        {isWindowsPath ? <span className="picker__crumb-static">{segments[0]}/</span> : <span className="picker__crumb-static">/</span>}
        {segments.map((segment, index) => {
          const prefix = isWindowsPath
            ? `${segments.slice(0, index + 1).join('/')}`
            : `/${segments.slice(0, index + 1).join('/')}`;
          const last = index === segments.length - 1;
          return (
            <span key={prefix} className="picker__crumb">
              {last ? (
                <strong>{segment}</strong>
              ) : (
                <button type="button" className="picker__crumb-btn" onClick={() => void load(prefix)} disabled={loading}>
                  {segment}
                </button>
              )}
              {last ? null : <span className="picker__crumb-sep">/</span>}
            </span>
          );
        })}
      </div>

      {loadError ? <p className="picker__error">{loadError}</p> : null}

      {payload && payload.roots.length > 0 ? (
        <div className="picker__chips">
          <span className="picker__chips-label">allowed roots</span>
          {payload.roots.map((root) => (
            <button key={root} type="button" className="chip" onClick={() => void load(root)} disabled={loading} title={root}>
              {root}
            </button>
          ))}
        </div>
      ) : null}

      {recents.length > 0 ? (
        <div className="picker__chips">
          <span className="picker__chips-label">recent</span>
          {recents.map((entry) => (
            <button key={entry} type="button" className="chip" onClick={() => void load(entry)} disabled={loading} title={entry}>
              {entry}
            </button>
          ))}
        </div>
      ) : null}

      <div className="picker__list">
        {loading && !payload ? <p className="picker__empty">Reading the folder…</p> : null}

        {payload?.entries.length === 0 && !loading ? (
          <p className="picker__empty">
            No folders here. {SKIP_HINT} You can still run in this folder with the button below.
          </p>
        ) : null}

        {payload?.entries.map((entry) => (
          <div key={entry.path} className="picker__entry">
            <button
              type="button"
              className="picker__entry-open"
              onClick={() => void load(entry.path)}
              disabled={loading}
              title={`Open ${entry.path}`}
            >
              <span className="picker__entry-icon" aria-hidden>
                🗀
              </span>
              <span className="picker__entry-name">{entry.name}</span>
            </button>

            <span className="picker__entry-facts">
              {entry.isProject ? <span className="picker__tag picker__tag--ok">package.json</span> : <span className="picker__tag">no manifest</span>}
              {entry.hasNodeModules ? <span className="picker__tag picker__tag--ok">installed</span> : null}
              {entry.devScript ? <span className="picker__tag mono-sm">{entry.devScript.slice(0, 40)}</span> : null}
              {!entry.isProject ? <span className="picker__tag picker__tag--info">{entry.installCommand} would create nothing here</span> : null}
            </span>

            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              onClick={() => onPick(entry.path, entry)}
              title={`Run in ${entry.path}`}
            >
              run here
            </button>
          </div>
        ))}
      </div>

      <div className="picker__foot">
        <span className="faint mono-sm">{payload?.path ?? target}</span>
        <span className="picker__spacer" />
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy || !payload || payload.error !== null}
          onClick={() => onPick(payload?.path ?? target, payload?.current ?? null)}
        >
          use this folder
        </button>
      </div>
    </div>
  );
}
