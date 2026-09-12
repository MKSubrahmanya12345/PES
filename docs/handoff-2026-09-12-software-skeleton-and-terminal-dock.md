# Handoff — the website half became a skeleton, and the site grew a terminal

_2026-09-12. Scope: the generated website ("software" half) and the terminal dock.
Nothing here changes the hardware pipeline, the graph, the firmware workbench or
the simulator link._

Two asks, both delivered:

1. **Stop hardcoding the website.** It was one dashboard template with a variable
   number of cards. It is now a skeleton: a spec, a registry, a shell.
2. **After the checks pass, the terminal opens itself**, the user picks a folder in
   the page, and the site runs `npm install` then `npm run dev` in it, streaming the
   output back.

---

## 1. The skeleton

### What changed

| Before | After |
| --- | --- |
| `templates.ts` → `appComponent()` emitted an `App.tsx` with `<h2>Readings</h2>`, a card grid, `<h2>Controls</h2>`, `<h2>Board output</h2>` and a caveats footer baked into the template | `templates-skeleton.ts` emits a **spec** plus the pieces that render it; `App.tsx` is identity + `<Shell board={board} />` and nothing else |
| The page's shape was fixed; only the card count varied | The page's shape is data: `src/surface.ts` lists blocks, order, bindings, layout |
| The validator checked "does `App.tsx` contain a literal for every telemetry field?" | The validator checks the **spec**: every reading bound to an enabled block, every control reachable, unknown kinds reported, duplicate ids caught |

### Generated project layout (25 files)

```
src/
├── App.tsx                 composition root — identity + <Shell/>
├── surface.ts              THE SPEC. Blocks, order, bindings, layout. Edit this.
├── contract.ts             the device contract (generated, do not hand-edit)
├── protocol.ts link.ts useBoard.ts     the foundation: parser, transports, state
├── app.css                 foundation styles + the skeleton's block chrome
└── skeleton/
    ├── Shell.tsx           walks the spec; grid | stack | tabs | bare
    ├── registry.tsx        kind → component, with a SlotBlock fallback
    ├── types.ts            BlockProps / BlockComponent
    ├── format.ts           one value formatter
    └── blocks/             MetricsBlock CommandsBlock LogBlock NotesBlock StatusBlock SlotBlock
```

### The rules the skeleton keeps

* **A block is a pure function of `(its spec entry, the board state, the contract)`.**
  It owns no layout — the shell decides where it sits.
* **Nothing invents data.** A `fields` entry the contract does not declare renders as an
  *unbound* card that says so. A `kind` the registry does not know renders as an empty
  *slot* that says so. Neither is a crash, neither is a silent gap.
* **The layout is a suggestion the spec carries**, not a decision the shell makes:
  `deriveSurface()` picks `grid` for ≥3 readings, `stack` for fewer, `bare` when the
  contract has nothing to show — and the user can overwrite any of it.
* **A dropped control is legitimate; a dropped reading is not.** `SW-COMMAND-UNBOUND` is a
  warning, `SW-METRIC-UNRENDERED` is an error. Rationale: the firmware prints that key
  whether or not the page shows it, and a reading that vanishes from the page is how a
  build starts lying by omission.
* **An empty page is allowed and reported** (`SW-SURFACE-EMPTY`, info). The skeleton is
  not obliged to be a dashboard.

### Files

* `src/modules/software-generator/skeleton.ts` — `SurfaceSpec`, `SurfaceBlock`,
  `deriveSurface()`, `enabledBlocks()`, `KNOWN_BLOCK_KINDS`, `isKnownKind()`.
* `src/modules/software-generator/templates-skeleton.ts` — the generated skeleton sources
  (spec module, shell, registry, blocks, `App.tsx`, skeleton CSS).
* `src/modules/software-generator/templates.ts` — now the *foundation* only (parser,
  transports, `useBoard` + the new `BoardApi` export, base CSS, README). The dashboard
  template is gone.
* `src/modules/software-generator/index.ts` — `assembleSoftwareFiles()` is exported on its
  own so the zip route and the terminal's write route materialise **the same bytes**;
  `SoftwareArtifact` now carries `surface`.
* `src/modules/software-generator/validate.ts` — new `checkSurface()`; the App.tsx literal
  scan is gone (the spec owns bindings now).

---

## 2. The terminal dock

### The flow

```
checks pass ──► dock opens itself ──► user picks a folder (server-side browser)
                                          │
              folder has no package.json ─┴─► POST /software/write  (same bytes as the zip)
                                          │
                                          ▼
                          POST /api/terminal/sessions
                                          │
                       npm install ──► npm run dev  (lockfile + scripts decide the words)
                                          │
                       SSE: snapshot · line · state · closed
                                          │
                       URL detected ──► dock links it, /simulation frames it
```

"All checks passed" is not a vibe — `ProjectHub` computes it: the run is finished, it is
not intake, firmware exists, and `project.validation.passed` (no blocking issues). Until
then the dock stays closed and its tab says why.

