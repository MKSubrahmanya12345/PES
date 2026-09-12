/**
 * kinematics.ts — Generic kinematics & dynamics models.
 *
 * Each `step*` function takes current chassis pose, per-motor speeds, the spec,
 * and dt (seconds), and returns an updated {x, z, y, rotY, tilt?}.
 *
 * Adding a new locomotion model = adding a new step function + a case in
 * `stepChassis()`. The agent picks the model via AssemblySpec.kinematics.model.
 */

import type { AssemblySpec } from './assembly/assemblyTypes';

export interface ChassisPose {
  x: number;
  y: number;
  z: number;
  rotY: number;     // radians, Y-up
  tilt: number;     // radians around Z (used by inverted_pendulum); 0 = upright
  tiltVel: number;  // rad/s
  vy: number;       // vertical velocity (drone)
}

export interface MotorInput {
  /** Signed turns per second. + = forward/up depending on model. */
  turnsPerSecond: number;
  /** Which role-slots this motor fills (e.g. 'left','right' or 1..4). */
  slot: 'left' | 'right' | 'fl' | 'fr' | 'rl' | 'rr' | 'm1' | 'm2' | 'm3' | 'm4' | 'm5' | 'm6';
}

const TAU = Math.PI * 2;

function degToRad(d: number): number { return d * Math.PI / 180; }

/** Differential drive for 2WD/4WD (skid-steer). */
function stepDifferential(pose: ChassisPose, motors: MotorInput[], spec: AssemblySpec, dt: number): ChassisPose {
  const wheelDiam = spec.wheel?.diameterMm ?? 65;
  const circ = Math.PI * wheelDiam;
  const wheelbase = spec.kinematics?.wheelbaseMm ?? 130;
  const deadband = spec.kinematics?.deadbandRps ?? 0.05;

  const speed = (slot: 'left'|'right'): number => {
    const side = slot === 'left' ? ['left','rl','fl','m2','m4'] : ['right','rr','fr','m1','m3'];
    let sum = 0, n = 0;
    for (const m of motors) {
      if (side.includes(m.slot)) {
        const v = Math.abs(m.turnsPerSecond) < deadband ? 0 : m.turnsPerSecond;
        sum += v; n++;
      }
    }
    return n ? sum/n : 0;
  };

  const vL = speed('left');
  const vR = speed('right');
  const vLin = (vL + vR) / 2 * circ;          // mm/s forward
  const omega = (vR - vL) / wheelbase * circ; // rad/s yaw — wheel geometry cancels out? Wait: (vR-vL) is in tps, *circ gives mm/s, /wheelbase_mm gives rad/s. Correct.

  // Integrate in local frame then rotate to world.
  const newRotY = pose.rotY + omega * dt;
  const dxLocal = vLin * dt;
  const dx = Math.sin(newRotY) * dxLocal;
  const dz = Math.cos(newRotY) * dxLocal;
  return { ...pose, x: pose.x + dx, z: pose.z + dz, rotY: newRotY, tilt: 0, tiltVel: 0, vy: 0, y: pose.y };
}

/**
 * Inverted pendulum (self-balancing bot).
 *
 * Simplified 2D model:
 *   - Wheels: differential drive as above.
 *   - Body tilts around Z (the axle) due to gravity + wheel reaction.
 *   - Motor torque applied to wheels creates a reaction torque on the body,
 *     which the firmware uses to balance. When `closedLoopSensors` is off, the
 *     body just stays upright; when on, a simple "firmware tries to hold 0°"
 *     PD controller is applied as a stand-in until real IMU feedback is
 *     plumbed, so the scene visually balances.
 */
