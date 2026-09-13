'use client';

/**
 * THE PROJECT MAP — the project graph as a working document, in two views.
 *
 *   PLAIN (default) — the narrative: the agent's working document, the
 *                     promises as a checklist, what it needs from you,
 *                     what you add, and what it did on its own since you
 *                     last looked.
 *   GRAPH — the full map: every node carries a completion goal (the dot
 *           says where it stands), click for its evidence; beside it the
 *           human channel in two columns:
 *              1. AI NEEDS YOU   — asks the agent filed: it can never close
 *                                   these goals alone, and it never blocks
 *                                   on you (each has a recorded default)
 *              2. YOU ADD TO AI  — information the agent cannot have.
 *                                   Registered as facts; a design change
 *                                   needs your explicit apply.
 *
 * A one-time 3-step explainer covers the first visit.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { HumanTask, ResearchFinding } from '@/types/everflow';

import { useHub } from '@/components/workspace/hub-context';

import {
  buildProject,
  continueEverflowPass,
  fetchEverflow,
  injectEverflowThought,
  researchEverflowNode,
  respondToEverflowTask,
  type EverflowPayload,
  createEverflowInjection,
} from '@/components/workspace/api';

import { BriefLines } from './BriefLines';
import { GraphCanvas } from './GraphCanvas';

const TERMINAL = new Set(['completed', 'completed_with_warnings', 'completed_with_errors']);
const TOUR_KEY = 'wireup-map-tour-v1';
const VIEW_KEY = 'wireup-map-view-v1';

function statusLine(evaluation: EverflowPayload['evaluation']): { text: string; tone: 'done' | 'wait' | 'work' } {
  if (evaluation.done) return { text: 'Complete — every goal met, nothing left hanging.', tone: 'done' };
  if (evaluation.blockedOnHuman) {
    const asks = evaluation.totals.aiTasksOpen;
    return { text: `Parked on you — ${asks} ask(s) in the “AI needs you” section. The agent keeps the record; it does not wait in silence.`, tone: 'wait' };
  }
  const ends = evaluation.totals.openEnds;
  return { text: `In flight — ${Math.round(evaluation.completion * 100)}% of goals met. ${ends === 0 ? 'The agent is working the rest.' : `${ends} goal(s) ${ends === 1 ? 'has' : 'have'} no one on them yet — the next pass will.`}`, tone: 'work' };
}

/* -------------------------------------------------------------------------- */
/* Plain-language verdicts — the first thing a node inspector says             */
/* -------------------------------------------------------------------------- */

function plainVerdict(result: { goal: { state: string }; evidence: string; openEnd?: boolean } | null): { text: string; word: string; tone: string } {
  if (!result) return { text: 'Not evaluated yet — it joins on the next pass.', word: 'open', tone: 'muted' };
  switch (result.goal.state) {
    case 'satisfied':
      return { text: `Done — ${result.evidence}`, word: 'met', tone: 'ok' };
    case 'blocked_human':
      return { text: 'Needs you — confirm or correct this. It is a recorded guess, and a guess never becomes a fact on its own.', word: 'needs you', tone: 'warn' };
    case 'in_progress':
      return { text: 'In flight — the agent is still working on this.', word: 'in flight', tone: 'info' };
    case 'waived':
      return { text: 'Waived — this does not count against completion.', word: 'waived', tone: 'muted' };
    default:
      return result.openEnd
        ? { text: 'Unowned — no task is working on it yet. The next pass will pick it up.', word: 'unowned', tone: 'warn' }
        : { text: 'Open — not met yet; the agent is working toward it.', word: 'open', tone: 'info' };
  }
}

