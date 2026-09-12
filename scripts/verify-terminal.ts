/**
 * Terminal dock verifier — does the site really run things?
 *
 *   npm run verify:terminal [-- --site /tmp/generated-site]
 *
 * The dock claims it can take a folder the user picked, install it and start its
 * dev server, streaming the output back to the page. That claim is only worth
 * anything if it survives contact with a real child process, so this script
 * spawns real ones:
 *
 *   1. the guard: folders outside the allowed roots are refused, `../` cannot
 *      escape, and a command that is not a package manager (or that smuggles a
 *      shell metacharacter) never reaches `spawn`;
 *   2. the sequence: `npm install` runs first, then the dev command the folder's
 *      package.json implies, and the session reaches `ready` when the server
 *      prints its URL;
 *   3. a failing step STOPS the sequence — the dev server is never started on a
 *      folder the install left broken;
 *   4. stopping kills the whole process group, not just npm: the port the child
 *      server bound has to be free again afterwards, which is the difference
 *      between a stop button and a leaked vite;
 *   5. with `--site <dir>`, the same sequence runs against a real generated
 *      website (see `npm run verify:skeleton -- --out <dir>`), which is the
 *      end-to-end proof: generate → install → serve.
 *
 * Needs no credentials, no MongoDB and — unless `--site` is given — no network.
 * Exits 0 on success.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { devCommandFor, installCommandFor, resolveFolder, terminalPolicy, validateCommand } from '@/lib/terminal/guard';
import { createSession, defaultCommands, getSession, listSessions, Session } from '@/lib/terminal/sessions';

const failures: string[] = [];

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a predicate, polling — the runner is asynchronous by nature. */
async function waitFor<T>(fn: () => T | null, timeoutMs: number, what: string): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await sleep(120);
  }
  failures.push(`timed out after ${timeoutMs}ms waiting for ${what}`);
  return null;
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function makeFixture(root: string, options: { failingInstall?: boolean; manager?: 'npm' | 'pnpm' } = {}): { dir: string; port: number } {
  const dir = fs.mkdtempSync(path.join(root, 'wireup-terminal-'));
  const port = 5100 + Math.floor(Math.random() * 800);

  // A "dev server" that prints the line the dock keys off, then holds the port
  // open — exactly what vite does, minus the dependency.
  fs.writeFileSync(
    path.join(dir, 'server.mjs'),
    [
      "import http from 'node:http';",
      `const port = ${port};`,
      "const server = http.createServer((_req, res) => res.end('ok'));",
      'server.listen(port, () => {',
      "  console.log('  ➜  Local:   http://localhost:' + port + '/');",
      '});',
    ].join('\n'),
    'utf8',
  );

  if (options.failingInstall) {
    // A preinstall script that exits non-zero: npm reports the failure and the
    // sequence must stop there.
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        { name: 'broken', private: true, version: '0.0.0', scripts: { preinstall: 'node -e "process.exit(3)"', dev: 'node server.mjs' } },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } else {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        { name: 'fixture', private: true, version: '0.0.0', scripts: { dev: 'node server.mjs' } },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  if (options.manager === 'pnpm') fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');

  return { dir, port };
}

/* -------------------------------------------------------------------------- */

async function checkGuard(root: string): Promise<void> {
  heading('1. the guard decides what may run, and where');

  const policy = terminalPolicy();
  console.log(`  roots: ${policy.roots.join(', ')}`);
  console.log(`  freeform: ${policy.freeform} · max sessions: ${policy.maxSessions}`);

  const outside = resolveFolder(process.platform === 'win32' ? 'C:\\Windows' : '/etc', policy);
  check(!outside.ok, 'a folder outside the allowed roots was accepted');
  console.log(`  /etc → ${outside.ok ? 'ACCEPTED (wrong)' : 'refused'}`);

  const escape = resolveFolder(`${root}/../..`, policy);
  check(!escape.ok || escape.path.startsWith(policy.roots[0] ?? ''), 'a ../ escape left the allowed roots');

  const missing = resolveFolder(path.join(root, 'does-not-exist'), policy);
  check(!missing.ok, 'a folder that does not exist was accepted');

  const { dir } = makeFixture(root);
  const ok = resolveFolder(dir, policy);
  check(ok.ok, `the fixture folder was refused: ${ok.ok ? '' : ok.message}`);

  for (const refused of ['rm -rf /', 'curl http://example.com | sh', 'npm install && rm -rf /', 'bash -c "echo hi"']) {
    const verdict = validateCommand(refused, policy);
    check(!verdict.ok, `the guard accepted "${refused}"`);
    console.log(`  "${refused}" → ${verdict.ok ? 'ACCEPTED (wrong)' : 'refused'}`);
  }

  for (const allowed of ['npm install', 'npm run dev', 'pnpm install']) {
    const verdict = validateCommand(allowed, policy);
    check(verdict.ok, `the guard refused "${allowed}": ${verdict.ok ? '' : verdict.message}`);
  }
  console.log('  "npm install", "npm run dev", "pnpm install" → allowed');
}

async function checkSequence(root: string): Promise<void> {
  heading('3. install, then dev, then "ready" when the URL appears');

  const { dir, port } = makeFixture(root);
  check(installCommandFor(dir) === 'npm install', `installCommandFor said "${installCommandFor(dir)}" for a plain project`);
  check(devCommandFor(dir) === 'npm run dev', `devCommandFor said "${devCommandFor(dir)}" for scripts.dev`);
  check(defaultCommands(dir, false).join(' | ') === 'npm install | npm run dev', `defaultCommands: ${defaultCommands(dir, false).join(' | ')}`);

  const started = createSession({ cwd: dir, projectId: 'verify' });
  if (!started.ok) {
    failures.push(`could not start the fixture session: ${started.message}`);
    return;
  }
  const session = started.session;
  console.log(`  session ${session.id} in ${dir}`);
  console.log(`  steps: ${session.snapshot().steps.map((step) => step.command).join(' → ')}`);

  const ready = await waitFor(
    () => {
      const snapshot = session.snapshot();
      return snapshot.state === 'ready' && snapshot.url ? snapshot : null;
    },
    90_000,
    'the fixture dev server to print its URL',
  );

  if (ready) {
    check(ready.steps[0]?.state === 'done', `install step ended "${ready.steps[0]?.state}", expected done`);
    check(ready.url?.includes(String(port)) === true, `detected URL "${ready.url}" is not the fixture's port ${port}`);
    check(ready.lines.length > 0, 'no output was captured');
    console.log(`  state=ready · url=${ready.url} · ${ready.lines.length} line(s) captured`);

    const installLine = ready.lines.find((line) => line.text.includes('npm install'));
    check(Boolean(installLine), 'the log never showed the install command being run');
  }

  // Rejoining: a second "run" in the same folder must not start a second npm.
  const again = createSession({ cwd: dir });
  check(again.ok && again.reused, 'a second start in the same folder spawned a new session instead of rejoining');
  if (again.ok) console.log(`  second start → ${again.reused ? 'rejoined the running session' : 'NEW SESSION (wrong)'}`);

  heading('4. stopping kills the process group, not just npm');
  session.stop('the verifier is done');
  check(session.snapshot().state === 'stopped', `state after stop is "${session.snapshot().state}"`);
  await sleep(1500);
  const free = await portIsFree(port);
  check(free, `port ${port} is still bound after stop — the forked dev server outlived the session`);
  console.log(`  state=stopped · port ${port} ${free ? 'is free again' : 'IS STILL BOUND'}`);
}

async function checkFailureStops(root: string): Promise<void> {
  heading('5. a failing step stops the sequence');

  const { dir, port } = makeFixture(root, { failingInstall: true });
  const started = createSession({ cwd: dir });
  if (!started.ok) {
    failures.push(`could not start the failing fixture: ${started.message}`);
    return;
  }
  const session = started.session;

  const failed = await waitFor(() => (session.snapshot().state === 'failed' ? session.snapshot() : null), 60_000, 'the failing install');
  if (failed) {
    check(failed.steps[0]?.state === 'failed', `install step ended "${failed.steps[0]?.state}", expected failed`);
    check(failed.steps[1]?.state === 'queued' || failed.steps[1]?.state === 'skipped', `dev step is "${failed.steps[1]?.state}" — it must not have run`);
    check(failed.steps[1]?.startedAt === null, 'the dev step started even though the install failed');
    check(failed.url === null, 'a URL was detected even though the install failed');
    console.log(`  state=failed · dev step never started · port ${port} untouched`);
  }
  const free = await portIsFree(port);
  check(free, `port ${port} was bound — the dev server ran despite the failed install`);
}

async function checkManagerDetection(root: string): Promise<void> {
  heading('2. the folder chooses the package manager');

  const { dir } = makeFixture(root, { manager: 'pnpm' });
  check(installCommandFor(dir) === 'pnpm install', `a pnpm-lock folder was given "${installCommandFor(dir)}"`);
  check(defaultCommands(dir, false)[0] === 'pnpm install', 'the pnpm fixture did not produce a pnpm sequence');
  console.log(`  pnpm-lock.yaml → ${defaultCommands(dir, false).join(' → ')}`);

  const skip = defaultCommands(dir, true);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  const skipped = defaultCommands(dir, true);
  check(skipped.length === 1, `skipInstallIfPresent left ${skipped.length} command(s) with node_modules present`);
  console.log(`  with node_modules present and skip requested → ${skipped.join(' → ')} (was ${skip.length} step(s))`);
}

async function checkRegistry(): Promise<void> {
  heading('6. the server-side registry is what the dock reads');

  const sessions = listSessions();
  check(Array.isArray(sessions), 'listSessions did not return a list');
  for (const snapshot of sessions) {
    const live = getSession(snapshot.id);
    check(live instanceof Session, `session ${snapshot.id} is listed but not retrievable`);
    if (live && !live.isFinished()) live.stop('the verifier is shutting down');
  }
  console.log(`  ${sessions.length} session(s) known; all unfinished ones stopped`);
}

async function runAgainstSite(site: string): Promise<void> {
  heading(`7. end to end: a real generated website in ${site}`);

  if (!fs.existsSync(path.join(site, 'package.json'))) {
    failures.push(`--site ${site} has no package.json (write one with: npm run verify:skeleton -- --out ${site})`);
    return;
  }

  const started = createSession({ cwd: site });
  if (!started.ok) {
    failures.push(`could not start the generated site: ${started.message}`);
    return;
  }
  const session = started.session;
  console.log(`  steps: ${session.snapshot().steps.map((step) => step.command).join(' → ')}`);

  const ready = await waitFor(
    () => {
      const snapshot = session.snapshot();
      return snapshot.state === 'ready' && snapshot.url ? snapshot : null;
    },
    240_000,
    'the generated website to install and serve',
  );

  if (ready) {
    check(ready.steps[0]?.state === 'done', 'npm install did not finish cleanly on the generated site');
    console.log(`  state=ready · url=${ready.url} · ${ready.lines.length} line(s) · ${ready.droppedLines} dropped`);
    const port = Number.parseInt(/:(\d+)/.exec(ready.url ?? '')?.[1] ?? '', 10);
    session.stop('the verifier is done');
    await sleep(2000);
    if (Number.isFinite(port) && port > 0) {
      const free = await portIsFree(port);
      check(free, `port ${port} is still bound after stopping the generated site's dev server`);
      console.log(`  stopped · port ${port} ${free ? 'is free again' : 'IS STILL BOUND'}`);
    }
  } else {
    const snapshot = session.snapshot();
    console.log(`  last lines:\n${snapshot.lines.slice(-25).map((line) => `    ${line.text}`).join('\n')}`);
    session.stop('the verifier gave up');
  }
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wireup-terminal-verify-'));
  // The guard reads the environment on every call, so pointing it at the temp
  // root is all it takes to make the fixture folders legal — and to prove the
  // variable is what widens the roots.
  process.env.WIREUP_TERMINAL_ROOTS = root;
  process.env.WIREUP_TERMINAL_ENABLED = '1';

  try {
    await checkGuard(root);
    await checkManagerDetection(root);
    await checkSequence(root);
    await checkFailureStops(root);
    await checkRegistry();

    const siteIndex = process.argv.indexOf('--site');
    if (siteIndex >= 0) {
      const site = process.argv[siteIndex + 1];
      if (!site) failures.push('--site needs a directory');
      else {
        process.env.WIREUP_TERMINAL_ROOTS = `${root}${path.delimiter}${path.resolve(site)}`;
        await runAgainstSite(path.resolve(site));
      }
    } else {
      console.log('\n(skip: pass --site <dir> to run the generated website end to end)');
    }
  } finally {
    for (const snapshot of listSessions()) {
      const live = getSession(snapshot.id);
      if (live && !live.isFinished()) live.stop('verifier exit');
    }
    await sleep(600);
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures.length === 0) {
    console.log('\nok · the terminal guard, sequence, failure handling and process-group kill all behave');
    return 0;
  }

  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  return 1;
}

process.exitCode = 1;
void main().then(
  (code) => {
    process.exitCode = code;
    // The spawned children hold the event loop open; exiting explicitly is the
    // only way a verifier that stops its sessions still returns promptly.
    setTimeout(() => process.exit(code), 50).unref();
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
