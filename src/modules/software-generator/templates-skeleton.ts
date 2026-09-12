/**
 * Source templates for the generated website's SKELETON.
 *
 * These are the files that make the generated site a structure the user can
 * reshape rather than a dashboard they have to accept:
 *
 *   src/surface.ts                  the spec — blocks, order, bindings, layout
 *   src/skeleton/types.ts           the block contract (props every block gets)
 *   src/skeleton/format.ts          one value formatter, shared
 *   src/skeleton/blocks/*.tsx       one small component per block kind
 *   src/skeleton/registry.tsx       kind → component, with a slot fallback
 *   src/skeleton/Shell.tsx          walks the spec, lays the blocks out
 *   src/App.tsx                     composition root: identity + <Shell/>
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * No template here may hardcode a section of the site. What appears, in what
 * order, bound to what, is read from `surface` at runtime. The only things the
 * templates fix are the mechanics: how a block is resolved, how a value is
 * formatted, how an unknown kind degrades. Everything else is data the user
 * edits in one file.
 *
 * A block that binds a field the contract does not declare still renders — it
 * says so on the card instead of showing a plausible number. Same for a kind
 * the registry does not know: an empty slot, not a crash.
 */

import type { DeviceContract } from './contract';
import type { SurfaceSpec } from './skeleton';
import { KNOWN_BLOCK_KINDS } from './skeleton';

/* -------------------------------------------------------------------------- */
/* The spec, as data the app imports                                          */
/* -------------------------------------------------------------------------- */

export function surfaceModule(spec: SurfaceSpec): string {
  return `/**
 * THE SKELETON SPEC — edit this file.
 *
 * This is the shape of the site: which blocks exist, in what order, what each
 * one is bound to, and how they are laid out. It is data, not JSX, and nothing
 * in the app assumes it describes a dashboard.
 *
 *   layout   'grid' | 'stack' | 'tabs' | 'bare'
 *   blocks   each has an id, a kind, a title, the telemetry \`fields\` it reads,
 *            the command \`characters\` it sends, a grid \`span\`, and \`enabled\`
 *
 * Things you can do here without touching a component:
 *   • reorder or delete blocks
 *   • flip \`enabled\` (the block stays in the file, it just does not render)
 *   • drop fields from \`fields\` to show fewer readings — or name one the
 *     contract does not have; the card will say so rather than fake a value
 *   • switch the layout to 'tabs'
 *   • add a block with your own \`kind\` and register it in
 *     src/skeleton/registry.tsx — an unregistered kind renders as an empty slot
 *
 * What this file must NOT do: claim a telemetry field the firmware does not
 * print, or a command character it does not accept. Regenerating the project
 * re-derives the spec from the device contract and will say so if you drift.
 */

export type SurfaceLayout = 'grid' | 'stack' | 'tabs' | 'bare';

export interface SurfaceBlock {
  id: string;
  /** Registry key. Known kinds: ${KNOWN_BLOCK_KINDS.join(', ')}. */
  kind: string;
  title: string;
  /** Telemetry fields this block reads. Empty = every field in the contract. */
  fields: string[];
  /** Command characters this block sends. Empty = every command. */
  characters: string[];
  /** Grid columns to span (layout: 'grid'). */
  span: number;
  enabled: boolean;
  note?: string;
}

export interface SurfaceSpec {
  version: 1;
  projectName: string;
  layout: SurfaceLayout;
  blocks: SurfaceBlock[];
}

/** Blocks that render, in order. The shell never reads \`blocks\` directly. */
export function enabledBlocks(spec: SurfaceSpec): SurfaceBlock[] {
  return spec.blocks.filter((block) => block.enabled);
}

export const surface: SurfaceSpec = ${JSON.stringify(spec, null, 2)};
`;
}

/* -------------------------------------------------------------------------- */
/* Block contract                                                             */
/* -------------------------------------------------------------------------- */

