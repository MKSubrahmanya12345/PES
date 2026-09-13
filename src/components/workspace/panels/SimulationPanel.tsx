'use client';

/**
 * SIMULATION — two halves, product-ready defaults.
 *
 *   ⚡ Simulation — hosted Velxio when WIREUP_VELXIO_URL is set; otherwise a
 *                  clear setup state (no pretend localhost for end users).
 *   🖥 Website    — hosted dashboard preview served by Wireup itself
 *                  (/api/projects/:id/simulation/dashboard). Zip download
 *                  still available for Web Serial on real hardware.
 *
 * This page relays serial bytes between the halves when both are live.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge, Card, Empty, Loader, Notice, SectionTitle } from '../ui';
import { useHub } from '../hub-context';
import { fetchSimulation, syncCanvas, type SimulationPayload } from '../api';
import { useVelxioBridge } from '../velxio-bridge';
import { useDashboardRelay } from '../dashboard-relay';

type View = 'simulation' | 'website';

export function SimulationPanel() {
  const { project, running, details, refresh } = useHub();
  const projectId = project?.id ?? null;

  const [payload, setPayload] = useState<SimulationPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('simulation');
  const [syncNote, setSyncNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

  /* ── Load the bundle ---------------------------------------------------- */
  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const next = await fetchSimulation(projectId);
      setPayload(next);
      setLoadError(null);
      setView(next.config.defaultView);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load the simulation bundle.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the pipeline runs, the diagram and firmware appear one after the
  // other. Re-fetch when the project's revision moves so the halves light up
  // without the user reloading.
  const revision = project?.revision ?? 0;
  const stage = project?.stage ?? 'idle';
  useEffect(() => {
    if (!payload) return;
    if (payload.revision === revision && payload.velxio && payload.software) return;
    void load();
    // `stage` is in the deps on purpose: it moves during a run even when the
    // revision does not, and each move can unblock a half.
  }, [revision, stage, load, payload]);

  const velxioUrl = payload?.config.velxioUrl ?? null;
  const websiteUrl = payload?.config.websiteUrl ?? null;
  const vlx = payload?.velxio?.vlx ?? null;

  /* ── Bridges ------------------------------------------------------------ */
  const velxio = useVelxioBridge({ embedUrl: velxioUrl, autoPushVlx: vlx });
  const dashboard = useDashboardRelay({
    embedUrl: websiteUrl,
    // Bytes the emulator printed go straight to the dashboard.
    serialOut: velxio.serialChunk,
    connected: velxio.status.state === 'pushed' || velxio.status.state === 'ready',
    // Bytes the dashboard's buttons produce go straight into the emulator.
    onWrite: velxio.serialWrite,
  });

  // Velxio only streams serial once someone asks for it. Ask as soon as the
  // canvas is live, and start the emulator so the dashboard iframe receives
  // telemetry the moment it attaches — the user shouldn't have to reach into
  // the embedded Velxio iframe to click Play every time.
  //
  // It is keyed on the PUSH, not on "pushed" alone: a sketch updated in the
  // workbench re-pushes the .vlx, and a board still running the previous build
  // would report that update as a success. (Velxio compiles before it starts —
  // see `utils/embedBridge.ts` — so a re-pushed program is actually rebuilt.)
  useEffect(() => {
    if (velxio.pushCount === 0) return;
    velxio.subscribeSerial();
    velxio.run();
  }, [velxio.pushCount, velxio.subscribeSerial, velxio.run]);

  /* ── Canvas → diagram.json --------------------------------------------- */
  const pullCanvas = useCallback(async () => {
    if (!projectId) return;
    setSyncing(true);
    setSyncNote(null);
    try {
      const canvas = await velxio.pull();
      const result = await syncCanvas(projectId, canvas);
      setSyncNote({
        tone: 'ok',
        text: `Saved as revision ${result.revision}. ${result.summary}`,
      });
      await refresh();
      await load();
    } catch (error) {
      setSyncNote({
        tone: 'err',
        text: error instanceof Error ? error.message : 'Pulling the canvas failed.',
      });
    } finally {
      setSyncing(false);
    }
  }, [projectId, velxio, refresh, load]);

  /* ── Render ------------------------------------------------------------- */
  if (loading && !payload) {
    return (
      <Card title="Simulation" wide>
        <Loader label="Preparing the simulator project and the dashboard" />
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card title="Simulation" wide>
        <Notice tone="err" title="Could not prepare this page">
          {loadError}
        </Notice>
      </Card>
    );
  }

  if (!payload) {
    return (
      <Card title="Simulation" wide>
        <Empty>No simulation data for this project.</Empty>
      </Card>
    );
  }

  return (
    <div className="sim">
      <div className="sim__bar">
        <div className="sim__swap" role="group" aria-label="Switch between the simulation and the website">
          <button
            type="button"
            className={view === 'simulation' ? 'sim__swap-btn sim__swap-btn--on' : 'sim__swap-btn'}
            aria-pressed={view === 'simulation'}
            onClick={() => setView('simulation')}
          >
            ⚡ Simulation
          </button>
          <button
            type="button"
            className={view === 'website' ? 'sim__swap-btn sim__swap-btn--on' : 'sim__swap-btn'}
            aria-pressed={view === 'website'}
            onClick={() => setView('website')}
          >
            🖥 Website
          </button>
        </div>

        <span className="sim__spacer" />

        <LinkPill label="emulator" state={velxioStatusLabel(velxio.status.state, velxio.running)} tone={velxioTone(velxio.status.state)} />
        <LinkPill
          label="dashboard"
          state={dashboard.attached ? 'attached' : 'waiting'}
          tone={dashboard.attached ? 'ok' : 'neutral'}
        />
        <LinkPill
          label="bytes"
          state={`${dashboard.bytesToDashboard} ↓ / ${dashboard.bytesToBoard} ↑`}
          tone={dashboard.bytesToDashboard > 0 ? 'ok' : 'neutral'}
        />

        <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      {running ? (
        <Notice tone="info" title="This build is still running">
          The halves below appear as the pipeline produces them — the circuit first, then the firmware, then the
          dashboard derived from it. Nothing needs a reload.
        </Notice>
      ) : null}

      {/* Both iframes stay MOUNTED regardless of the toggle. Unmounting the
          hidden one would tear down its bridge, and the serial relay would
          reset every time the user flipped the switch. */}
      <div className="sim__stage">
        <section className={view === 'simulation' ? 'sim__half' : 'sim__half sim__half--hidden'} aria-hidden={view !== 'simulation'}>
          <SimulationHalf
            payload={payload}
            velxioUrl={velxioUrl}
            frameRef={velxio.frameRef}
            status={velxio.status}
            runError={velxio.runError}
            onPull={() => void pullCanvas()}
            syncing={syncing}
            syncNote={syncNote}
            details={details}
          />
        </section>

        <section className={view === 'website' ? 'sim__half' : 'sim__half sim__half--hidden'} aria-hidden={view !== 'website'}>
          <WebsiteHalf payload={payload} websiteUrl={websiteUrl} frameRef={dashboard.frameRef} attached={dashboard.attached} details={details} />
        </section>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Simulation half                                                            */
/* -------------------------------------------------------------------------- */

function SimulationHalf({
  payload,
  velxioUrl,
  frameRef,
  status,
  runError,
  onPull,
  syncing,
  syncNote,
  details,
}: {
  payload: SimulationPayload;
  velxioUrl: string | null;
  frameRef: (node: HTMLIFrameElement | null) => void;
  status: ReturnType<typeof useVelxioBridge>['status'];
  runError: string | null;
  onPull: () => void;
  syncing: boolean;
  syncNote: { tone: 'ok' | 'err'; text: string } | null;
  details: boolean;
}) {
  const velxio = payload.velxio;

  return (
    <>
      <div className="sim__head">
        <div>
          <SectionTitle>Velxio emulator — embedded from {velxioUrl}</SectionTitle>
          <p className="faint">
            {velxio
              ? `${velxio.boardKind ?? 'board'} · ${velxio.parts} part(s) · ${velxio.wires} wire(s) · ${
                  velxio.files.length
                } source file(s) in the board's compile group${
                  velxio.fileGroup ? ` (${velxio.fileGroup})` : ''
                }, pushed and built on the canvas automatically.`
              : payload.blocked.velxio}
          </p>
        </div>
        <span className="sim__spacer" />
        <button type="button" className="btn btn--sm" onClick={onPull} disabled={syncing || status.state === 'idle'}>
          {syncing ? 'pulling…' : 'pull canvas → diagram.json'}
        </button>
      </div>

      {runError ? (
        <Notice tone="err" title="The pushed firmware did not build">
          {runError} — the canvas is loaded and the circuit is correct, so only the build failed. The board was left
          stopped rather than run against a program from an earlier push.
        </Notice>
      ) : null}

      {/* Only when this build DOES have firmware: while the pipeline is still
          running the sketch has simply not been generated yet, and `blocked`
          already says so in the line above. */}
      {velxio && velxio.files.length === 0 && !payload.blocked.software ? (
        <Notice tone="warn" title="No firmware reached the board">
          The .vlx pushed to the canvas has an empty file group{velxio.fileGroup ? ` ("${velxio.fileGroup}")` : ''}, so
          the emulator has a circuit and nothing to compile. Wireup writes the sketch into the exact group the imported
          board reads — if this project does have firmware and you still see this, this Velxio build and the exporter
          have drifted (see <code>velxioFileGroupId</code>).
        </Notice>
      ) : null}

      {syncNote ? (
        <Notice tone={syncNote.tone === 'ok' ? 'ok' : 'err'} title={syncNote.tone === 'ok' ? 'Canvas synced' : 'Sync failed'}>
          {syncNote.text}
        </Notice>
      ) : null}

      {status.state === 'error' ? (
        <Notice tone="err" title="The canvas did not answer">
          {status.message}
        </Notice>
      ) : null}

      {velxio && velxio.cadBench.length > 0 ? (
        <Notice tone="info" title={`${velxio.cadBench.length} part(s) are on the bench as CAD parts`}>
          <ul className="sim__list">
            {velxio.cadBench.map((entry) => (
              <li key={entry.id}>
                {entry.name} ({entry.catalogId})
              </li>
            ))}
          </ul>
          This build has no electrical model for them, so they hold their real shape and pin anchors on the
          canvas and in the 3D view without reacting to signals. They are never substituted with a lookalike
          emulator part.
        </Notice>
      ) : null}

      {velxio && velxio.unsupported.length > 0 ? (
        <Notice tone="warn" title={`${velxio.unsupported.length} item(s) could not be placed on the canvas`}>
          <ul className="sim__list">
            {velxio.unsupported.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
          These are reported rather than substituted: putting a lookalike part on the canvas would wire the
          firmware to pins the real component does not have.
        </Notice>
      ) : null}

      {velxioUrl ? (
        <div className="sim__frame-wrap">
          <iframe
            ref={frameRef}
            className="sim__frame"
            src={velxioUrl}
            title="Velxio emulator"
            allow="serial; usb"
          />
          {status.state === 'waiting' ? (
            <div className="sim__overlay">
              <strong>
                {payload.config.velxioHosted
                  ? `Connecting to hosted emulator at ${velxioUrl}`
                  : `Waiting for emulator at ${velxioUrl}`}
              </strong>
              <p className="faint">
                {payload.config.velxioHosted
                  ? 'Your workspace is configured with a hosted Velxio URL. If this hangs, check WIREUP_VELXIO_URL and frame-ancestors on that host.'
                  : 'Dev fallback: start local Velxio (`cd external/velxio/frontend && npm run dev`) or set WIREUP_VELXIO_URL to your hosted emulator for production.'}
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <Empty>
          No emulator URL configured. Set <code>WIREUP_VELXIO_URL</code> to your hosted Velxio deployment. The
          dashboard half still works without it.
        </Empty>
      )}

      {details && velxio ? (
        <details className="sim__details">
          <summary>the .vlx that was pushed</summary>
          <pre className="sim__pre">{velxio.vlx}</pre>
        </details>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Website half                                                               */
/* -------------------------------------------------------------------------- */

function WebsiteHalf({
  payload,
  websiteUrl,
  frameRef,
  attached,
  details,
}: {
  payload: SimulationPayload;
  websiteUrl: string | null;
  frameRef: (node: HTMLIFrameElement | null) => void;
  attached: boolean;
  details: boolean;
}) {
  const software = payload.software;
  const errors = software?.findings.filter((finding) => finding.severity === 'error') ?? [];
  const warnings = software?.findings.filter((finding) => finding.severity === 'warning') ?? [];
  const bytes = useMemo(
    () => (software ? software.files.reduce((total, file) => total + file.bytes, 0) : 0),
    [software],
  );

  return (
    <>
      <div className="sim__head">
        <div>
          <SectionTitle>
            {payload.config.dashboardHosted
              ? 'Hosted dashboard preview'
              : `Generated dashboard — ${websiteUrl}`}
          </SectionTitle>
          <p className="faint">
            {software
              ? payload.config.dashboardHosted
                ? `${software.files.length} file(s) generated. Live preview is served by Wireup — download the zip for Web Serial on real hardware.`
                : `${software.files.length} file(s), ${Math.round(bytes / 1024)} kB of source.`
              : payload.blocked.software}
          </p>
        </div>
        <span className="sim__spacer" />
        {software ? (
          <a className="btn btn--sm btn--primary" href={software.zipUrl} download>
            download the zip
          </a>
        ) : null}
      </div>

      {software ? (
        <>
          <div className="sim__meta">
            <Badge tone={software.passed ? 'ok' : 'err'}>
              {software.passed ? 'static checks passed' : `${errors.length} error(s)`}
            </Badge>
            {warnings.length > 0 ? <Badge tone="warn">{warnings.length} warning(s)</Badge> : null}
            <Badge tone="neutral">{software.contract.metrics.length} reading(s)</Badge>
            <Badge tone="neutral">{software.contract.commands.length} control(s)</Badge>
            <Badge tone={attached ? 'ok' : 'neutral'}>{attached ? 'relay attached' : 'relay waiting'}</Badge>
          </div>

          {errors.length > 0 ? (
            <Notice tone="err" title="Static validation found problems">
              <ul className="sim__list">
                {errors.map((finding) => (
                  <li key={`${finding.code}-${finding.file ?? ''}-${finding.message}`}>
                    <code>{finding.code}</code> {finding.message}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}

          {warnings.length > 0 ? (
            <Notice tone="warn" title={`${warnings.length} warning(s)`}>
              <ul className="sim__list">
                {warnings.map((finding) => (
                  <li key={`${finding.code}-${finding.message}`}>
                    <code>{finding.code}</code> {finding.message}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </>
      ) : null}

      {websiteUrl ? (
        <div className="sim__frame-wrap">
          <iframe ref={frameRef} className="sim__frame" src={websiteUrl} title="Generated dashboard" />
          {!attached ? (
            <div className="sim__overlay">
              <strong>
                {payload.config.dashboardHosted
                  ? 'Loading hosted dashboard…'
                  : `Waiting for dashboard at ${websiteUrl}`}
              </strong>
              <p className="faint">
                {payload.config.dashboardHosted
                  ? 'Wireup serves this preview. Serial link attaches automatically when the Simulation half is live.'
                  : 'Start the external dashboard host, or clear WIREUP_WEBSITE_URL to use the built-in preview.'}
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <Empty>No dashboard URL is configured.</Empty>
      )}

      {details && software ? (
        <details className="sim__details">
          <summary>the device contract both halves were generated from</summary>
          <pre className="sim__pre">{JSON.stringify(software.contract, null, 2)}</pre>
        </details>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Small bits                                                                 */
/* -------------------------------------------------------------------------- */

function LinkPill({ label, state, tone }: { label: string; state: string; tone: 'ok' | 'warn' | 'err' | 'neutral' }) {
  return (
    <span className={`sim__pill sim__pill--${tone}`}>
      <span className="sim__pill-label">{label}</span>
      <span className="sim__pill-state">{state}</span>
    </span>
  );
}

function velxioStatusLabel(state: string, running = false): string {
  switch (state) {
    case 'waiting':
      return 'waiting';
    case 'ready':
      return 'connected';
    case 'pushed':
      // "running" is the answer to the question this pill exists for: the
      // pushed build did not just load, it built and started.
      return running ? 'running' : 'circuit loaded';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

function velxioTone(state: string): 'ok' | 'warn' | 'err' | 'neutral' {
  if (state === 'pushed' || state === 'ready') return 'ok';
  if (state === 'error') return 'err';
  if (state === 'waiting') return 'warn';
  return 'neutral';
}
