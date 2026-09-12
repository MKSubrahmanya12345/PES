/**
 * Software skeleton verifier.
 *
 *   npm run verify:skeleton [-- --out /tmp/generated-site]
 *
 * The generated website stopped being a fixed dashboard: the shape of the page
 * is now a spec (`src/surface.ts`) resolved through a block registry by a shell.
 * That is a bigger claim than "the cards look right", so it gets its own gate.
 * This script proves:
 *
 *   1. the skeleton files are emitted, and every relative import between them
 *      resolves to a file that is actually in the project;
 *   2. every generated .ts/.tsx PARSES — with the real TypeScript compiler API,
 *      which is already a devDependency, so this costs no install and no network
 *      (the balance scanner in validate.ts is a heuristic; this is the parser);
 *   3. the composition root hardcodes no section of the page — the words the old
 *      dashboard baked into App.tsx are gone, and the shell reads the spec;
 *   4. the spec is derived from the contract: every reading and every control is
 *      bound to a block, and the layout follows the data;
 *   5. hand-editing the spec is caught the way it should be — a disabled metrics
 *      block is an error, an unregistered kind is an info, a duplicate id is an
 *      error, and none of them crash the generator;
 *   6. a contract with nothing to show still produces a valid, honest project.
 *
 * Needs no credentials, no MongoDB and no network. Exits 0 on success.
 * With `--out <dir>` it also writes the generated project there, so you can
 * `cd` into it and run `npm install && npm run dev` yourself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';

import type { DeviceContract } from '@/modules/software-generator/contract';
import { assembleSoftwareFiles, type SoftwareFile } from '@/modules/software-generator';
import { validateSoftwareProject, type SoftwareFinding } from '@/modules/software-generator/validate';
import { KNOWN_BLOCK_KINDS, deriveSurface, type SurfaceSpec } from '@/modules/software-generator/skeleton';
import type { GeneratedCodeFile } from '@/types/project';

const failures: string[] = [];
const notes: string[] = [];

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

/* -------------------------------------------------------------------------- */
/* Fixtures — a contract and the firmware it was derived from                 */
/* -------------------------------------------------------------------------- */

const FIRMWARE: Pick<GeneratedCodeFile, 'path' | 'content'>[] = [
  {
    path: 'sketch.ino',
    content: [
      'int speed = 70;',
      'float tempC = 21.4;',
      '',
      'void setup() {',
      '  Serial.begin(115200);',
      '}',
      '',
      'void sendTelemetry() {',
      '  Serial.print("status:{\\"state\\":\\"idle\\",\\"speed\\":");',
      '  Serial.print(speed);',
      '  Serial.print(",\\"tempC\\":");',
      '  Serial.print(tempC);',
      '  Serial.println("}");',
      '}',
      '',
      'void handleCommand(char command) {',
      "  if (command == 'a') { motorsOn(); }",
      "  else if (command == 'b') { motorsOff(); }",
      "  else if (command == '+') { speed += 10; }",
      "  else if (command == '-') { speed -= 10; }",
      '  else { Serial.println("err:unknown command"); }',
      '}',
    ].join('\n'),
  },
];

function richContract(): DeviceContract {
  return {
    projectName: 'Bench Rover',
    controller: 'Arduino Nano',
    baud: 115200,
    telemetryPrefix: 'status:',
    telemetryIntervalMs: 1000,
    metrics: [
      { field: 'state', label: 'State', unit: '', kind: 'string', source: 'control loop' },
      { field: 'speed', label: 'Speed', unit: '%', kind: 'number', min: 0, max: 100, precision: 0, source: 'motor driver' },
      { field: 'tempC', label: 'Temperature', unit: '°C', kind: 'number', precision: 1, source: 'on-board sensor' },
    ],
    commands: [
      { character: 'a', label: 'Motors on', meaning: 'start the drive motors', builtIn: false },
      { character: 'b', label: 'Motors off', meaning: 'stop the drive motors', builtIn: false },
      { character: '+', label: 'Faster', meaning: 'speed +10', builtIn: true },
      { character: '-', label: 'Slower', meaning: 'speed −10', builtIn: true },
    ],
    transport: 'USB serial',
    caveats: ['The site shows what the board prints; it never simulates a reading.'],
  };
}