export function skeletonTypesModule(): string {
  return `/**
 * The contract every block satisfies.
 *
 * A block is a pure function of (its spec entry, the board state, the device
 * contract). It owns no layout — the shell decides where it sits — and it never
 * invents data: if the spec binds something the contract does not declare, the
 * block says so.
 */
import type { ReactNode } from 'react';

import type { DeviceContract } from '../contract';
import type { SurfaceBlock } from '../surface';
import type { BoardApi } from '../useBoard';

export interface BlockProps {
  /** This block's entry in src/surface.ts. */
  block: SurfaceBlock;
  /** The live board link, telemetry and log. */
  board: BoardApi;
  /** The generated device contract — the only source of truth about fields. */
  contract: DeviceContract;
}

export type BlockComponent = (props: BlockProps) => ReactNode;
`;
}

export function skeletonFormatModule(): string {
  return `/**
 * One formatter for every block, so a reading looks the same wherever the spec
 * puts it. \`undefined\` renders as an em dash: a value the board has not sent is
 * never dressed up as a zero.
 */
export function formatValue(value: number | string | undefined, precision: number | undefined): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return '—';
  return precision === undefined ? String(value) : value.toFixed(precision);
}
`;
}

/* -------------------------------------------------------------------------- */
/* Blocks — one per kind, each driven entirely by its spec entry              */
/* -------------------------------------------------------------------------- */

export function skeletonBlockModules(): { path: string; content: string }[] {
  return [
    { path: 'src/skeleton/blocks/MetricsBlock.tsx', content: metricsBlockModule() },
    { path: 'src/skeleton/blocks/CommandsBlock.tsx', content: commandsBlockModule() },
    { path: 'src/skeleton/blocks/LogBlock.tsx', content: logBlockModule() },
    { path: 'src/skeleton/blocks/NotesBlock.tsx', content: notesBlockModule() },
    { path: 'src/skeleton/blocks/StatusBlock.tsx', content: statusBlockModule() },
    { path: 'src/skeleton/blocks/SlotBlock.tsx', content: slotBlockModule() },
  ];
}

function metricsBlockModule(): string {
  return `/**
 * metrics — one card per telemetry field the spec binds.
 *
 * \`block.fields\` decides what is shown, in the order it lists them. An empty
 * list means "every field in the contract". A field the contract does not
 * declare renders as an unbound card rather than disappearing, so a hand edit
 * that drifts from the firmware is visible on the page instead of silent.
 */
import type { BlockProps } from '../types';
import { formatValue } from '../format';

export function MetricsBlock({ block, board, contract }: BlockProps) {
  const fields = block.fields.length > 0 ? block.fields : contract.metrics.map((metric) => metric.field);

  if (fields.length === 0) {
    return <p className="empty">No telemetry fields are bound to this block.</p>;
  }

  return (
    <div className="grid">
      {fields.map((field) => {
        const metric = contract.metrics.find((entry) => entry.field === field);
        if (!metric) {
          return (
            <article className="card card--unbound" key={field}>
              <h3>{field}</h3>
              <p className="empty">
                The contract declares no field named <code>{field}</code>, so there is nothing to read. Remove it from
                this block in <code>src/surface.ts</code>, or regenerate the project.
              </p>
            </article>
          );
        }

        const value = board.telemetry[metric.field];
        const hasRange = metric.min !== undefined && metric.max !== undefined;

        return (
          <article className="card" key={metric.field}>
            <h3>{metric.label}</h3>
            <p className="card__value">
              {formatValue(value, metric.precision)}
              {metric.unit ? <span className="card__unit">{metric.unit}</span> : null}
            </p>
            {hasRange ? (
              <span className="card__range">
                {metric.min}–{metric.max}
                {metric.unit ? \` \${metric.unit}\` : ''}
              </span>
            ) : null}
            <p className="card__src">{metric.source}</p>
          </article>
        );
      })}
    </div>
  );
}
`;
}

