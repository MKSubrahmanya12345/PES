/**
 * Hardware-agent verifier.
 *
 * Exercises the agent's provider-neutral tool loop without credentials, a
 * database, or network access. The scripted driver has the same contract as
 * the GPT-6 Astra Responses adapter: it returns untrusted tool calls and gets
 * back results associated with the original call ids.
 */

process.env.BEDROCK_MODEL_ID = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

import { AgentEventLog } from '@/lib/logging/events';
import { callAstraToolTurn, parseAstraToolTurn } from '@/lib/models';
import { resetEnvCache } from '@/lib/validation/env';
import { SEED_COMPONENTS } from '@/modules/components';
import { understandPrompt } from '@/modules/project-understanding';
import { ALL_AGENT_TOOLS, runHardwareAgent, type AgentModelDriver, type AgentModelTurnInput } from '@/modules/agent';

resetEnvCache();

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✕'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const prompt = 'Build an ESP32 weather station with a DHT22 temperature and humidity sensor, an SSD1306 OLED display, and a buzzer alarm.';
const understanding = understandPrompt(prompt);
const requests: AgentModelTurnInput[] = [];
let turn = 0;

const driver: AgentModelDriver = {
  model: 'gpt-6-astra-scripted',
  transport: 'test',
  reason: 'scripted Responses-compatible agent driver',
  next: async (input) => {
    requests.push(input);
    turn += 1;
    switch (turn) {
      case 1:
        return { statusText: 'Finding the requested controller.', toolCalls: [{ id: 'call_search', name: 'search_components', arguments: { query: 'esp32', category: 'microcontroller' } }] };
      case 2:
        return { statusText: 'Selecting the controller.', toolCalls: [{ id: 'call_mcu', name: 'select_component', arguments: { componentId: 'esp32-devkit-v1', role: 'controller', quantity: 1 } }] };
      case 3:
        return { statusText: 'Selecting the sensor.', toolCalls: [{ id: 'call_sensor', name: 'select_component', arguments: { componentId: 'dht22-temperature-humidity', role: 'sensor', quantity: 1 } }] };
      case 4:
        return { statusText: 'Grounding the choices in the hardware plan.', toolCalls: [{ id: 'call_plan', name: 'plan_hardware', arguments: {} }] };
      case 5:
        // A structured-looking call is still untrusted: quantity is the wrong
        // type and must be returned to the model as an error without mutation.
        return { statusText: 'Trying an invalid action.', toolCalls: [{ id: 'call_bad', name: 'select_component', arguments: { componentId: 'servo-motor-sg90', quantity: 'two' } }] };
      default:
        return { statusText: 'The tool plan is complete.', toolCalls: [] };
    }
  },
};

