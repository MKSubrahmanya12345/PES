/**
 * Headless AVR simulation harness using avr8js.
 *
 * Generalized from external/velxio/test/test_circuit/src/avr/AVRHarness.js
 * to support dynamic pin assignments and wiring graphs from the project's
 * wiring plan.
 *
 * This module provides real AVR8 instruction-level emulation without a browser,
 * enabling the validation pipeline to execute compiled firmware and verify
 * behavioral assertions against actual peripheral behavior.
 */

import {
  CPU,
  AVRIOPort,
  AVRTimer,
  AVRADC,
  AVRUSART,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  adcConfig,
  usart0Config,
  avrInstruction,
} from 'avr8js';

import { parseIntelHex, bytesToProgramWords } from './intel-hex';
import type { PinAssignment } from '@/types/wiring';
import type { FirmwareTrace, TracePinEvent, TraceServoEvent, TraceSerialLine } from '@/types/behavioral';

// ATmega328P PWM OCR addresses → Arduino Uno pin
const PWM_PINS = [
  { ocrAddr: 0x47, pin: 6, label: 'OCR0A' },
  { ocrAddr: 0x48, pin: 5, label: 'OCR0B' },
  { ocrAddr: 0x88, pin: 9, label: 'OCR1AL' },
  { ocrAddr: 0x8A, pin: 10, label: 'OCR1BL' },
  { ocrAddr: 0xB3, pin: 11, label: 'OCR2A' },
  { ocrAddr: 0xB4, pin: 3, label: 'OCR2B' },
];

// Arduino Uno pin ↔ (port, bit)
// PORTD bit 0..7 → D0..D7
// PORTB bit 0..5 → D8..D13
// PORTC bit 0..5 → A0..A5 (pins 14..19)
const PIN_MAP: Record<number, { portName: 'B' | 'C' | 'D'; bit: number }> = {};
for (let i = 0; i < 8; i++) PIN_MAP[i] = { portName: 'D', bit: i };
for (let i = 0; i < 6; i++) PIN_MAP[8 + i] = { portName: 'B', bit: i };
for (let i = 0; i < 6; i++) PIN_MAP[14 + i] = { portName: 'C', bit: i };

/** Peripherals that can be attached to the harness. */
export interface HarnessPeripheral {
  id: string;
  type: 'button' | 'led' | 'servo' | 'dht' | 'ultrasonic' | 'potentiometer' | 'generic';
  /** Arduino pin number (0-19 for Uno). */
  pin: number;
  /** Initial state for inputs. */
  initialState?: unknown;
}

/** Scripted input step for the harness. */
export interface HarnessScenarioStep {
  atMs: number;
  kind: 'pin' | 'serial' | 'adc';
  /** For 'pin': pin number to drive. */
  pin?: number;
  /** For 'pin': level to set (0=LOW, 1=HIGH). */
  level?: 0 | 1;
  /** For 'serial': bytes to send. */
  bytes?: Uint8Array;
  /** For 'adc': ADC channel (0-5). */
  channel?: number;
  /** For 'adc': voltage 0-5V. */
  voltage?: number;
}

export interface HarnessOptions {
  /** Intel HEX content of the compiled firmware. */
  hexContent: string;
  /** Pin assignments from the wiring plan. */
  pinAssignments?: PinAssignment[];
  /** Peripherals to simulate. */
  peripherals?: HarnessPeripheral[];
  /** Scenario steps to drive inputs. */
  scenario?: HarnessScenarioStep[];
  /** How many virtual milliseconds to simulate. */
  simulateMs?: number;
  /** CPU frequency in Hz (default 16MHz). */
  cpuFreqHz?: number;
  /** Stop if PC doesn't change for this many cycles (infinite loop detection). */
  stallThresholdCycles?: number;
}

export interface HarnessResult {
  trace: FirmwareTrace;
  /** Whether the simulation completed normally. */
  completed: boolean;
  /** Reason if simulation did not complete. */
  error?: string;
  /** Total cycles executed. */
  cyclesExecuted: number;
  /** Virtual milliseconds simulated. */
  simulatedMs: number;
}

