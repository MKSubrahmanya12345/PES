/**
 * The surface spec — the skeleton the generated website is built from.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The generated website used to be a fixed dashboard: the generator emitted an
 * `App.tsx` whose sections ("Readings", "Controls", "Board output") were baked
 * into the template, so every project looked like the same dashboard and the
 * only thing that changed was how many cards were in the grid.
 *
 * This module replaces that with a SKELETON. The generator emits:
 *
 *   1. a `SurfaceSpec` — plain data: which blocks exist, in what order, bound
 *      to which telemetry fields and command characters, in which layout;
 *   2. a block registry — one small component per block kind, each of which
 *      renders whatever the spec binds to it and nothing else;
 *   3. a shell that walks the spec and resolves each block through the
 *      registry, so an unknown kind degrades to an empty slot instead of
 *      breaking the app.
 *
 * Nothing downstream is allowed to assume the result is a dashboard. The spec
 * is a starting point the user edits: reorder blocks, set `enabled: false`,
 * change the layout to `tabs`, or register a new kind and add a block that
 * uses it. The shape of the site is data, not template.
 *
 * The bindings are still derived from the device contract, so a block can only
 * claim fields the firmware actually prints and characters it actually
 * accepts — the skeleton is free-form, but it is not allowed to lie.
 */

import type { DeviceContract } from './contract';

/** How the shell lays the blocks out. Any of these can be swapped by hand. */
export type SurfaceLayout = 'grid' | 'stack' | 'tabs' | 'bare';

/**
 * Block kinds the generated registry knows how to render.
 *
 * Deliberately a `string` in `SurfaceBlock.kind`: a user who registers their
 * own renderer in `src/skeleton/registry.tsx` should be able to name it in the
 * spec without fighting a union type. Unknown kinds render as an empty slot
 * and are reported as an `info` finding, never as an error.
 */
export const KNOWN_BLOCK_KINDS = ['metrics', 'commands', 'log', 'notes', 'status', 'slot'] as const;

export type KnownBlockKind = (typeof KNOWN_BLOCK_KINDS)[number];

export interface SurfaceBlock {
  /** Stable id — the shell uses it as the React key and `data-block-id`. */
  id: string;
  /** Registry key. Anything outside `KNOWN_BLOCK_KINDS` renders as a slot. */
  kind: string;
  /** Heading the shell renders above the block. */
  title: string;
  /** Telemetry fields this block reads. Empty = "whatever the contract has". */
  fields: string[];
  /** Command characters this block sends. Empty = "all of them". */
  characters: string[];
  /** Grid columns to span, when the layout is a grid. 1–3. */
  span: number;
  /** Off blocks are kept in the spec, not rendered. */
  enabled: boolean;
  /** Free-form line the block may show under its title. */
  note?: string;
}

export interface SurfaceSpec {
  /** Bumped when the spec shape changes, so a stale hand-edit is detectable. */
  version: 1;
  projectName: string;
  layout: SurfaceLayout;
  blocks: SurfaceBlock[];
}

function block(partial: Partial<SurfaceBlock> & { id: string; kind: string; title: string }): SurfaceBlock {
  return {
    id: partial.id,
    kind: partial.kind,
    title: partial.title,
    fields: partial.fields ?? [],
    characters: partial.characters ?? [],
    span: partial.span ?? 1,
    enabled: partial.enabled ?? true,
    note: partial.note,
  };
}

/**
 * The starting spec for a build.
 *
 * Derived, never fixed: the blocks that exist are the ones the contract has
 * something to feed them. A project whose firmware prints four readings gets a
 * grid; a project that prints one gets a stack; a project with no readings at
 * all gets no metrics block, rather than an empty section pretending to be one.
 *
 * A disabled `slot` block always ships, so the file the user opens shows how to
 * add their own without having to invent the shape.
 */
export function deriveSurface(contract: DeviceContract): SurfaceSpec {
  const blocks: SurfaceBlock[] = [];

  blocks.push(
    block({
      id: 'status',
      kind: 'status',
      title: 'Link',
      note: `${contract.controller} · ${contract.transport} · ${contract.baud} baud`,
    }),
  );

  if (contract.metrics.length > 0) {
    blocks.push(
      block({
        id: 'readings',
        kind: 'metrics',
        title: contract.metrics.length === 1 ? 'Reading' : 'Readings',
        fields: contract.metrics.map((metric) => metric.field),
        span: contract.metrics.length > 2 ? 2 : 1,
        note: 'Every field below is a key the firmware prints.',
      }),
    );
  }

  blocks.push(
    block({
      id: 'controls',
      kind: 'commands',
      title: 'Controls',
      characters: contract.commands.map((command) => command.character),
      note:
        contract.commands.length > 0
          ? 'Each button writes one character to the board.'
          : 'This firmware defines no command set — the block says so instead of inventing buttons.',
    }),
  );

  blocks.push(
    block({
      id: 'output',
      kind: 'log',
      title: 'Board output',
      span: 2,
      note: 'Raw lines exactly as the board printed them.',
    }),
  );

  if (contract.caveats.length > 0) {
    blocks.push(
      block({
        id: 'caveats',
        kind: 'notes',
        title: 'What this is and is not',
      }),
    );
  }

  // The extension point, shipped disabled so it is visible but not noise.
  blocks.push(
    block({
      id: 'custom',
      kind: 'slot',
      title: 'Your block',
      enabled: false,
      note: 'Set enabled: true and register a renderer for "slot" (or your own kind) in src/skeleton/registry.tsx.',
    }),
  );

  return {
    version: 1,
    projectName: contract.projectName,
    layout: layoutFor(contract),
    blocks,
  };
}

/**
 * The layout is a suggestion the spec carries, not something the shell decides.
 * Wide data (several readings plus a log) wants a grid; a single reading wants a
 * stack; a build with nothing to show wants `bare` rather than a page of empty
 * section headings.
 */
function layoutFor(contract: DeviceContract): SurfaceLayout {
  if (contract.metrics.length === 0 && contract.commands.length === 0) return 'bare';
  if (contract.metrics.length >= 3) return 'grid';
  return 'stack';
}

/** Blocks that would actually render, in order. */
export function enabledBlocks(spec: SurfaceSpec): SurfaceBlock[] {
  return spec.blocks.filter((entry) => entry.enabled);
}

export function isKnownKind(kind: string): kind is KnownBlockKind {
  return (KNOWN_BLOCK_KINDS as readonly string[]).includes(kind);
}