function stepBalancer(pose: ChassisPose, motors: MotorInput[], spec: AssemblySpec, dt: number): ChassisPose {
  const wheelDiam = spec.wheel?.diameterMm ?? 85;
  const circ = Math.PI * wheelDiam;
  const wheelbase = spec.kinematics?.wheelbaseMm ?? 64;
  const deadband = spec.kinematics?.deadbandRps ?? 0.02;
  const g = spec.kinematics?.gravity ?? 9810;
  const maxTilt = degToRad(spec.kinematics?.maxTiltDeg ?? 45);
  const balancePoint = degToRad(spec.kinematics?.balancePointDeg ?? 0);

  const vL = (motors.find(m => m.slot === 'left')?.turnsPerSecond ?? 0);
  const vR = (motors.find(m => m.slot === 'right')?.turnsPerSecond ?? 0);
  const spL = Math.abs(vL) < deadband ? 0 : vL;
  const spR = Math.abs(vR) < deadband ? 0 : vR;

  // Effective forward wheel speed (avg).
  const vWheel = (spL + spR) / 2 * circ;      // mm/s
  const omega = (spR - spL) / wheelbase * circ;

  // When closed-loop sensors are on, the firmware's PID is holding balance;
  // use a lightweight PD stand-in so the bot visually balances while the
  // wheel-speed asymmetry drives it forward/turns. If it has fallen past
  // maxTilt, stop correcting (bot has fallen over).
  let tilt = pose.tilt;
  let tiltVel = pose.tiltVel;

  const fallen = Math.abs(tilt) > maxTilt;
  if (!fallen && spec.kinematics?.closedLoopSensors) {
    // PD correction to balance point: torque proportional to error & tiltVel.
    const err = tilt - balancePoint;
    const kP = 60, kD = 8;
    // Torque from wheel reaction opposes tilt.
    const torque = -kP * err - kD * tiltVel;
    // Linear acceleration at wheel == torque (simplified).
    const wheelAcc_mm_s2 = torque * 1000;
    // Integrate to get new wheel velocity from this sim-induced correction.
    // (Firmware commands are vWheel; the correction adds the balance reaction.)
    const vTotal = vWheel + wheelAcc_mm_s2 * dt * 0; // ignore double-count
    void vTotal;
    // Gravity pulls the pendulum over.
    const pendulumLen = 80; // mm (CoM above axle)
    const gAccel = (g / pendulumLen) * Math.sin(tilt);
    // Reaction from wheels accelerating counteracts tilt.
    const reaction = -wheelAcc_mm_s2 / pendulumLen * Math.cos(tilt);
    tiltVel += (gAccel + reaction) * dt;
    // Damping
    tiltVel *= 0.995;
    tilt += tiltVel * dt;
  } else {
    // No closed loop → just fall under gravity.
    const pendulumLen = 80;
    const gAccel = (g / pendulumLen) * Math.sin(tilt);
    tiltVel += gAccel * dt;
    tiltVel *= 0.99;
    tilt += tiltVel * dt;
  }

  // Clamp
  if (Math.abs(tilt) > Math.PI/2) {
    tilt = Math.sign(tilt) * Math.PI/2;
    tiltVel = 0;
  }

  const newRotY = pose.rotY + omega * dt;
  const dxLocal = vWheel * dt;
  const dx = Math.sin(newRotY) * dxLocal;
  const dz = Math.cos(newRotY) * dxLocal;

  // When upright, chassis sits with axle at y = wheelRadius. When fallen,
  // lower the body so it rests on the side.
  const wheelR = wheelDiam / 2;
  const yUp = wheelR + 110; // approximate top-of-chassis height when upright
  const yFallen = wheelR + 5;
  const fallK = Math.min(1, Math.abs(tilt) / maxTilt);
  const y = yUp * (1 - fallK) + yFallen * fallK;

  return { ...pose, x: pose.x + dx, z: pose.z + dz, rotY: newRotY, tilt, tiltVel, vy: 0, y };
}

