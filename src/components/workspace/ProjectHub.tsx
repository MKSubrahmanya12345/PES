'use client';

/**
 * PROJECT HUB — the shell around every project output page.
 *
 * Replaces the old always-open agent console + 8-card dump. The hub leads with
 * a plain-language status ribbon, a six-step build progress bar, and guided
 * tabs (Overview, Parts, Wiring, Firmware, Build guide, Check & fix). The raw
 * run log and "technical details" are deliberately off to the side so a normal
 * user is never drowned in internals, but nothing is impossible to reach.
 *
 * A single `useProjectStream` poller lives here (in the `/project/[id]`
 * layout) and is shared by every child page through `HubContext`.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { AgentEvent } from '@/types/generation';
import type { GenerationStage, ProjectState } from '@/types/project';

import { buildSteps, humanStageLabel, isIntake, isInProgress, statusPhrase } from '@/lib/project-presentation';
import { useProjectStream } from './useProjectStream';
import { HubContext, type HubValue } from './hub-context';
import { StatusBadge } from './ui';
import { BuildPackButton } from './BuildPackButton';
import { IntakeSession } from '@/components/everflow/IntakeSession';
import { DrawerVeil, HumanDrawers, type DrawerSide } from './HumanDrawers';
import { SimulationPanel } from './panels/SimulationPanel';
import { TerminalDock } from './TerminalDock';

const TABS = [
  { href: '', label: 'Overview', short: 'Overview' },
  { href: '/everflow', label: 'Project map', short: 'Map' },
  { href: '/parts', label: 'Parts & BOM', short: 'Parts' },
  { href: '/wiring', label: 'Wiring & Pins', short: 'Wiring' },
  { href: '/diagram', label: 'Diagram & Simulator', short: 'Diagram' },
  { href: '/simulation', label: 'Simulation', short: 'Simulation' },
  { href: '/firmware', label: 'Firmware', short: 'Firmware' },
  { href: '/guide', label: 'Build guide', short: 'Guide' },
  { href: '/quality', label: 'Check & fix', short: 'Check' },
] as const;

/* -------------------------------------------------------------------------- */
/* Goal status chip — the everflow loop, visible on every tab.                */
/* Data is already in the hub stream (project.everflow.evaluation); no        */
/* extra fetch. States: building · in flight · waiting on you · done.         */
/* -------------------------------------------------------------------------- */

function GoalRing({ pct, size, tone }: { pct: number; size: number; tone: 'work' | 'wait' | 'done' }) {
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="goal-ring" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} className="goal-ring__track" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className={`goal-ring__fill goal-ring__fill--${tone}`}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(100, Math.max(0, pct)) / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function GoalChip({
  project,
  inProgress,
  intake,
  openAsks,
  onOpen,
}: {
  project: ProjectState | null;
  inProgress: boolean;
  intake: boolean;
  openAsks: number;
  onOpen: () => void;
}) {
  if (intake || !project) return null;
  const evaluation = project.everflow?.evaluation ?? null;
  const pct = evaluation ? Math.round((evaluation.completion ?? 0) * 100) : 0;

  let tone: 'work' | 'wait' | 'done';
  let label: string;
  if (inProgress) {
    tone = 'work';
    label = evaluation ? `building · ${pct}%` : 'building';
  } else if (!evaluation) {
    return null;
  } else if (evaluation.done) {
    tone = 'done';
    label = 'all goals met';
  } else if (evaluation.blockedOnHuman || openAsks > 0) {
    tone = 'wait';
    label = `${pct}% · ${openAsks} ${openAsks === 1 ? 'needs' : 'need'} you`;
  } else {
    tone = 'work';
    label = `${pct}% · pass ${evaluation.pass ?? 0}`;
  }

  return (
    <button
      type="button"
      className={`goal-chip goal-chip--${tone}`}
      onClick={onOpen}
      title="Where every goal in the project stands — opens the project map"
    >
      <GoalRing pct={evaluation ? pct : 0} size={16} tone={tone} />
      <span>{label}</span>
    </button>
  );
}

