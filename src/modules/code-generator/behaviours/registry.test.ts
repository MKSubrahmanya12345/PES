import { describe, expect, it } from 'vitest';

import { listRegisteredBehaviourIds, resolveExclusiveBehaviour } from './registry';
import type { SketchContext } from '../templates';

function emptyCtx(overrides: Partial<SketchContext> = {}): SketchContext {
  return {
    projectName: 'Test',
    projectSummary: '',
    requirements: {
      goal: '',
      summary: '',
      requirements: [],
      inputs: [],
      outputs: [],
      behaviors: [],
      constraints: [],
      platformRequirements: [],
      communicationRequirements: [],
      powerRequirements: [],
      quantities: {},
      features: [],
      assumptions: [],
      ambiguities: [],
    },
    selections: [],
    catalog: [],
    assignments: [],
    serialLinks: [],
    i2cBuses: [],
    softwarePlan: {
      architecture: '',
      language: 'arduino-cpp',
      modules: [],
      libraries: [],
      controlStates: [],
      inputHandling: [],
      sensorLogic: [],
      actuatorLogic: [],
      communication: null,
      safety: [],
      loopStrategy: '',
      files: [],
    },
    controllerName: 'Arduino Uno',
    revision: 1,
    ...overrides,
  };
}

describe('behaviour registry', () => {
  it('lists product behaviours beyond the original two', () => {
    const ids = listRegisteredBehaviourIds();
    expect(ids).toContain('access-control');
    expect(ids).toContain('line-follower');
    expect(ids).toContain('plant-monitor');
    expect(ids).toContain('motion-alarm');
    expect(ids).toContain('telemetry-station');
    expect(ids).toContain('rc-vehicle');
    expect(ids.length).toBeGreaterThanOrEqual(6);
  });

  it('selects plant-monitor for soil moisture briefs', () => {
    const ctx = emptyCtx({
      projectName: 'Plant care',
      projectSummary: 'Water plants when soil is dry',
      requirements: {
        ...emptyCtx().requirements,
        goal: 'Arduino plant watering monitor with soil moisture and pump',
        features: ['soil_moisture'],
      },
      selections: [
        {
          id: 'sel1',
          componentId: 'soil-moisture',
          name: 'Soil moisture',
          category: 'sensor',
          role: 'sensor',
          quantity: 1,
          reason: 'test',
          required: true,
          instances: [{ instanceId: 'soil_1', componentId: 'soil-moisture', name: 'Soil', index: 1, label: 'Soil', category: 'sensor' }],
          source: 'catalog',
        },
      ],
      assignments: [
        {
          id: 'a1',
          mcuInstanceId: 'uno_1',
          mcuComponentId: 'arduino-uno',
          pin: 'A0',
          targetInstanceId: 'soil_1',
          targetComponentId: 'soil-moisture',
          targetPin: 'AO',
          purpose: 'soil moisture sense',
          signal: 'analog',
          protocol: 'adc',
          direction: 'input',
          required: true,
          rationale: 'test',
          source: 'planner',
        },
      ],
    });
    const match = resolveExclusiveBehaviour(ctx);
    expect(match?.id).toBe('plant-monitor');
    expect(match?.build?.(ctx)).toContain('plant-monitor');
    expect(match?.build?.(ctx)).toContain('void setup');
  });

  it('selects motion-alarm for PIR security briefs', () => {
    const ctx = emptyCtx({
      requirements: {
        ...emptyCtx().requirements,
        goal: 'ESP32 motion alarm with PIR and buzzer',
        features: ['motion'],
      },
      selections: [
        {
          id: 'sel1',
          componentId: 'pir-hc-sr501',
          name: 'PIR',
          category: 'sensor',
          role: 'sensor',
          quantity: 1,
          reason: 'test',
          required: true,
          instances: [{ instanceId: 'pir_1', componentId: 'pir-hc-sr501', name: 'PIR', index: 1, label: 'PIR', category: 'sensor' }],
          source: 'catalog',
        },
      ],
      assignments: [
        {
          id: 'a1',
          mcuInstanceId: 'esp_1',
          mcuComponentId: 'esp32',
          pin: 'D15',
          targetInstanceId: 'pir_1',
          targetComponentId: 'pir-hc-sr501',
          targetPin: 'OUT',
          purpose: 'motion sense',
          signal: 'digital',
          protocol: 'gpio',
          direction: 'input',
          required: true,
          rationale: 'test',
          source: 'planner',
        },
      ],
    });
    const match = resolveExclusiveBehaviour(ctx);
    expect(match?.id).toBe('motion-alarm');
  });
});