/** Where a node's workspace file lives — the map links into the product. */
function fileTarget(path: string, base: string): { href: string; label: string } | null {
  if (path.includes('diagram')) return { href: `${base}/diagram`, label: 'diagram' };
  if (path.includes('instructions') || path.endsWith('.md')) return { href: `${base}/guide`, label: 'build guide' };
  if (path.endsWith('.ino') || path.includes('firmware') || path.endsWith('.c') || path.endsWith('.h') || path.endsWith('.sketch'))
    return { href: `${base}/firmware`, label: 'firmware' };
  if (path === 'libraries.json') return { href: `${base}/firmware`, label: 'firmware' };
  if (path.includes('dashboard') || path.endsWith('.py') || path.endsWith('.js') || path.endsWith('.html') || path.endsWith('.css'))
    return { href: `${base}/firmware`, label: 'software' };
  return null;
}

/* -------------------------------------------------------------------------- */
/* First visit — a 3-step explainer, once per browser                          */
/* -------------------------------------------------------------------------- */

const TOUR_STEPS = [
  {
    title: 'Every box is a goal',
    body: 'This map holds everything the agent knows about your project. Each box is a goal with a definition of “done”, and the coloured dot says where it stands — green met, amber needs you, blue in flight.',
  },
  {
    title: 'The agent works it on its own',
    body: 'It checks, fixes and proves on its own, and only asks you what it cannot close alone. Every ask carries a printed default — so it never blocks on you, and you can come back whenever you like.',
  },
  {
    title: 'Your side of the loop',
    body: 'Anything you know that it cannot, goes into “You add to AI”. A design change always comes back to you as a question you explicitly apply — never a silent edit.',
  },
];

function MapTour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const close = () => {
    try {
      localStorage.setItem(TOUR_KEY, 'done');
    } catch {
      /* private mode — the tour simply shows next time */
    }
    onDone();
  };
  return (
    <div className="map-tour" role="dialog" aria-label="How to read the project map">
      <header className="map-tour__head">
        <span className="map-tour__step">
          {step + 1} / {TOUR_STEPS.length}
        </span>
        <button type="button" className="map-tour__x" onClick={close} aria-label="Close the intro">
          ✕
        </button>
      </header>
      <h3 className="map-tour__title">{TOUR_STEPS[step].title}</h3>
      <p className="map-tour__body">{TOUR_STEPS[step].body}</p>
      <footer className="map-tour__foot">
        <span className="map-tour__dots" aria-hidden="true">
          {TOUR_STEPS.map((_, index) => (
            <span key={index} className={index === step ? 'is-on' : ''} />
          ))}
        </span>
        <span className="map-tour__spacer" />
        {step > 0 ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setStep((current) => current - 1)}>
            back
          </button>
        ) : null}
        {step < TOUR_STEPS.length - 1 ? (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setStep((current) => current + 1)}>
            next
          </button>
        ) : (
          <button type="button" className="btn btn--sm btn--primary" onClick={close}>
            got it
          </button>
        )}
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Column one — AI → human                                                    */
/* -------------------------------------------------------------------------- */

