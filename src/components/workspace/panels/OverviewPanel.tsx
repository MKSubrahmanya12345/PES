'use client';

/**
 * OVERVIEW — the hook. Leads with what was built and what to do next, never
 * with internals. While the build is still running it says so simply and points
 * you at the parts/firmware tabs as they fill in.
 */

import Link from 'next/link';

import type { GoalEvaluation } from '@/types/everflow';

import { projectOverview, humanStageLabel } from '@/lib/project-presentation';
import { Badge, Card, Notice } from '../ui';
import { BuildPackButton } from '../BuildPackButton';
import { HardwareCopilot } from '../HardwareCopilot';
import { ProjectAtlas } from '../ProjectAtlas';
import { useHub } from '../hub-context';

/* -------------------------------------------------------------------------- */
/* Where your project stands — the everflow loop, in plain language.          */
/* Renders on the hook page: completion, the promises as a checklist,         */
/* guesses, and the one CTA (answer the agent / open the project map).        */
/* -------------------------------------------------------------------------- */

const GOAL_VERDICT: Record<string, { word: string; tone: string }> = {
  satisfied: { word: 'met', tone: 'ok' },
  blocked_human: { word: 'needs you', tone: 'warn' },
  in_progress: { word: 'in flight', tone: 'info' },
  waived: { word: 'waived', tone: 'muted' },
  open: { word: 'open', tone: 'warn' },
};

function goalVerdict(result: GoalEvaluation) {
  return GOAL_VERDICT[result.goal.state] ?? GOAL_VERDICT.open;
}

/** The brief is markdown-ish (`#`, `##`, `- [x]`, `**`); render it light. */
function BriefLines({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="mapcard__brief">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('# ')) return null; // duplicates the card title
        if (trimmed.startsWith('## ')) return <h4 key={index}>{trimmed.slice(3)}</h4>;
        const check = trimmed.match(/^- \[(x|\?| )\] (.*)$/);
        if (check) {
          const mark = check[1] === 'x' ? '✓' : check[1] === '?' ? '✋' : '○';
          const tone = check[1] === 'x' ? 'ok' : check[1] === '?' ? 'warn' : 'muted';
          return (
            <p key={index} className={`mapcard__brief-line mapcard__brief-line--${tone}`}>
              <span className="mapcard__brief-mark">{mark}</span>
              {stripBold(check[2])}
            </p>
          );
        }
        if (trimmed.startsWith('- ')) {
          return (
            <p key={index} className="mapcard__brief-line">
              <span className="mapcard__brief-mark mapcard__brief-mark--dot">·</span>
              {stripBold(trimmed.slice(2))}
            </p>
          );
        }
        if (!trimmed) return null;
        return (
          <p key={index} className="mapcard__brief-line mapcard__brief-line--plain">
            {stripBold(trimmed)}
          </p>
        );
      })}
    </div>
  );
}

function stripBold(value: string): string {
  return value.replace(/\*\*/g, '').replace(/_/g, '');
}

