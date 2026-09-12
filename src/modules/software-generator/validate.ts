/**
 * Static validation of the generated dashboard.
 *
 * The build must not install, compile or execute anything, so "does it work?"
 * is answered by reading the generated text. That is a weaker guarantee than
 * `tsc && vite build`, and this module is deliberately honest about which
 * class of bug it catches: the ones that break a fresh `npm install && npm run
 * dev` before a single line of application logic runs.
 *
 *   1. every relative import resolves to a file the zip actually contains
 *   2. every file the tooling reaches for (index.html's entry, tsconfig's
 *      include, package.json's scripts) exists
 *   3. every JSON file parses
 *   4. braces/parens/backticks balance in each TS/TSX file — the signature of
 *      a template-literal generator that dropped a brace
 *   5. the contract module round-trips (the site imports it)
 *   6. the SKELETON SPEC covers the contract: every telemetry field is bound to
 *      a block that renders, every command character to one that sends it, and
 *      a block kind the registry does not know is reported rather than hidden
 *   7. the contract's fields are ones the FIRMWARE actually prints
 *
 * What it explicitly does NOT claim: type correctness, React hook rules, or
 * that `vite build` succeeds. `npm run typecheck` in the generated project is
 * the real gate, and the README says so.
 */

import type { GeneratedCodeFile } from '@/types/project';

import type { DeviceContract } from './contract';
import { commandCharacters, opensControlLink } from './firmware-signals';
import { isKnownKind, type SurfaceSpec } from './skeleton';

export interface SoftwareFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  file?: string;
  /** What the user should do about it. */
  suggestion?: string;
}

export interface ValidateInput {
  files: { path: string; content: string }[];
  contract: DeviceContract;
  /** The skeleton spec the site renders from — `src/surface.ts` in the zip. */
  surface: SurfaceSpec;
  firmware: Pick<GeneratedCodeFile, 'path' | 'content'>[];
}

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.css', '.json', '/index.ts', '/index.tsx'];

export function validateSoftwareProject(input: ValidateInput): SoftwareFinding[] {
  const findings: SoftwareFinding[] = [];
  const byPath = new Map(input.files.map((file) => [file.path, file.content]));
  const paths = new Set(byPath.keys());

  checkImports(input.files, paths, findings);
  checkEntryPoints(byPath, paths, findings);
  checkJson(input.files, findings);
  checkBalance(input.files, findings);
  checkContractDrift(byPath, input.contract, findings);
  checkSurface(input.files, input.surface, input.contract, findings);
  checkFirmwareAgreement(input.contract, input.firmware, findings);

  return findings;
}

/* -------------------------------------------------------------------------- */
/* 1. Imports resolve                                                         */
/* -------------------------------------------------------------------------- */

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)\s[^;'"]*from\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

/** Bare specifiers are dependencies; only relative ones must exist in the zip. */
function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function resolveRelative(fromPath: string, specifier: string): string {
  const segments = fromPath.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

function checkImports(
  files: { path: string; content: string }[],
  paths: Set<string>,
  findings: SoftwareFinding[],
): void {
  const declared = new Set(dependenciesOf(files));

  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file.path)) continue;
    const specifiers = new Set<string>();
    for (const pattern of [IMPORT_PATTERN, SIDE_EFFECT_IMPORT]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(file.content)) !== null) {
        if (match[1]) specifiers.add(match[1]);
      }
    }

    for (const specifier of specifiers) {
      if (isRelative(specifier)) {
        const base = resolveRelative(file.path, specifier);
        const resolved = SOURCE_EXTENSIONS.some((extension) => paths.has(`${base}${extension}`));
        if (!resolved) {
          findings.push({
            severity: 'error',
            code: 'SW-IMPORT-MISSING',
            message: `${file.path} imports "${specifier}", which resolves to "${base}" — no such file is in the generated project.`,
            file: file.path,
            suggestion: 'Regenerate the project; a template emitted an import for a file it did not write.',
          });
        }
        continue;
      }
      // A bare specifier must be a declared dependency (or a subpath of one,
      // e.g. `react-dom/client`), otherwise `npm install` will not fetch it.
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : (specifier.split('/')[0] as string);
      if (!declared.has(packageName)) {
        findings.push({
          severity: 'error',
          code: 'SW-DEP-MISSING',
          message: `${file.path} imports "${specifier}" but "${packageName}" is not in package.json — \`npm install\` would not fetch it.`,
          file: file.path,
          suggestion: `Add "${packageName}" to dependencies, or drop the import.`,
        });
      }
    }
  }
}

