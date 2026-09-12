/**
 * archetypes.ts — Curated assembly presets an agent can reference by name.
 *
 * Each preset is a plain AssemblySpec object. Agents call
 * `applyArchetype('self_balancer', overrides?)` to get a complete spec for a
 * class of robot, then bind specific component ids to roles. Adding a new
 * class of robot is adding an entry here — no scene code changes.
 */

import type { AssemblySpec } from './assemblyTypes';

const TWO_WD_ROVER: AssemblySpec = {
  archetype: '2wd_rover',
  chassis: {
    shape: 'horizontal_plate',
    size: { x: 250, y: 2, z: 150 },
    thickness: 2,
    color: '#2b6cff',
    label: '2WD acrylic rover deck',
    mounts: [
      { role: 'motor_left',  at: { x: -70, y: 16, z:  65 }, rotY: 90 },
      { role: 'motor_right', at: { x: -70, y: 16, z: -65 }, rotY: 90 },
      { role: 'wheel_left',  at: { x: -70, y: 16, z:  82 } },
      { role: 'wheel_right', at: { x: -70, y: 16, z: -82 } },
      { role: 'caster_front', at: { x: 110, y: 13, z: 0 } },
      { role: 'controller', at: { x: -30, y: 4, z: 0 }, rotY: 0 },
      { role: 'battery',    at: { x:  60, y: 4, z: 0 } },
      { role: 'sensor_front', at: { x: 120, y: 18, z: 0 } },
      { role: 'passenger',  at: { x: -60, y: 25, z: 0 } },
    ],
  },
  wheel: { diameterMm: 65, widthMm: 26, tireColor: '#1a1a1a', color: '#b5b5b5' },
  kinematics: {
    model: 'differential_drive',
    wheelbaseMm: 130,
    deadbandRps: 0.05,
    closedLoopSensors: false,
  },
  origin: { x: -100, y: 5, z: 300 },
  rotYDeg: 0,
};

const FOUR_WD_ROVER: AssemblySpec = {
  archetype: '4wd_rover',
  chassis: {
    shape: 'horizontal_plate',
    size: { x: 260, y: 2, z: 180 },
    thickness: 3,
    color: '#2e7d32',
    label: '4WD off-road chassis',
    mounts: [
      { role: 'motor_fl', at: { x:  90, y: 18, z:  80 }, rotY: 90 },
      { role: 'motor_fr', at: { x:  90, y: 18, z: -80 }, rotY: 90 },
      { role: 'motor_rl', at: { x: -90, y: 18, z:  80 }, rotY: 90 },
      { role: 'motor_rr', at: { x: -90, y: 18, z: -80 }, rotY: 90 },
      { role: 'controller', at: { x: 0, y: 4, z: 0 } },
      { role: 'battery', at: { x: -50, y: 4, z: 0 } },
      { role: 'sensor_front', at: { x: 125, y: 22, z: 0 } },
    ],
  },
  wheel: { diameterMm: 80, widthMm: 30, tireColor: '#1a1a1a' },
  kinematics: {
    model: 'differential_drive',
    wheelbaseMm: 160,
    trackMm: 180,
    deadbandRps: 0.05,
  },
  origin: { x: -100, y: 5, z: 300 },
};

/** Two-wheel self-balancing robot (vertical plate). */
const SELF_BALANCER: AssemblySpec = {
  archetype: 'self_balancer',
  chassis: {
    shape: 'vertical_plate',
    // X = forward/back, Y = up/down, Z = left/right when plate is upright
    size: { x: 80, y: 200, z: 2 },
    thickness: 2,
    color: '#ff6f00',
    label: 'Self-balancing 2-wheel chassis',
    mounts: [
      // Motors hang from the bottom-left/right edges with shafts pointing
      // outwards along Z. Wheels attach to those shafts.
      { role: 'motor_left',  at: { x: -10, y: 10,  z: -12 }, rotY: 0 },
      { role: 'motor_right', at: { x: -10, y: 10,  z:  12 }, rotY: 0 },
      { role: 'wheel_left',  at: { x: -10, y: 10,  z: -32 }, rotY: 90 },
      { role: 'wheel_right', at: { x: -10, y: 10,  z:  32 }, rotY: 90 },
      // IMU sits high so the tilt signal is strong.
      { role: 'imu',        at: { x:  0, y: 150, z:  6 }, rotY: 0 },
      // Heavy battery LOW to keep CoM near the axle (important for balance).
      { role: 'battery',    at: { x: 10, y:  30, z: -6 } },
      // MCU + motor driver stack mid-height.
      { role: 'controller', at: { x: -5, y: 90, z:  6 }, rotY: 0 },
      // Rangefinder optional, forward-looking.
      { role: 'sensor_front', at: { x: 40, y: 90, z: 0 }, rotY: 0 },
    ],
  },
  wheel: { diameterMm: 85, widthMm: 20, tireColor: '#1a1a1a' },
  kinematics: {
    model: 'inverted_pendulum',
    wheelbaseMm: 64,        // distance between wheels (for turning)
    deadbandRps: 0.02,
    gravity: 9810,          // mm/s^2
    balancePointDeg: 0,
    maxTiltDeg: 45,
    closedLoopSensors: true,  // feed IMU back to firmware
  },
  sensors: [
    { role: 'imu' },
    { role: 'encoder_left' },
    { role: 'encoder_right' },
  ],
  origin: { x: 0, y: 0, z: 300 },
  rotYDeg: 0,
};

