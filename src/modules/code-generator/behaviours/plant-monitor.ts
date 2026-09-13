/**
 * Plant / soil moisture monitor with optional pump relay and climate sensor.
 */

import type { SketchContext } from '../templates';
import {
  buildIncludesBlock,
  buildPinMapBlock,
  constantName,
  i2cBusInitLines,
} from '../managed-blocks';

export interface PlantMonitorHit {
  moistureInstanceId: string;
  pumpInstanceId?: string;
  dhtInstanceId?: string;
  ledInstanceId?: string;
}

export function detectPlantMonitor(ctx: SketchContext): PlantMonitorHit | null {
  const brief = `${ctx.projectName} ${ctx.projectSummary} ${ctx.requirements.goal} ${ctx.requirements.features.join(' ')}`.toLowerCase();
  const soilish = /soil|moisture|plant|irrigation|garden|water/.test(brief) || ctx.requirements.features.includes('soil_moisture');
  if (!soilish) return null;

  const moisture = ctx.selections.find(
    (s) => /soil|moisture/i.test(s.componentId) || /soil|moisture/i.test(s.name),
  );
  if (!moisture?.instances[0]) return null;

  const pump = ctx.selections.find((s) => /relay|pump/i.test(s.componentId) || /relay|pump/i.test(s.name));
  const dht = ctx.selections.find((s) => /dht/i.test(s.componentId));
  const led = ctx.selections.find((s) => s.category === 'actuator' && /led/i.test(s.componentId) && !/rgb/i.test(s.componentId));

  return {
    moistureInstanceId: moisture.instances[0].instanceId,
    ...(pump?.instances[0] ? { pumpInstanceId: pump.instances[0].instanceId } : {}),
    ...(dht?.instances[0] ? { dhtInstanceId: dht.instances[0].instanceId } : {}),
    ...(led?.instances[0] ? { ledInstanceId: led.instances[0].instanceId } : {}),
  };
}

function pinConst(ctx: SketchContext, instanceId: string, pinHint?: string): string | null {
  const assignment = ctx.assignments.find(
    (a) =>
      a.targetInstanceId === instanceId &&
      (pinHint ? a.targetPin.toLowerCase() === pinHint.toLowerCase() : true),
  );
  return assignment ? constantName(assignment) : null;
}

export function buildPlantMonitorSketch(ctx: SketchContext, hit: PlantMonitorHit): string {
  const lines: string[] = [];
  const platformIsEsp32 = /esp32/i.test(ctx.controllerName);
  const moisturePin = pinConst(ctx, hit.moistureInstanceId);
  const pumpPin = hit.pumpInstanceId ? pinConst(ctx, hit.pumpInstanceId) : null;
  const ledPin = hit.ledInstanceId ? pinConst(ctx, hit.ledInstanceId) : null;
  const dhtPin = hit.dhtInstanceId ? pinConst(ctx, hit.dhtInstanceId) : null;
  const dhtType = hit.dhtInstanceId && /dht11/i.test(hit.dhtInstanceId) ? 'DHT11' : 'DHT22';

  lines.push(`/*`);
  lines.push(` * ${ctx.projectName}`);
  lines.push(` * Plant / soil monitor — Wireup behaviour: plant-monitor`);
  lines.push(` * Controller: ${ctx.controllerName}`);
  lines.push(` */`);
  lines.push('');
  lines.push(buildIncludesBlock(ctx.softwarePlan.libraries, platformIsEsp32));
  lines.push('');
  lines.push(buildPinMapBlock(ctx.assignments, ctx.profile));
  lines.push('');
  lines.push('#define controlLink Serial');
  lines.push('const uint32_t LINK_BAUD = 115200;');
  lines.push('const int DRY_THRESHOLD = 2800; // tune per probe + ADC');
  lines.push('const int WET_THRESHOLD = 1800;');
  lines.push('const uint32_t PUMP_MS = 3000;');
  lines.push('const uint32_t SAMPLE_MS = 2000;');
  lines.push('int soilRaw = 0;');
  lines.push('bool soilDry = false;');
  lines.push('uint32_t lastSampleAt = 0;');
  lines.push('uint32_t pumpUntil = 0;');
  if (dhtPin) {
    lines.push(`DHT dhtSensor(${dhtPin}, ${dhtType});`);
    lines.push('float temperatureC = 0.0f;');
    lines.push('float humidityPercent = 0.0f;');
  }
  lines.push('');
  lines.push('void sendTelemetry() {');
  lines.push('  controlLink.print("status:{\\"soil\\":");');
  lines.push('  controlLink.print(soilRaw);');
  lines.push('  controlLink.print(",\\"dry\\":");');
  lines.push('  controlLink.print(soilDry ? "true" : "false");');
  if (dhtPin) {
    lines.push('  controlLink.print(",\\"tempC\\":");');
    lines.push('  controlLink.print(temperatureC, 1);');
    lines.push('  controlLink.print(",\\"rh\\":");');
    lines.push('  controlLink.print(humidityPercent, 1);');
  }
  lines.push('  controlLink.println("}");');
  lines.push('}');
  lines.push('');
  lines.push('void setup() {');
  lines.push('  Serial.begin(115200);');
  lines.push('  controlLink.begin(LINK_BAUD);');
  if (moisturePin) lines.push(`  pinMode(${moisturePin}, INPUT);`);
  if (pumpPin) {
    lines.push(`  pinMode(${pumpPin}, OUTPUT);`);
    lines.push(`  digitalWrite(${pumpPin}, HIGH); // active-low relay idle`);
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
  if (dhtPin) lines.push('  dhtSensor.begin();');
  lines.push('  lastSampleAt = millis();');
  lines.push('}');
  lines.push('');
  lines.push('void loop() {');
  lines.push('  uint32_t now = millis();');
  if (pumpPin) {
    lines.push('  if (pumpUntil != 0 && now >= pumpUntil) {');
    lines.push(`    digitalWrite(${pumpPin}, HIGH);`);
    lines.push('    pumpUntil = 0;');
    lines.push('  }');
  }
  lines.push('  if (now - lastSampleAt < SAMPLE_MS) return;');
  lines.push('  lastSampleAt = now;');
  if (moisturePin) {
    lines.push(`  soilRaw = analogRead(${moisturePin});`);
    lines.push('  soilDry = soilRaw > DRY_THRESHOLD;');
  }
  if (ledPin) lines.push(`  digitalWrite(${ledPin}, soilDry ? HIGH : LOW);`);
  if (pumpPin) {
    lines.push('  if (soilDry && pumpUntil == 0) {');
    lines.push(`    digitalWrite(${pumpPin}, LOW);`);
    lines.push('    pumpUntil = now + PUMP_MS;');
    lines.push('    controlLink.println("ok:pump");');
    lines.push('  }');
  }
  if (dhtPin) {
    lines.push('  float t = dhtSensor.readTemperature();');
    lines.push('  float h = dhtSensor.readHumidity();');
    lines.push('  if (!isnan(t) && !isnan(h)) { temperatureC = t; humidityPercent = h; }');
  }
  lines.push('  sendTelemetry();');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}