export function ProjectHub({ projectId, initial, children }: { projectId: string; initial: ProjectState; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const stream = useProjectStream(projectId, initial);
  const [details, setDetails] = useState(false);
  const [drawer, setDrawer] = useState<DrawerSide | null>(null);
  const [dockOpen, setDockOpen] = useState(false);

  const openDock = useCallback(() => setDockOpen(true), []);
  const closeDock = useCallback(() => setDockOpen(false), []);
  const toggleDock = useCallback(() => setDockOpen((current) => !current), []);

  const project = stream.project;
  const base = `/project/${projectId}`;
  const activeHref = useMemo(() => {
    if (!pathname) return '';
    if (pathname === base) return '';
    if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
    return '';
  }, [pathname, base]);

  const [simulationMounted, setSimulationMounted] = useState(activeHref === '/simulation');
  useEffect(() => {
    if (activeHref === '/simulation') setSimulationMounted(true);
  }, [activeHref]);

  const toggleDetails = useCallback(() => setDetails((current) => !current), []);

  const openAsks = project?.humanTasks?.filter((task) => task.direction === 'ai_to_human' && task.status === 'open').length ?? 0;
  const steps = buildSteps(project);
  const status = project?.status ?? 'pending';
  const inProgress = isInProgress(status);
  const canExport = Boolean(
    project &&
      !inProgress &&
      !isIntake(status) &&
      (project.artifacts.code || project.artifacts.diagram || project.artifacts.instructions || project.artifacts.libraries || project.components.length > 0),
  );
  const stage = humanStageLabel(stream.stage);

  /* ── The gate the terminal watches ─────────────────────────────────────────
     "All checks passed" is not a vibe: it is the validation gate the build
     already runs (no blocking issues) plus the two facts that make running
     anything meaningful — the run is finished, and there is firmware to have
     generated a website from. Until then the dock stays closed and says why. */
  const checks = useMemo(() => {
    if (!project) return { passed: false, label: 'loading the build', detail: '' };
    if (isIntake(status)) {
      return { passed: false, label: 'still settling the brief with you', detail: 'The terminal starts once the build has been checked.' };
    }
    if (inProgress) {
      return { passed: false, label: 'the build is still running', detail: `Stage: ${stage}.` };
    }
    if (!project.artifacts?.code) {
      return { passed: false, label: 'no firmware has been generated yet', detail: 'Nothing to build a website from.' };
    }
    const validation = project.validation;
    if (!validation) {
      return { passed: false, label: 'the build has not been checked yet', detail: 'Open Check & fix to run the gate.' };
    }
    if (!validation.passed) {
      const errors = validation.summary?.errors ?? validation.issues.filter((issue) => issue.severity === 'error').length;
      return {
        passed: false,
        label: `${errors} blocking ${errors === 1 ? 'issue' : 'issues'} still open`,
        detail: 'Fix them on the Check & fix tab — the terminal opens itself the moment the gate passes.',
      };
    }
    const summary = validation.summary;
    return {
      passed: true,
      label: summary ? `${summary.checksPassed}/${summary.checksRun} checks passed` : 'all checks passed',
      detail: summary && summary.warnings > 0 ? `${summary.warnings} warning(s) — not blocking.` : 'Nothing blocking.',
    };
  }, [project, status, inProgress, stage]);

  const value: HubValue = useMemo(
    () => ({ ...stream, details, toggleDetails, dockOpen, openDock, closeDock, toggleDock, checks }),
    [stream, details, toggleDetails, dockOpen, openDock, closeDock, toggleDock, checks],
  );

  const headline = statusPhrase(status);
  const subhead = inProgress
    ? `We're ${stage.toLowerCase()} right now.`
    : status === 'failed'
      ? 'We ran into a problem while building. The run log has the details.'
      : 'Everything is ready below.';

  /* The living line under the build steps: the goal loop keeps going after
     the six steps are all done — so the page never visually freezes. */
  const loopEvaluation = project?.everflow?.evaluation ?? null;
  const loopPct = loopEvaluation ? Math.round((loopEvaluation.completion ?? 0) * 100) : 0;
  const loopLine = isIntake(status)
    ? null
    : inProgress
      ? { tone: 'work' as const, text: 'loop · the goal map comes online when the first build finishes' }
      : loopEvaluation
        ? loopEvaluation.done
          ? { tone: 'done' as const, text: 'loop · every goal met — the agent has nothing left to do' }
          : openAsks > 0 || loopEvaluation.blockedOnHuman
            ? { tone: 'wait' as const, text: `loop · pass ${loopEvaluation.pass} · ${loopPct}% of goals met · ${openAsks} ${openAsks === 1 ? 'ask needs' : 'asks need'} you` }
            : { tone: 'work' as const, text: `loop · pass ${loopEvaluation.pass} · ${loopPct}% of goals met · the agent is working the rest` }
        : null;

  return (
    <HubContext.Provider value={value}>
      <header className="topbar">
        <Link href="/" className="topbar__brand">
          <span className="topbar__mark">W</span>
          <span className="topbar__title">Wireup</span>
        </Link>

        <span className="topbar__meta hub__crumb">
          <span className="hub__crumb-label">active bench</span>
          <span className="hub__crumb-divider" aria-hidden="true" />
          {project?.name ?? 'Project'}
          {details ? <span className="faint mono-sm">{project?.id}</span> : null}
          <GoalChip
            project={project}
            inProgress={inProgress}
            intake={isIntake(status)}
            openAsks={openAsks}
            onOpen={() => {
              if (openAsks > 0) {
                setDrawer((current) => (current === 'left' ? null : 'left'));
              } else if (project) {
                router.push(`${base}/everflow`);
              }
            }}
          />
        </span>

        <span className="topbar__spacer" />

        <span className="topbar__meta">
          {inProgress ? (
            <span className="row row--tight">
              <span className="dot dot--live" />
              <span>working</span>
            </span>
          ) : (
            <StatusBadge status={status} />
          )}

          <BuildPackButton projectId={projectId} disabled={!canExport} />

          <button
            type="button"
            className={`btn btn--sm${dockOpen ? ' btn--on' : ''}${checks.passed && !dockOpen ? ' btn--attention' : ''}`}
            onClick={toggleDock}
            title={checks.passed ? 'Terminal — installs and runs the generated website' : `Terminal — waiting: ${checks.label}`}
          >
            {'>_\u2009terminal'}
            {checks.passed ? '' : ' · waiting'}
          </button>

          <Link href={`${base}/log`} className="btn btn--ghost btn--sm">
            run log
          </Link>

          <button
            type="button"
            className={`btn btn--sm${openAsks > 0 ? ' btn--attention' : ''}${drawer === 'left' ? ' btn--on' : ''}`}
            onClick={() => setDrawer((current) => (current === 'left' ? null : 'left'))}
            title="Asks the agent filed for you — it never blocks on you"
          >
            needs you{openAsks > 0 ? ` (${openAsks})` : ''}
          </button>

          <button
            type="button"
            className={`btn btn--sm${drawer === 'right' ? ' btn--on' : ''}`}
            onClick={() => setDrawer((current) => (current === 'right' ? null : 'right'))}
            title="Add a note, idea, correction, resource or steer — the agent reads it on the next pass"
          >
            add to agent
          </button>

          <button type="button" className="btn btn--sm" onClick={toggleDetails} title="Show internal ids, provenance and raw data">
            {details ? 'details: on' : 'details'}
          </button>

          <Link href="/" className="btn btn--ghost btn--sm">
            new project
          </Link>
        </span>
      </header>

      {isIntake(status) ? (
        <main className="hub__content hub__content--intake">
          <IntakeSession />
        </main>
      ) : (
        <>
       <div className={`hub__status${inProgress ? ' hub__status--working' : ''}${status === 'failed' ? ' hub__status--failed' : ''}`}>
        <div className="hub__inner">
           <div className="hub__kicker">
             <span className="hub__kicker-line" aria-hidden="true" />
             build handoff
           </div>
          <div className="hub__headline">
            <h1 className="hub__title">{headline}</h1>
            <p className="hub__sub">{subhead}</p>
          </div>

          <ol className="hub__steps">
            {steps.map((step) => (
              <li key={step.key} className={`hub__step hub__step--${step.state}`}>
                <span className="hub__step-dot" aria-hidden />
                <span className="hub__step-label">{step.label}</span>
              </li>
            ))}
          </ol>
          {loopLine ? (
            <Link href={`${base}/everflow`} className={`hub__loopline hub__loopline--${loopLine.tone}`} title="Open the project map">
              {loopLine.text}
            </Link>
          ) : null}
        </div>
      </div>

      <nav className="hub__nav" aria-label="Project sections">
        {TABS.map((tab) => {
          const active = activeHref === tab.href;
          const evaluation = project?.everflow?.evaluation ?? null;
          const mapBadge =
            tab.href === '/everflow' && !isIntake(status)
              ? openAsks > 0
                ? { tone: 'wait' as const, text: String(openAsks) }
                : evaluation?.done
                  ? { tone: 'done' as const, text: '✓' }
                  : null
              : null;
          return (
            <Link
              key={tab.href}
              href={`${base}${tab.href}`}
              className={`hub__tab${active ? ' hub__tab--active' : ''}`}
              title={tab.href === '/everflow' ? 'The project map — every goal, what is proven, and what the agent needs from you' : undefined}
            >
              {tab.label.replace('&', '\u00a0&')}
              {mapBadge ? <span className={`hub__tab-badge hub__tab-badge--${mapBadge.tone}`}>{mapBadge.text}</span> : null}
            </Link>
          );
        })}
      </nav>

      <main className="hub__content">
        <div className={activeHref === '/simulation' ? 'hub__route' : 'hub__route hub__route--hidden'}>
          {simulationMounted ? <SimulationPanel /> : null}
        </div>
        <div className={activeHref === '/simulation' ? 'hub__route hub__route--hidden' : 'hub__route'}>{children}</div>
      </main>
        </>
      )}

      {/* The terminal: opens itself once the checks pass, then installs and
          runs whatever folder the user picks. Mounted once, at the hub, so it
          survives tab switches mid-install. */}
      <TerminalDock projectId={projectId} open={dockOpen} onOpenChange={setDockOpen} checks={checks} />

      {/* The two drawers — same live project, no second poll. */}
      <DrawerVeil open={drawer !== null} onClose={() => setDrawer(null)} />
      <HumanDrawers side="left" open={drawer === 'left'} onClose={() => setDrawer(null)} />
      <HumanDrawers side="right" open={drawer === 'right'} onClose={() => setDrawer(null)} />
    </HubContext.Provider>
  );
}