function commandsBlockModule(): string {
  return `/**
 * commands — one button per command character the spec binds.
 *
 * Each button writes exactly one character to the board's link: the same byte
 * you would type into a serial monitor. Buttons are disabled until a link is
 * open, and a firmware with no command set renders an explanation instead of
 * invented controls.
 */
import type { BlockProps } from '../types';

export function CommandsBlock({ block, board, contract }: BlockProps) {
  const commands =
    block.characters.length > 0
      ? contract.commands.filter((command) => block.characters.includes(command.character))
      : contract.commands;
  const connected = board.state.status === 'connected';

  if (commands.length === 0) {
    return (
      <p className="empty">
        {contract.commands.length === 0
          ? "This project's firmware defines no command set, so there is nothing to send. Read-only by design, not by omission."
          : 'No command in the contract matches the characters this block binds.'}
      </p>
    );
  }

  return (
    <>
      <div className="commands">
        {commands.map((command) => (
          <button
            key={command.character}
            type="button"
            disabled={!connected}
            title={command.meaning}
            onClick={() => void board.send(command.character)}
          >
            <span className="commands__char">{command.character}</span>
            <span>{command.label}</span>
          </button>
        ))}
      </div>
      {!connected ? <p className="empty">Open the link to enable the controls.</p> : null}
    </>
  );
}
`;
}

function logBlockModule(): string {
  return `/**
 * log — the board's own lines, in the order they arrived.
 *
 * Nothing is parsed away or prettified: this is what the firmware printed,
 * colour-coded by the kind the protocol parser recognised.
 */
import type { BlockProps } from '../types';

export function LogBlock({ board }: BlockProps) {
  return (
    <>
      <button type="button" className="ghost" onClick={board.clearLog}>
        clear
      </button>
      <div className="log">
        {board.log.length === 0 ? (
          <p className="empty">Nothing received yet.</p>
        ) : (
          board.log.map((entry) => (
            <div key={entry.id} className={\`log__line log__line--\${entry.line.kind}\`}>
              <span className="log__at">{entry.at}</span>
              <span className="log__text">{entry.line.raw}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
`;
}

function notesBlockModule(): string {
  return `/**
 * notes — the contract's caveats, plus whatever the spec's \`note\` says.
 *
 * This block exists so the limits of the build stay on the page instead of
 * living only in the README.
 */
import type { BlockProps } from '../types';

export function NotesBlock({ contract }: BlockProps) {
  return (
    <ul className="notes">
      {contract.caveats.map((caveat) => (
        <li key={caveat}>{caveat}</li>
      ))}
      {contract.caveats.length === 0 ? <li className="empty">The contract lists no caveats.</li> : null}
    </ul>
  );
}
`;
}

function statusBlockModule(): string {
  return `/**
 * status — the link, and the controls that open or close it.
 *
 * In embedded mode (inside Wireup's simulation page) there is no button: the
 * host owns the transport and the block reports what it is relaying.
 */
import type { BlockProps } from '../types';

export function StatusBlock({ board, contract }: BlockProps) {
  const connected = board.state.status === 'connected';

  const label =
    board.state.status === 'connected'
      ? board.state.detail
      : board.state.status === 'error'
        ? board.state.message
        : board.state.status === 'connecting'
          ? 'connecting…'
          : 'not connected';

  return (
    <>
      <div className="link">
        <span className={\`dot dot--\${board.state.status}\`} aria-hidden />
        <span className="link__label">{label}</span>
        {!board.embedded ? (
          <button type="button" onClick={() => (connected ? void board.disconnect() : void board.connect())}>
            {connected ? 'Disconnect' : 'Connect to the board'}
          </button>
        ) : null}
      </div>

      <p className="sub">
        {contract.controller} · {contract.transport} · {contract.baud} baud · one frame every{' '}
        {Math.round(contract.telemetryIntervalMs / 1000)} s
      </p>

      {!board.embedded && !board.canUseWebSerial ? (
        <p className="notice">
          This browser has no Web Serial API, so the site cannot open the board's USB port. Use Chrome or Edge, or open
          it inside Wireup's simulation page to drive the emulated board instead.
        </p>
      ) : null}

      {board.stale && connected ? (
        <p className="notice">
          No telemetry frame for over {Math.round((contract.telemetryIntervalMs * 3) / 1000)} s — the board may have
          stopped, reset, or lost its link. The values on this page are the last ones it sent.
        </p>
      ) : null}
    </>
  );
}
`;
}