function TaskAskCard({ task, projectId, onDone, onApply }: { task: HumanTask; projectId: string; onDone: () => void; onApply: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const answered = task.status !== 'open';

  const send = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        await respondToEverflowTask(projectId, task.id, value);
        if (task.type === 'choose' && /^apply/i.test(value)) {
          await buildProject(projectId, { rebuild: true });
          onApply();
          return;
        }
        onDone();
      } finally {
        setBusy(false);
      }
    },
    [projectId, task.id, onDone, onApply, task.type],
  );

  const boolean = task.asks.shape === 'boolean';
  const choice = task.asks.shape === 'choice';

  return (
    <article className={`evf-ask${answered ? ' evf-ask--answered' : ''}`} data-type={task.type}>
      <header className="evf-ask__head">
        <span className="evf-ask__type">{task.type.toUpperCase()}</span>
        <span className={`evf-ask__prio evf-ask__prio--${task.priority}`}>{task.priority}</span>
        {task.lookAt ? (
          <Link className="evf-ask__look" href={task.lookAt.ref}>
            {task.lookAt.label} →
          </Link>
        ) : null}
        {task.assumptionIfSkipped ? <span className="evf-ask__default">{task.assumptionIfSkipped}</span> : null}
      </header>
      <h4 className="evf-ask__title">{task.title}</h4>
      <p className="evf-ask__body">{task.body}</p>

      {answered && task.response ? (
        <p className="evf-ask__resolved">
          You said: <strong>{task.response.value}</strong>
        </p>
      ) : boolean ? (
        <div className="evf-ask__actions">
          {(task.asks.options ?? ['Yes, it works', 'No, it does not']).map((option, index) => (
            <button key={option} type="button" className={index === 0 ? 'btn btn--sm btn--primary' : 'btn btn--sm'} disabled={busy} onClick={() => void send(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : choice ? (
        <div className="evf-ask__actions">
          {(task.asks.options ?? []).map((option) => (
            <button key={option} type="button" className="btn btn--sm" disabled={busy} onClick={() => void send(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : (
        <div className="evf-ask__actions evf-ask__actions--text">
          <input className="evf-input" placeholder="Your answer…" value={text} onChange={(event) => setText(event.target.value)} />
          <button type="button" className="btn btn--sm btn--primary" disabled={busy || text.trim().length === 0} onClick={() => void send(text.trim())}>
            Send
          </button>
        </div>
      )}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Column two — human → AI                                                    */
/* -------------------------------------------------------------------------- */

type InjectType = 'note' | 'idea' | 'correction' | 'resource' | 'steer';

const INJECT_TYPES: { id: InjectType; label: string; hint: string }[] = [
  { id: 'idea', label: 'idea', hint: 'An idea the agent has not had yet — a feature, a different approach…' },
  { id: 'correction', label: 'correction', hint: 'Something in the design that is wrong or should be different…' },
  { id: 'resource', label: 'resource', hint: 'Parts, tools or hardware you already own…' },
  { id: 'note', label: 'note', hint: 'Context the agent cannot know — where it lives, who uses it…' },
  { id: 'steer', label: 'steer', hint: 'Redirect the reasoning: the current move finishes, the next pass folds this in.' },
];

function InjectionColumn({ projectId, tasks, onDone, steerOk }: { projectId: string; tasks: HumanTask[]; onDone: () => void; steerOk: boolean }) {
  const [type, setType] = useState<InjectType>('idea');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const steerBlocked = type === 'steer' && steerOk !== true;

  const send = useCallback(async () => {
    if (text.trim().length < 3 || steerBlocked) return;
    setBusy(true);
    setError(null);
    try {
      await injectEverflowThought(projectId, { type, text: text.trim() });
      setText('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The addition could not be sent.');
    } finally {
      setBusy(false);
    }
  }, [projectId, type, text, onDone, steerBlocked]);

  const active = INJECT_TYPES.find((entry) => entry.id === type)!;

  return (
    <div className="evf-add">
      <div className="evf-add__composer">
        <div className="evf-add__types" role="group" aria-label="What you are adding">
          {INJECT_TYPES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`evf-add__type${type === option.id ? ' is-active' : ''}${option.id === 'steer' && !steerOk ? ' is-off' : ''}`}
              onClick={() => setType(option.id)}
              title={option.id === 'steer' && !steerOk ? 'Mid-turn steering is off here (needs WIREUP_ENABLE_MID_TURN_STEER=true and model gpt-6-astra)' : undefined}
            >
              {option.label}
            </button>
          ))}
        </div>
        <textarea
          className="evf-add__text"
          rows={3}
          placeholder={active.hint}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {steerBlocked ? (
          <p className="evf-error evf-error--soft">
            Mid-turn steering is off here — a note lands on the map the same way and is read on the next pass.
          </p>
        ) : null}
        {error ? <p className="evf-error">{error}</p> : null}
        <div className="evf-add__foot">
          <span className="evf-muted">Registered as a fact on the map. Design changes come back to you as a question.</span>
          <button type="button" className="btn btn--sm btn--primary" disabled={busy || text.trim().length < 3 || steerBlocked} onClick={() => void send()}>
            Send to the agent
          </button>
        </div>
      </div>

      <ul className="evf-add__list" aria-label="Your additions">
        {tasks.length === 0 ? (
          <li className="evf-muted">Nothing yet. This column is yours — the agent reads it before every pass.</li>
        ) : (
          tasks.map((task) => (
            <li key={task.id} className={`evf-add__item${task.status === 'open' ? '' : ' evf-add__item--processed'}`}>
              <span className={`evf-add__status evf-add__status--${task.status}`}>
                {task.status === 'open' ? 'awaiting the agent' : task.status === 'processed' ? 'agent: registered' : task.status}
              </span>
              <span className="evf-add__title">{task.title}</span>
              <span className="evf-add__body">{task.response?.value ?? task.body}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Research — the agent's docs/web check tool, per node                        */
/* -------------------------------------------------------------------------- */

function NodeResearch({
  projectId,
  nodeId,
  kind,
  onDone,
}: {
  projectId: string;
  nodeId: string;
  kind: string;
  onDone: () => void;
}) {
  const { project } = useHub();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const findings = useMemo(
    () => (project?.research ?? []).filter((finding) => finding.nodeId === nodeId),
    [project?.research, nodeId],
  );

  const research = useCallback(
    async (useWeb: boolean) => {
      setBusy(true);
      setMessage(null);
      try {
        const payload = await researchEverflowNode(projectId, nodeId, useWeb);
        if (!payload.found) {
          setMessage(payload.message ?? 'No source found yet.');
        } else {
          setMessage(null);
        }
        onDone();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'The check could not run.');
      } finally {
        setBusy(false);
      }
    },
    [projectId, nodeId, onDone],
  );

  const canResearch = kind === 'claim' || kind === 'decision' || kind === 'goal' || kind === 'assumption';

  return (
    <div className="evf-research">
      <header className="evf-research__head">
        <span className="evf-col-title">Documentation check</span>
        {canResearch ? (
          <span className="evf-research__actions">
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void research(false)}>
              {busy ? 'Checking…' : 'check the docs'}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} title="Also pull a snippet from the cited page (flagged for your review)" onClick={() => void research(true)}>
              + the web
            </button>
          </span>
        ) : null}
      </header>

      {message ? <p className="evf-research__none">{message}</p> : null}
      {findings.length === 0 && !message ? (
        <p className="evf-research__none">
          {canResearch ? 'The agent checks this against the catalog, the docs corpus, and the web — findings appear here with a citation.' : 'Research applies to claims, decisions, goals and assumptions.'}
        </p>
      ) : null}

      <div className="evf-research__list">
        {findings.map((finding) => (
          <FindingCard key={finding.id} finding={finding} />
        ))}
      </div>
    </div>
  );
}

function FindingCard({ finding }: { finding: ResearchFinding }) {
  return (
    <details className="evf-finding" open={finding.needsHumanCheck}>
      <summary>
        <span className={`evf-finding__src evf-finding__src--${finding.source}`}>{finding.source}</span>
        <span className="evf-finding__title">{finding.title}</span>
        {finding.needsHumanCheck ? <span className="evf-chip evf-chip--veto">needs your check</span> : null}
        <span className="evf-finding__conf">{Math.round(finding.confidence * 100)}%</span>
      </summary>
      <ul>
        {finding.facts.map((fact, index) => (
          <li key={index}>{fact}</li>
        ))}
      </ul>
      {finding.url ? (
        <a className="evf-finding__url" href={finding.url} target="_blank" rel="noreferrer">
          source →
        </a>
      ) : null}
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/* Human Testing & Feedback for selected Node                                  */
/* -------------------------------------------------------------------------- */

function NodeHumanFeedback({
  projectId,
  node,
  onDone,
}: {
  projectId: string;
  node: { id: string; label: string; goal: { state: string } };
  onDone: () => void;
}) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const sendFeedback = useCallback(
    async (type: 'idea' | 'correction' | 'note', text: string) => {
      if (!text.trim()) return;
      setBusy(true);
      setMsg(null);
      try {
        await createEverflowInjection(projectId, {
          type,
          text: `[Node: ${node.label}] ${text.trim()}`,
        });
        setFeedback('');
        setMsg('Feedback registered on the graph as fact!');
        onDone();
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Could not submit feedback.');
      } finally {
        setBusy(false);
      }
    },
    [projectId, node.label, onDone],
  );

  return (
    <div className="evf-human-feedback" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
      <header className="evf-research__head" style={{ marginBottom: 6 }}>
        <span className="evf-col-title">Human Feedback & Testing</span>
      </header>
      <p className="evf-muted" style={{ marginBottom: 8, fontSize: 11 }}>
        Test this node yourself on the bench or simulator and submit your feedback to cut off doubts.
      </p>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy}
          onClick={() => void sendFeedback('note', 'Confirmed working on bench/simulator.')}
        >
          ✅ Confirm Working
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={() => void sendFeedback('correction', 'Needs adjustment / test failed.')}
        >
          ❌ Report Issue
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="evf-input"
          style={{ flex: 1, fontSize: 11 }}
          placeholder="Custom test feedback or note for this node..."
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy || !feedback.trim()}
          onClick={() => void sendFeedback('correction', feedback)}
        >
          Send
        </button>
      </div>
      {msg ? <p className="evf-muted" style={{ marginTop: 6, color: 'var(--ok)', fontSize: 11 }}>{msg}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

export function EverflowPanel() {
  const { project, refresh } = useHub();
  const projectId = project?.id ?? '';
  const base = `/project/${projectId}`;
  const onProjectChanged = refresh;
  const [payload, setPayload] = useState<EverflowPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'plain' | 'graph'>('plain');
  const [tourDone, setTourDone] = useState(true);

  useEffect(() => {
    try {
      if (localStorage.getItem(TOUR_KEY) !== 'done') setTourDone(false);
      const stored = localStorage.getItem(VIEW_KEY);
      if (stored === 'graph' || stored === 'plain') setView(stored);
    } catch {
      /* private mode */
    }
  }, []);

  const switchView = (next: 'plain' | 'graph') => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* private mode */
    }
  };

  const loadGraph = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await fetchEverflow(projectId);
      setPayload(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The graph could not be loaded.');
    }
  }, [projectId]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  const runPass = useCallback(async () => {
    setWorking(true);
    try {
      await continueEverflowPass(projectId);
      await loadGraph();
      await onProjectChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The pass could not run.');
    } finally {
      setWorking(false);
    }
  }, [projectId, loadGraph, onProjectChanged]);

  const evaluation = payload?.evaluation ?? null;
  const line = evaluation ? statusLine(evaluation) : null;
  const actions = payload?.actions ?? null;
  const moves = useMemo(() => [...(actions?.history ?? [])].reverse(), [actions]);
  const aiAsks = useMemo(() => payload?.humanTasks.filter((task) => task.direction === 'ai_to_human') ?? [], [payload]);
  const injections = useMemo(() => payload?.humanTasks.filter((task) => task.direction === 'human_to_ai') ?? [], [payload]);
  const openAsks = aiAsks.filter((task) => task.status === 'open');
  const doneAsks = aiAsks.filter((task) => task.status !== 'open');
  const selectedNode = payload && selected ? payload.graph.nodes.find((node) => node.id === selected) : null;
  const selectedResult = payload && selected ? payload.evaluation.results.find((result) => result.nodeId === selected) : null;
  const terminal = project ? TERMINAL.has(payload?.status ?? project.status) : false;
  const goals = useMemo(() => (payload ? payload.evaluation.results.filter((result) => result.kind === 'goal') : []), [payload]);
  const steerOk = payload?.capabilities?.midTurnSteer === true;
  const refreshBoth = useCallback(() => {
    void loadGraph();
    void onProjectChanged();
  }, [loadGraph, onProjectChanged]);

  if (!project) return null;

  /* ---------------- plain view ---------------- */

  const plainView = (
    <div className="evf-plain">
      <section className="evf-plain__section" aria-label="The brief">
        <h3 className="evf-plain__title">The brief, in the agent's words</h3>
        {payload?.brief ? <BriefLines text={payload.brief} /> : <p className="evf-muted">Materialising…</p>}
      </section>

      <section className="evf-plain__section" aria-label="Promises">
        <h3 className="evf-plain__title">
          Promises — what it must do <span className="evf-plain__count">{goals.filter((g) => g.satisfied).length}/{goals.length} met</span>
        </h3>
        {goals.length === 0 ? (
          <p className="evf-muted">The promises appear here as the graph materialises.</p>
        ) : (
          <ul className="mapcard__goal-list evf-plain__goals">
            {goals.map((result) => {
              const verdict = plainVerdict(result);
              return (
                <li key={result.nodeId} className={`mapcard__goal mapcard__goal--${verdict.tone}`} title={verdict.text}>
                  <span className="mapcard__goal-dot" aria-hidden="true" />
                  <span className="mapcard__goal-label">{result.label}</span>
                  <span className="mapcard__goal-verdict">{verdict.word}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="evf-plain__section" aria-label="AI needs you">
        <h3 className="evf-plain__title">
          AI needs you <span className="evf-plain__count">{openAsks.length}</span>
        </h3>
        {openAsks.length === 0 ? (
          <p className="evf-muted">Nothing is parked on you. The agent is working what it can, alone.</p>
        ) : (
          openAsks.map((task) => <TaskAskCard key={task.id} task={task} projectId={projectId} onDone={refreshBoth} onApply={refreshBoth} />)
        )}
        {doneAsks.length > 0 ? (
          <details className="evf-chan__history">
            <summary>Earlier answers ({doneAsks.length})</summary>
            {doneAsks.map((task) => (
              <div key={task.id} className="evf-chan__history-item">
                <span>{task.title}</span>
                <strong>{task.response?.value}</strong>
              </div>
            ))}
          </details>
        ) : null}
      </section>

      <section className="evf-plain__section" aria-label="You add to AI">
        <h3 className="evf-plain__title">You add to AI</h3>
        <InjectionColumn projectId={projectId} tasks={injections} onDone={refreshBoth} steerOk={steerOk} />
      </section>

      <section className="evf-plain__section" aria-label="Since you last looked">
        <h3 className="evf-plain__title">Since you last looked</h3>
        {moves.length === 0 ? (
          <p className="evf-muted">
            The agent's own moves land here — every check, proof and fix it made on its own, pass {evaluation?.pass ?? 0}.
          </p>
        ) : (
          <ul className="evf-plain__moves">
            {moves.slice(0, 8).map((move) => (
              <li key={move.id} className={`evf-move evf-move--${move.outcome}`}>
                <span className="evf-chip">{move.move}</span>
                <span className={`evf-chip evf-chip--${move.outcome}`}>{move.outcome.replace('_', ' ')}</span>
                <span className="evf-move__summary">{move.summary}</span>
                {move.revision ? <code className="evf-move__rev">v{move.revision}</code> : null}
                <span className="evf-muted">pass {move.pass}</span>
              </li>
            ))}
          </ul>
        )}
        {actions ? (
          <p className="evf-muted evf-plain__budget">
            loop budget: repairs {actions.repairsUsed} · reproofs {actions.reproofsUsed}
          </p>
        ) : null}
      </section>
    </div>
  );

  /* ---------------- graph view ---------------- */

  const graphView = (
    <>
      {actions && moves.length > 0 ? (
        <details className="evf-moves">
          <summary>
            What the agent did on its own — before asking you
            <span className="evf-moves__count">{moves.length}</span>
            <span className="evf-muted">
              repairs {actions.repairsUsed} · reproofs {actions.reproofsUsed}
            </span>
          </summary>
          <ul className="evf-moves__list">
            {moves.map((move) => (
              <li key={move.id} className={`evf-move evf-move--${move.outcome}`}>
                <span className="evf-chip">{move.move}</span>
                <span className={`evf-chip evf-chip--${move.outcome}`}>{move.outcome.replace('_', ' ')}</span>
                <span className="evf-move__summary">{move.summary}</span>
                {move.revision ? <code className="evf-move__rev">v{move.revision}</code> : null}
                <span className="evf-muted">pass {move.pass}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="evf-grid">
        <div className="evf-col evf-col--graph">
          <div className="evf-col__head">
            <h3 className="evf-col-title">The project graph</h3>
            <div className="evf-col__actions">
              <button type="button" className="btn btn--ghost btn--sm" disabled={working} onClick={() => void runPass()}>
                {working ? 'Working…' : 'keep working'}
              </button>
              {terminal ? <span className="evf-muted">to change the design, add it on the right and choose apply</span> : null}
            </div>
          </div>
          {payload ? (
            <GraphCanvas graph={payload.graph} selectedId={selected} onSelect={setSelected} />
          ) : (
            <p className="evf-muted">Materialising the graph…</p>
          )}
          {selectedNode ? (
            <div className="evf-inspector">
              <header>
                <span className="evf-chip">LEVEL {selectedNode.level ?? 1}</span>
                <span className="evf-chip">{selectedNode.kind.toUpperCase()}</span>
                {selectedNode.subsystemClass ? <span className="evf-chip">{selectedNode.subsystemClass}</span> : null}
                {selectedNode.owner === 'human' ? <span className="evf-chip evf-chip--you">owned by you</span> : selectedNode.owner === 'ai' ? <span className="evf-chip evf-chip--ai">owned by the agent</span> : null}
                {selectedNode.file ? (
                  (() => {
                    const target = fileTarget(selectedNode.file.path, base);
                    return target ? (
                      <Link className="evf-inspector__file evf-inspector__file--link" href={target.href} title={`Open in ${target.label}`}>
                        {selectedNode.file.path} → {target.label}
                      </Link>
                    ) : (
                      <code className="evf-inspector__file">{selectedNode.file.path}</code>
                    );
                  })()
                ) : null}
              </header>
              <h4>{selectedNode.label}</h4>
              <p className={`evf-inspector__verdict evf-inspector__verdict--${plainVerdict(selectedResult ?? null).tone}`}>
                {plainVerdict(selectedResult ?? null).text}
              </p>
              <p>{selectedNode.content}</p>
              <details className="evf-inspector__tech">
                <summary>technical detail</summary>
                <dl>
                  <dt>hierarchy</dt>
                  <dd>Level {selectedNode.level ?? 1} {selectedNode.subsystemClass ? `· ${selectedNode.subsystemClass}` : ''} {selectedNode.parentId ? `(parent: ${selectedNode.parentId})` : '(root branch)'}</dd>
                  <dt>goal</dt>
                  <dd>{selectedNode.goal.criterion}</dd>
                  <dt>status / verdict</dt>
                  <dd>
                    <strong>{selectedNode.goal.state === 'satisfied' ? 'SURETY (Satisfied / Verified)' : 'DOUBT (Open / Unconfirmed)'}</strong>
                    {selectedResult ? ` — ${selectedResult.evidence}` : ''}
                  </dd>
                  {selectedNode.testSpec ? (
                    <>
                      <dt>test rung</dt>
                      <dd>{selectedNode.testSpec.rung.toUpperCase()} — {selectedNode.testSpec.assertion} [{selectedNode.testSpec.status}]</dd>
                    </>
                  ) : null}
                  <dt>source</dt>
                  <dd>
                    {selectedNode.source.origin}
                    {selectedNode.source.stage ? ` · ${selectedNode.source.stage}` : ''}
                    {selectedNode.source.revision ? ` · v${selectedNode.source.revision}` : ''}
                  </dd>
                </dl>
              </details>
              <NodeResearch projectId={projectId} nodeId={selectedNode.id} kind={selectedNode.kind} onDone={refreshBoth} />
              <NodeHumanFeedback projectId={projectId} node={selectedNode} onDone={refreshBoth} />
            </div>
          ) : null}
        </div>

        <div className="evf-col evf-col--channel">
          <div className="evf-channel">
            <section className="evf-chan" aria-label="AI needs you">
              <h3 className="evf-chan__title">
                AI needs you <span className="evf-chan__count">{openAsks.length}</span>
              </h3>
              {openAsks.length === 0 ? (
                <p className="evf-muted">Nothing is parked on you. The agent is working what it can, alone.</p>
              ) : (
                openAsks.map((task) => <TaskAskCard key={task.id} task={task} projectId={projectId} onDone={refreshBoth} onApply={refreshBoth} />)
              )}
              {doneAsks.length > 0 ? (
                <details className="evf-chan__history">
                  <summary>Earlier answers ({doneAsks.length})</summary>
                  {doneAsks.map((task) => (
                    <div key={task.id} className="evf-chan__history-item">
                      <span>{task.title}</span>
                      <strong>{task.response?.value}</strong>
                    </div>
                  ))}
                </details>
              ) : null}
            </section>

            <section className="evf-chan evf-chan--add" aria-label="You add to AI">
              <h3 className="evf-chan__title">
                You add to AI <span className="evf-chan__count">{injections.filter((task) => task.status === 'open').length}</span>
              </h3>
              <InjectionColumn projectId={projectId} tasks={injections} onDone={refreshBoth} steerOk={steerOk} />
            </section>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <section className="evf-panel" aria-label="The project map — goals and the human channel">
      {!tourDone ? <MapTour onDone={() => setTourDone(true)} /> : null}

      <header className="evf-headline">
        <div className="evf-headline__row">
          <div>
            <p className="evf-eyebrow">everflow · the goal map</p>
            <p className="evf-headline__sub">
              Every box on this map is a goal with a definition of “done”. The dot says where it stands; the agent keeps working the
              map on its own and only asks you what it can’t close itself.
            </p>
          </div>
          <div className="evf-viewtoggle" role="group" aria-label="Map view">
            <button type="button" className={view === 'plain' ? 'is-on' : ''} onClick={() => switchView('plain')}>
              plain
            </button>
            <button type="button" className={view === 'graph' ? 'is-on' : ''} onClick={() => switchView('graph')}>
              full graph
            </button>
          </div>
        </div>
      </header>

      {line ? (
        <div className={`evf-ribbon evf-ribbon--${line.tone}`}>
          <div className="evf-ribbon__progress" aria-hidden="true">
            <span style={{ width: `${Math.round((evaluation?.completion ?? 0) * 100)}%` }} />
          </div>
          <div className="evf-ribbon__row">
            <strong>{Math.round((evaluation?.completion ?? 0) * 100)}%</strong>
            <span>{line.text}</span>
            <span className="evf-ribbon__meta">
              pass {payload?.evaluation.pass ?? 0} · {payload?.graph.nodes.length ?? 0} boxes · {evaluation?.totals.openEnds ?? 0} unowned
            </span>
          </div>
        </div>
      ) : null}

      {view === 'plain' ? plainView : graphView}

      {error ? <p className="evf-error">{error}</p> : null}
    </section>
  );
}
