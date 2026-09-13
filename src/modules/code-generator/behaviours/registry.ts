/**
 * Behaviour registry — data-driven dispatch instead of two hard-coded sketches.
 *
 * Each behaviour detects from structural + prompt signals and either:
 *   • owns the entire sketch (exclusive), or
 *   • defers to the generic template (scored for telemetry / product metrics).
 *
 * Adding a product class = one file + one register() call.
 */

import type { SketchContext } from '../templates';
import { buildAccessControlSketch, detectAccessControl } from './access-control';
import { buildLineFollowerSketch, detectLineFollower } from './line-follower';
import { buildPlantMonitorSketch, detectPlantMonitor } from './plant-monitor';
import { buildMotionAlarmSketch, detectMotionAlarm } from './motion-alarm';
import { buildTelemetryStationSketch, detectTelemetryStation } from './telemetry-station';
import { detectRcVehicle } from './rc-vehicle';

export interface BehaviourMatch {
  id: string;
  name: string;
  confidence: number;
  /** When true, this behaviour owns the entire sketch. */
  exclusive: boolean;
  /** Present when exclusive — builds the full .ino source. */
  build?: (ctx: SketchContext) => string;
}

export type BehaviourDetector = (ctx: SketchContext) => BehaviourMatch | null;

const detectors: BehaviourDetector[] = [];
let defaultsRegistered = false;

export function registerBehaviour(detector: BehaviourDetector): void {
  detectors.push(detector);
}

function registerDefaults(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;

  registerBehaviour((ctx) => {
    const hit = detectAccessControl(ctx);
    if (!hit) return null;
    return {
      id: 'access-control',
      name: 'Access control / lock',
      confidence: 0.95,
      exclusive: true,
      build: (c) => buildAccessControlSketch(c, hit),
    };
  });

  registerBehaviour((ctx) => {
    const hit = detectLineFollower(ctx);
    if (!hit) return null;
    return {
      id: 'line-follower',
      name: 'Line follower robot',
      confidence: 0.95,
      exclusive: true,
      build: (c) => buildLineFollowerSketch(c, hit),
    };
  });

  registerBehaviour((ctx) => {
    const hit = detectPlantMonitor(ctx);
    if (!hit) return null;
    return {
      id: 'plant-monitor',
      name: 'Plant / soil monitor',
      confidence: 0.9,
      exclusive: true,
      build: (c) => buildPlantMonitorSketch(c, hit),
    };
  });

  registerBehaviour((ctx) => {
    const hit = detectMotionAlarm(ctx);
    if (!hit) return null;
    return {
      id: 'motion-alarm',
      name: 'Motion alarm / security node',
      confidence: 0.9,
      exclusive: true,
      build: (c) => buildMotionAlarmSketch(c, hit),
    };
  });

  registerBehaviour((ctx) => {
    const hit = detectTelemetryStation(ctx);
    if (!hit) return null;
    return {
      id: 'telemetry-station',
      name: 'Sensor telemetry station',
      confidence: 0.82,
      exclusive: true,
      build: (c) => buildTelemetryStationSketch(c, hit),
    };
  });

  // RC vehicle: scored so product metrics see it; sketch stays on generic
  // motor+command path (already correct for drive channels + failsafe).
  registerBehaviour((ctx) => {
    const hit = detectRcVehicle(ctx);
    if (!hit) return null;
    return {
      id: 'rc-vehicle',
      name: 'RC / remote vehicle',
      confidence: 0.85,
      exclusive: false,
    };
  });
}

/** Best exclusive behaviour that can build a full sketch. */
export function resolveExclusiveBehaviour(ctx: SketchContext): BehaviourMatch | null {
  registerDefaults();
  let best: BehaviourMatch | null = null;
  for (const detect of detectors) {
    const match = detect(ctx);
    if (!match?.exclusive || !match.build) continue;
    if (!best || match.confidence > best.confidence) best = match;
  }
  return best && best.confidence >= 0.75 ? best : null;
}

/** All matches (exclusive + scored) for telemetry / UI. */
export function matchBehaviours(ctx: SketchContext): BehaviourMatch[] {
  registerDefaults();
  const hits: BehaviourMatch[] = [];
  for (const detect of detectors) {
    const match = detect(ctx);
    if (match) hits.push(match);
  }
  return hits.sort((a, b) => b.confidence - a.confidence);
}

export function listRegisteredBehaviourIds(): string[] {
  registerDefaults();
  return ['access-control', 'line-follower', 'rc-vehicle', 'plant-monitor', 'motion-alarm', 'telemetry-station'];
}
