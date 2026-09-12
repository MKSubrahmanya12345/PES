/**
 * verify:self-heal — the four failure classes one real build shipped with,
 * and the repairs that must close every one of them.
 *
 *   pnpm verify:self-heal
 *
 * The build under test is the exact shape a user hit: a Bluetooth RC car with
 * two DC motors, an L298N, an HC-SR04 that should stop the car before
 * obstacles, a "9 V battery" in the brief, a doubt-session transcript folded
 * into the prompt, and a Bedrock model the account is not allowed to call
 * (moonshotai.kimi-k2.5 → "Operation not allowed" on every model call).
 *
 * What used to ship: "No firmware source was generated" + a CodeArtifact
 * schema violation (empty artifact), two power-budget errors (a PP3 feeding
 * ~3 A of motors), and requirement warnings for the obstacle stop and for
 * transcript junk ("4 V) Q: … A (ASSUMPTION …)").
 *
 * What must happen now:
 *   1. the planner never freezes a supply that fails its own budget,
 *   2. the pipeline ALWAYS carries firmware (agent fallback + rescue),
 *   3. the deterministic sketch implements the obstacle stop,
 *   4. transcript scaffolding never becomes a requirement statement,
 *   5. and if any of that regresses, the validate→fix loop repairs it:
 *      the empty/broken code artifact is regenerated and the inadequate
 *      supply is swapped for one sized to the load.
 *
 * Needs no credentials, no MongoDB and no network.
 */

import dns from 'node:dns';

/* --- Make Bedrock unreachable the same way a broken resolver would -------- */
const realLookup = dns.lookup as unknown as (...args: unknown[]) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dns as any).lookup = (hostname: string, ...rest: unknown[]): unknown => {
  const callback = rest[rest.length - 1];
  if (typeof callback === 'function' && String(hostname).endsWith('amazonaws.com')) {
    const error = new Error(`getaddrinfo EAI_AGAIN ${hostname}`) as NodeJS.ErrnoException;
    error.code = 'EAI_AGAIN';
    error.errno = -3001;
    error.syscall = 'getaddrinfo';
    return (callback as (err: Error) => void)(error);
  }
  return realLookup(hostname, ...rest);
};

/* The user's exact configuration: a model id the account cannot call. */
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=1200';
process.env.BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'moonshotai.kimi-k2.5';
process.env.AWS_REGION = process.env.AWS_REGION ?? 'eu-north-1';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'AKIAVERIFYVERIFYVERIFY';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'not-a-real-secret';
process.env.BEDROCK_MAX_RETRIES = process.env.BEDROCK_MAX_RETRIES ?? '2';

import { AgentEventLog } from '@/lib/logging/events';
import { env, resetEnvCache } from '@/lib/validation/env';
import { nowIso } from '@/lib/validation/time';
import { CodeArtifactSchema } from '@/lib/validation/schema';
import type { ProjectState } from '@/types/project';

import { runPipeline } from '@/modules/orchestrator/pipeline';
import { buildRefreshers, controllerInfo, refreshSoftware } from '@/modules/orchestrator/context';
import { validateProject } from '@/modules/validator';
import { fixProject } from '@/modules/fixer';
import { stripIntakeScaffolding } from '@/modules/project-understanding/heuristics';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✕'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function initialProject(prompt: string): ProjectState {
  const now = nowIso();
  return {
    id: 'verify-self-heal',
    name: 'Untitled project',
    prompt,
    status: 'pending',
    stage: 'idle',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    requirements: null,
    components: [],
    hardwarePlan: null,
    pinAssignments: [],
    wiring: null,
    softwarePlan: null,
    assembly: null,
    artifacts: { code: null, diagram: null, libraries: null, instructions: null },
    validation: null,
    revisions: [],
    events: [],
    iteration: { current: 0, max: env().agent.maxFixIterations },
    llm: { calls: [] },
    chat: [],
    revision: 0,
    doubts: [],
    humanTasks: [],
    everflow: { graph: null, evaluation: null, pass: 0 },
    intakeContext: null,
    expandedBrief: null,
    research: [],
  };
}

const BASE_PROMPT =
  'Build a Bluetooth RC car with two DC motors through an L298N, controlled from my phone, ' +
  'with an HC-SR04 ultrasonic sensor that stops the car before it hits obstacles. 9V battery powered.';

/** The doubt-session block exactly as `buildIntakeContext` renders it. */
const INTAKE_BLOCK = [
  '',
  'RESOLVED CONTEXT FROM THE DOUBT SESSION (treat "user" answers as facts and ASSUMPTION lines as guesses the user may later correct):',
  '',
  'Q: What voltage should the motors run at?\nA (user): 6 V',
  '',
  'Q: How will you drive the device?\nA (ASSUMPTION — user did not answer): Phone over Bluetooth/serial',
  '',
].join('\n');

