/**
 * cadCatalog — fetches `/cad-catalog.json` (written by
 * `scripts/export-cad-catalog-to-velxio.ts` from Wireup's CAD studio specs)
 * and turns each entry into a cached, ready-to-place THREE.Group via
 * `buildParametricAssembly`.
 *
 * This is the sibling of `models3d.ts`'s GLB loader: same instance-key space
 * (board -> boardKind, part -> metadataId), same caching shape
 * (`LoadedModel`-compatible group + named pin nodes + bbox size), so
 * `Cad3DScene.tsx` can treat "loaded from a GLB" and "built parametrically"
 * as the same kind of thing and never fall back to an unshaded placeholder.
 */

import { useEffect, useState } from 'react';
import { Box3, Group, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { CadCatalogManifest, CadComponentSpec } from './cadTypes';
import { buildParametricAssembly } from './cadParametric';
import type { LoadedModel } from './models3d';
import { reportCatalog, reportModels } from './live/intakeReport';

/* Runtime-injected CAD entries: car-kit parts (chassis plate + TT wheel +
 * caster). These are authored here rather than in Wireup's static
 * cad-catalog.json so they are always available regardless of which
 * Wireup build shipped the JSON — we want the 3D car agent to be able
 * to assemble a vehicle for ANY project that drops the right parts on
 * the canvas. */
function injectedEntries(): Record<string, { kind: 'part'; cadOnly: true; canvasPlaced: true; spec: CadComponentSpec }> {
  return {
    'tt-wheel-65mm': {
      kind: 'part',
      cadOnly: true,
      canvasPlaced: true,
      spec: {
        id: 'tt-wheel-65mm',
        name: 'TT robot wheel (65 mm)',
        category: 'mechanical',
        description: '65 mm plastic robot wheel with rubber tire, press-fits onto the 3 mm D-shaft of a TT/BO gear motor.',
        voltage: 0,
        currentMa: 0,
        dimensions: { widthMm: 65, lengthMm: 26, heightMm: 65 },
        bodyStyle: 'none',
        pinStyle: 'none',
        bodyColor: '#1a1d22',
        pins: [],
        features: [
          {
            name: 'tire',
            type: 'wheel',
            dimensions: [65, 8, 0],
            position: [0, 32.5, 0],
            rotation: [0, 0, 0],
          },
          {
            name: 'hub_outer',
            type: 'wheel_hub',
            dimensions: [40, 10, 0],
            position: [0, 32.5, 0],
            color: '#c0c8d0',
          },
          {
            name: 'axle_bore',
            type: 'cylinder',
            dimensions: [6, 14, 0],
            position: [0, 32.5, 0],
            color: '#2a2d33',
          },
        ],
      } as unknown as CadComponentSpec,
    },
    'caster-wheel-14mm': {
      kind: 'part',
      cadOnly: true,
      canvasPlaced: true,
      spec: {
        id: 'caster-wheel-14mm',
        name: 'Caster wheel (14 mm, nylon)',
        category: 'mechanical',
        description: 'Small passive ball/nylon caster for the front of a 2WD smart car.',
        voltage: 0,
        currentMa: 0,
        dimensions: { widthMm: 20, lengthMm: 18, heightMm: 22 },
        bodyStyle: 'none',
        pinStyle: 'none',
        bodyColor: '#2a2d33',
        pins: [],
        features: [
          {
            name: 'bracket',
            type: 'box',
            dimensions: [16, 10, 12],
            position: [0, 17, 0],
            color: '#2f353e',
          },
          {
            name: 'ball',
            type: 'cylinder',
            dimensions: [14, 6, 0],
            position: [0, 5, 0],
            color: '#0e1014',
          },
        ],
      } as unknown as CadComponentSpec,
    },
    'chassis-2wd-acrylic': {
      kind: 'part',
      cadOnly: true,
      canvasPlaced: true,
      spec: {
        id: 'chassis-2wd-acrylic',
        name: '2WD smart-car chassis (acrylic)',
        category: 'mechanical',
        description: 'Classic 250 × 150 × 2 mm two-layer acrylic car plate with mounting slots for two TT motors, a caster ball in front and a 4×AA battery tray on top.',
        voltage: 0,
        currentMa: 0,
        dimensions: { widthMm: 250, lengthMm: 150, heightMm: 10 },
        bodyStyle: 'enclosure',
        pinStyle: 'none',
        bodyColor: '#2b6fb5',
        pins: [],
        features: [
          {
            name: 'top_plate',
            type: 'box',
            dimensions: [250, 2, 150],
            position: [0, 9, 0],
            color: '#2b6fb5',
          },
          {
            name: 'bottom_plate',
            type: 'box',
            dimensions: [250, 2, 150],
            position: [0, 3, 0],
            color: '#2b6fb5',
          },
          {
            name: 'battery_tray',
            type: 'box',
            dimensions: [70, 16, 60],
            position: [-60, 16, 0],
            color: '#1f242c',
          },
          {
            name: 'caster_mount',
            type: 'box',
            dimensions: [30, 4, 20],
            position: [105, 10, 0],
            color: '#1f242c',
          },
          {
            name: 'motor_mount_left',
            type: 'box',
            dimensions: [70, 12, 24],
            position: [-70, 6, -70],
            color: '#1f242c',
          },
          {
            name: 'motor_mount_right',
            type: 'box',
            dimensions: [70, 12, 24],
            position: [-70, 6, 70],
            color: '#1f242c',
          },
          // Copper standoffs between the two plates.
          {
            name: 'standoff_fl',
            type: 'cylinder',
            dimensions: [5, 6, 0],
            position: [110, 6, 55],
            color: '#c59b43',
          },
          {
            name: 'standoff_fr',
            type: 'cylinder',
            dimensions: [5, 6, 0],
            position: [110, 6, -55],
            color: '#c59b43',
          },
          {
            name: 'standoff_bl',
            type: 'cylinder',
            dimensions: [5, 6, 0],
            position: [-110, 6, 55],
            color: '#c59b43',
          },
          {
            name: 'standoff_br',
            type: 'cylinder',
            dimensions: [5, 6, 0],
            position: [-110, 6, -55],
            color: '#c59b43',
          },
        ],
      } as unknown as CadComponentSpec,
    },
  };
}

let cache: CadCatalogManifest | null = null;
let pending: Promise<CadCatalogManifest> | null = null;
let injected = false;

/** Load (and cache) the CAD catalog. Never throws: missing/bad JSON -> empty. */
export function loadCadCatalog(): Promise<CadCatalogManifest> {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = fetch('/cad-catalog.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { version: 0, generatedAt: '', entries: {} }))
      .catch(() => ({ version: 0, generatedAt: '', entries: {} }))
      .then((m) => {
        cache = m as CadCatalogManifest;
        // Inject the mechanical car-kit parts (wheels, chassis, caster) that
        // the live-ground / car agent relies on, regardless of what the
        // Wireup-side catalog exported.
        if (!injected) {
          cache.entries = { ...(cache.entries ?? {}), ...injectedEntries() };
          injected = true;
        }
        const entries = Object.values(cache.entries ?? {});
        reportCatalog({
          entries: entries.length,
          withoutSpec: entries.filter((entry) => !entry?.spec?.features || entry.spec.pins === undefined).length,
        });
        return cache;
      });
  }
  return pending;
}

const groupCache = new Map<string, LoadedModel>();

/** Build (and cache) the parametric assembly for one catalog key. */
function buildAndIndex(key: string): LoadedModel | null {
  const cached = groupCache.get(key);
  if (cached) return cached;
  const entry = cache?.entries?.[key];
  if (!entry) return null;

  const assembly = buildParametricAssembly(entry.spec);
  assembly.updateMatrixWorld(true);

  const box = new Box3().setFromObject(assembly);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());

  // Match models3d.ts's convention: the returned group's origin is the
  // assembly's centroid, so a part's bench position lands on its middle the
  // same way a centered GLB does.
  const group = new Group();
  assembly.position.sub(center);
  group.add(assembly);
  group.updateMatrixWorld(true);

  const pins = new Map<string, Vector3>();
  group.traverse((o: Object3D) => {
    if (o.name) pins.set(o.name, o.getWorldPosition(new Vector3()));
  });

  // No manifest `def` of its own (this isn't a GLB), so a minimal
  // GLB-compatible CadModelDef is synthesised for the shared LoadedModel
  // shape — `layoutInstances()` and `resolvePinWorld()` only ever read
  // `def.bench`, which parametric parts don't need (auto-grid layout).
  const bounds = new Box3().setFromObject(group);
  const loaded: LoadedModel = { def: { file: '' }, group, pins, size, recenter: center.clone(), bounds };
  groupCache.set(key, loaded);
  return loaded;
}