/** Classic quadcopter "X" frame. */
const QUADCOPTER: AssemblySpec = {
  archetype: 'quadcopter',
  chassis: {
    shape: 'frame',
    size: { x: 250, y: 20, z: 250 },
    thickness: 4,
    color: '#222222',
    label: 'Quadcopter X-frame',
    mounts: [
      { role: 'motor_1', at: { x:  80, y: 14, z:  80 }, rotY: 0 }, // FR
      { role: 'motor_2', at: { x:  80, y: 14, z: -80 }, rotY: 0 }, // FL
      { role: 'motor_3', at: { x: -80, y: 14, z: -80 }, rotY: 0 }, // RL
      { role: 'motor_4', at: { x: -80, y: 14, z:  80 }, rotY: 0 }, // RR
      { role: 'controller', at: { x: 0, y: 6, z: 0 } },
      { role: 'battery',    at: { x: -20, y: 2, z: 0 } },
      { role: 'imu',        at: { x: 0, y: 10, z: 0 } },
    ],
  },
  // "Wheels" = propellers in this archetype; reuse the wheel primitive
  // but thin + light.
  wheel: { diameterMm: 127, widthMm: 8, tireColor: '#1a1a1a', color: '#555555' },
  kinematics: {
    model: 'quadcopter',
    wheelbaseMm: 226,       // diagonal motor-to-motor
    deadbandRps: 0.5,
    gravity: 9810,
    liftK: 0.003,
    massKg: 0.8,
    closedLoopSensors: true,
  },
  sensors: [{ role: 'imu' }],
  origin: { x: 0, y: 80, z: 300 },
  rotYDeg: 0,
};

/** Mecanum-drive omnidirectional base (4 wheels with angled rollers). */
const MECANUM: AssemblySpec = {
  archetype: 'mecanum',
  chassis: {
    shape: 'horizontal_plate',
    size: { x: 300, y: 3, z: 200 },
    thickness: 3,
    color: '#455a64',
    label: 'Mecanum omnidirectional base',
    mounts: [
      { role: 'motor_fl', at: { x:  120, y: 20, z:  90 }, rotY: 90 },
      { role: 'motor_fr', at: { x:  120, y: 20, z: -90 }, rotY: 90 },
      { role: 'motor_rl', at: { x: -120, y: 20, z:  90 }, rotY: 90 },
      { role: 'motor_rr', at: { x: -120, y: 20, z: -90 }, rotY: 90 },
      { role: 'controller', at: { x: 0, y: 4, z: 0 } },
      { role: 'battery', at: { x: -60, y: 4, z: 0 } },
    ],
  },
  wheel: { diameterMm: 100, widthMm: 36, tireColor: '#333333' },
  kinematics: {
    model: 'mecanum',
    wheelbaseMm: 180,
    trackMm: 240,
    deadbandRps: 0.05,
  },
  origin: { x: -100, y: 5, z: 300 },
};

/** Static bench — no driving, just assembles parts in place. */
const STATIC_BENCH: AssemblySpec = {
  archetype: 'static_bench',
  kinematics: { model: 'static' },
};

export const ARCHETYPES: Readonly<Record<string, AssemblySpec>> = {
  '2wd_rover': TWO_WD_ROVER,
  'smart_car': TWO_WD_ROVER,        // alias — matches "2WD smart car"
  'car': TWO_WD_ROVER,
  '4wd_rover': FOUR_WD_ROVER,
  'tank': FOUR_WD_ROVER,
  'self_balancer': SELF_BALANCER,
  'balancer': SELF_BALANCER,
  'segway': SELF_BALANCER,
  'quadcopter': QUADCOPTER,
  'drone': QUADCOPTER,
  'mecanum': MECANUM,
  'static': STATIC_BENCH,
  'bench': STATIC_BENCH,
};

export function listArchetypes(): string[] {
  return Object.keys(ARCHETYPES);
}

/**
 * Return a deep-merged copy of an archetype, optionally with overrides. If the
 * id is unknown, returns a static bench. Fields in `overrides` win per-key;
 * arrays are replaced (not appended) unless explicitly deep-merged by caller.
 */
export function getArchetype(id: string, overrides: Partial<AssemblySpec> = {}): AssemblySpec {
  const base = ARCHETYPES[id] ?? STATIC_BENCH;
  return deepMerge(base, overrides) as AssemblySpec;
}

function deepMerge<T>(a: T, b: Partial<T>): T {
  if (Array.isArray(a) || Array.isArray(b)) return (b as T) ?? a;
  if (typeof a !== 'object' || a === null) return (b as T) ?? a;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (v === undefined) continue;
    const prev = (a as Record<string, unknown>)[k];
    out[k] = prev && typeof prev === 'object' && !Array.isArray(prev) && typeof v === 'object' && !Array.isArray(v)
      ? deepMerge(prev, v as Partial<unknown>)
      : v;
  }
  return out as T;
}