async function main(): Promise<number> {
  resetEnvCache();
  const prompt = BASE_PROMPT + INTAKE_BLOCK;

  console.log('wireup · self-heal verifier');
  console.log(`bedrock model under test: ${env().bedrock.modelId} in ${env().bedrock.region} (DNS forced to fail)\n`);

  /* --- 0. Transcript scaffolding never reaches the requirements ------------ */
  console.log('0. intake transcript scaffolding is stripped before analysis');
  const stripped = stripIntakeScaffolding(prompt);
  check('Q:/A (ASSUMPTION…) wrappers removed', !/Q:|ASSUMPTION|\(user\)/.test(stripped));
  check('the answers themselves survive', /6 V/.test(stripped) && /Phone over Bluetooth\/serial/.test(stripped));

  /* --- 1. The full pipeline, model down, exactly the user's brief ---------- */
  console.log('\n1. pipeline with the model unavailable (Bluetooth RC car + 9 V brief)');
  const events = new AgentEventLog({ initialSeq: 0 });
  const pipeline = await runPipeline({ project: initialProject(prompt), events });
  const project = pipeline.project;
  const catalog = pipeline.context.catalog;

  /* Firmware: never empty, always schema-valid. */
  const code = project.artifacts.code;
  check('firmware was generated', (code?.files.length ?? 0) > 0, `${code?.files.length ?? 0} file(s)`);
  const parsedCode = code ? CodeArtifactSchema.safeParse(code) : null;
  check('code artifact passes the CodeArtifact schema', parsedCode?.success === true, parsedCode?.success ? '' : 'schema violation');
  const sketch = code?.files.find((file) => file.path === 'sketch.ino')?.content ?? '';
  check('sketch defines setup() and loop()', /void\s+setup\s*\(/.test(sketch) && /void\s+loop\s*\(/.test(sketch));

  /* Power: the planner must not freeze a supply that fails its own budget. */
  const power = project.hardwarePlan?.power;
  check('power budget is adequate at plan time', power?.adequate === true, (power?.shortfalls ?? []).join(' | ').slice(0, 120));
  check(
    'the 9 V PP3 is not the supply for a motor build',
    power?.supplyComponentId !== 'battery-9v',
    `supply: ${power?.supplyComponentId ?? 'none'}`,
  );

  /* Behaviour: the obstacle stop is implemented, not just requested. */
  check('sketch implements the obstacle-stop guard', sketch.includes('OBSTACLE_STOP_CM'));
  check('sketch reads the HC-SR04', /readDistanceCm/.test(sketch));

  /* Requirements: clean statements, no transcript junk. */
  const statements = [
    ...(project.requirements?.requirements ?? []),
    ...(project.requirements?.behaviors ?? []),
    ...(project.requirements?.communicationRequirements ?? []),
    ...(project.requirements?.outputs ?? []),
  ];
  check(
    'no requirement statement carries Q:/ASSUMPTION scaffolding',
    statements.every((statement) => !/Q:|ASSUMPTION|\(user\)/.test(statement)),
    statements.filter((statement) => /Q:|ASSUMPTION/.test(statement)).slice(0, 1).join('') || 'clean',
  );

  /* --- 2. Validation of the built project ---------------------------------- */
  console.log('\n2. validation of the built project');
  const controller = controllerInfo(project, catalog);
  const outcome = await validateProject({
    project,
    catalog,
    catalogContext: pipeline.context.fullCatalogContext,
    mcuContext: pipeline.context.mcuContext,
    ...(controller.profile ? { profile: controller.profile } : {}),
    iteration: 0,
    events,
    enableModelReview: false,
  });
  const issues = outcome.result.issues;
  const codeErrors = issues.filter(
    (issue) => issue.domain === 'code' && (issue.code === 'empty_artifact' || (issue.code === 'schema_violation' && issue.domain === 'code')),
  );
  check('no "no firmware source" / code schema errors', codeErrors.length === 0, codeErrors.map((issue) => issue.message).join('; ').slice(0, 120));
  const powerErrors = issues.filter((issue) => issue.code === 'power_budget_exceeded');
  check('no power budget errors', powerErrors.length === 0, powerErrors.map((issue) => issue.message).join('; ').slice(0, 120));
  const junkWarnings = issues.filter((issue) => issue.code === 'requirement_uncovered' && /Q:|ASSUMPTION|\(user\)/.test(issue.message));
  check('no requirement warning quotes transcript junk', junkWarnings.length === 0);
  const obstacleWarnings = issues.filter((issue) => issue.code === 'requirement_uncovered' && /sr04|obstacle|stops the car/i.test(issue.message));
  check('the obstacle-stop requirement is covered by the design', obstacleWarnings.length === 0, obstacleWarnings.map((issue) => issue.message).join('; ').slice(0, 140));

  /* --- 3. Self-heal: the user's broken state, repaired by the fix loop ----- */
  console.log('\n3. the fix loop repairs the broken state a regression could reintroduce');
  const broken = structuredClone(project);
  /* Empty code artifact — the exact shape the old fallback produced. */
  broken.artifacts.code = { files: [], entryPoint: 'sketch.ino', pinsSynchronised: true, notes: [] };
  /* The PP3 back as the supply — the exact power failure the user saw. */
  const supplySelection = broken.components.find(
    (selection) => selection.componentId === (power?.supplyComponentId ?? 'battery-2s-lipo'),
  );
  if (supplySelection) {
    supplySelection.componentId = 'battery-9v';
    supplySelection.name = '9 V alkaline battery (PP3)';
  }
  broken.hardwarePlan = broken.hardwarePlan
    ? { ...broken.hardwarePlan, power: { ...broken.hardwarePlan.power, adequate: false } }
    : broken.hardwarePlan;
  broken.revision = project.revision + 1;

  const brokenOutcome = await validateProject({
    project: broken,
    catalog,
    catalogContext: pipeline.context.fullCatalogContext,
    mcuContext: pipeline.context.mcuContext,
    ...(controller.profile ? { profile: controller.profile } : {}),
    iteration: 0,
    events,
    enableModelReview: false,
  });
  check(
    'the broken state is still detected (validator sanity)',
    brokenOutcome.result.issues.some((issue) => issue.domain === 'code' && issue.code === 'empty_artifact') &&
      brokenOutcome.result.issues.some((issue) => issue.code === 'power_budget_exceeded'),
    `${brokenOutcome.result.issues.filter((issue) => issue.severity === 'error').length} error(s) detected`,
  );

  const refreshers = buildRefreshers({ catalog, baseline: broken, analysis: pipeline.analysis, events });
  const fix = await fixProject({
    project: broken,
    validation: brokenOutcome.result,
    catalog,
    catalogContext: pipeline.context.fullCatalogContext,
    mcuContext: pipeline.context.mcuContext,
    ...(controller.profile ? { profile: controller.profile } : {}),
    iteration: 0,
    events,
    enableLlmFixer: false,
    refresh: { ...refreshers, software: (candidate) => refreshSoftware(candidate, catalog, events) },
  });
  check('fixer planned changes', fix.result.changes.length > 0, `${fix.result.changes.length} change(s)`);
  check(
    'fixer swaps the inadequate supply',
    fix.result.changes.some((change) => change.op === 'replace_component'),
    fix.result.changes.filter((change) => change.op === 'replace_component').map((change) => ('componentId' in change ? change.componentId : '?')).join(', '),
  );
  check(
    'fixer queues a forced code re-derivation',
    fix.result.changes.some((change) => change.op === 'rerun_stage' && 'stage' in change && change.stage === 'code'),
  );

  const healedCode = fix.project.artifacts.code;
  check(
    'firmware is regenerated by the fix',
    (healedCode?.files.length ?? 0) > 0 && CodeArtifactSchema.safeParse(healedCode).success,
    `${healedCode?.files.length ?? 0} file(s)`,
  );
  check(
    'the healed supply can carry the load',
    fix.project.hardwarePlan?.power.adequate === true,
    (fix.project.hardwarePlan?.power.shortfalls ?? []).join(' | ').slice(0, 120),
  );

  /* --- 4. Re-validation closes the loop ------------------------------------ */
  console.log('\n4. re-validation of the healed project');
  const recheck = await validateProject({
    project: fix.project,
    catalog,
    catalogContext: pipeline.context.fullCatalogContext,
    mcuContext: pipeline.context.mcuContext,
    ...(controller.profile ? { profile: controller.profile } : {}),
    iteration: 1,
    events,
    enableModelReview: false,
  });
  const remaining = recheck.result.issues.filter(
    (issue) =>
      issue.severity === 'error' ||
      (issue.code === 'requirement_uncovered' && /Q:|ASSUMPTION|sr04|obstacle/i.test(issue.message)),
  );
  check(
    'no blocking errors and no junk/obstacle requirement warnings remain',
    remaining.length === 0,
    remaining.map((issue) => `${issue.code}: ${issue.message}`).slice(0, 3).join(' | ').slice(0, 160),
  );

  console.log(
    `\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`} — ` +
      `the agent now heals: firmware, power budget, obstacle stop, transcript junk.`,
  );
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('verify:self-heal crashed:', error);
    process.exit(1);
  });
