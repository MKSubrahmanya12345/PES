/**
 * parametricExtras.ts — the parametric wheel / caster / propeller primitive.
 *
 * The component catalog is electrical: it carries no wheels, no casters, no
 * propellers. The assembly spec still authors their mounts and geometry
 * (`spec.wheel`, the archetype tables), but until now a mount with no bound
 * part rendered nothing — an RC car showed up as a plank with motors and no
 * wheels.
 *
 * This module draws those mechanical extras on the spot from the spec alone:
 * cheap parametric geometry (tire + hub + treads, a caster ball, a two-blade
 * propeller) that LiveGround poses and spins with the same math as bound
 * parts. Rough is fine — present beats perfect. Whenever a real part is bound
 * to the same role, LiveGround hides the parametric stand-in.
 */

import * as THREE from 'three';
import type { AssemblySpec, MountPoint } from '../assembly/assemblyTypes';
import type { MotorInput } from '../assembly/kinematics';

export type ParametricKind = 'wheel' | 'caster' | 'prop';

export interface ParametricExtra {
  /** The mount role this extra stands in for. */
  role: string;
  kind: ParametricKind;
  /** Chassis-local mount position (mm). */
  at: { x: number; y: number; z: number };
  /** Spin radius (mm) — also the ground-contact clamp for wheels/casters. */
  radius: number;
  /** Motor slot whose live speed spins this extra (null = never spins). */
  slot: MotorInput['slot'] | null;
  /** World-posed group added to the scene root. */
  holder: THREE.Group;
  /** Child that rotates inside the holder (wheel axle = local Z, prop = local Y). */
  spinner: THREE.Group;
  /** Accumulated spin angle (radians), mutated by LiveGround each frame. */
  spinAngle: number;
  /** Height above the mount (props sit on top of their motor). */
  lift: number;
}

export interface ParametricExtras {
  root: THREE.Group;
  extras: ParametricExtra[];
}

function hex(color: string | undefined, fallback: number): number {
  if (!color) return fallback;
  const c = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return parseInt(c.slice(1), 16);
  return fallback;
}

/**
 * The motor slot a spinning extra follows: `wheel_left` mirrors `motor_left`
 * (the wheel sits on that motor's shaft), `motor_1` drives its own prop.
 * Mirrors LiveGround's `slotOfRole` without importing it (no cycles).
 */
function slotForRole(role: string, kind: ParametricKind): MotorInput['slot'] | null {
  if (kind === 'prop') {
    const m = role.match(/^motor_(m?\d+)$/);
    return m ? (`m${m[1]!.replace('m', '')}` as MotorInput['slot']) : null;
  }
  const m = role.match(/^wheel_(left|right|fl|fr|rl|rr)$/);
  return m ? (m[1]! as MotorInput['slot']) : null;
}

/** One parametric extra: a holder posed in world space + a spinning child. */
function makeExtra(
  mount: MountPoint,
  kind: ParametricKind,
  radius: number,
  lift: number,
  buildSpinner: (radius: number) => THREE.Group,
  root: THREE.Group,
): ParametricExtra {
  const holder = new THREE.Group();
  holder.visible = false; // LiveGround shows it on the first pose frame.
  const spinner = buildSpinner(radius);
  holder.add(spinner);
  root.add(holder);
  return {
    role: mount.role,
    kind,
    at: { x: mount.at.x, y: mount.at.y, z: mount.at.z },
    radius,
    slot: slotForRole(mount.role, kind),
    holder,
    spinner,
    spinAngle: 0,
    lift,
  };
}

function wheelSpinner(radius: number, width: number, tireColor: number, hubColor: number): THREE.Group {
  const g = new THREE.Group();
  const tireMat = new THREE.MeshStandardMaterial({ color: tireColor, roughness: 0.95 });
  const hubMat = new THREE.MeshStandardMaterial({ color: hubColor, roughness: 0.4, metalness: 0.4 });
  const treadMat = new THREE.MeshStandardMaterial({ color: 0x2f2f2f, roughness: 0.9 });
  // Cylinder axis defaults to Y; rotate onto Z (the chassis-left axle) so the
  // wheel rolls forward and spins around its own axis.
  const tireGeom = new THREE.CylinderGeometry(radius, radius, width, 24);
  tireGeom.rotateX(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeom, tireMat);
  tire.castShadow = true;
  g.add(tire);
  const hubGeom = new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width + 2, 18);
  hubGeom.rotateX(Math.PI / 2);
  g.add(new THREE.Mesh(hubGeom, hubMat));
  // Tread pads make the spin visible and the tire look like a tire.
  const padGeom = new THREE.BoxGeometry(4, 3, width + 1);
  for (let i = 0; i < 8; i++) {
    const theta = (i / 8) * Math.PI * 2;
    const pad = new THREE.Mesh(padGeom, treadMat);
    pad.position.set(Math.cos(theta) * radius, Math.sin(theta) * radius, 0);
    pad.rotation.z = theta - Math.PI / 2;
    g.add(pad);
  }
  return g;
}