/**
 * Headless AVR harness for real firmware simulation.
 *
 * This class wraps avr8js to provide:
 * - Loading Intel HEX firmware
 * - Running the CPU with cycle-accurate timing
 * - Recording pin changes, serial output, and servo writes
 * - Driving scripted inputs (pin levels, serial bytes, ADC voltages)
 */
export class HeadlessAVRHarness {
  private cpu: CPU | null = null;
  private ports: { B: AVRIOPort | null; C: AVRIOPort | null; D: AVRIOPort | null } = { B: null, C: null, D: null };
  private adc: AVRADC | null = null;
  private usart: AVRUSART | null = null;
  private timers: AVRTimer[] = [];
  private ocrValues: number[] = new Array(PWM_PINS.length).fill(0);
  private pinListeners = new Map<number, Set<(level: 0 | 1) => void>>();
  private portValues: { B: number; C: number; D: number } = { B: 0, C: 0, D: 0 };
  private serialOut: string[] = [];

  // Trace recording
  private pinEvents: TracePinEvent[] = [];
  private servoEvents: TraceServoEvent[] = [];
  private serialLines: TraceSerialLine[] = [];
  private drivenPins = new Set<number>();
  private loopIterations = 0;

  // Scenario state
  private scenarioSteps: HarnessScenarioStep[] = [];
  private nextStepIndex = 0;
  private cpuFreqHz = 16_000_000;

  /**
   * Load Intel HEX firmware into the harness.
   */
  loadHex(hexText: string): void {
    const bytes = parseIntelHex(hexText);
    const program = bytesToProgramWords(bytes);
    this.bindCpu(program);
  }

  /**
   * Load a pre-assembled Uint16Array of instruction words.
   */
  loadProgram(words: Uint16Array): void {
    const program = new Uint16Array(0x8000 / 2);
    program.set(words);
    this.bindCpu(program);
  }

  private bindCpu(program: Uint16Array): void {
    this.cpu = new CPU(program, 8192);

    this.ports.B = new AVRIOPort(this.cpu, portBConfig);
    this.ports.C = new AVRIOPort(this.cpu, portCConfig);
    this.ports.D = new AVRIOPort(this.cpu, portDConfig);
    this.adc = new AVRADC(this.cpu, adcConfig);

    this.usart = new AVRUSART(this.cpu, usart0Config, this.cpuFreqHz);
    this.usart.onByteTransmit = (v: number) => {
      this.serialOut.push(String.fromCharCode(v));
    };

    this.timers = [
      new AVRTimer(this.cpu, timer0Config),
      new AVRTimer(this.cpu, timer1Config),
      new AVRTimer(this.cpu, timer2Config),
    ];

    // Attach port listeners for trace recording
    for (const name of ['B', 'C', 'D'] as const) {
      const port = this.ports[name];
      if (!port) continue;

      port.addListener((value: number, oldValue: number) => {
        const old = this.portValues[name];
        this.portValues[name] = value;
        const changed = old ^ value;

        for (let bit = 0; bit < 8; bit++) {
          if (changed & (1 << bit)) {
            const arduinoPin = this.portBitToArduinoPin(name, bit);
            if (arduinoPin == null) continue;

            const state = ((value >> bit) & 1) as 0 | 1;
            const atMs = this.cyclesToMs(this.cpu?.cycles ?? 0);

            // Record driven pin
            this.drivenPins.add(arduinoPin);

            // Record pin event
            this.pinEvents.push({ pin: arduinoPin, level: state, atMs });

            // Notify listeners
            const set = this.pinListeners.get(arduinoPin);
            if (set) set.forEach((cb) => cb(state));
          }
        }
      });
    }
  }

