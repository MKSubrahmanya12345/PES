/**
 * RC / Bluetooth vehicle detector.
 * Sketch body is still produced by the generic motor+command template;
 * this module exists so the registry can name and score the product class
 * and so future RC-only overlays (ultrasonic brake, trim) land here.
 */

import type { SketchContext } from '../templates';

export interface RcVehicleHit {
  motorChannels: number;
}

export function detectRcVehicle(ctx: SketchContext): RcVehicleHit | null {
  const brief = `${ctx.projectName} ${ctx.projectSummary} ${ctx.requirements.goal} ${ctx.requirements.features.join(' ')}`.toLowerCase();
  const vehicle =
    /rc[-\s]*car|robot[-\s]*car|rover|tank|remote[-\s]*control|bluetooth.*motor|motor.*bluetooth/.test(brief) ||
    (ctx.requirements.features.includes('motor_control') &&
      (ctx.requirements.features.includes('bluetooth') || ctx.requirements.features.includes('wifi')));
  if (!vehicle) return null;

  const drivers = ctx.selections.filter((s) => s.category === 'motor_driver');
  const motors = ctx.selections.filter((s) => s.category === 'motor');
  if (drivers.length === 0 && motors.length === 0) return null;

  return { motorChannels: Math.max(motors.reduce((n, s) => n + s.quantity, 0), drivers.length > 0 ? 2 : 0) };
}
