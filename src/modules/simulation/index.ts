/**
 * Simulation module — everything the /simulation page is built from.
 *
 * A project's simulation payload is a pure function of its persisted state:
 * the diagram + the firmware in, a Velxio project and a generated dashboard
 * out. Nothing here is stored separately, so the two halves can never go stale
 * against the project they came from — regenerating is cheaper and safer than
 * invalidating a cache.
 */

import type { AssemblyBundleView, AssemblyPlacement } from '@/types/assembly';
import type { ProjectState } from '@/types/project';

import { generateSoftware, slugify, type SoftwareArtifact } from '@/modules/software-generator';
import {
  heuristicAssembly,
  pruneAssemblyToIds,
  rosterFromDiagram,
  translateAssemblyForVlx,
} from '@/modules/assembly-planner';

import { generateVelxioProject, VLX_BOARD_ID, type VelxioProjectResult } from './velxio-project';

export interface SimulationBundle {
  projectId: string;
  projectName: string;
  slug: string;
  revision: number;
  /** Null when the project has no diagram yet. */
  velxio: VelxioProjectResult | null;
  /** Null when the project has no firmware yet. */
  software: SoftwareArtifact | null;
  /** The 3D shape, pruned to the current diagram. Null without a diagram. */
  assembly: AssemblyBundleView | null;
  /** Why a half is missing, in the user's terms. */
  blocked: { velxio: string | null; software: string | null };
}

/** The controller's display name, or a plain fallback. */
function controllerName(project: ProjectState): string {
  const controller = project.hardwarePlan?.controller;
  if (controller?.name) return controller.name;
  const mcu = project.components.find((selection) => selection.category === 'microcontroller');
  return mcu?.name ?? 'the controller';
}

/**
 * The assembly view for the bundle: the persisted plan pruned to the diagram
 * instances that still exist, with its spec translated to Velxio ids. Builds
 * that predate the assembly stage get the deterministic shape derived on read
 * (pure function of the diagram — stable without persisting anything).
 */
export function buildAssemblyView(project: ProjectState): {
  view: AssemblyBundleView | null;
  placements: Record<string, AssemblyPlacement>;
} {
  const diagram = project.artifacts.diagram;
  if (!diagram) return { view: null, placements: {} };
  const roster = rosterFromDiagram(diagram);
  if (roster.length === 0) return { view: null, placements: {} };

  const readNotes: string[] = [];
  let plan = project.assembly;
  if (!plan) {
    plan = heuristicAssembly({
      roster,
      prompt: project.prompt,
      goal: project.requirements?.goal ?? project.name,
    });
    readNotes.push('Assembled on read — this build predates the assembly stage, so the deterministic shape applies.');
  }
  const ids = new Set(diagram.components.map((component) => component.id));
  const pruned = pruneAssemblyToIds(plan, ids);
  if (pruned.dropped.length > 0) {
    readNotes.push(
      `${pruned.dropped.length} stale seat(s) pruned (the diagram changed after the assembly was planned).`,
    );
  }

  const controller = diagram.components.find((component) => component.category === 'microcontroller');
  const controllerId = controller?.id ?? null;
  const spec = translateAssemblyForVlx(pruned.plan, (id) => (controllerId && id === controllerId ? VLX_BOARD_ID : id));

  // The board carries no properties bag in `.vlx`, so its seat travels in the
  // pushed spec only; every other seat is baked into its component.
  const placements: Record<string, AssemblyPlacement> = {};
  for (const [id, seat] of Object.entries(pruned.plan.placements)) {
    if (controllerId && id === controllerId) continue;
    placements[id] = seat;
  }

  const seated = new Set([...Object.keys(pruned.plan.placements), ...pruned.plan.parametric]);
  return {
    placements,
    view: {
      spec,
      archetype: pruned.plan.archetype,
      label: pruned.plan.label,
      source: pruned.plan.source,
      placed: seated.size,
      total: roster.length,
      parametric: pruned.plan.parametric,
      parametricRoles: pruned.plan.parametricRoles ?? [],
      unplaced: pruned.plan.unplaced,
      notes: [...readNotes, ...pruned.plan.notes],
      warnings: pruned.plan.warnings,
    },
  };
}

export function buildSimulationBundle(project: ProjectState): SimulationBundle {
  const diagram = project.artifacts.diagram;
  const code = project.artifacts.code;
  const libraries = project.artifacts.libraries?.libraries.map((library) => library.name) ?? [];

  const blocked: SimulationBundle['blocked'] = { velxio: null, software: null };
  const assembly = buildAssemblyView(project);

  let velxio: VelxioProjectResult | null = null;
  if (!diagram) {
    blocked.velxio =
      project.status === 'running' || project.status === 'validating' || project.status === 'fixing'
        ? 'The wiring graph is still being built — the simulator project is generated from it, so it comes next.'
        : 'This project has no diagram.json, so there is nothing to place on the simulator canvas.';
  } else {
    velxio = generateVelxioProject({
      projectName: project.name,
      diagram,
      files: code?.files ?? [],
      ...(code?.entryPoint ? { entryPoint: code.entryPoint } : {}),
      libraries,
      assemblyPlacements: assembly.placements,
    });
  }

  let software: SoftwareArtifact | null = null;
  if (!code || !project.softwarePlan) {
    blocked.software = !code
      ? 'The firmware has not been generated yet. The dashboard is derived from it (it reads the exact fields the sketch prints), so it comes after.'
      : 'This project has no software plan, so the dashboard\'s command set could not be derived.';
  } else {
    software = generateSoftware({
      projectName: project.name,
      controllerName: controllerName(project),
      selections: project.components,
      assignments: project.pinAssignments,
      softwarePlan: project.softwarePlan,
      firmware: code.files,
    });
  }

  return {
    projectId: project.id,
    projectName: project.name,
    slug: slugify(project.name),
    revision: project.revision,
    velxio,
    software,
    assembly: assembly.view,
    blocked,
  };
}

export { generateVelxioProject } from './velxio-project';
export type { VlxProject, VelxioProjectResult } from './velxio-project';
export { applyCanvasToDiagram, CanvasSyncError, assertCanvasPayload } from './vlx-sync';
export type { VlxCanvasPayload, CanvasSyncResult } from './vlx-sync';
