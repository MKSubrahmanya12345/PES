/**
 * AGENT TOOLS REGISTRY.
 *
 * Implements the atomic tools the Agent uses to explore the component database,
 * verify physical/electrical constraints, assign MCU pins, route wiring,
 * generate firmware, and run design rule checks.
 */

import type { AgentTool, AgentToolContext } from './types';
import type { ComponentDefinition, ComponentInstance, ComponentPin, ComponentRole, ComponentSelection, PowerBudget } from '@/types/component';
import type { HardwarePlan, SoftwarePlan } from '@/types/project';
import { checkCompatibility } from '@/modules/hardware-planner/compatibility';
import { planPins } from '@/modules/pin-planner';
import { planWiring } from '@/modules/wiring-planner';
import { planSoftware } from '@/modules/software-planner';
import { generateCode } from '@/modules/code-generator';
import { generateLibraries } from '@/modules/libraries-generator';
import { generateDiagram } from '@/modules/diagram-generator';
import { generateInstructions } from '@/modules/instructions-generator';
import { createId } from '@/lib/validation/ids';

const VALID_ROLES = new Set<ComponentRole>([
  'controller',
  'driver',
  'sensor',
  'actuator',
  'communication',
  'power',
  'input',
  'display',
  'passive',
  'prototyping',
  'other',
]);

function toRole(roleCandidate: string, category: string): ComponentRole {
  if (VALID_ROLES.has(roleCandidate as ComponentRole)) return roleCandidate as ComponentRole;
  if (category === 'microcontroller') return 'controller';
  if (category === 'sensor') return 'sensor';
  if (category === 'motor' || category === 'actuator') return 'actuator';
  if (category === 'display') return 'display';
  if (category === 'power') return 'power';
  return 'other';
}

/**
 * Tool 1: search_components
 * Search the component catalog by keywords, category, or interface.
 */
export const searchComponentsTool: AgentTool = {
  schema: {
    name: 'search_components',
    description: 'Search the catalog of real hardware components by keyword, category, or communication protocol.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term e.g. "soil moisture", "oled", "servo", "temp sensor"' },
        category: {
          type: 'string',
          description: 'Filter by category: microcontroller, sensor, display, motor, motor_driver, discrete, power, communication',
        },
      },
      required: ['query'],
    },
  },
  execute: (args, context) => {
    const query = String(args.query || '').toLowerCase().trim();
    const category = args.category ? String(args.category).toLowerCase().trim() : null;
    const catalog = context.blackboard.workingCatalog;

    const matches = catalog.filter((part) => {
      if (category && part.category !== category) return false;
      if (!query) return true;
      const haystack = [
        part.id,
        part.name,
        part.category,
        part.description,
        ...(part.keywords || []),
        ...(part.aliases || []),
      ].join(' ').toLowerCase();
      return query.split(/\s+/).every((word) => haystack.includes(word));
    }).slice(0, 8);

    return {
      success: true,
      message: `Found ${matches.length} matching component(s).`,
      data: matches.map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        voltage: m.voltage,
        maxVoltage: m.maxVoltage,
        protocols: m.communicationProtocols,
        pinCount: m.pins?.length ?? 0,
        pins: m.pins?.map((p: ComponentPin) => `${p.name} (${p.type}/${p.direction})`),
        description: m.description,
      })),
    };
  },
};

/**
 * Tool 2: select_component
 * Select a component instance into the working circuit.
 */