function dependenciesOf(files: { path: string; content: string }[]): string[] {
  const manifest = files.find((file) => file.path === 'package.json');
  if (!manifest) return [];
  try {
    const parsed = JSON.parse(manifest.content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      // Types packages provide the ambient modules for these.
      'react/jsx-runtime',
      'react',
    ];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Entry points exist                                                      */
/* -------------------------------------------------------------------------- */

function checkEntryPoints(
  byPath: Map<string, string>,
  paths: Set<string>,
  findings: SoftwareFinding[],
): void {
  for (const required of ['package.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'src/main.tsx']) {
    if (!paths.has(required)) {
      findings.push({
        severity: 'error',
        code: 'SW-FILE-MISSING',
        message: `The project has no ${required}, which Vite requires to start.`,
      });
    }
  }

  const html = byPath.get('index.html');
  if (html) {
    const script = /<script[^>]+src="\/([^"]+)"/.exec(html);
    if (!script) {
      findings.push({
        severity: 'error',
        code: 'SW-HTML-NO-ENTRY',
        message: 'index.html has no <script type="module" src="…"> — Vite would serve a blank page.',
        file: 'index.html',
      });
    } else if (!paths.has(script[1] as string)) {
      findings.push({
        severity: 'error',
        code: 'SW-HTML-ENTRY-MISSING',
        message: `index.html points at "/${script[1]}", which is not in the project.`,
        file: 'index.html',
      });
    }
    if (!/id="root"/.test(html)) {
      findings.push({
        severity: 'error',
        code: 'SW-HTML-NO-ROOT',
        message: 'index.html has no #root element, but src/main.tsx mounts into one.',
        file: 'index.html',
      });
    }
  }

  const manifest = byPath.get('package.json');
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest) as { scripts?: Record<string, string> };
      for (const required of ['dev', 'build', 'typecheck']) {
        if (!parsed.scripts?.[required]) {
          findings.push({
            severity: 'warning',
            code: 'SW-SCRIPT-MISSING',
            message: `package.json has no "${required}" script — the README tells the user to run it.`,
            file: 'package.json',
          });
        }
      }
    } catch {
      // checkJson reports the parse failure; nothing to add here.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 3. JSON parses                                                             */
/* -------------------------------------------------------------------------- */

function checkJson(files: { path: string; content: string }[], findings: SoftwareFinding[]): void {
  for (const file of files) {
    if (!file.path.endsWith('.json')) continue;
    try {
      JSON.parse(file.content);
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'SW-JSON-INVALID',
        message: `${file.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        file: file.path,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 4. Delimiters balance                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Count delimiters outside strings, template literals, regexes and comments.
 *
 * This is a scanner, not a parser: it exists to catch a generator that emitted
 * an unclosed brace, which is by far the most likely way a template-built file
 * becomes unparseable. It reports a warning rather than an error when it is
 * unsure, so a scanner limitation never blocks a download.
 */
function checkBalance(files: { path: string; content: string }[], findings: SoftwareFinding[]): void {
  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file.path)) continue;
    const counts = scanDelimiters(file.content);
    if (counts === null) {
      findings.push({
        severity: 'warning',
        code: 'SW-SCAN-INCOMPLETE',
        message: `${file.path} ends inside a string, template literal or comment — it is very likely truncated.`,
        file: file.path,
      });
      continue;
    }
    for (const [name, value] of Object.entries(counts)) {
      if (value !== 0) {
        findings.push({
          severity: 'error',
          code: 'SW-UNBALANCED',
          message: `${file.path} has ${Math.abs(value)} unclosed ${value > 0 ? 'opening' : 'closing'} ${name}.`,
          file: file.path,
          suggestion: 'Regenerate the project; a template produced malformed source.',
        });
      }
    }
  }
}

function scanDelimiters(source: string): { brace: number; paren: number; bracket: number } | null {
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let index = 0;
  // Template literals nest (`${ `inner` }`), so depth is a stack of counts.
  const templateStack: number[] = [];

  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    // Comments
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      if (end < 0) return { brace, paren, bracket }; // trailing line comment is fine
      index = end + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }

    // Quoted strings.
    //
    // JSX text makes naive quote tracking unsound: `the board's link` is prose,
    // not the start of a string literal. The distinguishing rule is what comes
    // BEFORE the quote — a real string opener always follows punctuation or
    // whitespace (`= '…'`, `('…')`, `['…']`, `, '…'`), while an apostrophe in
    // prose follows a word character. Treating the latter as text is what lets
    // this scanner run over generated .tsx at all.
    if (char === '"' || char === "'") {
      if (char === "'" && /[A-Za-z0-9]/.test(source[index - 1] ?? '')) {
        index += 1; // a contraction inside JSX text
        continue;
      }
      const end = skipQuoted(source, index, char);
      if (end < 0) {
        // An unterminated quote in a .tsx file is far more likely to be prose
        // the rule above did not catch (an opening curly-style apostrophe, a
        // quoted phrase in a sentence) than a truncated file. Skip it rather
        // than condemning a file that is probably fine.
        index += 1;
        continue;
      }
      index = end;
      continue;
    }

    // Template literals
    if (char === '`') {
      templateStack.push(brace);
      const end = skipTemplate(source, index);
      if (end < 0) return null;
      templateStack.pop();
      index = end;
      continue;
    }

    if (char === '{') brace += 1;
    else if (char === '}') brace -= 1;
    else if (char === '(') paren += 1;
    else if (char === ')') paren -= 1;
    else if (char === '[') bracket += 1;
    else if (char === ']') bracket -= 1;

    index += 1;
  }

  return { brace, paren, bracket };
}

/** Index just past the closing quote, or -1 when unterminated. */
function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === '\n') return -1; // a normal string cannot span lines
    index += 1;
  }
  return -1;
}