function GoalStandCard() {
  const { project, running } = useHub();
  if (!project || project.status === 'failed') return null;

  const evaluation = project.everflow?.evaluation ?? null;
  const openAsks = (project.humanTasks ?? []).filter((task) => task.direction === 'ai_to_human' && task.status === 'open').length;
  const mapHref = `/project/${project.id}/everflow`;

  if (!evaluation) {
    return (
      <Card title="Where your project stands" wide>
        <div className="mapcard__pending">
          <span className="dot dot--live" />
          <p>
            The goal map comes online when the first build finishes — from then on the agent keeps a visible
            scoreboard: every goal, what is proven, and what it needs from you.
          </p>
        </div>
      </Card>
    );
  }

  const pct = Math.round(evaluation.completion * 100);
  const goals = evaluation.results.filter((result) => result.kind === 'goal');
  const shownGoals = goals.slice(0, 6);
  const extraGoals = goals.length - shownGoals.length;
  const guesses = evaluation.results.filter((result) => result.kind === 'assumption' && !result.satisfied).slice(0, 3);
  const openEnds = evaluation.totals.openEnds;

  const statusLine = evaluation.done
    ? 'Every goal is met — the agent has nothing left to close.'
    : evaluation.blockedOnHuman || openAsks > 0
      ? `Parked on you — ${openAsks} ${openAsks === 1 ? 'ask' : 'asks'} the agent can't close alone. It keeps the record and never waits in silence.`
      : `In flight — ${pct}% of goals met. The agent keeps working on the rest, and asks only for what it can't.`;
  const tone: 'done' | 'wait' | 'work' = evaluation.done
    ? 'done'
    : evaluation.blockedOnHuman || openAsks > 0
      ? 'wait'
      : 'work';

  return (
    <Card
      title="Where your project stands"
      count={`pass ${evaluation.pass}`}
      wide
      footer={
        <div className="mapcard__foot">
          <span className="mapcard__foot-note">
            {openAsks > 0
              ? `${openAsks} ${openAsks === 1 ? 'thing' : 'things'} need your answer`
              : evaluation.done
                ? 'nothing needs you'
                : 'nothing parked on you right now'}
          </span>
          <Link href={mapHref} className="btn btn--sm btn--primary">
            {openAsks > 0 ? 'Answer the agent →' : 'Open the project map →'}
          </Link>
        </div>
      }
    >
      <div className="mapcard">
        <div className="mapcard__top">
          <span className="mapcard__ring" aria-hidden="true">
            <svg width="46" height="46" viewBox="0 0 46 46">
              <circle cx="23" cy="23" r="19" className="goal-ring__track" strokeWidth="4" />
              <circle
                cx="23"
                cy="23"
                r="19"
                className={`goal-ring__fill goal-ring__fill--${tone}`}
                strokeWidth="4"
                strokeDasharray={2 * Math.PI * 19}
                strokeDashoffset={2 * Math.PI * 19 * (1 - pct / 100)}
                transform="rotate(-90 23 23)"
              />
              <text x="23" y="23" className="mapcard__ring-pct" textAnchor="middle" dominantBaseline="central">
                {pct}%
              </text>
            </svg>
          </span>
          <p className="mapcard__status">{statusLine}</p>
        </div>

        {shownGoals.length > 0 ? (
          <div className="mapcard__goals">
            <span className="mapcard__label">promises — what it must do</span>
            <ul className="mapcard__goal-list">
              {shownGoals.map((result) => {
                const verdict = goalVerdict(result);
                return (
                  <li key={result.nodeId} className={`mapcard__goal mapcard__goal--${verdict.tone}`} title={result.evidence}>
                    <span className="mapcard__goal-dot" aria-hidden="true" />
                    <span className="mapcard__goal-label">{result.label}</span>
                    <span className="mapcard__goal-verdict">{verdict.word}</span>
                  </li>
                );
              })}
            </ul>
            {extraGoals > 0 ? <span className="mapcard__more">+ {extraGoals} more on the map</span> : null}
          </div>
        ) : null}

        {guesses.length > 0 ? (
          <p className="mapcard__guesses">
            It is guessing on: <strong>{guesses.map((guess) => guess.label).join(', ')}</strong>
            {guesses.length === 3 && evaluation.results.filter((r) => r.kind === 'assumption' && !r.satisfied).length > 3 ? ' …' : ''} — a
            guess stays visible until you confirm it.
          </p>
        ) : null}

        {openEnds > 0 && !evaluation.done ? (
          <p className="mapcard__openends">
            {openEnds} {openEnds === 1 ? 'goal' : 'goals'} {openEnds === 1 ? 'has' : 'have'} no one working on them yet — the next pass
            will.
          </p>
        ) : null}

        {evaluation.brief ? (
          <details className="mapcard__brief-wrap">
            <summary>the agent's working document</summary>
            <BriefLines text={evaluation.brief} />
          </details>
        ) : null}
      </div>
      {running ? (
        <p className="mapcard__running">
          <span className="dot dot--live" /> the agent is mid-build — this card updates as each pass lands.
        </p>
      ) : null}
    </Card>
  );
}