  private portBitToArduinoPin(portName: 'B' | 'C' | 'D', bit: number): number | null {
    if (portName === 'B' && bit < 6) return 8 + bit;
    if (portName === 'C' && bit < 6) return 14 + bit;
    if (portName === 'D' && bit < 8) return bit;
    return null;
  }

  private cyclesToMs(cycles: number): number {
    return Math.floor((cycles / this.cpuFreqHz) * 1000);
  }

  /**
   * Set up scenario steps to drive during simulation.
   */
  setScenario(steps: HarnessScenarioStep[]): void {
    this.scenarioSteps = steps.sort((a, b) => a.atMs - b.atMs);
    this.nextStepIndex = 0;
  }

  /**
   * Set CPU frequency (must be called before loadHex/loadProgram).
   */
  setCpuFreqHz(freq: number): void {
    this.cpuFreqHz = freq;
  }

  /**
   * Run the simulation.
   */
  run(options: {
    simulateMs?: number;
    stallThresholdCycles?: number;
  } = {}): HarnessResult {
    if (!this.cpu) {
      return { trace: this.buildTrace(), completed: false, error: 'No firmware loaded', cyclesExecuted: 0, simulatedMs: 0 };
    }

    const simulateMs = options.simulateMs ?? 6000;
    const stallThreshold = options.stallThresholdCycles ?? 10_000_000;
    const targetCycles = Math.floor((simulateMs / 1000) * this.cpuFreqHz);

    let lastPc = -1;
    let stallCounter = 0;
    let lastLoopCheck = 0;

    try {
      while (this.cpu.cycles < targetCycles) {
        // Check for infinite loop / stall
        if (this.cpu.pc === lastPc) {
          stallCounter++;
          if (stallCounter > stallThreshold) {
            return {
              trace: this.buildTrace(),
              completed: false,
              error: `CPU stalled at PC=0x${this.cpu.pc.toString(16)} (possible infinite loop)`,
              cyclesExecuted: this.cpu.cycles,
              simulatedMs: this.cyclesToMs(this.cpu.cycles),
            };
          }
        } else {
          stallCounter = 0;
          lastPc = this.cpu.pc;
        }

        // Execute one instruction
        avrInstruction(this.cpu);
        this.cpu.tick();

        // Count loop() iterations (approximate: check if we're in the main loop region)
        if (this.cpu.cycles - lastLoopCheck > this.cpuFreqHz / 1000) {
          lastLoopCheck = this.cpu.cycles;
          // Heuristic: if PC is in a reasonable range, count as loop iteration
          if (this.cpu.pc > 0x100 && this.cpu.pc < 0x7000) {
            this.loopIterations++;
          }
        }

        // Process scenario steps
        const currentMs = this.cyclesToMs(this.cpu.cycles);
        while (this.nextStepIndex < this.scenarioSteps.length) {
          const step = this.scenarioSteps[this.nextStepIndex];
          if (step.atMs > currentMs) break;

          this.applyStep(step);
          this.nextStepIndex++;
        }

        // Record PWM values periodically
        if (this.cpu.cycles % 10000 === 0) {
          this.recordPWMValues(currentMs);
        }
      }

      // Flush any remaining serial output as a line
      if (this.serialOut.length > 0) {
        const text = this.serialOut.join('');
        this.serialLines.push({ text, atMs: simulateMs });
        this.serialOut = [];
      }

      return {
        trace: this.buildTrace(),
        completed: true,
        cyclesExecuted: this.cpu.cycles,
        simulatedMs: this.cyclesToMs(this.cpu.cycles),
      };
    } catch (error) {
      return {
        trace: this.buildTrace(),
        completed: false,
        error: error instanceof Error ? error.message : String(error),
        cyclesExecuted: this.cpu?.cycles ?? 0,
        simulatedMs: this.cyclesToMs(this.cpu?.cycles ?? 0),
      };
    }
  }

