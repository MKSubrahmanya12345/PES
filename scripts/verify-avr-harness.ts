/**
 * Offline verification of the headless AVR harness (avr8js).
 *
 * No arduino-cli needed: the test firmwares are hand-assembled AVR programs
 * (avr8js's own assembler), so this runs anywhere and proves the pieces the
 * real-sim feedback loop depends on:
 *
 *   1. INPUT_PULLUP idles HIGH and scenario pin steps REALLY drive the pin
 *      (old setPinInput called a getter — presses were silently dropped).
 *   2. getPin() reports the driven LEVEL, not the pin configuration.
 *   3. Serial TX is split into timestamped lines, and a partial line survives
 *      a stall exit (old code flushed only on normal completion).
 *   4. Serial RX scenario bytes reach the firmware (old code dropped them).
 *   5. 16-bit OCR1A is read whole → correct servo angle (old code read the
 *      low byte only → garbage angles).
 */
import { assemble } from 'avr8js/dist/esm/utils/assembler';
import { HeadlessAVRHarness } from '@/modules/simulation/headless-avr/harness';
import { bytesToProgramWords } from '@/modules/simulation/headless-avr/intel-hex';

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function program(asm: string): Uint16Array {
  const result = assemble(asm);
  if (result.errors.length > 0) throw new Error(`assembler errors: ${result.errors.join('; ')}`);
  return bytesToProgramWords(result.bytes);
}

/* --- 1 + 2: pull-up idle HIGH, real pin drive, getPin level -------------- */
const MIRROR_ASM = `
  ldi r16, 0x20
  out 0x04, r16     ; DDRB: PB5 (pin 13) output
  ldi r16, 0x00
  out 0x0a, r16     ; DDRD: all inputs
  ldi r16, 0x04
  out 0x0b, r16     ; PORTD: PD2 (pin 2) pull-up
loop:
  in r17, 0x09      ; PIND
  sbrc r17, 2       ; SBRC skips when the bit is CLEARED (pressed)
  rjmp released     ; not skipped → PD2 HIGH (released)
  ldi r16, 0x00     ; pressed → mirror LOW on PB5
  out 0x05, r16
  rjmp loop
released:
  ldi r16, 0x20     ; released → mirror HIGH on PB5
  out 0x05, r16
  rjmp loop
`;

/* --- 3: serial TX lines + stall flush ------------------------------------ */
const SERIAL_ASM = `
  ldi r16, 103
  sts 0xc4, r16     ; UBRRL → 9600 baud @ 16 MHz
  ldi r16, 0
  sts 0xc5, r16     ; UBRRH
  ldi r16, 0x18
  sts 0xc1, r16     ; UCSRB: TXEN | RXEN
  ldi r16, 0x86
  sts 0xc2, r16     ; UCSRC: 8N1
  ldi r16, 65
  rcall send        ; 'A'
  ldi r16, 66
  rcall send        ; 'B'
  ldi r16, 10
  rcall send        ; '\\n'
  ldi r16, 67
  rcall send        ; 'C' (no newline — must survive the stall flush)
  ldi r16, 68
  rcall send        ; 'D'
hang:
  rjmp hang         ; deliberate infinite loop
send:
  lds r17, 0xc0     ; UCSRA
  sbrs r17, 5       ; wait for UDRE
  rjmp send
  sts 0xc6, r16     ; UDR
  ret
`;

/* --- 4: serial RX echo ---------------------------------------------------- */
const ECHO_ASM = `
  ldi r16, 103
  sts 0xc4, r16
  ldi r16, 0
  sts 0xc5, r16
  ldi r16, 0x18
  sts 0xc1, r16
  ldi r16, 0x86
  sts 0xc2, r16
waitrx:
  lds r17, 0xc0
  sbrc r17, 7       ; RXC?
  rjmp gotrx
  rjmp waitrx
gotrx:
  lds r16, 0xc6     ; read UDR (clears RXC)
  rcall send        ; echo it back
  rjmp waitrx
send:
  lds r17, 0xc0
  sbrs r17, 5
  rjmp send
  sts 0xc6, r16
  ret
`;