const LINKS = [
  { href: 'everflow', label: 'Project map', blurb: 'Every goal, what is proven, what the agent needs from you' },
  { href: 'parts', label: 'Parts & BOM', blurb: 'Every part you need, with why' },
  { href: 'wiring', label: 'Wiring & Pins', blurb: 'The picture of how it connects' },
  { href: 'diagram', label: 'Diagram & Simulator', blurb: 'See it laid out, open it in a simulator' },
  { href: 'firmware', label: 'Firmware', blurb: 'The code for your board' },
  { href: 'guide', label: 'Build guide', blurb: 'Step-by-step to assemble it' },
  { href: 'quality', label: 'Check & fix', blurb: 'Was it validated, and what to fix' },
] as const;

export function OverviewPanel() {
  const { project, running, stage } = useHub();
  const overview = projectOverview(project);

  const goal = project?.requirements?.goal;
  const prompt = project?.prompt;
  const failed = project?.status === 'failed';
  const pending = project === null;
  const canExport = Boolean(
    project &&
      !running &&
      (project.artifacts.code || project.artifacts.diagram || project.artifacts.instructions || project.artifacts.libraries || project.components.length > 0),
  );

  return (
    <div className="col stack hub__stack">
      {failed ? (
        <Notice tone="err" title="We couldn't finish this one">
          The build stopped here. Open the{' '}
          <Link href={`/project/${project?.id ?? ''}/log`} className="notice__link">
            run log
          </Link>{' '}
          to see what happened, or start a new project.
        </Notice>
      ) : null}

      <Card
        title="What you got"
        wide
        flush
        actions={project ? <BuildPackButton projectId={project.id} disabled={!canExport} /> : null}
      >
        <div className="overview__hero">
          <div className="overview__hero-topline">
            <span className="overview__hero-marker" aria-hidden="true" />
            <span>your build brief, made concrete</span>
          </div>
          <p className="overview__headline">{overview.headline}</p>
          {overview.subhead ? <p className="overview__subhead">{overview.subhead}</p> : null}

          {overview.facts.length > 0 ? (
            <dl className="overview__facts">
              {overview.facts.map((fact) => (
                <div key={fact.label} className="overview__fact">
                  <dt className="overview__fact-label">{fact.label}</dt>
                  <dd className="overview__fact-value">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : running ? (
            <p className="overview__subhead" style={{ marginBottom: 0 }}>
              Watch it come together — each part of your project will appear here as soon as it's ready.
            </p>
          ) : null}

          {overview.nextSteps.length > 0 ? (
            <div className="overview__steps">
              <span className="overview__steps-title">What to do next</span>
              <ul className="list list--tight">
                {overview.nextSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Card>

      <GoalStandCard />

      {project && !running ? <HardwareCopilot /> : null}
      {project && !running ? <ProjectAtlas /> : null}

      <Card title="Dig in">
        <div className="overview__links">
          {LINKS.map((link, index) => (
            <Link key={link.href} href={`/project/${project?.id ?? ''}/${link.href}`} className="overview__link">
              <span className="overview__link-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="overview__link-copy">
                <span className="overview__link-label">{link.label}</span>
                <span className="overview__link-blurb">{link.blurb}</span>
              </span>
              <span className="overview__link-arrow">open</span>
            </Link>
          ))}
        </div>
      </Card>

      {(goal || prompt) ? (
        <Card title="The brief" count={running ? undefined : 'from your prompt'}>
          {goal ? <p className="overview__goal">{goal}</p> : null}
          {prompt ? (
            <details className="overview__prompt">
              <summary className="mono-sm">your original prompt</summary>
              <p className="small muted" style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {prompt}
              </p>
            </details>
          ) : null}
        </Card>
      ) : null}

      {pending && running ? (
        <Card title="Building" wide>
          <Badge tone="info">working</Badge>
          <p className="small muted" style={{ marginTop: 8 }}>
            We're {humanStageLabel(stage).toLowerCase()} right now. Your parts, wiring and firmware will appear as they're ready.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
