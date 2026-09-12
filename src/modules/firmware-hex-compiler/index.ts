/**
 * Real firmware cross-compiler using arduino-cli.
 *
 * Unlike firmware-compiler/ (which type-checks with host g++ against a stub
 * core), this module produces actual AVR/ESP machine code by shelling out to
 * arduino-cli. The resulting .hex file can be loaded into avr8js for real
 * hardware simulation.
 *
 * The gate is used in the validation pipeline when WIREUP_ENABLE_REAL_SIM_LOOP
 * is true. If arduino-cli is not on PATH, it degrades honestly with status
 * `sim_execution_unavailable` — the pipeline continues, just without real sim.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { GeneratedCodeFile } from '@/types/project';

export interface HexCompileStatus {
  available: boolean;
  compiler?: string;
  version?: string;
  reason?: string;
}

export interface HexCompileResult {
  /** False when the gate was disabled or arduino-cli is not on PATH. */
  ran: boolean;
  ok: boolean;
  /** Path to the compiled .hex file (only when ok=true). */
  hexPath?: string;
  /** The hex file content as string (only when ok=true). */
  hexContent?: string;
  /** Compiler version info. */
  compilerInfo?: string;
  durationMs: number;
  /** stdout/stderr from arduino-cli for debugging. */
  output?: string;
  /** Why the gate did not run (disabled, no compiler, …). */
  skippedReason?: string;
}

interface Probe {
  at: number;
  status: HexCompileStatus;
}

let probe: Probe | null = null;
const PROBE_TTL_MS = 60_000;

/** Board FQBN mapping for common controllers. */
const BOARD_FQBN_MAP: Record<string, string> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano',
  'arduino-mega': 'arduino:avr:mega',
  'arduino-leonardo': 'arduino:avr:leonardo',
  'esp32': 'esp32:esp32:esp32',
  'esp32-s2': 'esp32:esp32:esp32s2',
  'esp32-s3': 'esp32:esp32:esp32s3',
  'esp32-c3': 'esp32:esp32:esp32c3',
  'rp2040': 'rp2040:rp2040:rpipico',
  'rp2040-w': 'rp2040:rp2040:rpipicow',
};

/** Find arduino-cli, probing at most once a minute. */
export function hexCompilerStatus(): HexCompileStatus {
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.status;

  let status: HexCompileStatus = { available: false, reason: 'no arduino-cli found on PATH' };
  try {
    const output = execFileSync('arduino-cli', ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
    const versionMatch = /Version:\s*(\S+)/.exec(output);
    status = { available: true, compiler: 'arduino-cli', version: versionMatch?.[1] ?? 'unknown' };
  } catch {
    /* arduino-cli not available */
  }

  probe = { at: Date.now(), status };
  return status;
}

/** Reset the probe cache (useful for tests). */
export function resetHexCompilerProbe(): void {
  probe = null;
}

/** Resolve board FQBN from component ID or return default. */
function resolveFqbn(controllerComponentId?: string): string {
  if (!controllerComponentId) return BOARD_FQBN_MAP['arduino-uno'];
  const normalized = controllerComponentId.toLowerCase().replace(/[_-]/g, '-');
  for (const [key, fqbn] of Object.entries(BOARD_FQBN_MAP)) {
    if (normalized.includes(key)) return fqbn;
  }
  return BOARD_FQBN_MAP['arduino-uno'];
}

/** Compilable source files, entry point first. */
function compilableFiles(files: GeneratedCodeFile[], entryPoint: string): GeneratedCodeFile[] {
  const sources = files.filter((file) => /\.(ino|cpp|c|h|hpp)$/i.test(file.path));
  const entry = sources.find((file) => file.path === entryPoint);
  const rest = sources.filter((file) => file !== entry);
  return entry ? [entry, ...rest] : sources;
}

export interface CompileToHexInput {
  files: GeneratedCodeFile[];
  entryPoint: string;
  /** Controller component ID to determine board FQBN. */
  controllerComponentId?: string;
  /** Optional libraries to install before compile. */
  libraries?: string[];
}

/**
 * Cross-compile Arduino sketch to .hex using arduino-cli.
 *
 * This creates a temporary sketch directory, writes all files, runs
 * arduino-cli compile, and returns the hex content.
 */
export function compileToHex(input: CompileToHexInput): HexCompileResult {
  const startedAt = Date.now();

  const status = hexCompilerStatus();
  if (!status.available) {
    return { ran: false, ok: false, durationMs: 0, skippedReason: status.reason };
  }

  const sources = compilableFiles(input.files, input.entryPoint);
  const entry = sources[0];
  if (!entry) {
    return { ran: false, ok: false, durationMs: 0, skippedReason: 'no compilable source file in the code artifact' };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wireup-hex-compile-'));
  const sketchDir = path.join(workDir, 'sketch');
  fs.mkdirSync(sketchDir, { recursive: true });

  try {
    // Write all source files to the sketch directory
    for (const file of sources) {
      const target = path.join(sketchDir, path.basename(file.path));
      fs.writeFileSync(target, file.content, 'utf8');
    }

    const fqbn = resolveFqbn(input.controllerComponentId);
    const buildDir = path.join(workDir, 'build');

    // Install libraries if specified
    if (input.libraries && input.libraries.length > 0) {
      for (const lib of input.libraries) {
        try {
          execFileSync('arduino-cli', ['lib', 'install', lib], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
          });
        } catch {
          // Library install failure is non-fatal; compilation will fail if truly needed
        }
      }
    }

    // Run arduino-cli compile
    const compileOutput = execFileSync(
      'arduino-cli',
      [
        'compile',
        '--fqbn', fqbn,
        '--build-path', buildDir,
        '--output-dir', buildDir,
        sketchDir,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );

    // Find the generated .hex file
    const hexFiles = fs.readdirSync(buildDir).filter((f) => f.endsWith('.hex'));
    if (hexFiles.length === 0) {
      return {
        ran: true,
        ok: false,
        durationMs: Date.now() - startedAt,
        output: compileOutput,
        skippedReason: 'compilation succeeded but no .hex file was produced',
      };
    }

    const hexPath = path.join(buildDir, hexFiles[0]);
    const hexContent = fs.readFileSync(hexPath, 'utf8');

    return {
      ran: true,
      ok: true,
      hexPath,
      hexContent,
      compilerInfo: status.version,
      durationMs: Date.now() - startedAt,
      output: compileOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
    return {
      ran: true,
      ok: false,
      durationMs: Date.now() - startedAt,
      output: `${message}\n${stderr}`,
      skippedReason: `arduino-cli compile failed: ${message.split('\n')[0]}`,
    };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
}
