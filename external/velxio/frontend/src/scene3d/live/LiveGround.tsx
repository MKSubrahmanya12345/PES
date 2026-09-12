/**
 * LiveGround.tsx — declarative ground/vehicle agent.
 *
 * Reads an AssemblySpec (set by `setAssemblySpec()` or through the postMessage
 * bridge from Wireup / Everflow), auto-lays the bench into that mechanical
 * configuration on first appearance, and every frame applies the spec's
 * kinematic model to animate the assembled vehicle.
 *
 * Supports any robot archetype an agent declares: 2WD/4WD rover, self-balancing
 * two-wheeler, mecanum, quadcopter, or a static bench. Adding a new archetype
 * is a matter of publishing an AssemblySpec — no code changes in this file.
 *
 * When NO AssemblySpec is present, it falls back to auto-detecting the classic
 * 2WD smart car from the part list (original behavior), so legacy projects
 * keep working.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { rotYOfInstance } from '../placement';
import { usePartRenderStore } from '../../store/usePartRenderStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { buildChassis } from '../chassisParametric';
import { getArchetype, listArchetypes } from '../assembly/archetypes';
import { stepChassis, type ChassisPose, type MotorInput } from '../assembly/kinematics';
import {
  EMPTY_ASSEMBLY,
  type AssemblySpec,
} from '../assembly/assemblyTypes';

/* ───────────────────────── helpers ─────────────────────────────────────── */

function isMotor(metadataId: string): boolean {
  const id = metadataId.toLowerCase();
  return id.includes('dc-motor') || id.includes('n20') || id.includes('bldc') ||
    id.includes('gear-motor') || id.includes('tt-motor') || id.includes('motor-generic');
}
function isWheel(metadataId: string): boolean {
  const id = metadataId.toLowerCase();
  return id.includes('wheel') || id.includes('tire') || id.includes('tt-wheel') || id.includes('caster');
}
function isCaster(metadataId: string): boolean { return metadataId.toLowerCase().includes('caster'); }
function isBattery(metadataId: string): boolean {
  return /battery|lipo|li-ion/.test(metadataId.toLowerCase());
}
function isImu(metadataId: string): boolean {
  return /mpu6050|mpu9250|\bimu\b|bmi/.test(metadataId.toLowerCase());
}
function isRangefinder(metadataId: string): boolean {
  return /hc-sr04|ultrasonic|vl53l0x|\blidar\b/.test(metadataId.toLowerCase());
}
function isController(metadataId: string): boolean {
  return /l298n|l293d|tb6612|drv8833|motor-driver|l298|esp32|arduino|raspberry-pi|stm32|\bnano\b|\buno\b|\bpico\b|motor-shield/.test(metadataId.toLowerCase());
}
function isBlade(metadataId: string): boolean { return /propeller|\bblade\b/.test(metadataId.toLowerCase()); }
function dist2D(a: { x: number; z: number }, b: { x: number; z: number }): number { return Math.hypot(a.x - b.x, a.z - b.z); }

function inferArchetypeFromParts(
  counts: { motors: number; wheels: number; casters: number; imus: number; blades: number },
): string | null {
  if (counts.blades >= 4 && counts.motors >= 4) return 'quadcopter';
  if (counts.motors >= 2 && counts.wheels >= 2 && counts.imus >= 1 && counts.casters === 0) return 'self_balancer';
  if (counts.motors >= 2 && counts.wheels >= 2 && counts.casters >= 1) return '2wd_rover';
  if (counts.motors >= 4 && counts.wheels >= 4) return '4wd_rover';
  return null;
}

type ComponentLike = { id: string; metadataId: string; x?: number; y?: number; properties?: Record<string, unknown> };