export const selectComponentTool: AgentTool = {
  schema: {
    name: 'select_component',
    description: 'Add a component from the catalog into the active project circuit with a role and quantity.',
    parameters: {
      type: 'object',
      properties: {
        componentId: { type: 'string', description: 'The exact ID of the catalog component (e.g. "esp32-devkit-v1", "sensor-dht22")' },
        role: { type: 'string', description: 'Role in the project (e.g. "Main microcontroller", "Ambient temperature monitor")' },
        quantity: { type: 'number', description: 'Number of instances needed (default: 1)' },
      },
      required: ['componentId'],
    },
  },
  execute: (args, context) => {
    const componentId = String(args.componentId).trim();
    const roleRaw = String(args.role || 'Hardware component').trim();
    const qty = Math.max(1, Math.min(10, Number(args.quantity) || 1));
    const def = context.blackboard.workingCatalog.find((c) => c.id === componentId);

    if (!def) {
      return {
        success: false,
        message: `Component "${componentId}" not found in catalog. Use search_components to find valid component IDs.`,
      };
    }

    const role = toRole(roleRaw, def.category);

    // Check if already selected
    const existing = context.blackboard.selections.find((s) => s.componentId === componentId);
    if (existing) {
      existing.quantity = qty;
      existing.role = role;
      existing.reason = roleRaw;
      return {
        success: true,
        message: `Updated existing component "${def.name}" quantity to ${qty}.`,
        data: existing,
      };
    }

    const instances: ComponentInstance[] = Array.from({ length: qty }, (_, i) => ({
      instanceId: qty > 1 ? `${componentId}-${i + 1}` : `${componentId}-1`,
      componentId: def.id,
      name: def.name,
      index: i + 1,
      label: qty > 1 ? `${def.name} #${i + 1}` : def.name,
      category: def.category,
    }));

    const selection: ComponentSelection = {
      id: createId('sel'),
      componentId: def.id,
      name: def.name,
      category: def.category,
      role,
      quantity: qty,
      reason: roleRaw,
      required: true,
      instances,
      source: 'catalog',
    };

    context.blackboard.selections.push(selection);
    context.events.emit('component_selected', `Selected ${def.name} (${role})`, {
      stage: 'hardware',
      metadata: { componentId: def.id, quantity: qty, role },
    });

    return {
      success: true,
      message: `Selected ${def.name} into the circuit.`,
      data: {
        componentId: def.id,
        name: def.name,
        category: def.category,
        instances: instances.map((ins) => ins.instanceId),
      },
    };
  },
};

/**
 * Tool 3: deselect_component
 * Backtracking: Remove a component from the working circuit if incompatible.
 */
export const deselectComponentTool: AgentTool = {
  schema: {
    name: 'deselect_component',
    description: 'Remove a component instance from the circuit (used to swap incompatible parts or backtrack).',
    parameters: {
      type: 'object',
      properties: {
        componentId: { type: 'string', description: 'Component ID to remove' },
      },
      required: ['componentId'],
    },
  },
  execute: (args, context) => {
    const componentId = String(args.componentId).trim();
    const idx = context.blackboard.selections.findIndex((s) => s.componentId === componentId);
    if (idx === -1) {
      return { success: false, message: `Component "${componentId}" is not currently in the circuit.` };
    }
    context.blackboard.selections.splice(idx, 1);
    // Invalidate downstream dependent plans so they will be recalculated
    context.blackboard.pinAssignments = [];
    context.blackboard.wiring = null;

    context.events.emit('info', `Removed ${componentId} from the circuit for replacement.`, {
      stage: 'hardware',
      metadata: { componentId },
    });

    return {
      success: true,
      message: `Removed ${componentId}. Downstream pin and wire plans cleared for re-routing.`,
    };
  },
};

/**
 * Tool 4: check_compatibility
 * Check electrical and voltage compatibility between selected parts and the controller.
 */
export const checkCompatibilityTool: AgentTool = {
  schema: {
    name: 'check_compatibility',
    description: 'Check electrical, logic-level, and power compatibility for the currently selected components.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  execute: (_args, context) => {
    const selections = context.blackboard.selections;
    const catalog = context.blackboard.workingCatalog;
    const controllerSel = selections.find((s) => {
      const def = catalog.find((c) => c.id === s.componentId);
      return def?.category === 'microcontroller';
    }) ?? null;

    if (!controllerSel) {
      return {
        success: false,
        message: 'No microcontroller is currently selected in the circuit. Select a microcontroller first.',
      };
    }

    const { checks, risks } = checkCompatibility({
      selections,
      catalog,
      controller: controllerSel,
    });
    const incompatible = checks.filter((c) => !c.compatible);

    return {
      success: incompatible.length === 0,
      message: incompatible.length === 0
        ? `All ${checks.length} compatibility checks passed clean.`
        : `Found ${incompatible.length} compatibility issue(s).`,
      data: {
        controller: controllerSel.componentId,
        incompatible: incompatible.map((c) => ({
          partA: c.a,
          partB: c.b,
          reason: c.reason,
        })),
        risks,
      },
    };
  },
};

/**
 * Tool 5: assign_and_verify_pins
 * Assign MCU pins to all peripherals and check for shortages/conflicts.
 */