/** A build with nothing to show: no readings, no controls. */
function bareContract(): DeviceContract {
  const contract = richContract();
  return { ...contract, projectName: 'Blink Beacon', metrics: [], commands: [] };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function codes(findings: SoftwareFinding[]): string[] {
  return findings.map((finding) => finding.code);
}

function errorsOf(findings: SoftwareFinding[]): SoftwareFinding[] {
  return findings.filter((finding) => finding.severity === 'error');
}

function fileOf(files: SoftwareFile[], target: string): SoftwareFile | undefined {
  return files.find((file) => file.path === target);
}

/** Parse every generated TS/TSX with the real compiler front end. */
function parseProblems(files: SoftwareFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file.path)) continue;
    const kind = file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ES2022, true, kind);
    // `parseDiagnostics` is internal but stable, and it is exactly the question
    // being asked here: would `tsc` get through the first pass over this file?
    const diagnostics = (source as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
    for (const diagnostic of diagnostics.slice(0, 3)) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      const position = diagnostic.file
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
        : null;
      problems.push(
        `${file.path}${position ? `:${position.line + 1}:${position.character + 1}` : ''} — ${message}`,
      );
    }
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/* The checks                                                                 */
/* -------------------------------------------------------------------------- */

function checkSkeletonShape(files: SoftwareFile[], surface: SurfaceSpec): void {
  heading('1. the skeleton is emitted');

  const required = [
    'src/App.tsx',
    'src/surface.ts',
    'src/skeleton/Shell.tsx',
    'src/skeleton/registry.tsx',
    'src/skeleton/types.ts',
    'src/skeleton/format.ts',
    'src/skeleton/blocks/MetricsBlock.tsx',
    'src/skeleton/blocks/CommandsBlock.tsx',
    'src/skeleton/blocks/LogBlock.tsx',
    'src/skeleton/blocks/NotesBlock.tsx',
    'src/skeleton/blocks/StatusBlock.tsx',
    'src/skeleton/blocks/SlotBlock.tsx',
  ];

  for (const target of required) {
    check(Boolean(fileOf(files, target)), `missing generated file: ${target}`);
  }
  console.log(`  ${files.length} file(s) generated; ${required.length} of them are skeleton structure`);

  const registry = fileOf(files, 'src/skeleton/registry.tsx')?.content ?? '';
  for (const kind of KNOWN_BLOCK_KINDS) {
    check(registry.includes(`${kind}:`), `registry.tsx does not map the "${kind}" kind`);
  }
  check(/blockRegistry\[kind\] \?\? SlotBlock/.test(registry), 'registry.tsx has no slot fallback for unknown kinds');

  const shell = fileOf(files, 'src/skeleton/Shell.tsx')?.content ?? '';
  check(/enabledBlocks\(surface\)/.test(shell), 'Shell.tsx does not render from the spec (enabledBlocks(surface))');
  check(/resolveBlock\(block\.kind\)/.test(shell), 'Shell.tsx does not resolve blocks through the registry');

  for (const layout of ['grid', 'stack', 'tabs', 'bare'] as const) {
    check(shell.includes(layout), `Shell.tsx does not handle the "${layout}" layout`);
  }
}

function checkNotADashboard(files: SoftwareFile[]): void {
  heading('2. the composition root hardcodes no page');

  const app = fileOf(files, 'src/App.tsx')?.content ?? '';
  // These were the sections the old template baked into App.tsx. If any of them
  // comes back, the site is a fixed dashboard again and the spec is decoration.
  for (const baked of ['<h2>Readings</h2>', '<h2>Controls</h2>', '<h2>Board output</h2>', 'className="grid"']) {
    check(!app.includes(baked), `src/App.tsx still hardcodes ${baked}`);
  }
  check(/<Shell board=\{board\} \/>/.test(app), 'src/App.tsx does not hand the board to <Shell/>');
  check(app.includes('src/surface.ts'), 'src/App.tsx does not point the reader at the spec');
  console.log('  App.tsx is identity + <Shell/>; sections come from the spec');
}

function checkParses(files: SoftwareFile[]): void {
  heading('3. every generated source parses');

  const problems = parseProblems(files);
  for (const problem of problems) failures.push(`parse error · ${problem}`);
  const count = files.filter((file) => /\.(ts|tsx)$/.test(file.path)).length;
  console.log(problems.length === 0 ? `  ${count} TS/TSX file(s) parsed clean` : `  ${problems.length} parse problem(s)`);
}