### Why the folder picker reads the server's filesystem

A browser cannot hand a server a path. `showDirectoryPicker()` returns a handle with a
*name* and no location, which is useless to a process that has to `cd` somewhere. So
`GET /api/terminal/browse` walks the machine that is actually running Wireup — the same
machine the dev server will run on — one level at a time, and every row reports the three
facts that make the choice informed: `package.json`? `node_modules`? what would `dev` do?

### Why the child is detached, and what stop does

`npm run dev` forks Vite. Killing only npm leaves a server holding port 5175 with nothing
attached to it — the worst possible outcome of a stop button. Children get their own
process group (`detached: true`) and `stop()` signals `-pid`, escalating to `SIGKILL` after
4 s (Windows: `taskkill /T /F`). `verify:terminal` proves it by re-binding the port after a
stop and asserting it is free.

### The guard

* `WIREUP_TERMINAL_ROOTS` (default: this repo + `$HOME`) — checked for the picker *and* the
  spawn, on the realpath, so neither `../` nor a symlink escapes.
* Commands must start with `npm|npx|pnpm|yarn|bun|node|corepack` and contain no shell
  metacharacters. `WIREUP_TERMINAL_FREEFORM=1` lifts that; it is off by default.
* `WIREUP_TERMINAL_ENABLED=0` makes every route answer 403 and the dock say so.
* A second start in the same folder **rejoins** the running session rather than putting a
  second `npm install` beside the first.

### Files

* `src/lib/terminal/{types,guard,sessions}.ts` — protocol types, the guard, the runner and
  registry (sessions live on `globalThis` so a dev recompile does not orphan processes;
  `exit`/`SIGTERM`/`SIGINT` stop everything).
* `src/app/api/terminal/browse/route.ts`, `src/app/api/terminal/sessions/route.ts`,
  `.../sessions/[id]/{route,stream/route,input/route}.ts`.
* `src/app/api/projects/[id]/software/write/route.ts` — materialise the generated site
  (empty folder → into it; otherwise `<picked>/<slug>`; never over a manifest unless asked).
* `src/components/workspace/{terminal-api,useTerminalSession,FolderPicker,TerminalDock}.tsx?`
  — client layer, state machine, picker, dock.
* `ProjectHub.tsx` mounts the dock once (so an install survives a tab switch) and exposes
  `checks` + `dockOpen` through `HubContext`; `SimulationPanel`'s Website half gets a
  **run it — terminal** button and a table of the skeleton spec.
* Dock/picker styles are appended to `src/app/globals.css` (`.dock*`, `.picker*`,
  `.sim__surface`, `.sim__table`).

---

## 3. Verification

```bash
npm run verify:skeleton                 # the generated site is a skeleton; every source parses
npm run verify:skeleton -- --out /tmp/gen-site
npm run verify:terminal                 # guard, ordering, failure handling, process-group kill
npm run verify:terminal -- --site /tmp/gen-site   # end to end: generate → install → serve → stop
```

Both ran clean at handoff. The end-to-end run installed the generated website with
`npm install`, started it with `npm run dev`, detected `http://localhost:5175/`, reached
`ready`, and freed the port on stop. Independently, in the written-out project:
`npx tsc --noEmit` → 0 errors under its own strict config (`noUnusedLocals`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), and
`npx vite build` → 43 modules, built.

`verify:skeleton` parses every generated `.ts`/`.tsx` with the real TypeScript compiler
front end rather than trusting the balance scanner in `validate.ts`, which is a heuristic.

---

## 4. What this deliberately does not do

* **The pipeline still installs nothing.** Generation stays pure and offline; execution is
  a separate, user-initiated, observable act in `src/lib/terminal`. The module docstring in
  `software-generator/index.ts` says exactly that, because the old rule ("nothing is
  installed, built or executed here") is still true of the generator and would be a lie if
  it were read as a claim about the product.
* **No pty.** Output is piped, not a pseudo-terminal: no cursor addressing, no interactive
  TUIs. Stdin is a POST for the rare prompt; that is enough for `npm install`/`vite` and it
  is honest about being less than a real terminal.
* **Sessions are in-memory.** A server restart loses them (the dock says so and offers to
  run again). Persisting a process across a restart is not a thing; persisting its log is
  possible and was not needed.
* **The dock does not tail the Velxio frontend.** It runs whatever folder you point it at —
  which can be `external/velxio/frontend` — but nothing assumes that.

## 5. Loose ends worth knowing about

* `WEBSITE_DEV_PORT` is an alias of the older `DASHBOARD_DEV_PORT`; both are 5175 and the
  old name still has callers in prose (findings text, README of generated projects).
* The dock auto-runs only when it already knows a folder (remembered in `localStorage`).
  First time through it opens itself and waits for the pick — a browser cannot do better.
* `HubValue.terminal` (pre-existing) means "the run reached a terminal status"; the dock's
  state is `dockOpen`. The names are close and the older one is load-bearing in several
  panels, so it was left alone.