async function main(): Promise<void> {
  console.log('verify:agent — provider-neutral hardware tool loop, offline\n');

  const events = new AgentEventLog();
  const output = await runHardwareAgent({
    prompt,
    projectName: 'Agent verifier weather station',
    requirements: understanding.requirementsDraft,
    analysis: understanding.analysis,
    catalog: SEED_COMPONENTS,
    events,
    modelDriver: driver,
  });

  console.log('1. scripted model loop + canonical completion');
  check('first turn receives the user prompt and complete tool schema', Boolean(requests[0]?.userPrompt) && requests[0]?.tools.some((tool) => tool.name === 'plan_hardware'));
  check('every continuation receives the exact prior call id', requests.slice(1, 5).every((request, index) => request.toolOutputs?.[0]?.callId === ['call_search', 'call_mcu', 'call_sensor', 'call_plan'][index]));
  check('tool output is JSON and exposes success/error status', requests.slice(1, 5).every((request) => {
    try {
      const payload = JSON.parse(request.toolOutputs?.[0]?.output ?? '{}') as { success?: unknown };
      return typeof payload.success === 'boolean';
    } catch {
      return false;
    }
  }));
  const rejected = output.steps.find((step) => step.action?.tool === 'select_component' && step.result?.error === 'invalid_tool_arguments');
  check('invalid model arguments are rejected before a tool mutates state', rejected?.result?.success === false, rejected?.result?.message ?? 'no rejection');
  check('invalid component was not added to the final BOM', !output.blackboard.selections.some((selection) => selection.componentId === 'servo-motor-sg90'));
  check('planner completed the BOM, pins, wiring, firmware, and artifacts',
    output.blackboard.selections.length > 0 &&
    output.blackboard.pinAssignments.length > 0 &&
    (output.blackboard.wiring?.connections.length ?? 0) > 0 &&
    (output.blackboard.code?.files.length ?? 0) > 0 &&
    (output.blackboard.diagram?.components.length ?? 0) > 0 &&
    (output.blackboard.instructions?.sections.length ?? 0) > 0,
    `${output.blackboard.selections.length} parts, ${output.blackboard.pinAssignments.length} pins, ${output.blackboard.wiring?.connections.length ?? 0} wires`,
  );
  check('firmware generation records an honest compile-gate verdict',
    output.blackboard.firmwareCompile !== null &&
    ['passed', 'failed', 'skipped', 'unavailable'].includes(output.blackboard.firmwareCompile.status),
    output.blackboard.firmwareCompile?.status ?? 'no compile verdict',
  );
  check('step numbers are contiguous after model and deterministic actions', output.steps.every((step, index) => step.step === index + 1), `${output.steps.length} records`);
  check('agent events do not persist raw model status text', !events.list().some((event) => event.message.includes('Finding the requested controller')));

  console.log('\n2. stale-artifact invalidation after a model backtrack');
  const update = await ALL_AGENT_TOOLS.select_component.execute(
    { componentId: 'servo-motor-sg90', role: 'actuator', quantity: 2 },
    { blackboard: output.blackboard, events },
  );
  const servo = output.blackboard.selections.find((selection) => selection.componentId === 'servo-motor-sg90');
  check('quantity update materializes one instance per requested part', update.success && servo?.quantity === 2 && servo.instances.length === 2);
  check('new selection clears every stale derived circuit artifact',
    output.blackboard.hardwarePlan === null &&
    output.blackboard.pinAssignments.length === 0 &&
    output.blackboard.wiring === null &&
    output.blackboard.softwarePlan === null &&
    output.blackboard.code === null &&
    output.blackboard.firmwareCompile === null &&
    output.blackboard.diagram === null &&
    output.blackboard.libraries === null &&
    output.blackboard.instructions === null,
  );

  console.log('\n3. GPT-6 Astra Responses payload contract');
  const astra = parseAstraToolTurn({
    id: 'resp_agent_1',
    output_text: 'Selecting the controller.',
    output: [
      { type: 'reasoning' },
      { type: 'function_call', call_id: 'call_astra_1', name: 'select_component', arguments: '{"componentId":"esp32-devkit-v1","quantity":1}' },
    ],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  });
  check('Astra function call keeps the provider call id and raw arguments', astra.responseId === 'resp_agent_1' && astra.toolCalls[0]?.callId === 'call_astra_1' && astra.toolCalls[0]?.arguments.includes('esp32-devkit-v1'));
  check('Astra tool-turn usage is normalized', astra.usage.inputTokens === 11 && astra.usage.outputTokens === 7 && astra.usage.totalTokens === 18);

  const originalFetch = globalThis.fetch;
  const outbound: Record<string, unknown>[] = [];
  let directRound = 0;
  process.env.OPENAI_API_KEY = 'test-key-not-a-secret';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    outbound.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    directRound += 1;
    return new Response(
      JSON.stringify(
        directRound === 1
          ? {
              id: 'resp_direct_1',
              output: [{ type: 'function_call', call_id: 'call_direct_1', name: 'search_components', arguments: '{"query":"esp32"}' }],
            }
          : directRound === 2
            ? { id: 'resp_direct_2', output_text: 'Hardware plan complete.', output: [] }
            : { id: 'resp_direct_3', output_text: 'Repair plan requested.', output: [] },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  try {
    const first = await callAstraToolTurn({
      model: 'gpt-6-astra',
      system: ['Agent system instruction'],
      userText: 'Find an ESP32.',
      tools: [{ name: 'search_components', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
      effort: 'medium',
    });
    const second = await callAstraToolTurn({
      model: 'gpt-6-astra',
      system: ['Agent system instruction'],
      previousResponseId: first.responseId,
      tools: [{ name: 'search_components', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
      toolOutputs: [{ callId: first.toolCalls[0]!.callId, output: '{"success":true,"message":"Found ESP32"}' }],
      effort: 'high',
    });
    const feedback = await callAstraToolTurn({
      model: 'gpt-6-astra',
      system: ['Agent system instruction'],
      previousResponseId: second.responseId,
      userText: 'The generated sketch failed compile validation. Use repair_firmware with these diagnostics.',
      tools: [{ name: 'repair_firmware', description: 'repair', parameters: { type: 'object', properties: { plan: { type: 'object' } }, required: ['plan'] } }],
      effort: 'high',
    });
    const firstRequest = outbound[0] ?? {};
    const secondRequest = outbound[1] ?? {};
    const feedbackRequest = outbound[2] ?? {};
    check('direct Astra turn uses function tools, effort, and no legacy sampling parameters',
      firstRequest.store === true &&
      firstRequest.parallel_tool_calls === false &&
      !('temperature' in firstRequest) &&
      !('top_p' in firstRequest) &&
      (firstRequest.reasoning as { effort?: unknown } | undefined)?.effort === 'medium' &&
      Array.isArray(firstRequest.tools) &&
      (firstRequest.tools as { type?: unknown }[])[0]?.type === 'function',
    );
    check('direct Astra continuation preserves response and function-call ids',
      second.responseId === 'resp_direct_2' &&
      secondRequest.previous_response_id === 'resp_direct_1' &&
      Array.isArray(secondRequest.input) &&
      (secondRequest.input as { type?: unknown; call_id?: unknown }[])[0]?.type === 'function_call_output' &&
      (secondRequest.input as { type?: unknown; call_id?: unknown }[])[0]?.call_id === 'call_direct_1',
    );
    check('direct Astra accepts bounded compiler feedback on the existing response chain',
      feedback.responseId === 'resp_direct_3' &&
      feedbackRequest.previous_response_id === 'resp_direct_2' &&
      Array.isArray(feedbackRequest.input) &&
      (feedbackRequest.input as { role?: unknown; content?: unknown }[])[0]?.role === 'user' &&
      String((feedbackRequest.input as { role?: unknown; content?: unknown }[])[0]?.content).includes('failed compile validation') &&
      Array.isArray(feedbackRequest.tools) &&
      (feedbackRequest.tools as { name?: unknown }[])[0]?.name === 'repair_firmware',
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = '';
  }

  console.log(failures === 0 ? '\n✓ all agent checks passed' : `\n✕ ${failures} agent check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verify:agent crashed:', error);
  process.exit(1);
});