function resolveBindings(spec: AssemblySpec, components: ComponentLike[]): Map<string, string> {
  const roleToId = new Map<string, string>();
  const motors = components.filter((c) => isMotor(c.metadataId));
  const wheels = components.filter((c) => isWheel(c.metadataId) && !isCaster(c.metadataId));
  const casters = components.filter((c) => isCaster(c.metadataId));
  const batteries = components.filter((c) => isBattery(c.metadataId));
  const imus = components.filter((c) => isImu(c.metadataId));
  const controllers = components.filter((c) => isController(c.metadataId));
  const rfs = components.filter((c) => isRangefinder(c.metadataId));
  const blades = components.filter((c) => isBlade(c.metadataId));
  const passengers = components.filter((c) => {
    if (isMotor(c.metadataId) || isWheel(c.metadataId) || isBattery(c.metadataId) ||
        isImu(c.metadataId) || isController(c.metadataId) || isRangefinder(c.metadataId)) return false;
    const id = c.metadataId.toLowerCase();
    return !id.includes('chassis') && !id.includes('board') && !id.includes('chassis-parametric');
  });

  const taken = new Set<string>();
  const assign = (role: string, id: string | undefined): void => { if (id && !taken.has(id)) { roleToId.set(role, id); taken.add(id); } };
  const pickFrom = (pool: ComponentLike[], pred?: (c: ComponentLike) => boolean): string | undefined => {
    const found = pool.find((c) => !taken.has(c.id) && (!pred || pred(c)));
    return found?.id;
  };

  // Explicit bindings first.
  for (const [role, val] of Object.entries(spec.bindings ?? {})) {
    if (Array.isArray(val) && val[0]) assign(role, val[0]);
    else if (typeof val === 'string') assign(role, val);
  }

  // Motors by mount order.
  for (const mp of spec.chassis?.mounts ?? []) {
    if (!mp.role.startsWith('motor_') || roleToId.has(mp.role)) continue;
    const side = mp.role.replace('motor_', '');
    assign(mp.role, pickFrom(motors, (m) => m.metadataId.toLowerCase().includes(side)) ?? pickFrom(motors));
  }

  // Wheels: attach to nearest motor in 2D (using last known positions).
  for (const mp of spec.chassis?.mounts ?? []) {
    if (!mp.role.startsWith('wheel_') || roleToId.has(mp.role)) continue;
    const motorRole = mp.role.replace('wheel_', 'motor_');
    const motorId = roleToId.get(motorRole);
    if (!motorId) continue;
    const motorCmp = components.find((c) => c.id === motorId);
    if (!motorCmp) continue;
    const mx = (motorCmp.properties?.x3d as number) ?? motorCmp.x ?? 0;
    const mz = (motorCmp.properties?.z3d as number) ?? 0;
    let bestId: string | undefined, bestD = Infinity;
    for (const w of wheels) {
      if (taken.has(w.id)) continue;
      const wx = (w.properties?.x3d as number) ?? w.x ?? 0;
      const wz = (w.properties?.z3d as number) ?? 0;
      const d = dist2D({ x: mx, z: mz }, { x: wx, z: wz });
      if (d < bestD) { bestD = d; bestId = w.id; }
    }
    assign(mp.role, bestId);
  }
  // Caster.
  assign('caster_front', pickFrom(casters));
  assign('imu', pickFrom(imus));
  assign('battery', pickFrom(batteries));
  assign('controller', pickFrom(controllers));
  assign('sensor_front', pickFrom(rfs));

  // Drone props — pair propellers (or wheels as fallback) to m1..m6 mounts.
  const propPool = blades.length > 0 ? blades : wheels;
  for (let i = 1; i <= 6; i++) {
    const key = `m${i}`;
    const has = spec.chassis?.mounts.find((m) => m.role === key);
    if (has && !roleToId.has(key)) assign(key, propPool[i-1]?.id);
  }
  // Passengers distribute over 'passenger' mounts.
  const passCount = (spec.chassis?.mounts.filter((m) => m.role === 'passenger') ?? []).length;
  let pi = 0;
  for (const p of passengers) {
    if (taken.has(p.id)) continue;
    roleToId.set(`passenger_${pi}`, p.id); taken.add(p.id);
    pi++;
    if (passCount > 0 && pi >= passCount * 2) break;
  }
  return roleToId;
}

function slotOfRole(role: string): MotorInput['slot'] {
  if (role.endsWith('_left')) return 'left';
  if (role.endsWith('_right')) return 'right';
  if (role === 'motor_fl') return 'fl';
  if (role === 'motor_fr') return 'fr';
  if (role === 'motor_rl') return 'rl';
  if (role === 'motor_rr') return 'rr';
  const m = role.match(/^motor_(m?\d+)$/);
  if (m) {
    const num = m[1].replace('m','');
    return `m${num}` as MotorInput['slot'];
  }
  return 'm1';
}

/* ─────────────────── store-level assembly spec ─────────────────────────── */

let currentSpec: AssemblySpec = EMPTY_ASSEMBLY;
const specListeners = new Set<(s: AssemblySpec) => void>();

export function setAssemblySpec(spec: AssemblySpec): void {
  currentSpec = spec;
  for (const l of specListeners) l(structuredClone(spec));
}
export function getAssemblySpec(): AssemblySpec { return currentSpec; }
function subscribeAssemblySpec(fn: (s: AssemblySpec) => void): () => void {
  specListeners.add(fn); fn(currentSpec); return () => { specListeners.delete(fn); };
}

/* ─────────────────────── the React component ───────────────────────────── */

