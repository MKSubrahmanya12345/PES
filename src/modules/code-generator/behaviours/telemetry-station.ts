/**
 * Generic multi-sensor telemetry station (DHT, light, gas, etc.) with serial JSON.
 */

import type { SketchContext } from '../templates';
import { buildIncludesBlock, buildPinMapBlock, constantName, i2cBusInitLines, isAnalogAssignment as assignmentIsAnalog } from '../managed-blocks';

export interface TelemetryStationHit {
  sensorCount: number;
}

export function detectTelemetryStation(ctx: SketchContext): TelemetryStationHit | null {
  const sensors = ctx.selections.filter((s) => s.category === 'sensor' || s.role === 'sensor');
  const motors = ctx.selections.filter((s) => s.category === 'motor' || s.category === 'motor_driver');
  const brief = `${ctx.requirements.goal} ${ctx.requirements.features.join(' ')}`.toLowerCase();
  const wants =
    ctx.requirements.features.includes('telemetry') ||
    /weather|station|monitor|logger|dashboard|sensor\s*data/.test(brief);
  if (sensors.length < 1) return null;
  if (motors.length > 0 && !wants) return null;
  if (!wants && sensors.length < 2) return null;
  return { sensorCount: sensors.length };
}

export function buildTelemetryStationSketch(ctx: SketchContext, _hit: TelemetryStationHit): string {
  const lines: string[] = [];
  const platformIsEsp32 = /esp32/i.test(ctx.controllerName);
  const analog = ctx.assignments.filter((a) => a.protocol === 'adc' || assignmentIsAnalog(a));
  const dht = ctx.selections.find((s) => /dht/i.test(s.componentId));
  const dhtAssignment = dht?.instances[0]
    ? ctx.assignments.find((a) => a.targetInstanceId === dht.instances[0]!.instanceId)
    : undefined;

  lines.push(`/*`);
  lines.push(` * ${ctx.projectName}`);
  lines.push(` * Telemetry station — Wireup behaviour: telemetry-station`);
  lines.push(` * Controller: ${ctx.controllerName}`);
  lines.push(` */`);
  lines.push('');
  lines.push(buildIncludesBlock(ctx.softwarePlan.libraries, platformIsEsp32));
  lines.push('');
  lines.push(buildPinMapBlock(ctx.assignments, ctx.profile));
  lines.push('');
  lines.push('#define controlLink Serial');
  lines.push('const uint32_t LINK_BAUD = 115200;');
  lines.push('const uint32_t TELEMETRY_MS = 1000;');
  lines.push('uint32_t lastTelemAt = 0;');
  if (dhtAssignment) {
    const kind = /dht11/i.test(dht?.componentId ?? '') ? 'DHT11' : 'DHT22';
    lines.push(`DHT dhtSensor(${constantName(dhtAssignment)}, ${kind});`);
    lines.push('float temperatureC = 0.0f;');
    lines.push('float humidityPercent = 0.0f;');
  }
  lines.push('');
  lines.push('void sendTelemetry() {');
  lines.push('  controlLink.print("status:{");');
  let first = true;
  if (dhtAssignment) {
    lines.push('  controlLink.print("\\"tempC\\":");');
    lines.push('  controlLink.print(temperatureC, 1);');
    lines.push('  controlLink.print(",\\"rh\\":");');
    lines.push('  controlLink.print(humidityPercent, 1);');
    first = false;
  }
  for (const assignment of analog) {
    const field = assignment.targetInstanceId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    if (!first) lines.push('  controlLink.print(",");');
    first = false;
    lines.push(`  controlLink.print("\\"${field}\\":");`);
    lines.push(`  controlLink.print(analogRead(${constantName(assignment)}));`);
  }
  lines.push('  controlLink.println("}");');
  lines.push('}');
  lines.push('');
  lines.push('void setup() {');
  lines.push('  Serial.begin(115200);');
  lines.push('  controlLink.begin(LINK_BAUD);');
  for (const assignment of ctx.assignments.filter((a) => a.direction === 'input' && a.protocol !== 'i2c')) {
    lines.push(`  pinMode(${constantName(assignment)}, INPUT);`);
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
  if (dhtAssignment) lines.push('  dhtSensor.begin();');
  lines.push('}');
  lines.push('');
  lines.push('void loop() {');
  lines.push('  uint32_t now = millis();');
  lines.push('  if (now - lastTelemAt < TELEMETRY_MS) return;');
  lines.push('  lastTelemAt = now;');
  if (dhtAssignment) {
    lines.push('  float t = dhtSensor.readTemperature();');
    lines.push('  float h = dhtSensor.readHumidity();');
    lines.push('  if (!isnan(t) && !isnan(h)) { temperatureC = t; humidityPercent = h; }');
  }
  lines.push('  sendTelemetry();');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}
