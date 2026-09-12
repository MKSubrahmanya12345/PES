/**
 * verify:assembly — the two shape libraries must agree, and sample builds
 * must resolve to specs the scene accepts.
 *
 *   pnpm verify:assembly
 *
 * The pushed spec's mounts ARE the scene's per-frame posing source of truth,
 * so the PES archetype tables (`src/modules/assembly-planner/archetypes.ts`)
 * and the Velxio tables (`external/velxio/.../scene3d/assembly/archetypes.ts`)
 * must match mount-for-mount. This script fails on any drift, then resolves
 * a sample RC car, a drone, and a static build through the real resolver and
 * checks every part is seated, the spec passes Velxio's own validation, and
 * no false overlap warnings fire (wheels on shafts and stacked cargo are
 * interpenetration by design, not collisions).
 */

import { ARCHETYPES } from '../external/velxio/frontend/src/scene3d/assembly/archetypes';
import { isAssemblySpec } from '../external/velxio/frontend/src/scene3d/assembly/assemblyTypes';
import {
  ASSEMBLY_ARCHETYPE_IDS,
  getArchetypeBase,
  type AssemblyArchetypeId,
} from '@/modules/assembly-planner/archetypes';
import { heuristicAssembly, rosterEntryFor } from '@/modules/assembly-planner/resolve';

const failures: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) failures.push(msg);
}

/** Order-insensitive structural compare. */
function stable(value: unknown): string {
  if (value === undefined) return '∅';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, val]) => `${JSON.stringify(key)}:${stable(val)}`);
  return `{${entries.join(',')}}`;
}

/* -------------------------------------------------------------------------- */
/* 1. Table drift                                                               */
/* -------------------------------------------------------------------------- */

const CANONICAL: AssemblyArchetypeId[] = [...ASSEMBLY_ARCHETYPE_IDS];
for (const id of CANONICAL) {
  const pes = getArchetypeBase(id);
  const vlx = ARCHETYPES[id];
  check(!!vlx, `${id}: missing from Velxio ARCHETYPES`);
  if (!vlx) continue;
  check(pes.archetype === vlx.archetype, `${id}: archetype tag differs (${pes.archetype} vs ${vlx.archetype})`);
  check(!!pes.chassis === !!vlx.chassis, `${id}: chassis presence differs`);
  if (pes.chassis && vlx.chassis) {
    check(pes.chassis.shape === vlx.chassis.shape, `${id}: chassis shape ${pes.chassis.shape} vs ${vlx.chassis.shape}`);
    check(
      stable(pes.chassis.size) === stable(vlx.chassis.size),
      `${id}: chassis size ${stable(pes.chassis.size)} vs ${stable(vlx.chassis.size)}`,
    );
    check(
      (pes.chassis.thickness ?? null) === (vlx.chassis.thickness ?? null),
      `${id}: chassis thickness differs`,
    );
    const pm = new Map<string, { at: unknown; rotY?: number }>(
      pes.chassis.mounts.map((mount) => [mount.role as string, mount]),
    );
    const vm = new Map<string, { at: unknown; rotY?: number }>(
      vlx.chassis.mounts.map((mount) => [mount.role as string, mount]),
    );
    check(pm.size === vm.size, `${id}: mount count ${pm.size} vs ${vm.size}`);
    for (const [role, mount] of pm) {
      const other = vm.get(role);
      check(!!other, `${id}: mount ${role} missing Velxio-side`);
      if (other) {
        check(
          stable(mount.at) === stable(other.at),
          `${id}.${role}: position ${stable(mount.at)} vs ${stable(other.at)}`,
        );
        check(
          (mount.rotY ?? 0) === (other.rotY ?? 0),
          `${id}.${role}: rotY ${mount.rotY ?? 0} vs ${other.rotY ?? 0}`,
        );
      }
    }
    for (const role of vm.keys()) {
      check(pm.has(role), `${id}: mount ${role} missing PES-side`);
    }
  }
  check(stable(pes.wheel) === stable(vlx.wheel), `${id}: wheel spec differs`);
  check(stable(pes.kinematics) === stable(vlx.kinematics), `${id}: kinematics differ`);
  check(stable(pes.sensors) === stable(vlx.sensors), `${id}: sensors differ`);
  check(stable(pes.origin) === stable(vlx.origin), `${id}: origin differs`);
  check((pes.rotYDeg ?? 0) === (vlx.rotYDeg ?? 0), `${id}: rotYDeg differs`);
}

for (const alias of ['smart_car', 'car', 'tank', 'balancer', 'segway', 'drone', 'static', 'bench']) {
  check(!!ARCHETYPES[alias], `Velxio alias ${alias} went missing`);
}

/* -------------------------------------------------------------------------- */
/* 2. Sample RC car — every part seated, wheels on the axles, cargo follows     */
/* -------------------------------------------------------------------------- */