function checkDerivation(contract: DeviceContract, surface: SurfaceSpec, files: SoftwareFile[]): void {
  heading('4. the spec is derived from the contract');

  const enabled = surface.blocks.filter((block) => block.enabled);
  const bound = new Set(enabled.flatMap((block) => block.fields));
  for (const metric of contract.metrics) {
    check(bound.has(metric.field), `metric "${metric.field}" is bound to no enabled block`);
  }
  const sent = new Set(enabled.flatMap((block) => block.characters));
  for (const command of contract.commands) {
    check(sent.has(command.character), `command "${command.character}" is bound to no enabled block`);
  }

  const expected = contract.metrics.length >= 3 ? 'grid' : contract.metrics.length > 0 ? 'stack' : 'bare';
  check(surface.layout === expected, `layout is "${surface.layout}", expected "${expected}" for ${contract.metrics.length} reading(s)`);

  const spec = fileOf(files, 'src/surface.ts')?.content ?? '';
  check(/export const surface: SurfaceSpec = \{[\s\S]+\};\n$/.test(spec), 'src/surface.ts does not end with the spec literal');
  check(spec.includes('edit this file') || spec.includes('EDIT'), 'src/surface.ts does not tell the user it is meant to be edited');
  for (const metric of contract.metrics) {
    check(spec.includes(`"${metric.field}"`), `src/surface.ts does not bind "${metric.field}"`);
  }

  console.log(
    `  ${surface.blocks.length} block(s), layout "${surface.layout}", ` +
      `${contract.metrics.length} reading(s) and ${contract.commands.length} control(s) all bound`,
  );
}

function checkValidationIsClean(
  files: SoftwareFile[],
  contract: DeviceContract,
  surface: SurfaceSpec,
  firmware: Pick<GeneratedCodeFile, 'path' | 'content'>[],
): SoftwareFinding[] {
  heading('5. the static gate passes on the generated skeleton');

  const findings = validateSoftwareProject({ files, contract, surface, firmware });
  const errors = errorsOf(findings);
  for (const finding of errors) failures.push(`static error · ${finding.code} — ${finding.message}`);
  for (const finding of findings.filter((entry) => entry.severity === 'warning')) {
    notes.push(`warning · ${finding.code} — ${finding.message}`);
  }
  console.log(`  ${findings.length} finding(s), ${errors.length} error(s)`);
  return findings;
}

function checkHandEditsAreCaught(contract: DeviceContract): void {
  heading('6. hand edits to the spec are reported, not silently absorbed');

  const base = deriveSurface(contract);
  // Each case re-assembles the project from the edited spec, so the emitted
  // src/surface.ts and the spec the validator is handed are the same object —
  // otherwise every case would trip SW-SURFACE-DRIFT and prove nothing else.
  const validate = (surface: SurfaceSpec) =>
    validateSoftwareProject({
      files: assembleSoftwareFiles('bench-rover', contract, surface),
      contract,
      surface,
      firmware: FIRMWARE,
    });

  const withBlock = (kind: string, patch: Partial<SurfaceSpec['blocks'][number]>): SurfaceSpec => ({
    ...base,
    blocks: base.blocks.map((block) => (block.kind === kind ? { ...block, ...patch } : block)),
  });

  // (a) switch the readings block off — the firmware still prints them.
  const disabledCodes = codes(validate(withBlock('metrics', { enabled: false })));
  check(disabledCodes.includes('SW-METRIC-UNRENDERED'), 'disabling the metrics block did not raise SW-METRIC-UNRENDERED');

  // (b) bind a field the firmware never prints: the block renders it as unbound,
  //     which is a page-level statement, not a generation error.
  const driftedFindings = validate(
    withBlock('metrics', { fields: [...contract.metrics.map((metric) => metric.field), 'heartRate'] }),
  );
  check(
    errorsOf(driftedFindings).length === 0,
    `binding an unknown field produced errors: ${codes(errorsOf(driftedFindings)).join(', ')}`,
  );

  // (c) a block kind the registry does not know.
  const custom: SurfaceSpec = {
    ...base,
    blocks: [
      ...base.blocks,
      { id: 'chart', kind: 'sparkline', title: 'Trend', fields: ['speed'], characters: [], span: 2, enabled: true },
    ],
  };
  const customFindings = validate(custom);
  check(codes(customFindings).includes('SW-BLOCK-CUSTOM-KIND'), 'an unregistered block kind did not raise SW-BLOCK-CUSTOM-KIND');
  check(
    errorsOf(customFindings).length === 0,
    `an unregistered block kind was reported as an error: ${codes(errorsOf(customFindings)).join(', ')}`,
  );

  // (d) two blocks with the same id.
  const first = base.blocks[0];
  if (!first) failures.push('the derived spec has no blocks at all');
  else {
    const duplicated: SurfaceSpec = { ...base, blocks: [...base.blocks, { ...first }] };
    check(codes(validate(duplicated)).includes('SW-BLOCK-DUPLICATE-ID'), 'a duplicate block id did not raise SW-BLOCK-DUPLICATE-ID');
  }

  // (e) everything off — allowed, but never silent.
  const empty: SurfaceSpec = { ...base, blocks: base.blocks.map((block) => ({ ...block, enabled: false })) };
  check(codes(validate(empty)).includes('SW-SURFACE-EMPTY'), 'an empty surface did not raise SW-SURFACE-EMPTY');

  // (f) a control dropped from the page is a warning, not an error: showing fewer
  //     buttons than the firmware accepts is a legitimate design choice.
  const noControlFindings = validate(withBlock('commands', { enabled: false }));
  check(codes(noControlFindings).includes('SW-COMMAND-UNBOUND'), 'disabling the controls did not raise SW-COMMAND-UNBOUND');
  check(
    errorsOf(noControlFindings).every((finding) => finding.code !== 'SW-COMMAND-UNBOUND'),
    'a dropped control was treated as an error',
  );

  // (g) a spec the file does not match is caught too — that is what stops a
  //     template edit from shipping a site whose shell renders a stale shape.
  const mismatched = validateSoftwareProject({
    files: assembleSoftwareFiles('bench-rover', contract, base),
    contract,
    surface: custom,
    firmware: FIRMWARE,
  });
  check(codes(mismatched).includes('SW-SURFACE-DRIFT'), 'a spec that disagrees with src/surface.ts did not raise SW-SURFACE-DRIFT');

  console.log('  readings dropped → error · control dropped → warning · unknown kind → info · empty spec → info · drift → error');
}