/** Mecanum (holonomic) drive: wheels at 45°, independent vx/vy/ω. */
function stepMecanum(pose: ChassisPose, motors: MotorInput[], spec: AssemblySpec, dt: number): ChassisPose {
  const wheelDiam = spec.wheel?.diameterMm ?? 100;
  const circ = Math.PI * wheelDiam;
  const wheelbase = spec.kinematics?.wheelbaseMm ?? 180;
  const track = spec.kinematics?.trackMm ?? 240;
  const deadband = spec.kinematics?.deadbandRps ?? 0.05;
  const v = (slot: MotorInput['slot']) => {
    const m = motors.find(x => x.slot === slot);
    return m && Math.abs(m.turnsPerSecond) > deadband ? m.turnsPerSecond : 0;
  };
  const vfl = v('fl'), vfr = v('fr'), vrl = v('rl'), vrr = v('rr');
  // Standard mecanum inverse → forward (wheel circ in mm/s):
  // vx = (fl+fr+rl+rr)/4 * circ
  // vy = (-fl+fr+rl-rr)/4 * circ  (strafe)
  // w  = (-fl+fr-rl+rr)/(4*(L+W)/2) * circ
  const vx = ( vfl + vfr + vrl + vrr) / 4 * circ;
  const vy = (-vfl + vfr + vrl - vrr) / 4 * circ;
  const LpW = (wheelbase + track) / 2;
  const w = (-vfl + vfr - vrl + vrr) / (4 * LpW) * circ;
  const newRotY = pose.rotY + w * dt;
  // Rotate (vx,vy) from local to world (local +x = forward +Z in world? Match diff drive)
  // Keep convention: local +x forward → world dx=sin(rotY)*dxL, dz=cos(rotY)*dxL.
  // For mecanum, local "strafe right" is +z local.
  const fwd = vx * dt;
  const str = vy * dt;
  const dx = Math.sin(newRotY) * fwd + Math.cos(newRotY) * str;
  const dz = Math.cos(newRotY) * fwd - Math.sin(newRotY) * str;
  return { ...pose, x: pose.x + dx, z: pose.z + dz, rotY: newRotY, tilt: 0, tiltVel: 0, vy: 0, y: pose.y };
}

/** Quadcopter: collective lift + roll/pitch/yaw from 4 motors. */
function stepQuadcopter(pose: ChassisPose, motors: MotorInput[], spec: AssemblySpec, dt: number): ChassisPose {
  const liftK = spec.kinematics?.liftK ?? 0.003;
  const g = spec.kinematics?.gravity ?? 9810;
  const mass = spec.kinematics?.massKg ?? 0.8;
  const deadband = spec.kinematics?.deadbandRps ?? 0.5;
  const get = (slot: MotorInput['slot']) => {
    const m = motors.find(x => x.slot === slot);
    return m && m.turnsPerSecond > deadband ? m.turnsPerSecond : 0;
  };
  // m1=FR(cw), m2=FL(ccw), m3=RL(cw), m4=RR(ccw) typical X-frame
  const m1 = get('m1'), m2 = get('m2'), m3 = get('m3'), m4 = get('m4');
  const totalThrust = (m1 + m2 + m3 + m4) * liftK; // N-ish
  // Net vertical acceleration (mm/s^2)
  const weightN = mass * g / 1000;
  const ay = (totalThrust - weightN) / mass * 1000; // mm/s^2
  let vy = pose.vy + ay * dt;
  vy *= 0.995; // drag
  let y = pose.y + vy * dt;
  if (y < 0) { y = 0; vy = 0; }
  // Differential thrust → yaw rate (extremely simplified)
  const yawTorque = (m1 - m2 + m3 - m4) - (m2 - m1 + m4 - m3);
  const rotY = pose.rotY + yawTorque * 0.002 * dt;
  return { ...pose, y, vy, rotY, x: pose.x, z: pose.z, tilt: pose.tilt, tiltVel: pose.tiltVel };
}

function stepStatic(pose: ChassisPose, _motors: MotorInput[], _spec: AssemblySpec, _dt: number): ChassisPose {
  return pose;
}

export function stepChassis(pose: ChassisPose, motors: MotorInput[], spec: AssemblySpec, dt: number): ChassisPose {
  switch (spec.kinematics?.model) {
    case 'differential_drive': return stepDifferential(pose, motors, spec, dt);
    case 'inverted_pendulum':  return stepBalancer(pose, motors, spec, dt);
    case 'mecanum':            return stepMecanum(pose, motors, spec, dt);
    case 'quadcopter':
    case 'hexacopter':         return stepQuadcopter(pose, motors, spec, dt);
    case 'static':
    default:                   return stepStatic(pose, motors, spec, dt);
  }
}