const car = heuristicAssembly({
  roster: [
    rosterEntryFor('uno-1', 'arduino-uno', 'Arduino Uno', 'microcontroller'),
    rosterEntryFor('drv-1', 'l298n', 'L298N driver', 'motor_driver'),
    rosterEntryFor('m-left', 'tt-motor', 'TT motor', 'motor'),
    rosterEntryFor('m-right', 'tt-motor', 'TT motor', 'motor'),
    rosterEntryFor('w-left', 'tt-wheel', 'TT wheel', 'other'),
    rosterEntryFor('w-right', 'tt-wheel', 'TT wheel', 'other'),
    rosterEntryFor('caster-1', 'caster-wheel', 'Caster wheel', 'other'),
    rosterEntryFor('sonic-1', 'hc-sr04', 'Ultrasonic sensor', 'sensor'),
    rosterEntryFor('bat-1', 'lipo-2s', 'LiPo battery', 'power'),
  ],
  prompt: 'bluetooth rc car',
  goal: 'a bluetooth rc car that stops before obstacles',
});
check(car.archetype === '2wd_rover', `car: archetype is ${car.archetype}, want 2wd_rover`);
check(car.unplaced.length === 0, `car: unseated parts: ${car.unplaced.join(', ') || '(none listed)'}`);
check(car.warnings.length === 0, `car: false warnings: ${car.warnings.join('; ')}`);
check(isAssemblySpec(car.spec), 'car: resolved spec rejected by Velxio isAssemblySpec');
const carWheelY = car.placements['w-left']?.y;
check(
  carWheelY !== undefined && Math.abs(carWheelY - 33) < 0.01,
  `car: wheel centre height is ${carWheelY}, want 33 (axle height, resting on the bench)`,
);
check(
  (car.bindings['wheel_left'] === 'w-left' && car.bindings['wheel_right'] === 'w-right') ||
    (car.bindings['wheel_left'] === 'w-right' && car.bindings['wheel_right'] === 'w-left'),
  'car: wheels are not bound to the wheel mounts',
);
check(car.bindings['caster_front'] === 'caster-1', 'car: caster is not bound to the caster mount');
check(car.bindings['passenger_0'] === 'drv-1', 'car: the motor driver has no follower seat (passenger_0)');
check(
  (car.spec.chassis?.mounts ?? []).some((mount) => mount.role === 'passenger_0'),
  'car: pushed spec carries no passenger_0 mount',
);

/* -------------------------------------------------------------------------- */
/* 3. Sample drone — props above the motors                                     */
/* -------------------------------------------------------------------------- */

const drone = heuristicAssembly({
  roster: [
    rosterEntryFor('fc-1', 'arduino-nano', 'Arduino Nano', 'microcontroller'),
    rosterEntryFor('bl1', 'bldc-2204', 'BLDC motor', 'motor'),
    rosterEntryFor('bl2', 'bldc-2204', 'BLDC motor', 'motor'),
    rosterEntryFor('bl3', 'bldc-2204', 'BLDC motor', 'motor'),
    rosterEntryFor('bl4', 'bldc-2204', 'BLDC motor', 'motor'),
    rosterEntryFor('prop1', 'propeller-5in', 'Propeller', 'other'),
    rosterEntryFor('prop2', 'propeller-5in', 'Propeller', 'other'),
    rosterEntryFor('prop3', 'propeller-5in', 'Propeller', 'other'),
    rosterEntryFor('prop4', 'propeller-5in', 'Propeller', 'other'),
    rosterEntryFor('bat-1', 'lipo-4s', 'LiPo battery', 'power'),
  ],
  prompt: 'camera drone',
  goal: 'a camera drone',
});
check(drone.archetype === 'quadcopter', `drone: archetype is ${drone.archetype}, want quadcopter`);
check(drone.unplaced.length === 0, `drone: unseated parts: ${drone.unplaced.join(', ') || '(none listed)'}`);
check(drone.warnings.length === 0, `drone: false warnings: ${drone.warnings.join('; ')}`);
check(isAssemblySpec(drone.spec), 'drone: resolved spec rejected by Velxio isAssemblySpec');
const motorTops = ['bl1', 'bl2', 'bl3', 'bl4'].map((id) => drone.placements[id]?.y ?? -Infinity);
const propBottoms = ['prop1', 'prop2', 'prop3', 'prop4'].map((id) => drone.placements[id]?.y ?? Infinity);
check(
  Math.min(...propBottoms) > Math.max(...motorTops),
  'drone: propellers are not seated above the motors',
);

/* -------------------------------------------------------------------------- */
/* 4. Static build — bench, no chassis                                          */
/* -------------------------------------------------------------------------- */

const bench = heuristicAssembly({
  roster: [
    rosterEntryFor('uno-1', 'arduino-uno', 'Arduino Uno', 'microcontroller'),
    rosterEntryFor('led-1', 'led-5mm', 'LED', 'discrete'),
    rosterEntryFor('btn-1', 'pushbutton', 'Pushbutton', 'input_device'),
  ],
  prompt: 'a button that toggles an led',
  goal: 'a button that toggles an LED',
});
check(bench.archetype === 'static_bench', `bench: archetype is ${bench.archetype}, want static_bench`);
check(!bench.spec.chassis, 'bench: static spec should carry no chassis');
check(isAssemblySpec(bench.spec), 'bench: resolved spec rejected by Velxio isAssemblySpec');

/* -------------------------------------------------------------------------- */

if (failures.length > 0) {
  console.error(`verify:assembly FAILED — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(
  `verify:assembly OK — ${CANONICAL.length} archetypes in sync, ` +
    `car (${Object.keys(car.placements).length} seated), ` +
    `drone (${Object.keys(drone.placements).length} seated), ` +
    `bench (${bench.unplaced.length} on the bench).`,
);