export const assignPinsTool: AgentTool = {
  schema: {
    name: 'assign_and_verify_pins',
    description: 'Assign microcontroller GPIO pins to all selected peripherals with bus and capability constraints.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  execute: (_args, context) => {
    const selections = context.blackboard.selections;
    const catalog = context.blackboard.workingCatalog;
    const controllerSel = selections.find((s) => {
      const def = catalog.find((c) => c.id === s.componentId);
      return def?.category === 'microcontroller';
    });

    if (!controllerSel) {
      return {
        success: false,
        message: 'Cannot assign pins: No microcontroller is selected in the circuit.',
      };
    }

    const controllerInstanceId = controllerSel.instances[0]?.instanceId;
    const result = planPins({
      selections,
      catalog,
      controllerInstanceId,
      events: context.events,
    });

    context.blackboard.pinAssignments = result.assignments;
    context.blackboard.serialLinks = result.serialLinks;
    context.blackboard.i2cBuses = result.i2cBuses;

    if (result.unassigned.length > 0) {
      return {
        success: false,
        message: `Pin allocation failed: ${result.unassigned.length} pin(s) could not be assigned.`,
        data: {
          assignedCount: result.assignments.length,
          unassigned: result.unassigned.map((u) => `${u.instanceId}.${u.pin}: ${u.reason}`),
          suggestion: 'Consider selecting a microcontroller with more GPIO/analog pins or using an I2C expander.',
        },
      };
    }

    return {
      success: true,
      message: `Successfully assigned all ${result.assignments.length} pins with zero conflicts.`,
      data: {
        assignments: result.assignments.map((a) => ({
          peripheral: `${a.targetInstanceId}.${a.targetPin}`,
          mcuPin: a.pin,
          signalType: a.signal,
        })),
        buses: {
          i2c: result.i2cBuses,
          serial: result.serialLinks,
        },
      },
    };
  },
};

/**
 * Tool 6: route_wiring
 * Route the power rails and signal connections for the design.
 */
export const routeWiringTool: AgentTool = {
  schema: {
    name: 'route_wiring',
    description: 'Route power rails (VCC/3V3/5V/GND) and signal lines based on the allocated pin map.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  execute: (_args, context) => {
    const { selections, pinAssignments, workingCatalog: catalog } = context.blackboard;
    if (pinAssignments.length === 0) {
      return {
        success: false,
        message: 'Cannot route wiring before pins are assigned. Call assign_and_verify_pins first.',
      };
    }

    const controllerSel = selections.find((s) => {
      const def = catalog.find((c) => c.id === s.componentId);
      return def?.category === 'microcontroller';
    });

    const power: PowerBudget = context.blackboard.hardwarePlan?.power || {
      rails: [],
      adequate: true,
      notes: [],
    };

    const wiring = planWiring({
      selections,
      catalog,
      assignments: pinAssignments,
      power,
      controllerInstanceId: controllerSel?.instances[0]?.instanceId,
      serialLinks: context.blackboard.serialLinks,
      events: context.events,
    });

    context.blackboard.wiring = wiring;

    return {
      success: wiring.conflicts.length === 0,
      message: `Routed ${wiring.connections.length} connection(s) across the circuit.`,
      data: {
        totalWires: wiring.connections.length,
        conflicts: wiring.conflicts,
      },
    };
  },
};

/**
 * Tool 7: generate_firmware
 * Synthesize verified sketch firmware and compile-check against the assigned pin map.
 */
export const generateFirmwareTool: AgentTool = {
  schema: {
    name: 'generate_firmware',
    description: 'Author the sketch.ino embedded firmware based on the assigned pins and verified components.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  execute: async (_args, context) => {
    const { selections, pinAssignments, workingCatalog: catalog, requirements } = context.blackboard;
    if (pinAssignments.length === 0) {
      return {
        success: false,
        message: 'Cannot generate firmware: No pins have been assigned yet.',
      };
    }

    const controllerSel = selections.find((s) => {
      const def = catalog.find((c) => c.id === s.componentId);
      return def?.category === 'microcontroller';
    });
    const controllerDef = catalog.find((c) => c.id === controllerSel?.componentId);

    const softwarePlan: SoftwarePlan = planSoftware({
      requirements,
      selections,
      catalog,
      assignments: pinAssignments,
      serialLinks: context.blackboard.serialLinks || [],
      i2cBuses: context.blackboard.i2cBuses || [],
      controllerInstanceId: controllerSel?.instances[0]?.instanceId,
      controllerComponentId: controllerSel?.componentId,
      events: context.events,
    });
    context.blackboard.softwarePlan = softwarePlan;

    const code = await generateCode({
      projectName: context.blackboard.projectName,
      projectSummary: requirements.summary,
      requirements,
      selections,
      catalog,
      assignments: pinAssignments,
      serialLinks: context.blackboard.serialLinks || [],
      i2cBuses: context.blackboard.i2cBuses || [],
      softwarePlan,
      controllerName: controllerDef?.name || 'Arduino',
      revision: 1,
      prompt: context.blackboard.prompt,
      events: context.events,
    });

    context.blackboard.code = code;

    return {
      success: code.files.length > 0,
      message: `Firmware generated: ${code.files.length} file(s).`,
      data: {
        files: code.files.map((f) => f.path),
        notes: code.notes,
      },
    };
  },
};

