/**
 * chassisParametric.ts — Generate a THREE.Group for a chassis from a ChassisSpec.
 *
 * Supports all four ChassisShape values: horizontal_plate, vertical_plate,
 * box, frame. Renders mounting holes (subtle dimples at each mount point)
 * and standoffs for controller/battery mounts. Wheels/parts themselves are
 * placed by LiveGround separately — this only draws the body.
 */

import * as THREE from 'three';
import type { ChassisSpec, MountPoint } from './assembly/assemblyTypes';

function hex(color: string | undefined, fallback: number): number {
  if (!color) return fallback;
  const c = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return parseInt(c.slice(1), 16);
  return fallback;
}

function bodyMaterial(spec: ChassisSpec, roughness = 0.55, metalness = 0.1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex(spec.color, 0x2b6cff),
    roughness,
    metalness,
  });
}

/** Four corner standoffs with screw holes — typical acrylic robot deck look. */
function addStandoffs(group: THREE.Group, spec: ChassisSpec): void {
  const { x: X, z: Z } = spec.size;
  const t = spec.thickness ?? 2;
  const mat = new THREE.MeshStandardMaterial({ color: 0xd4a04a, metalness: 0.85, roughness: 0.3 });
  const standoffGeom = new THREE.CylinderGeometry(3, 3, 16, 12);
  const positions: [number, number][] = [
    [X/2 - 10, Z/2 - 10], [X/2 - 10, -Z/2 + 10], [-X/2 + 10, Z/2 - 10], [-X/2 + 10, -Z/2 + 10],
  ];
  for (const [px, pz] of positions) {
    const m = new THREE.Mesh(standoffGeom, mat);
    m.position.set(px, t/2 + 8, pz);
    group.add(m);
    // screw head
    const head = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 2, 12), new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.9 }));
    head.position.set(px, t/2 + 17, pz);
    group.add(head);
  }
}

function addMountDots(group: THREE.Group, mounts: MountPoint[], _t: number): void {
  const dotMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const dotGeom = new THREE.CylinderGeometry(1.2, 1.2, 1, 12);
  for (const mp of mounts) {
    const d = new THREE.Mesh(dotGeom, dotMat);
    d.position.set(mp.at.x, mp.at.y + 0.6, mp.at.z);
    group.add(d);
  }
}

function buildHorizontalPlate(spec: ChassisSpec): THREE.Group {
  const g = new THREE.Group();
  const { x: X, y: _y, z: Z } = spec.size;
  const t = spec.thickness ?? 2;
  const mat = bodyMaterial(spec);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(X, t, Z), mat);
  plate.position.y = t/2;
  plate.castShadow = true;
  plate.receiveShadow = true;
  g.add(plate);
  // Layer 2 plate above standoffs (two-deck acrylic look)
  if (X > 180 && Z > 100) {
    const deck2 = new THREE.Mesh(new THREE.BoxGeometry(X - 40, t, Z - 30), bodyMaterial(spec, 0.6, 0.1));
    deck2.position.set(10, t + 18, 0);
    g.add(deck2);
  }
  addStandoffs(g, spec);
  // Battery tray recess
  if (X > 150) {
    const tray = new THREE.Mesh(new THREE.BoxGeometry(60, 1, 40), new THREE.MeshStandardMaterial({ color: 0x151820, roughness: 0.9 }));
    tray.position.set(50, t + 1, 0);
    g.add(tray);
  }
  addMountDots(g, spec.mounts, t);
  return g;
}

function buildVerticalPlate(spec: ChassisSpec): THREE.Group {
  const g = new THREE.Group();
  const { x: X, y: Y, z: Z } = spec.size;
  const t = spec.thickness ?? 2;
  const mat = bodyMaterial(spec);
  // Main vertical plate standing on the axle line (x=-10 is axle offset)
  const plate = new THREE.Mesh(new THREE.BoxGeometry(t, Y, X), mat);
  // Orient so that X is forward, Y is up, plate spans Y/0..Y and X/-W/2..W/2
  plate.geometry.translate(0, Y/2, 0);
  plate.position.set(0, 0, 0);
  plate.castShadow = true;
  plate.receiveShadow = true;
  g.add(plate);
  // Top cross-brace for IMU
  const top = new THREE.Mesh(new THREE.BoxGeometry(t + 8, 14, 60), bodyMaterial(spec, 0.6, 0.15));
  top.position.set(0, Y - 7, 0);
  g.add(top);
  // Bottom axle clamp
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(t + 12, 20, 40), new THREE.MeshStandardMaterial({ color: 0x202020, metalness: 0.7, roughness: 0.4 }));
  clamp.position.set(0, 10, 0);
  g.add(clamp);
  addMountDots(g, spec.mounts, t);
  return g;
}

function buildBox(spec: ChassisSpec): THREE.Group {
  const g = new THREE.Group();
  const { x: X, y: Y, z: Z } = spec.size;
  const mat = bodyMaterial(spec, 0.35, 0.25);
  const body = new THREE.Mesh(new THREE.BoxGeometry(X, Y, Z), mat);
  body.position.y = Y/2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // Top lid seam
  const lid = new THREE.Mesh(new THREE.BoxGeometry(X + 1, 1, Z + 1), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
  lid.position.y = Y + 0.5;
  g.add(lid);
  addMountDots(g, spec.mounts, Y);
  return g;
}

function buildFrame(spec: ChassisSpec): THREE.Group {
  const g = new THREE.Group();
  const { x: X, y: Y, z: Z } = spec.size;
  const armMat = new THREE.MeshStandardMaterial({ color: hex(spec.color, 0x222222), metalness: 0.6, roughness: 0.4 });
  const armR = 6;
  // Two X arms, two Z arms forming a cross
  const armX = new THREE.Mesh(new THREE.CylinderGeometry(armR, armR, X, 12), armMat);
  armX.rotation.z = Math.PI/2;
  armX.position.y = Y/2;
  g.add(armX);
  const armZ = new THREE.Mesh(new THREE.CylinderGeometry(armR, armR, Z, 12), armMat);
  armZ.rotation.x = Math.PI/2;
  armZ.position.y = Y/2;
  g.add(armZ);
  // Central hub
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 12, 20), new THREE.MeshStandardMaterial({ color: 0x303030, metalness: 0.7, roughness: 0.3 }));
  hub.position.y = Y/2;
  g.add(hub);
  // Motor pods at each diagonal end
  const podGeom = new THREE.CylinderGeometry(10, 10, 14, 18);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pod = new THREE.Mesh(podGeom, armMat);
      pod.position.set(sx * X/2, Y/2, sz * Z/2);
      g.add(pod);
    }
  }
  return g;
}

/** Build a parametric chassis group from a spec. */
export function buildChassis(spec: ChassisSpec): THREE.Group {
  let g: THREE.Group;
  switch (spec.shape) {
    case 'vertical_plate': g = buildVerticalPlate(spec); break;
    case 'box':            g = buildBox(spec); break;
    case 'frame':          g = buildFrame(spec); break;
    case 'horizontal_plate':
    default:               g = buildHorizontalPlate(spec); break;
  }
  g.name = spec.label ?? 'chassis';
  g.userData.cadChassis = true;
  return g;
}