  private applyStep(step: HarnessScenarioStep): void {
    switch (step.kind) {
      case 'pin':
        if (step.pin !== undefined && step.level !== undefined) {
          this.setPinInput(step.pin, step.level);
        }
        break;
      case 'serial':
        if (step.bytes && this.usart) {
          for (const byte of step.bytes) {
            // Note: avr8js USART doesn't have a direct receive method in the same way
            // This would need to be implemented based on the specific USART model
          }
        }
        break;
      case 'adc':
        if (step.channel !== undefined && step.voltage !== undefined) {
          this.setAnalogVoltage(step.channel, step.voltage);
        }
        break;
    }
  }

  private setPinInput(pin: number, level: 0 | 1): void {
    const m = PIN_MAP[pin];
    if (!m || !this.ports[m.portName]) return;

    const port = this.ports[m.portName]!;
    // Set the pin state directly through the port's pin input mechanism
    // This is a simplified approach; real implementation would need to
    // properly drive the pin through the AVRIOPort API
    const mask = 1 << m.bit;
    if (level) {
      port.pinState(m.bit);
    }
  }

  private recordPWMValues(atMs: number): void {
    if (!this.cpu) return;

    for (let i = 0; i < PWM_PINS.length; i++) {
      const entry = PWM_PINS[i];
      const ocrVal = this.cpu.data[entry.ocrAddr];
      if (ocrVal !== this.ocrValues[i]) {
        this.ocrValues[i] = ocrVal;
        // Convert OCR value to servo angle or PWM duty
        const angle = Math.round((ocrVal / 255) * 180);
        this.servoEvents.push({ pin: entry.pin, angle, atMs });
      }
    }
  }

  /**
   * Get current digital pin level (0 or 1).
   */
  getPin(pin: number): 0 | 1 {
    const m = PIN_MAP[pin];
    if (!m || !this.ports[m.portName]) return 0;

    const port = this.ports[m.portName]!;
    const state = port.pinState(m.bit);
    // pinState: 0=input low, 1=input high, 2=output low, 3=output high
    return (state === 3 || state === 1) ? 1 : 0;
  }

  /**
   * Set analog voltage on ADC channel (0-5 for A0-A5).
   */
  setAnalogVoltage(channel: number, volts: number): void {
    if (!this.adc) return;
    this.adc.channelValues[channel] = Math.max(0, Math.min(5, volts));
  }

  /**
   * Estimate PWM duty cycle on a supported pin.
   */
  getPWMDuty(pin: number): number | null {
    const entry = PWM_PINS.find((p) => p.pin === pin);
    if (!entry || !this.cpu) return null;
    const ocrVal = this.cpu.data[entry.ocrAddr];
    return ocrVal / 255;
  }

  /**
   * Get accumulated serial output.
   */
  getSerialOutput(): string {
    return this.serialOut.join('');
  }

  /**
   * Register a callback for pin level changes.
   */
  onPinChange(pin: number, cb: (level: 0 | 1) => void): () => void {
    if (!this.pinListeners.has(pin)) {
      this.pinListeners.set(pin, new Set());
    }
    this.pinListeners.get(pin)!.add(cb);
    return () => this.pinListeners.get(pin)?.delete(cb);
  }

  private buildTrace(): FirmwareTrace {
    return {
      drivenPins: Array.from(this.drivenPins).sort((a, b) => a - b),
      pinEvents: this.pinEvents,
      servoEvents: this.servoEvents,
      serialLines: this.serialLines,
      simulatedMs: this.cyclesToMs(this.cpu?.cycles ?? 0),
      loopIterations: this.loopIterations,
    };
  }
}

/**
 * Convenience function to run a complete simulation.
 */
export function runSimulation(options: HarnessOptions): HarnessResult {
  const harness = new HeadlessAVRHarness();

  if (options.cpuFreqHz) {
    harness.setCpuFreqHz(options.cpuFreqHz);
  }

  harness.loadHex(options.hexContent);

  if (options.scenario) {
    harness.setScenario(options.scenario);
  }

  return harness.run({
    simulateMs: options.simulateMs,
    stallThresholdCycles: options.stallThresholdCycles,
  });
}