function slotBlockModule(): string {
  return `/**
 * slot — the extension point.
 *
 * Rendered for a block whose kind the registry does not know, and for the
 * shipped \`custom\` block. It is deliberately loud about being empty: a page
 * that quietly dropped a block would look like a working site with a missing
 * section.
 */
import type { BlockProps } from '../types';

export function SlotBlock({ block }: BlockProps) {
  return (
    <div className="slot">
      <p>
        Nothing renders for kind <code>{block.kind}</code> yet.
      </p>
      <p className="sub">
        Write a component that takes <code>BlockProps</code> and register it in <code>src/skeleton/registry.tsx</code>,
        or point this block at a kind that already exists.
      </p>
      {block.fields.length > 0 ? (
        <p className="sub">
          Bound fields: {block.fields.map((field) => <code key={field}>{field}</code>)}
        </p>
      ) : null}
    </div>
  );
}
`;
}

/* -------------------------------------------------------------------------- */
/* Registry + shell                                                           */
/* -------------------------------------------------------------------------- */

export function registryModule(): string {
  return `/**
 * kind → component.
 *
 * The only file that knows which blocks exist. Add a renderer here and the spec
 * in src/surface.ts can name it; nothing else changes. A kind that is not here
 * resolves to the slot block, so a spec ahead of the registry renders an honest
 * placeholder instead of throwing.
 */
import type { BlockComponent } from './types';

import { CommandsBlock } from './blocks/CommandsBlock';
import { LogBlock } from './blocks/LogBlock';
import { MetricsBlock } from './blocks/MetricsBlock';
import { NotesBlock } from './blocks/NotesBlock';
import { SlotBlock } from './blocks/SlotBlock';
import { StatusBlock } from './blocks/StatusBlock';

export const blockRegistry: Record<string, BlockComponent> = {
  metrics: MetricsBlock,
  commands: CommandsBlock,
  log: LogBlock,
  notes: NotesBlock,
  status: StatusBlock,
  slot: SlotBlock,
};

export function resolveBlock(kind: string): BlockComponent {
  return blockRegistry[kind] ?? SlotBlock;
}

export function isRegistered(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(blockRegistry, kind);
}
`;
}

export function shellModule(): string {
  return `/**
 * The shell — walks the spec and lays the blocks out.
 *
 * It reads \`surface\` and nothing else, so the site's shape is whatever the
 * spec says: 'grid', 'stack', 'tabs' or 'bare'. Blocks are resolved through the
 * registry, keyed by their spec id, and given the same three props every block
 * takes. There is no section in here that a spec edit cannot remove.
 */
import { useState } from 'react';

import { contract } from '../contract';
import { enabledBlocks, surface, type SurfaceBlock } from '../surface';
import type { BoardApi } from '../useBoard';
import { resolveBlock } from './registry';

export function Shell({ board }: { board: BoardApi }) {
  const blocks = enabledBlocks(surface);

  if (blocks.length === 0 || surface.layout === 'bare') {
    return (
      <main className="shell shell--bare">
        <p className="empty">
          This spec renders no blocks{surface.layout === 'bare' ? ' (layout: bare)' : ''}. Edit{' '}
          <code>src/surface.ts</code> to put something on the page.
        </p>
      </main>
    );
  }

  if (surface.layout === 'tabs') {
    return <Tabbed blocks={blocks} board={board} />;
  }

  return (
    <main className={\`shell shell--\${surface.layout}\`}>
      {blocks.map((block) => (
        <Surface key={block.id} block={block} board={board} />
      ))}
    </main>
  );
}

function Surface({ block, board }: { block: SurfaceBlock; board: BoardApi }) {
  const Block = resolveBlock(block.kind);
  const wide = block.span > 1 ? \` block--span-\${Math.min(block.span, 3)}\` : '';

  return (
    <section className={\`block block--\${block.kind}\${wide}\`} data-block-id={block.id}>
      <h2 className="block__title">{block.title}</h2>
      {block.note ? <p className="block__note">{block.note}</p> : null}
      <Block block={block} board={board} contract={contract} />
    </section>
  );
}

function Tabbed({ blocks, board }: { blocks: SurfaceBlock[]; board: BoardApi }) {
  const [active, setActive] = useState<string>(blocks[0]?.id ?? '');
  const current = blocks.find((block) => block.id === active) ?? blocks[0];
  if (!current) return null;

  return (
    <main className="shell shell--tabs">
      <div className="tabs" role="tablist">
        {blocks.map((block) => (
          <button
            key={block.id}
            type="button"
            role="tab"
            aria-selected={block.id === current.id}
            className={block.id === current.id ? 'tabs__tab tabs__tab--on' : 'tabs__tab'}
            onClick={() => setActive(block.id)}
          >
            {block.title}
          </button>
        ))}
      </div>
      <Surface block={current} board={board} />
    </main>
  );
}
`;
}

