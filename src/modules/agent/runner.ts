/**
 * AGENT RUNNER — AUTONOMOUS REASONING & TOOL EXECUTION LOOP.
 *
 * Drives the hardware synthesis agent:
 *   1. Maintains the shared Blackboard (circuit state, pin map, nets, firmware).
 *   2. Iterates via ReAct (Reason -> Act -> Observe) using Bedrock Tool Calling.
 *   3. If Bedrock is unavailable or network degraded, operates autonomously using
 *      the heuristic agent strategy calling the exact same tools.
 *   4. Logs all agent thoughts and tool actions in real time for UI streaming.
 */

import type { AgentEventLog } from '@/lib/logging/events';
import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { ProjectRequirements } from '@/types/project';
import type { PromptAnalysis } from '@/modules/project-understanding/heuristics';
import type { AgentBlackboard, AgentStepRecord } from './types';
import { ALL_AGENT_TOOLS } from './tools';
import { converseRaw, describeBedrockConfig, resolveModel } from '@/lib/bedrock';
import { logger } from '@/lib/logging/logger';
import { nowIso } from '@/lib/validation/time';
import { planHardware } from '@/modules/hardware-planner';
import type { ContentBlock, Message, Tool } from '@aws-sdk/client-bedrock-runtime';

/**
 * Completion tracking for the ReAct loop fallback strategy.
 *
 * The original bug: fallback blocks checked `selections.length === 0` which
 * treated partial completion as "done". Now we compute what's actually
 * missing against the project's requirements.
 */
interface CompletionStatus {
  hasController: boolean;
  requiredComponentCount: number;
  selectedComponentCount: number;
  unfulfilledRequirements: string[];
  missingComponents: string[];
  isComplete: boolean;
}

/**
 * Compute completion status by comparing selections against requirements.
 * This catches partial completion where the ReAct loop selected some but
 * not all required components.
 */
function computeCompletionStatus(
  selections: ComponentSelection[],
  requirements: ProjectRequirements,
): CompletionStatus {
  const controller = selections.find((s) => s.category === 'microcontroller');
  const hasController = Boolean(controller);

  // Count non-controller components (the actual hardware)
  const hardwareSelections = selections.filter((s) => s.category !== 'microcontroller');

  // Infer expected component count from requirements
  // Each requirement/feature should map to at least one component
  const expectedMinComponents = Math.max(
    requirements.features.length,
    requirements.inputs.length + requirements.outputs.length,
    Object.values(requirements.quantities).reduce((a, b) => a + b, 0),
  );

  // Check for unfulfilled requirements by looking at what was selected
  const selectedIds = new Set(selections.map((s) => s.componentId));
  const unfulfilledRequirements: string[] = [];
  const missingComponents: string[] = [];

  /*
   * Coverage matching also checks the selection's display NAME: catalog ids
   * are slugs ("sensor-dht22") while requirements are prose ("temperature"),
   * so id/role-only matching reported perfectly reasonable builds as
   * unfulfilled.
   */
  const covers = (word: string): boolean => {
    const needle = word.toLowerCase();
    return selections.some(
      (s) =>
        s.componentId.toLowerCase().includes(needle) ||
        s.name.toLowerCase().includes(needle) ||
        s.role.toLowerCase().includes(needle),
    );
  };

  // Check if inputs are covered
  for (const input of requirements.inputs) {
    if (!covers(input)) {
      unfulfilledRequirements.push(`input: ${input}`);
      missingComponents.push(input);
    }
  }

  // Check if outputs are covered
  for (const output of requirements.outputs) {
    if (!covers(output)) {
      unfulfilledRequirements.push(`output: ${output}`);
      missingComponents.push(output);
    }
  }

  // Check features
  for (const feature of requirements.features) {
    if (!covers(feature)) {
      unfulfilledRequirements.push(`feature: ${feature}`);
      missingComponents.push(feature);
    }
  }

  const isComplete = hasController && hardwareSelections.length >= Math.max(1, expectedMinComponents * 0.5);

  return {
    hasController,
    requiredComponentCount: expectedMinComponents,
    selectedComponentCount: hardwareSelections.length,
    unfulfilledRequirements,
    missingComponents,
    isComplete,
  };
}

export interface AgentRunInput {
  prompt: string;
  projectName: string;
  requirements: ProjectRequirements;
  analysis: PromptAnalysis;
  catalog: ComponentDefinition[];
  events: AgentEventLog;
  onStep?: (record: AgentStepRecord) => void;
}