/**
 * Tool 8: build_artifacts
 * Generate Wokwi/Velxio diagram, required libraries, and step-by-step instructions.
 */
export const buildArtifactsTool: AgentTool = {
  schema: {
    name: 'build_artifacts',
    description: 'Generate supporting engineering artifacts: diagram.json, libraries.json, and instructions.md.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  execute: (_args, context) => {
    const { selections, pinAssignments, wiring, softwarePlan, workingCatalog: catalog, requirements } = context.blackboard;
    if (!wiring) {
      return { success: false, message: 'Wiring must be routed before generating diagrams and instructions.' };
    }

    const controllerSel = selections.find((s) => {
      const def = catalog.find((c) => c.id === s.componentId);
      return def?.category === 'microcontroller';
    });

    const fallbackHardwarePlan: HardwarePlan = context.blackboard.hardwarePlan || {
      summary: requirements.summary,
      architecture: [],
      controller: null,
      power: { rails: [], adequate: true, notes: [] },
      subsystems: [],
      signalFlow: [],
      compatibility: [],
      supportingComponents: [],
      risks: [],
    };

    const libraries = generateLibraries({
      softwarePlan: softwarePlan || {
        architecture: 'Layered',
        language: 'arduino-cpp',
        modules: [],
        libraries: [],
        controlStates: [],
        inputHandling: [],
        sensorLogic: [],
        actuatorLogic: [],
        communication: null,
        safety: [],
        loopStrategy: 'non_blocking',
        files: [{ path: 'sketch.ino', purpose: 'Main sketch' }],
      },
      selections,
      catalog,
      controllerComponentId: controllerSel?.componentId,
      events: context.events,
    });
    context.blackboard.libraries = libraries;

    const diagram = generateDiagram({
      projectId: createId('proj'),
      revision: 1,
      projectName: context.blackboard.projectName,
      projectSummary: requirements.summary,
      requirements,
      selections,
      catalog,
      assignments: pinAssignments,
      wiring,
      hardwarePlan: fallbackHardwarePlan,
      events: context.events,
    });
    context.blackboard.diagram = diagram;

    const instructions = generateInstructions({
      projectName: context.blackboard.projectName,
      projectSummary: requirements.summary,
      requirements,
      selections,
      catalog,
      hardwarePlan: fallbackHardwarePlan,
      pinAssignments,
      wiring,
      softwarePlan: softwarePlan || {
        architecture: 'Layered',
        language: 'arduino-cpp',
        modules: [],
        libraries: [],
        controlStates: [],
        inputHandling: [],
        sensorLogic: [],
        actuatorLogic: [],
        communication: null,
        safety: [],
        loopStrategy: 'non_blocking',
        files: [{ path: 'sketch.ino', purpose: 'Main sketch' }],
      },
      libraries,
      diagram,
      controllerName: controllerSel?.componentId || 'Microcontroller',
      controllerComponentId: controllerSel?.componentId,
      revision: 1,
      events: context.events,
    });
    context.blackboard.instructions = instructions;

    return {
      success: true,
      message: 'Generated diagram.json, libraries.json, and instructions.md.',
      data: {
        diagramParts: diagram.stats.components,
        wireCount: diagram.stats.connections,
        librariesNeeded: libraries.libraries.map((l) => l.name),
        instructionSections: instructions.sections.length,
      },
    };
  },
};

export const ALL_AGENT_TOOLS: Record<string, AgentTool> = {
  search_components: searchComponentsTool,
  select_component: selectComponentTool,
  deselect_component: deselectComponentTool,
  check_compatibility: checkCompatibilityTool,
  assign_and_verify_pins: assignPinsTool,
  route_wiring: routeWiringTool,
  generate_firmware: generateFirmwareTool,
  build_artifacts: buildArtifactsTool,
};