interface ResolvedState {
  spec: AssemblySpec;
  roleToId: Map<string, string>;
  pose: ChassisPose;
  mountPositions: Array<{ role: string; at: { x: number; y: number; z: number }; rotY: number }>;
  origin: { x: number; y: number; z: number };
}

export default function LiveGround(): JSX.Element | null {
  const [activeSpec, setActiveSpec] = useState<AssemblySpec>(EMPTY_ASSEMBLY);
  const laidRef = useRef(false);
  const resolvedRef = useRef<ResolvedState | null>(null);
  const chassisGroupRef = useRef<THREE.Group>(null);

  useEffect(() => subscribeAssemblySpec((s) => {
    setActiveSpec(s);
    laidRef.current = false;
    resolvedRef.current = null;
  }), []);

  const chassisMesh = useMemo(() => {
    if (!activeSpec.chassis) return null;
    return buildChassis(activeSpec.chassis);
  }, [activeSpec.chassis]);

  useFrame((_, dtRaw) => {
    const dt = Math.min(0.05, dtRaw);
    const state = useSimulatorStore.getState();
    const components = state.components as ComponentLike[];
    if (!components || components.length === 0) return;

    if (currentSpec === EMPTY_ASSEMBLY && !laidRef.current) {
      const counts = { motors: 0, wheels: 0, casters: 0, imus: 0, blades: 0 };
      for (const c of components) {
        if (isMotor(c.metadataId)) counts.motors++;
        if (isWheel(c.metadataId) && !isCaster(c.metadataId)) counts.wheels++;
        if (isCaster(c.metadataId)) counts.casters++;
        if (isImu(c.metadataId)) counts.imus++;
        if (isBlade(c.metadataId)) counts.blades++;
      }
      const arch = inferArchetypeFromParts(counts);
      currentSpec = arch ? getArchetype(arch) : { ...EMPTY_ASSEMBLY };
      setActiveSpec(currentSpec);
    }

    const spec = currentSpec;
    const roleToId = resolveBindings(spec, components);

    if (!laidRef.current && spec.chassis) {
      laidRef.current = true;
      const origin = spec.origin ?? { x: -100, y: 5, z: 300 };
      const rotY0 = ((spec.rotYDeg ?? 0) * Math.PI) / 180;

      // Place every bound part at its mount point by writing x3d/y3d/z3d/rotY
      // directly into component properties. This is a layout decision from the
      // agent/archetype, not a single user drag to undo, so we don't go
      // through pushCommand (which only understands canvas x/y moves).
      const patches = new Map<string, Record<string, number>>();
      for (const mount of spec.chassis.mounts) {
        const id = roleToId.get(mount.role);
        if (!id) continue;
        patches.set(id, {
          x3d: origin.x + mount.at.x,
          y3d: origin.y + mount.at.y,
          z3d: origin.z + mount.at.z,
          rotY: ((mount.rotY ?? 0) + (spec.rotYDeg ?? 0)) * Math.PI / 180,
        });
      }
      const existingChassis = components.find((c) => c.metadataId.toLowerCase().includes('chassis'));
      if (existingChassis) {
        patches.set(existingChassis.id, { x3d: origin.x, y3d: origin.y, z3d: origin.z, rotY: rotY0 });
      }
      useSimulatorStore.setState((s) => ({
        components: (s.components as ComponentLike[]).map((c) => {
          const p = patches.get(c.id);
          if (!p) return c;
          return { ...c, properties: { ...c.properties, ...p } };
        }),
      } as never));

      resolvedRef.current = {
        spec,
        roleToId,
        origin,
        pose: { x: origin.x, y: origin.y, z: origin.z, rotY: rotY0, tilt: 0, tiltVel: 0, vy: 0 },
        mountPositions: spec.chassis.mounts.map((m) => ({
          role: m.role,
          at: { x: m.at.x, y: m.at.y, z: m.at.z },
          rotY: ((m.rotY ?? 0) * Math.PI) / 180,
        })),
      };
    }

    const res = resolvedRef.current;
    if (!res || !res.spec.chassis) return;

    // Motor inputs.
    const live = usePartRenderStore.getState().values;
    const motorsIn: MotorInput[] = [];
    for (const mount of res.spec.chassis.mounts) {
      if (!mount.role.startsWith('motor_')) continue;
      const id = res.roleToId.get(mount.role);
      if (!id) continue;
      const entry = live[id];
      const tps = (entry?.turnsPerSecond ?? 0) * (entry?.direction ?? 1) * (entry?.drive ?? 0);
      motorsIn.push({ turnsPerSecond: tps, slot: slotOfRole(mount.role) });
    }

    res.pose = stepChassis(res.pose, motorsIn, res.spec, dt);
    const { x: cx, y: cy, z: cz, rotY: cRotY, tilt, vy } = res.pose;
    void vy;

    const isVertical = res.spec.chassis.shape === 'vertical_plate';
    const isAir = res.spec.kinematics?.model === 'quadcopter' || res.spec.kinematics?.model === 'hexacopter';
    const axleY = isVertical ? 10 : 0;

    // Update all bound components' x3d/y3d/z3d/rotY in place.
    for (const mp of res.mountPositions) {
      const id = res.roleToId.get(mp.role) ??
        (mp.role === 'passenger' ? [...res.roleToId.entries()].find(([k]) => k.startsWith('passenger_'))?.[1] : undefined);
      if (!id) continue;
      const comp = components.find((c) => c.id === id);
      if (!comp) continue;
      const p = comp.properties ?? (comp.properties = {});
      if (isVertical) {
        // Local: axles at z=±32, y=10 on the plate; body above axle tilts.
        const localYRel = mp.at.y - axleY;
        const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
        const tiltedX = mp.at.x * cosT - localYRel * sinT;
        const tiltedY = mp.at.x * sinT + localYRel * cosT + axleY;
        const worldX = cx + Math.sin(cRotY) * tiltedX - Math.cos(cRotY) * mp.at.z;
        const worldZ = cz + Math.cos(cRotY) * tiltedX + Math.sin(cRotY) * mp.at.z;
        const worldY = cy + tiltedY;
        // Wheels stay at axle height, don't tilt with body.
        const wheelLike = mp.role.startsWith('wheel_') || mp.role === 'caster_front' || mp.role === 'caster_back';
        p.x3d = worldX;
        p.z3d = worldZ;
        p.y3d = wheelLike ? cy + mp.at.y : worldY;
        p.rotY = cRotY + mp.rotY;
        (p as Record<string, unknown>).rotZ = wheelLike ? 0 : tilt;
      } else if (isAir) {
        // For drones everything hangs below origin, no tilt yet.
        p.x3d = cx + Math.sin(cRotY) * mp.at.x - Math.cos(cRotY) * mp.at.z;
        p.z3d = cz + Math.cos(cRotY) * mp.at.x + Math.sin(cRotY) * mp.at.z;
        p.y3d = cy + mp.at.y;
        p.rotY = cRotY + mp.rotY;
        (p as Record<string, unknown>).rotZ = 0;
      } else {
        // Differential / mecanum / static.
        p.x3d = cx + Math.sin(cRotY) * mp.at.x - Math.cos(cRotY) * mp.at.z;
        p.z3d = cz + Math.cos(cRotY) * mp.at.x + Math.sin(cRotY) * mp.at.z;
        p.y3d = cy + mp.at.y;
        p.rotY = cRotY + mp.rotY;
        (p as Record<string, unknown>).rotZ = 0;
      }
    }

    // Apply transform to our chassis mesh directly (it lives in the scene-graph as a React child).
    if (chassisGroupRef.current) {
      chassisGroupRef.current.position.set(cx, cy, cz);
      chassisGroupRef.current.rotation.set(isVertical ? tilt : 0, cRotY, 0);
    }

    // Nudge store to trigger 3D re-render (component positions were mutated in place).
    const tick = ((state as Record<string, unknown>).__liveGroundTick as number) ?? 0;
    useSimulatorStore.setState({ __liveGroundTick: tick + 1 } as never);
  });

  // PostMessage bridge + debug helpers on window.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__liveGround = {
      setAssemblySpec,
      getAssemblySpec,
      listArchetypes,
      getArchetype,
    };
    const handler = (ev: MessageEvent): void => {
      if (!ev.data || typeof ev.data !== 'object') return;
      const t = (ev.data as Record<string, unknown>).type;
      if (t === 'wireup:set_assembly') {
        const spec = (ev.data as Record<string, unknown>).spec as AssemblySpec | undefined;
        if (spec) setAssemblySpec(spec);
      } else if (t === 'wireup:apply_archetype') {
        const arch = (ev.data as Record<string, unknown>).archetype as string;
        const overrides = ((ev.data as Record<string, unknown>).overrides ?? {}) as Partial<AssemblySpec>;
        setAssemblySpec(getArchetype(arch, overrides));
      } else if (t === 'wireup:reset_assembly') {
        setAssemblySpec(EMPTY_ASSEMBLY);
        laidRef.current = false;
        resolvedRef.current = null;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  if (!chassisMesh) return null;
  return <primitive object={chassisMesh} ref={chassisGroupRef} />;
}