/** The CAD spec for an instance key (live-surface anchors read it), or null. */
export function cadSpecFor(key: string): CadComponentSpec | null {
  return cache?.entries?.[key]?.spec ?? null;
}

/** React hook: the CAD spec for a key, once the catalog has loaded. */
export function useCadSpec(key: string): CadComponentSpec | null {
  const [spec, setSpec] = useState<CadComponentSpec | null>(() => cadSpecFor(key));
  useEffect(() => {
    let alive = true;
    void loadCadCatalog().then(() => {
      if (alive) setSpec(cadSpecFor(key));
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return spec;
}

/** Does the CAD catalog have an entry for this instance key? */
export function isParametricRegistered(key: string): boolean {
  return cache ? Boolean(cache.entries?.[key]) : false;
}

/** Build every requested key's parametric assembly (cache-backed). Keys with
 *  no catalog entry are simply absent from the result. */
export async function loadParametricForKeys(keys: string[]): Promise<Map<string, LoadedModel>> {
  await loadCadCatalog();
  const out = new Map<string, LoadedModel>();
  for (const key of keys) {
    const model = buildAndIndex(key);
    if (model) out.set(key, model);
  }
  // The parametric tier is the fallback for a key with no reviewed GLB: what it
  // could build is part of the intake picture (a key missing from BOTH tiers is
  // a part the bench cannot draw at all).
  reportModels({ parametric: [...out.keys()].sort() });
  return out;
}

/** React hook mirroring `useCadModels` for the parametric catalog. */
export function useParametricModels(keys: string[]): {
  models: Map<string, LoadedModel>;
  ready: boolean;
} {
  const [models, setModels] = useState<Map<string, LoadedModel>>(new Map());
  const [ready, setReady] = useState(false);
  const keySig = keys.join('|');

  useEffect(() => {
    let alive = true;
    setReady(false);
    loadParametricForKeys(keys).then((map) => {
      if (!alive) return;
      setModels(map);
      setReady(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySig]);

  return { models, ready };
}
