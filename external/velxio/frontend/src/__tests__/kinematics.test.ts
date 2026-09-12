/**
 * Kinematics contract tests — verifies each model produces sane integration
 * for the basic cases: straight-line drive, in-place turn, hover, etc.
 */

import { describe, expect, it } from 'vitest';
import { stepChassis, type ChassisPose, type MotorInput } from '../scene3d/assembly/kinematics';
import { getArchetype } from '../scene3d/assembly/archetypes';

const START: ChassisPose = { x: 0, y: 0, z: 0, rotY: 0, tilt: 0, tiltVel: 0, vy: 0 };
const DT = 1 / 60;

function run(spec: ReturnType<typeof getArchetype>, motors: MotorInput[], steps = 60): ChassisPose {
  let pose = { ...START };
  for (let i = 0; i < steps; i++) pose = stepChassis(pose, motors, spec, DT);
  return pose;
}

describe('differential_drive (2wd rover)', () => {
  const spec = getArchetype('2wd_rover');

  it('drives forward when both motors spin the same direction', () => {
    // 1 tps × π×65mm circumference × (60/60)s ≈ 204mm forward in 1 second.
    const pose = run(spec, [
      { turnsPerSecond: 1, slot: 'left' },
      { turnsPerSecond: 1, slot: 'right' },
    ], 60);
    expect(Math.abs(pose.x)).toBeLessThan(5);   // lateral ≈ 0
    expect(pose.z).toBeGreaterThan(180);        // forward along +Z in local frame
    expect(Math.abs(pose.rotY)).toBeLessThan(0.01);
  });

  it('turns in place when motors run opposite directions', () => {
    const pose = run(spec, [
      { turnsPerSecond: 1, slot: 'left' },
      { turnsPerSecond: -1, slot: 'right' },
    ], 60);
    // No net displacement, significant rotation.
    expect(Math.hypot(pose.x, pose.z)).toBeLessThan(5);
    expect(Math.abs(pose.rotY)).toBeGreaterThan(0.5);
  });

  it('does not move under deadband', () => {
    const pose = run(spec, [
      { turnsPerSecond: 0.01, slot: 'left' },
      { turnsPerSecond: 0.01, slot: 'right' },
    ], 60);
    expect(Math.hypot(pose.x, pose.z)).toBeLessThan(1);
  });
});

describe('mecanum', () => {
  const spec = getArchetype('mecanum');

  it('strafes sideways when FL≠FR and RL≠RR diagonally', () => {
    // Diagonal rollers: fl-, fr+, rl+, rr- → strafe in +x (world x)
    const pose = run(spec, [
      { turnsPerSecond: -1, slot: 'fl' },
      { turnsPerSecond:  1, slot: 'fr' },
      { turnsPerSecond:  1, slot: 'rl' },
      { turnsPerSecond: -1, slot: 'rr' },
    ], 60);
    // Should move laterally with minimal forward displacement.
    expect(Math.abs(pose.z)).toBeLessThan(40);
    expect(Math.abs(pose.x)).toBeGreaterThan(50);
  });
});

describe('quadcopter', () => {
  const spec = getArchetype('quadcopter');

  it('sits on the ground when motors are off', () => {
    const pose = run(spec, [], 60);
    expect(pose.y).toBeLessThanOrEqual(0);
    expect(pose.vy).toBeLessThanOrEqual(0);
  });
});

describe('static bench', () => {
  const spec = getArchetype('static');
  it('never moves even with motors running', () => {
    const pose = run(spec, [
      { turnsPerSecond: 100, slot: 'left' },
      { turnsPerSecond: 100, slot: 'right' },
    ], 60);
    expect(pose.x).toBe(0);
    expect(pose.z).toBe(0);
    expect(pose.rotY).toBe(0);
  });
});

describe('self_balancer inverted pendulum', () => {
  const spec = getArchetype('self_balancer');

  it('starts upright at origin', () => {
    const pose = { ...START };
    const after = stepChassis(pose, [], spec, DT);
    expect(after.tilt).toBeCloseTo(0, 3);
    expect(after.y).toBeGreaterThan(50); // body elevated
  });
});