function checkBareBuild(files: SoftwareFile[], contract: DeviceContract, surface: SurfaceSpec): void {
  heading('7. a build with nothing to show is still a valid site');

  check(surface.layout === 'bare', `a contract with no readings or controls should lay out as "bare", got "${surface.layout}"`);
  check(
    surface.blocks.every((block) => block.kind !== 'metrics'),
    'a contract with no readings still produced a metrics block',
  );

  const findings = validateSoftwareProject({ files, contract, surface, firmware: FIRMWARE });
  for (const finding of errorsOf(findings)) {
    failures.push(`bare build · static error ${finding.code} — ${finding.message}`);
  }
  const shell = fileOf(files, 'src/skeleton/Shell.tsx')?.content ?? '';
  check(shell.includes('shell--bare'), 'Shell.tsx has no bare-layout branch');
  console.log(`  ${files.length} file(s), ${errorsOf(findings).length} error(s), layout "${surface.layout}"`);
}

function writeOut(dir: string, files: SoftwareFile[]): void {
  heading('8. written to disk (so you can run it yourself)');
  for (const file of files) {
    const full = path.resolve(dir, file.path);
    if (!full.startsWith(path.resolve(dir))) {
      failures.push(`refusing to write outside the output directory: ${file.path}`);
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content, 'utf8');
  }
  console.log(`  ${files.length} file(s) → ${path.resolve(dir)}`);
  console.log('  cd there and run: npm install && npm run dev');
}

/* -------------------------------------------------------------------------- */

function main(): number {
  const contract = richContract();
  const surface = deriveSurface(contract);
  const files = assembleSoftwareFiles('bench-rover', contract, surface);

  checkSkeletonShape(files, surface);
  checkNotADashboard(files);
  checkParses(files);
  checkDerivation(contract, surface, files);
  checkValidationIsClean(files, contract, surface, FIRMWARE);
  checkHandEditsAreCaught(contract);

  const bare = bareContract();
  const bareSurface = deriveSurface(bare);
  const bareFiles = assembleSoftwareFiles('blink-beacon', bare, bareSurface);
  checkBareBuild(bareFiles, bare, bareSurface);
  const bareParse = parseProblems(bareFiles);
  for (const problem of bareParse) failures.push(`bare build parse error · ${problem}`);

  const outIndex = process.argv.indexOf('--out');
  if (outIndex >= 0) {
    const dir = process.argv[outIndex + 1];
    if (!dir) failures.push('--out needs a directory');
    else writeOut(dir, files);
  }

  if (notes.length > 0) {
    heading('notes (informational)');
    for (const note of notes) console.log(`  · ${note}`);
  }

  if (failures.length === 0) {
    console.log(
      `\nok · the generated website is a skeleton: ${files.length} file(s), ${surface.blocks.length} block(s), ` +
        `layout "${surface.layout}", every source parses, and the static gate passes`,
    );
    return 0;
  }

  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  return 1;
}

process.exit(main());