/* -------------------------------------------------------------------------- */
/* Composition root                                                           */
/* -------------------------------------------------------------------------- */

export function appComponent(contract: DeviceContract): string {
  return `/**
 * ${contract.projectName} — composition root.
 *
 * Two jobs, and neither is "the dashboard":
 *   1. own the board link (one hook, one place) and the page identity;
 *   2. hand it to <Shell/>, which renders whatever src/surface.ts describes.
 *
 * Change the site by editing the spec, not this file.
 */
import { contract } from './contract';
import { Shell } from './skeleton/Shell';
import { useBoard } from './useBoard';
import './app.css';

export default function App() {
  const board = useBoard();

  return (
    <div className="app">
      <header className="bar">
        <div>
          <h1>{contract.projectName}</h1>
          <p className="sub">
            {contract.controller} · {contract.transport}
          </p>
        </div>
        <span className="bar__tag">skeleton — edit src/surface.ts</span>
      </header>

      <Shell board={board} />
    </div>
  );
}
`;
}

/* -------------------------------------------------------------------------- */
/* Styles for the skeleton                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Appended to the generated stylesheet. The block chrome is deliberately
 * boring: the spec decides the structure, so the CSS must not smuggle a layout
 * opinion back in beyond the four the spec can name.
 */
export function skeletonCss(): string {
  return `
/* --- the skeleton: shell, blocks, slots ---------------------------------- */

.shell {
  padding: 0 0 8px;
  display: flex;
  gap: 16px;
}

.shell--grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
}

.shell--stack {
  flex-direction: column;
}

.shell--tabs {
  flex-direction: column;
}

.shell--bare {
  min-height: 30vh;
  align-items: center;
  justify-content: center;
}

.block--span-2 {
  grid-column: span 2;
}

.block--span-3 {
  grid-column: 1 / -1;
}

.block {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  padding: 16px 18px 18px;
}

.block__title {
  margin: 0;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

.block__note {
  margin: 4px 0 12px;
  font-size: 12px;
  color: var(--muted);
}

.block__title + .block__note:empty {
  display: none;
}

.card--unbound {
  border-style: dashed;
  background: transparent;
}

.notes {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--muted);
}

.notes li + li {
  margin-top: 6px;
}

.slot {
  border: 1px dashed var(--line);
  border-radius: 10px;
  padding: 14px;
  font-size: 13px;
}

.slot p {
  margin: 0 0 6px;
}

.slot code {
  font-family: var(--mono);
  font-size: 12px;
}

.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tabs__tab {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}

.tabs__tab--on {
  border-color: var(--ink);
  background: var(--ink);
  color: #fff;
}

.bar__tag {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 10px;
}

@media (max-width: 720px) {
  .shell--grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .block--span-2,
  .block--span-3 {
    grid-column: auto;
  }
}
`;
}