/* --- 5: 16-bit OCR1A servo ------------------------------------------------ */
const SERVO_ASM = `
  ldi r16, 0x77     ; 375 & 0xff → 1500 µs at 4 µs/tick
  sts 0x88, r16     ; OCR1AL
  ldi r17, 0x01     ; 375 >> 8
  sts 0x89, r17     ; OCR1AH
hang:
  rjmp hang
`;

async function main(): Promise<void> {
  console.log('=== Headless AVR Harness Verification ===\n');

  /* 1 + 2 */
  {
    const harness = new HeadlessAVRHarness();
    harness.loadProgram(program(MIRROR_ASM));
    harness.setScenario([
      { atMs: 50, kind: 'pin', pin: 2, level: 0 }, // press
      { atMs: 150, kind: 'pin', pin: 2, level: 1 }, // release
    ]);
    const result = await harness.run({ simulateMs: 250 });

    const pin13 = result.trace.pinEvents.filter((event) => event.pin === 13);
    const lowAt = pin13.find((event) => event.level === 0);
    const highAfter = pin13.filter((event) => event.level === 1).pop();
    check('simulation completed', result.completed, result.error ?? '');
    check('pull-up idles HIGH before the press', pin13[0]?.level === 1 && pin13[0].atMs < 50, `first pin13 event: ${JSON.stringify(pin13[0])}`);
    check('button press drives the firmware (mirror goes LOW ~50ms)', lowAt !== undefined && lowAt.atMs >= 50 && lowAt.atMs < 60, `low event: ${JSON.stringify(lowAt)}`);
    check('release drives the firmware (mirror HIGH ~150ms)', highAfter !== undefined && highAfter.atMs >= 150 && highAfter.atMs < 160, `high event: ${JSON.stringify(highAfter)}`);
    check('pin 13 recorded as firmware-driven', result.trace.drivenPins.includes(13), `drivenPins: ${result.trace.drivenPins.join(',')}`);
    check('getPin(2) reports the driven level (1 after release)', harness.getPin(2) === 1, `getPin(2)=${harness.getPin(2)}`);
    check('getPin(13) reports the output level (1)', harness.getPin(13) === 1, `getPin(13)=${harness.getPin(13)}`);
  }

  /* 3 */
  {
    const harness = new HeadlessAVRHarness();
    harness.loadProgram(program(SERIAL_ASM));
    const result = await harness.run({ simulateMs: 2000, stallThresholdCycles: 1_000_000 });

    const texts = result.trace.serialLines.map((line) => line.text);
    check('stall detected (rjmp .)', !result.completed && /stalled/i.test(result.error ?? ''), result.error ?? 'completed?!');
    check('serial split into lines', JSON.stringify(texts) === JSON.stringify(['AB', 'CD']), `lines: ${JSON.stringify(result.trace.serialLines)}`);
    check('line timestamps are real (not one blob at the end)', result.trace.serialLines[0] !== undefined && result.trace.serialLines[0].atMs < 500, `atMs: ${result.trace.serialLines.map((l) => l.atMs).join(',')}`);
  }

  /* 4 */
  {
    const harness = new HeadlessAVRHarness();
    harness.loadProgram(program(ECHO_ASM));
    harness.setScenario([{ atMs: 5, kind: 'serial', bytes: Uint8Array.from([0x68]) }]); // 'h'
    const result = await harness.run({ simulateMs: 100 });

    const echoed = result.trace.serialLines.map((line) => line.text).join('');
    check('serial RX byte reached the firmware and was echoed', result.completed && echoed.includes('h'), `lines: ${JSON.stringify(result.trace.serialLines)}, completed=${result.completed}`);
  }

  /* 5 */
  {
    const harness = new HeadlessAVRHarness();
    harness.loadProgram(program(SERVO_ASM));
    const result = await harness.run({ simulateMs: 50, stallThresholdCycles: 200_000 });

    const servo = result.trace.servoEvents.find((event) => event.pin === 9);
    check('16-bit OCR1A → 1500µs → 90°', servo?.angle === 90, `servoEvents: ${JSON.stringify(result.trace.servoEvents)}`);
  }

  console.log(failures === 0 ? '\n=== all harness checks passed ===' : `\n=== ${failures} harness check(s) FAILED ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
