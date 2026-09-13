/**
 * Motion / security node: PIR (+ optional IMU) → buzzer/LED + telemetry.
 */

import type { SketchContext } from '../templates';
import { buildIncludesBlock, buildPinMapBlock, constantName, i2cBusInitLines } from '../managed-blocks';

export interface MotionAlarmHit {
  pirInstanceId: string;
  buzzerInstanceId?: string;
  ledInstanceId?: string;
}

export function detectMotionAlarm(ctx: SketchContext): MotionAlarmHit | null {
  const brief = `${ctx.projectName} ${ctx.projectSummary} ${ctx.requirements.goal} ${ctx.requirements.features.join(' ')}`.toLowerCase();
  const wants =
    /motion|pir|alarm|intruder|security|tamper/.test(brief) ||
    ctx.requirements.features.includes('motion');
  if (!wants) return null;

  const pir = ctx.selections.find((s) => /pir|sr501|motion/i.test(s.componentId) || /pir|motion/i.test(s.name));
  if (!pir?.instances[0]) return null;

  const buzzer = ctx.selections.find((s) => /buzzer|piezo/i.test(s.componentId));
  const led = ctx.selections.find((s) => s.category === 'actuator' && /led|rgb/i.test(s.componentId));

  return {
    pirInstanceId: pir.instances[0].instanceId,
    ...(buzzer?.instances[0] ? { buzzerInstanceId: buzzer.instances[0].instanceId } : {}),
    ...(led?.instances[0] ? { ledInstanceId: led.instances[0].instanceId } : {}),
  };
}

function pinConst(ctx: SketchContext, instanceId: string): string | null {
  const a = ctx.assignments.find((x) => x.targetInstanceId === instanceId);
  return a ? constantName(a) : null;
}

export function buildMotionAlarmSketch(ctx: SketchContext, hit: MotionAlarmHit): string {
  const lines: string[] = [];
  const platformIsEsp32 = /esp32/i.test(ctx.controllerName);
  const pirPin = pinConst(ctx, hit.pirInstanceId);
  const buzzerPin = hit.buzzerInstanceId ? pinConst(ctx, hit.buzzerInstanceId) : null;
  const ledPin = hit.ledInstanceId ? pinConst(ctx, hit.ledInstanceId) : null;

  lines.push(`/*`);
  lines.push(` * ${ctx.projectName}`);
  lines.push(` * Motion alarm — Wireup behaviour: motion-alarm`);
  lines.push(` * Controller: ${ctx.controllerName}`);
  lines.push(` */`);
  lines.push('');
  lines.push(buildIncludesBlock(ctx.softwarePlan.libraries, platformIsEsp32));
  lines.push('');
  lines.push(buildPinMapBlock(ctx.assignments, ctx.profile));
  lines.push('');
  lines.push('#define controlLink Serial');
  lines.push('const uint32_t LINK_BAUD = 115200;');
  lines.push('const uint32_t SAMPLE_MS = 100;');
  lines.push('const uint32_t ALARM_HOLD_MS = 5000;');
  lines.push('bool motion = false;');
  lines.push('uint32_t alarmUntil = 0;');
  lines.push('uint32_t lastSampleAt = 0;');
  lines.push('');
  lines.push('void sendTelemetry() {');
  lines.push('  controlLink.print("status:{\\"motion\\":");');
  lines.push('  controlLink.print(motion ? "true" : "false");');
  lines.push('  controlLink.print(",\\"alarm\\":");');
  lines.push('  controlLink.print(alarmUntil > millis() ? "true" : "false");');
  lines.push('  controlLink.println("}");');
  lines.push('}');
  lines.push('');
  lines.push('void setup() {');
  lines.push('  Serial.begin(115200);');
  lines.push('  controlLink.begin(LINK_BAUD);');
  if (pirPin) lines.push(`  pinMode(${pirPin}, INPUT);`);
  if (buzzerPin) {
    lines.push(`  pinMode(${buzzerPin}, OUTPUT);`);
    lines.push(`  digitalWrite(${buzzerPin}, LOW);`);
  }
  if (ledPin) {
    lines.push(`  pinMode(${ledPin}, OUTPUT);`);
    lines.push(`  digitalWrite(${ledPin}, LOW);`);
  }
  if (ctx.i2cBuses.length > 0) {
    for (const line of i2cBusInitLines({
      assignments: ctx.assignments,
      buses: ctx.i2cBuses,
      ...(ctx.profile ? { profile: ctx.profile } : {}),
      linkIdentifier: 'controlLink',
    })) {
      lines.push(`  ${line}`);
    }
  }
  lines.push('}');
  lines.push('');
  lines.push('void loop() {');
  lines.push('  uint32_t now = millis();');
  lines.push('  if (now - lastSampleAt < SAMPLE_MS) return;');
  lines.push('  lastSampleAt = now;');
  if (pirPin) {
    lines.push(`  motion = digitalRead(${pirPin}) == HIGH;`);
    lines.push('  if (motion) alarmUntil = now + ALARM_HOLD_MS;');
  }
  lines.push('  bool alarm = alarmUntil > now;');
  if (buzzerPin) lines.push(`  digitalWrite(${buzzerPin}, alarm ? HIGH : LOW);`);
  if (ledPin) lines.push(`  digitalWrite(${ledPin}, alarm ? HIGH : LOW);`);
  lines.push('  static uint32_t lastTelem = 0;');
  lines.push('  if (now - lastTelem >= 1000) { lastTelem = now; sendTelemetry(); }');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}