function casterSpinner(radius: number): THREE.Group {
  const g = new THREE.Group();
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.85 }),
  );
  ball.castShadow = true;
  g.add(ball);
  // Bracket from the ball up to the deck underside.
  const bracketH = Math.max(6, radius * 0.7);
  const bracket = new THREE.Mesh(
    new THREE.BoxGeometry(12, bracketH, 12),
    new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.6, roughness: 0.4 }),
  );
  bracket.position.y = radius + bracketH / 2 - 2;
  g.add(bracket);
  return g;
}

function propSpinner(radius: number, bladeColor: number): THREE.Group {
  const g = new THREE.Group();
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(4, 6, 8, 12),
    new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.5, roughness: 0.4 }),
  );
  g.add(hub);
  const bladeMat = new THREE.MeshStandardMaterial({ color: bladeColor, roughness: 0.7 });
  const bladeLen = Math.max(14, radius - 3);
  const bladeGeom = new THREE.BoxGeometry(bladeLen, 1.6, Math.min(16, radius * 0.4 + 6));
  for (const side of [-1, 1]) {
    const blade = new THREE.Mesh(bladeGeom, bladeMat);
    blade.position.x = (side * bladeLen) / 2;
    blade.rotation.x = 0.22; // a hint of pitch
    g.add(blade);
  }
  return g;
}

/**
 * Build every parametric extra the spec declares: wheels for `wheel_*` mounts,
 * a caster for `caster_*` mounts, and propellers on `motor_*` mounts of
 * flying frames (the quad/hex tables reuse `spec.wheel` as the prop disc).
 * All of them start hidden; LiveGround shows the ones whose role has no bound
 * part and poses them every frame.
 */
export function buildParametricExtras(spec: AssemblySpec): ParametricExtras {
  const root = new THREE.Group();
  const extras: ParametricExtra[] = [];
  const chassis = spec.chassis;
  if (!chassis) return { root, extras };

  const wheel = spec.wheel;
  const wheelR = (wheel?.diameterMm ?? 65) / 2;
  const wheelW = Math.max(8, wheel?.widthMm ?? 26);
  const tireColor = hex(wheel?.tireColor, 0x1a1a1a);
  const hubColor = hex(wheel?.color, 0xb5b5b5);
  const isAir = spec.kinematics?.model === 'quadcopter' || spec.kinematics?.model === 'hexacopter';

  for (const mount of chassis.mounts ?? []) {
    if (mount.role.startsWith('wheel_')) {
      extras.push(
        makeExtra(
          mount,
          'wheel',
          wheelR,
          0,
          (radius) => wheelSpinner(radius, wheelW, tireColor, hubColor),
          root,
        ),
      );
    } else if (mount.role === 'caster_front' || mount.role === 'caster_back') {
      // The archetype seats the caster at its ball-centre height; trust it,
      // clamped to something sane for custom mounts.
      const r = Math.min(40, Math.max(8, mount.at.y || 13));
      extras.push(makeExtra(mount, 'caster', r, 0, casterSpinner, root));
    } else if (isAir && mount.role.startsWith('motor_')) {
      // The prop disc diameter rides in spec.wheel on the flying archetypes.
      const propR = (wheel?.diameterMm ?? 127) / 2;
      extras.push(
        makeExtra(mount, 'prop', propR, 20, (radius) => propSpinner(radius, tireColor), root),
      );
    }
  }
  return { root, extras };
}

/** Dispose geometries/materials when the spec swaps the extras out. */
export function disposeExtras(extras: ParametricExtras): void {
  extras.root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
  extras.root.clear();
}