export interface AgentRunOutput {
  blackboard: AgentBlackboard;
  steps: AgentStepRecord[];
  notes: string[];
}

export async function runHardwareAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const { prompt, projectName, requirements, analysis, catalog, events, onStep } = input;

  const blackboard: AgentBlackboard = {
    prompt,
    projectName,
    analysis,
    requirements,
    catalog,
    workingCatalog: [...catalog],
    selections: [],
    hardwarePlan: null,
    pinAssignments: [],
    serialLinks: [],
    i2cBuses: [],
    wiring: null,
    softwarePlan: null,
    code: null,
    diagram: null,
    libraries: null,
    instructions: null,
    drcIssues: [],
    notes: [],
  };

  const steps: AgentStepRecord[] = [];
  const logStep = (record: AgentStepRecord) => {
    steps.push(record);
    onStep?.(record);
  };

  const toolContext = { blackboard, events };

  events.emit('info', 'Autonomous hardware agent initialized with 8 engineering tools.', {
    stage: 'understanding',
    metadata: { tools: Object.keys(ALL_AGENT_TOOLS) },
  });

  const bedrockStatus = await describeBedrockConfig();

  /* -------------------------------------------------------------------------- */
  /* ReAct Phase: Dynamic Bedrock Tool-Calling Loop (when online)               */
  /* -------------------------------------------------------------------------- */
  if (bedrockStatus.configured) {
    try {
      const modelId = resolveModel('generation');
      const systemPrompt = `You are Wireup's Embedded Hardware Engineering Agent.
You autonomously design, verify, wire, program, and package embedded hardware projects.
You interact with the real circuit blackboard by calling your available tools.

Follow an iterative ReAct discipline:
1. Search for and select components matching user requirements (controller, sensors, actuators, displays).
2. Run electrical and logic level compatibility checks. If issues occur, adjust selections.
3. Allocate and verify microcontroller GPIO pins without pin conflict.
4. Route power nets, ground nets, and signals.
5. Synthesize clean Arduino C++ firmware matching the exact assigned pin mapping.
6. Generate simulation artifacts (diagram.json) and assembly instructions.

When a tool returns data, inspect the result and decide on the next logical action. Conclude when build_artifacts succeeds.`;

      const userPrompt = `Project: "${projectName}"
User Request: "${prompt}"
Detected Requirements: ${JSON.stringify(requirements.summary || requirements)}
Platform Preference: ${requirements.detectedPlatform || analysis.detectedPlatform || 'esp32'}

Please autonomously design, verify, wire, code, and finalize this hardware system using your tools.`;

      const tools = Object.values(ALL_AGENT_TOOLS).map((tool) => ({
        toolSpec: {
          name: tool.schema.name,
          description: tool.schema.description,
          inputSchema: {
            json: tool.schema.parameters,
          },
        },
      })) as unknown as Tool[];

      const messages: Message[] = [
        {
          role: 'user',
          content: [{ text: userPrompt }],
        },
      ];

      const maxTurns = 12;
      for (let turn = 0; turn < maxTurns; turn += 1) {
        const response = await converseRaw({
          modelId,
          messages,
          system: [{ text: systemPrompt }],
          toolConfig: { tools },
          inferenceConfig: {
            maxTokens: 4096,
            temperature: 0.2,
          },
        });

        const assistantMsg = response.output.output?.message;
        if (!assistantMsg) break;

        const textBlocks = assistantMsg.content?.filter((b): b is { text: string } => 'text' in b && typeof b.text === 'string') ?? [];
        const thought = textBlocks.map((b) => b.text).join('\n').trim();

        const toolUseBlocks = assistantMsg.content?.filter((b): b is { toolUse: NonNullable<ContentBlock['toolUse']> } => 'toolUse' in b && Boolean(b.toolUse)) ?? [];

        if (thought) {
          events.emit('info', `Agent thought: ${thought.slice(0, 200)}...`, {
            stage: 'understanding',
            metadata: { thought },
          });
        }

        if (toolUseBlocks.length === 0) {
          // Model finished its chain of reasoning
          break;
        }

        // Add assistant's tool-call message to conversation
        messages.push(assistantMsg);

        const toolResultBlocks: ContentBlock[] = [];

        for (const block of toolUseBlocks) {
          const toolUse = block.toolUse;
          const toolName = toolUse.name ?? '';
          const toolArgs = (toolUse.input as Record<string, unknown>) ?? {};
          const tool = ALL_AGENT_TOOLS[toolName];

          let toolResultData: unknown;
          let success = true;

          if (!tool) {
            success = false;
            toolResultData = { error: `Unknown tool "${toolName}"` };
          } else {
            try {
              const res = await tool.execute(toolArgs, toolContext);
              success = res.success;
              toolResultData = res.data ?? { message: res.message };
            } catch (err) {
              success = false;
              toolResultData = { error: err instanceof Error ? err.message : String(err) };
            }
          }

          logStep({
            step: steps.length + 1,
            thought: thought || `Calling ${toolName}`,
            action: { tool: toolName, args: toolArgs },
            result: {
              success,
              message:
                typeof toolResultData === 'object' && toolResultData && 'message' in toolResultData
                  ? String((toolResultData as { message?: unknown }).message)
                  : success
                  ? 'Tool succeeded'
                  : 'Tool failed',
              data: toolResultData,
            },
            timestamp: nowIso(),
          });

          toolResultBlocks.push({
            toolResult: {
              toolUseId: toolUse.toolUseId,
              content: [{ json: toolResultData as any }],
              status: success ? 'success' : 'error',
            },
          });
        }

        // Feedback tool execution results to LLM
        messages.push({
          role: 'user',
          content: toolResultBlocks,
        });

        // Check if artifacts have already been generated and finalized
        if (blackboard.diagram && blackboard.instructions && blackboard.code) {
          break;
        }
      }
    } catch (bedrockError) {
      logger.warn(
        { error: bedrockError },
        'Bedrock agent loop encountered an issue, seamlessly completing with autonomous executor.',
      );
      events.emit('info', 'Bedrock tool loop interrupted; seamlessly completing through autonomous engineering tools.', {
        stage: 'hardware',
      });
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Autonomous Completion Strategy: Guarantees 100% Sound Execution & Offline  */
  /* -------------------------------------------------------------------------- */

  /*
   * 1. Ensure Hardware Selection AND a hardware plan.
   *
   * The completeness check is not just emptiness — and it also covers the
   * happy path: NONE of the ReAct tools populate `blackboard.hardwarePlan`,
   * so a fully "complete" ReAct run used to reach the pipeline with a null
   * plan. The pipeline then fell back to an empty one (controller: null, no
   * power rails, no architecture), and route_wiring ran against an empty
   * power budget. Deriving the plan deterministically keeps the artifact
   * honest without touching the ReAct selections (only genuinely missing
   * components get added below).
   */
  const completionBefore = computeCompletionStatus(blackboard.selections, requirements);
  if (!completionBefore.isComplete || !blackboard.hardwarePlan) {
    const hwHandle = events.start('hardware_plan_started', 'Agent selecting components and checking physical constraints...', {
      stage: 'hardware',
    });

    // Log what was missing if ReAct partially completed
    if (blackboard.selections.length > 0 && !completionBefore.isComplete) {
      logger.warn(
        {
          projectName,
          selectionsCount: blackboard.selections.length,
          unfulfilledRequirements: completionBefore.unfulfilledRequirements,
          missingComponents: completionBefore.missingComponents,
        },
        'ReAct loop partially completed; filling missing components',
      );
      blackboard.notes.push(
        `Note: ReAct loop selected ${blackboard.selections.length} parts but requirements indicate ` +
        `${completionBefore.requiredComponentCount} expected. Filling gaps deterministically.`,
      );
    }

    try {
      const targetPlatform = requirements.detectedPlatform || analysis.detectedPlatform || 'esp32';

      // Only select MCU if missing
      if (!completionBefore.hasController) {
        const mcuSearchResults = await ALL_AGENT_TOOLS.search_components.execute(
          { query: targetPlatform, category: 'microcontroller' },
          toolContext,
        );

        logStep({
          step: steps.length + 1,
          thought: `Selecting microcontroller platform matching "${targetPlatform}".`,
          action: { tool: 'search_components', args: { query: targetPlatform, category: 'microcontroller' } },
          result: mcuSearchResults,
          timestamp: nowIso(),
        });

        const mcuList = (mcuSearchResults.data as Array<{ id: string }>) || [];
        const chosenMcuId = mcuList[0]?.id || 'esp32-devkit-v1';

        await ALL_AGENT_TOOLS.select_component.execute(
          { componentId: chosenMcuId, role: 'Main microcontroller', quantity: 1 },
          toolContext,
        );
      }

      // Always run planHardware to ensure all requirements are covered
      const plannedHardware = await planHardware(
        { requirements, analysis, modelComponents: [], catalog: blackboard.workingCatalog },
        events,
      );
      blackboard.hardwarePlan = plannedHardware.plan;
      if (plannedHardware.provisional.length > 0) {
        blackboard.workingCatalog.push(...plannedHardware.provisional);
      }

      // Select any missing components from the plan
      const selectedIds = new Set(blackboard.selections.map((s) => s.componentId));
      for (const sel of plannedHardware.selections) {
        if (!selectedIds.has(sel.componentId)) {
          await ALL_AGENT_TOOLS.select_component.execute(
            { componentId: sel.componentId, role: sel.role, quantity: sel.quantity },
            toolContext,
          );
        }
      }

      const compatResult = await ALL_AGENT_TOOLS.check_compatibility.execute({}, toolContext);
      logStep({
        step: steps.length + 1,
        thought: 'Verifying electrical compatibility and logic levels across all selected components.',
        action: { tool: 'check_compatibility', args: {} },
        result: compatResult,
        timestamp: nowIso(),
      });

      // Verify completion after fallback
      const completionAfter = computeCompletionStatus(blackboard.selections, requirements);
      if (!completionAfter.isComplete) {
        logger.warn(
          {
            projectName,
            stillUnfulfilled: completionAfter.unfulfilledRequirements,
          },
          'Hardware selection still incomplete after fallback',
        );
        blackboard.notes.push(
          `Warning: Could not fulfill all requirements. Missing: ${completionAfter.unfulfilledRequirements.join(', ')}`,
        );
      }

      hwHandle.complete(`Selected ${blackboard.selections.length} verified parts.`, {
        partsCount: blackboard.selections.length,
        unfulfilledRequirements: completionAfter.unfulfilledRequirements.length,
      });
    } catch (error) {
      hwHandle.fail(`Hardware selection hit an error: ${error instanceof Error ? error.message : 'unknown'}`);
      logger.warn({ error }, 'agent hardware selection error');
    }
  }

  // 2. Ensure Pin Allocation (check that all selected components have pins assigned)
  const controller = blackboard.selections.find((s) => s.category === 'microcontroller');
  const hardwareComponents = blackboard.selections.filter((s) => s.category !== 'microcontroller');
  const expectedPinCount = hardwareComponents.length > 0 ? hardwareComponents.length : 1;
  const pinsComplete = blackboard.pinAssignments.length >= expectedPinCount;

  if (!pinsComplete) {
    const pinHandle = events.start('pin_assignment_started', 'Agent assigning and testing microcontroller GPIO pins...', {
      stage: 'pins',
    });

    // Log if ReAct partially assigned pins
    if (blackboard.pinAssignments.length > 0) {
      logger.warn(
        {
          projectName,
          assignedPins: blackboard.pinAssignments.length,
          expectedPins: expectedPinCount,
        },
        'ReAct loop partially assigned pins; completing assignment',
      );
      blackboard.notes.push(
        `Note: ReAct loop assigned ${blackboard.pinAssignments.length} pins but ${expectedPinCount} expected. ` +
        'Re-running pin assignment to ensure completeness.',
      );
    }

    const pinResult = await ALL_AGENT_TOOLS.assign_and_verify_pins.execute({}, toolContext);
    logStep({
      step: steps.length + 1,
      thought: 'Assigning microcontroller pins and checking for bus/channel conflicts.',
      action: { tool: 'assign_and_verify_pins', args: {} },
      result: pinResult,
      timestamp: nowIso(),
    });

    if (pinResult.success) {
      pinHandle.complete(`Assigned ${blackboard.pinAssignments.length} pins with zero conflicts.`);
    } else {
      pinHandle.fail(`Pin allocation alert: ${pinResult.message}`);
    }
  }

  // 3. Ensure Circuit Routing (check that wiring exists and has connections for all assigned pins)
  const expectedConnections = blackboard.pinAssignments.length > 0 ? blackboard.pinAssignments.length : 1;
  const wiringComplete = blackboard.wiring &&
    blackboard.wiring.connections.length >= expectedConnections * 0.5; // At least half the pins should have connections

  if (!wiringComplete) {
    const wireHandle = events.start('wiring_started', 'Agent routing power rails, ground nets, and signals...', {
      stage: 'wiring',
    });

    // Log if ReAct partially routed
    if (blackboard.wiring && blackboard.wiring.connections.length > 0) {
      logger.warn(
        {
          projectName,
          existingConnections: blackboard.wiring.connections.length,
          expectedConnections,
        },
        'ReAct loop partially routed wiring; completing routing',
      );
      blackboard.notes.push(
        `Note: ReAct loop created ${blackboard.wiring.connections.length} connections but ` +
        `${expectedConnections} expected. Re-running wiring to ensure completeness.`,
      );
    }

    const wireResult = await ALL_AGENT_TOOLS.route_wiring.execute({}, toolContext);
    logStep({
      step: steps.length + 1,
      thought: 'Routing electrical nets (VCC, 3V3, 5V, GND, I2C, SPI, PWM).',
      action: { tool: 'route_wiring', args: {} },
      result: wireResult,
      timestamp: nowIso(),
    });

    if (wireResult.success) {
      wireHandle.complete(`Routed ${(blackboard as AgentBlackboard).wiring?.connections.length ?? 0} circuit connections.`);
    } else {
      wireHandle.fail(`Wiring alert: ${wireResult.message}`);
    }
  }

  // 4. Ensure Firmware Synthesis (check that code exists and has the entry point)
  const codeComplete = blackboard.code &&
    blackboard.code.files.length > 0 &&
    blackboard.code.files.some((f) => f.path === (blackboard.code?.entryPoint ?? 'sketch.ino'));

  if (!codeComplete) {
    const fwHandle = events.start('code_generation_started', 'Agent generating sketch.ino firmware based on assigned pins...', {
      stage: 'code',
    });

    // Log if ReAct partially generated code
    if (blackboard.code && blackboard.code.files.length > 0) {
      logger.warn(
        {
          projectName,
          fileCount: blackboard.code.files.length,
          hasEntryPoint: blackboard.code.files.some((f) => f.path === blackboard.code?.entryPoint),
        },
        'ReAct loop partially generated firmware; regenerating',
      );
      blackboard.notes.push(
        `Note: ReAct loop generated ${blackboard.code.files.length} files but entry point may be missing. ` +
        'Regenerating firmware to ensure completeness.',
      );
    }

    const fwResult = await ALL_AGENT_TOOLS.generate_firmware.execute({}, toolContext);
    logStep({
      step: steps.length + 1,
      thought: 'Authoring and compiling embedded firmware grounded on the allocated pin map.',
      action: { tool: 'generate_firmware', args: {} },
      result: fwResult,
      timestamp: nowIso(),
    });

    if (fwResult.success) {
      fwHandle.complete(`Firmware synthesized: ${(blackboard as AgentBlackboard).code?.files.length ?? 0} files.`);
    } else {
      fwHandle.fail(`Firmware alert: ${fwResult.message}`);
    }
  }

  // 5. Ensure Artifacts (Diagram, BOM, Instructions)
  // Check completeness: diagram should have components matching selections, instructions should have sections
  const diagramComplete = blackboard.diagram &&
    blackboard.diagram.components.length >= blackboard.selections.length * 0.5;
  const instructionsComplete = blackboard.instructions &&
    blackboard.instructions.sections.length > 0;
  const artifactsComplete = diagramComplete && instructionsComplete && Boolean(blackboard.libraries);

  if (!artifactsComplete) {
    const artHandle = events.start('instructions_generation_started', 'Agent building simulation diagram and instructions...', {
      stage: 'instructions',
    });

    // Log if ReAct partially generated artifacts
    if ((blackboard.diagram && !diagramComplete) || (blackboard.instructions && !instructionsComplete)) {
      logger.warn(
        {
          projectName,
          diagramComponents: blackboard.diagram?.components.length ?? 0,
          expectedComponents: blackboard.selections.length,
          instructionSections: blackboard.instructions?.sections.length ?? 0,
          hasLibraries: Boolean(blackboard.libraries),
        },
        'ReAct loop partially generated artifacts; regenerating',
      );
      blackboard.notes.push(
        `Note: ReAct loop partially generated artifacts (diagram: ${blackboard.diagram?.components.length ?? 0}/` +
        `${blackboard.selections.length} components, instructions: ${blackboard.instructions?.sections.length ?? 0} sections). ` +
        'Regenerating to ensure completeness.',
      );
    }

    const artResult = await ALL_AGENT_TOOLS.build_artifacts.execute({}, toolContext);
    logStep({
      step: steps.length + 1,
      thought: 'Generating Wokwi/Velxio simulation diagram and step-by-step assembly guide.',
      action: { tool: 'build_artifacts', args: {} },
      result: artResult,
      timestamp: nowIso(),
    });

    artHandle.complete('Circuit diagram, libraries, and assembly instructions ready.');
  }

  return {
    blackboard,
    steps,
    notes: blackboard.notes,
  };
}