/** Index just past the closing backtick, handling nested `${ … }`. */
function skipTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '`') return index + 1;
    if (char === '$' && source[index + 1] === '{') {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        const inner = source[index];
        if (inner === '\\') {
          index += 2;
          continue;
        }
        if (inner === '`') {
          const end = skipTemplate(source, index);
          if (end < 0) return -1;
          index = end;
          continue;
        }
        if (inner === '"' || inner === "'") {
          const end = skipQuoted(source, index, inner);
          if (end < 0) return -1;
          index = end;
          continue;
        }
        if (inner === '{') depth += 1;
        else if (inner === '}') depth -= 1;
        index += 1;
      }
      if (depth > 0) return -1;
      continue;
    }
    index += 1;
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* 5. The contract module round-trips                                         */
/* -------------------------------------------------------------------------- */

function checkContractDrift(
  byPath: Map<string, string>,
  contract: DeviceContract,
  findings: SoftwareFinding[],
): void {
  const app = byPath.get('src/App.tsx');
  const contractFile = byPath.get('src/contract.ts');
  if (!app || !contractFile) return;

  // The contract module must round-trip: it is what the app imports.
  const embedded = /export const contract: DeviceContract = ([\s\S]+);\n$/.exec(contractFile);
  if (!embedded) {
    findings.push({
      severity: 'error',
      code: 'SW-CONTRACT-UNREADABLE',
      message: 'src/contract.ts does not end with the expected `export const contract` assignment.',
      file: 'src/contract.ts',
    });
    return;
  }
  try {
    const parsed = JSON.parse(embedded[1] as string) as DeviceContract;
    if (parsed.metrics.length !== contract.metrics.length) {
      findings.push({
        severity: 'error',
        code: 'SW-CONTRACT-DRIFT',
        message: 'src/contract.ts does not carry the same metric list the dashboard was generated from.',
        file: 'src/contract.ts',
      });
    }
  } catch (error) {
    findings.push({
      severity: 'error',
      code: 'SW-CONTRACT-INVALID',
      message: `The contract embedded in src/contract.ts is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      file: 'src/contract.ts',
    });
  }

  // "Is this reading rendered?" is answered by checkSurface below: the site is a
  // skeleton, so the binding lives in the spec (src/surface.ts), not in a
  // section hardcoded into src/App.tsx. What App.tsx owes is the hand-off.
  if (!/<Shell\s+board=\{board\}\s*\/>/.test(app)) {
    findings.push({
      severity: 'error',
      code: 'SW-APP-NO-SHELL',
      message:
        'src/App.tsx does not hand the board to <Shell/>, so the skeleton spec in src/surface.ts would not be rendered at all.',
      file: 'src/App.tsx',
      suggestion: 'Keep App.tsx a composition root: own the link, render <Shell board={board} />.',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 6. The skeleton spec covers the contract                                   */
/* -------------------------------------------------------------------------- */

const SURFACE_PATH = 'src/surface.ts';

/**
 * The spec is the site's shape, so it is checked the way the contract is:
 *
 *   • it round-trips — `src/surface.ts` really ends with the literal the shell
 *     imports, and that literal is valid JSON;
 *   • every telemetry field is bound to an ENABLED block, otherwise the firmware
 *     prints a reading nothing on the page shows (an error, not a style choice —
 *     that is exactly how a card silently disappears);
 *   • every command character is reachable from an enabled block (a warning:
 *     dropping a control is a legitimate edit, but it should be a chosen one);
 *   • a block kind the registry does not know is reported as info — it renders
 *     as an honest empty slot, so it is a loose end, not a break;
 *   • two blocks sharing an id would collide as React keys.
 *
 * What it does NOT do is insist on a dashboard: an empty spec, a `bare` layout
 * and a page holding nothing but the board's raw output are all valid skeletons.
 */
function checkSurface(
  files: { path: string; content: string }[],
  surface: SurfaceSpec,
  contract: DeviceContract,
  findings: SoftwareFinding[],
): void {
  const source = files.find((file) => file.path === SURFACE_PATH)?.content;
  if (!source) {
    findings.push({
      severity: 'error',
      code: 'SW-SURFACE-MISSING',
      message: `The project has no ${SURFACE_PATH}, but src/skeleton/Shell.tsx renders from it.`,
      suggestion: 'Regenerate the project; the skeleton templates did not emit the spec.',
    });
    return;
  }

  const embedded = /export const surface: SurfaceSpec = ([\s\S]+);\n$/.exec(source);
  if (!embedded) {
    findings.push({
      severity: 'error',
      code: 'SW-SURFACE-UNREADABLE',
      message: `${SURFACE_PATH} does not end with the expected \`export const surface\` assignment.`,
      file: SURFACE_PATH,
    });
    return;
  }

  try {
    const parsed = JSON.parse(embedded[1] as string) as SurfaceSpec;
    if (parsed.blocks.length !== surface.blocks.length) {
      findings.push({
        severity: 'error',
        code: 'SW-SURFACE-DRIFT',
        message: `${SURFACE_PATH} does not carry the same block list the site was generated from.`,
        file: SURFACE_PATH,
      });
    }
  } catch (error) {
    findings.push({
      severity: 'error',
      code: 'SW-SURFACE-INVALID',
      message: `The spec embedded in ${SURFACE_PATH} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      file: SURFACE_PATH,
    });
    return;
  }

  const enabled = surface.blocks.filter((block) => block.enabled);
  const boundFields = new Set(enabled.flatMap((block) => block.fields));
  // A metrics block with no `fields` means "everything in the contract".
  const bindsEverything = enabled.some((block) => block.kind === 'metrics' && block.fields.length === 0);

  for (const metric of contract.metrics) {
    if (bindsEverything || boundFields.has(metric.field)) continue;
    findings.push({
      severity: 'error',
      code: 'SW-METRIC-UNRENDERED',
      message: `The firmware prints "${metric.field}" but no enabled block in ${SURFACE_PATH} binds it, so nothing on the page shows that reading.`,
      file: SURFACE_PATH,
      suggestion: `Add "${metric.field}" to a metrics block's \`fields\`, or enable the block that already has it.`,
    });
  }

  const boundCharacters = new Set(enabled.flatMap((block) => block.characters));
  const sendsEverything = enabled.some((block) => block.kind === 'commands' && block.characters.length === 0);
  for (const command of contract.commands) {
    if (sendsEverything || boundCharacters.has(command.character)) continue;
    findings.push({
      severity: 'warning',
      code: 'SW-COMMAND-UNBOUND',
      message: `The firmware accepts "${command.character}" (${command.label}) but no enabled block sends it, so that control is not on the page.`,
      file: SURFACE_PATH,
      suggestion: 'Correct if you meant to drop it; otherwise bind the character to a commands block.',
    });
  }

  const seen = new Set<string>();
  for (const block of surface.blocks) {
    if (seen.has(block.id)) {
      findings.push({
        severity: 'error',
        code: 'SW-BLOCK-DUPLICATE-ID',
        message: `Two blocks in ${SURFACE_PATH} share the id "${block.id}", so the shell would render one React key twice.`,
        file: SURFACE_PATH,
      });
    }
    seen.add(block.id);

    if (!isKnownKind(block.kind)) {
      findings.push({
        severity: 'info',
        code: 'SW-BLOCK-CUSTOM-KIND',
        message: `Block "${block.id}" uses kind "${block.kind}", which the generated registry does not know — it renders as an empty slot until a component is registered for it.`,
        file: 'src/skeleton/registry.tsx',
        suggestion: 'Add it to blockRegistry, or point the block at a kind that already exists.',
      });
    }
  }

  if (enabled.length === 0) {
    findings.push({
      severity: 'info',
      code: 'SW-SURFACE-EMPTY',
      message: `Every block in ${SURFACE_PATH} is disabled, so the site renders an empty shell. That is allowed; it is reported so it is not a surprise.`,
      file: SURFACE_PATH,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 7. The contract matches the firmware that was actually generated           */
/* -------------------------------------------------------------------------- */

function checkFirmwareAgreement(
  contract: DeviceContract,
  firmware: Pick<GeneratedCodeFile, 'path' | 'content'>[],
  findings: SoftwareFinding[],
): void {
  const source = firmware.map((file) => file.content).join('\n');
  if (source.trim().length === 0) {
    findings.push({
      severity: 'warning',
      code: 'SW-NO-FIRMWARE',
      message:
        'There is no firmware to cross-check the dashboard against, so the telemetry fields could not be verified.',
    });
    return;
  }

  // The sketch prints each field as a literal `"<field>":` inside sendTelemetry.
  for (const metric of contract.metrics) {
    if (!source.includes(`\\"${metric.field}\\"`) && !source.includes(`"${metric.field}"`)) {
      findings.push({
        severity: 'warning',
        code: 'SW-FIELD-NOT-PRINTED',
        message: `The dashboard shows "${metric.field}", but the generated firmware never prints that key — its card will stay empty.`,
        suggestion: 'This is a firmware/contract mismatch; re-run the build so both halves agree.',
      });
    }
  }

  /*
   * Every command must be accepted by the firmware's parser. Both idioms count:
   * `case 'x':` labels and `if (command == 'x')` chains — checking only the
   * former flagged every command in every generated sketch as unhandled.
   */
  const handled = commandCharacters(firmware) ?? [];
  for (const command of contract.commands.filter((entry) => !entry.builtIn)) {
    if (!handled.includes(command.character)) {
      findings.push({
        severity: 'warning',
        code: 'SW-COMMAND-UNHANDLED',
        message: `The dashboard offers "${command.character}" (${command.label}), but the firmware's command parser has no case for it — the board would answer "err:unknown command".`,
      });
    }
  }

  if (!opensControlLink(firmware)) {
    findings.push({
      severity: 'warning',
      code: 'SW-NO-LINK',
      message: 'The firmware never opens its control link, so the dashboard will receive nothing.',
    });
  }
}
