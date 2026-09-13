declare module 'avr8js' {
  export class CPU {
    pc: number;
    cycles: number;
    data: Uint8Array;
    progBytes: Uint8Array;
    constructor(progBytes: Uint16Array | Uint8Array);
    reset(): void;
  }

  export interface AVRPortConfig {
    [key: string]: any;
  }

  export class AVRIOPort {
    constructor(cpu: CPU, config: AVRPortConfig);
    addListener(listener: (value: number, oldValue: number) => void): void;
    removeListener(listener: (value: number, oldValue: number) => void): void;
    setPin(pin: number, value: boolean): void;
  }

  export class AVRTimer {
    constructor(cpu: CPU, config: any);
  }

  export class AVRUSART {
    constructor(cpu: CPU, config: any, freqHz?: number);
    onByteTransmit?: (value: number) => void;
  }

  export const timer0Config: any;
  export const timer1Config: any;
  export const timer2Config: any;
  export const portBConfig: AVRPortConfig;
  export const portCConfig: AVRPortConfig;
  export const portDConfig: AVRPortConfig;
  export const usart0Config: any;
  export function avrInstruction(cpu: CPU): void;
}

declare module 'avr8js/dist/esm/utils/assembler' {
  export function assemble(code: string): { bytes: Uint8Array; errors: any[] };
}
