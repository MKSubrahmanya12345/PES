/**
 * Diagnose arduino-cli installation and configuration.
 *
 * Run with: pnpm diagnose:arduino-cli
 *
 * This script checks:
 * - arduino-cli is on PATH
 * - Core platforms are installed (arduino:avr, esp32:esp32, rp2040:rp2040)
 * - Library index is up to date
 * - Compilation works with a simple test sketch
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_SKETCH = `
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}
`;

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  details?: string;
}

function runCheck(name: string, fn: () => { status: 'ok' | 'warn' | 'error'; message: string; details?: string }): CheckResult {
  try {
    const result = fn();
    return { name, ...result };
  } catch (error) {
    return {
      name,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkArduinoCliOnPath(): CheckResult {
  return runCheck('arduino-cli on PATH', () => {
    try {
      const output = execFileSync('arduino-cli', ['version'], { encoding: 'utf8', timeout: 5000 });
      const versionMatch = /Version:\s*(\S+)/.exec(output);
      return {
        status: 'ok',
        message: `arduino-cli found: ${versionMatch?.[1] ?? 'unknown version'}`,
        details: output.trim(),
      };
    } catch {
      return {
        status: 'error',
        message: 'arduino-cli not found on PATH',
        details: 'Install arduino-cli from https://arduino.github.io/arduino-cli/latest/installation/',
      };
    }
  });
}

function checkCoreIndex(): CheckResult {
  return runCheck('Core index updated', () => {
    try {
      execFileSync('arduino-cli', ['core', 'update-index'], { encoding: 'utf8', timeout: 30000 });
      return {
        status: 'ok',
        message: 'Core index updated successfully',
      };
    } catch (error) {
      return {
        status: 'warn',
        message: 'Failed to update core index',
        details: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function checkAvrCore(): CheckResult {
  return runCheck('Arduino AVR core', () => {
    try {
      const output = execFileSync('arduino-cli', ['core', 'list'], { encoding: 'utf8', timeout: 10000 });
      if (output.includes('arduino:avr')) {
        const match = /arduino:avr\s+(\S+)/.exec(output);
        return {
          status: 'ok',
          message: `Arduino AVR core installed: ${match?.[1] ?? 'version unknown'}`,
        };
      }
      return {
        status: 'error',
        message: 'Arduino AVR core not installed',
        details: 'Run: arduino-cli core install arduino:avr',
      };
    } catch (error) {
      return {
        status: 'error',
        message: 'Failed to check AVR core',
        details: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function checkEsp32Core(): CheckResult {
  return runCheck('ESP32 core (optional)', () => {
    try {
      const output = execFileSync('arduino-cli', ['core', 'list'], { encoding: 'utf8', timeout: 10000 });
      if (output.includes('esp32:esp32')) {
        const match = /esp32:esp32\s+(\S+)/.exec(output);
        return {
          status: 'ok',
          message: `ESP32 core installed: ${match?.[1] ?? 'version unknown'}`,
        };
      }
      return {
        status: 'warn',
        message: 'ESP32 core not installed (optional)',
        details: 'Run: arduino-cli core install esp32:esp32 (requires board_manager.additional_urls)',
      };
    } catch (error) {
      return {
        status: 'warn',
        message: 'Failed to check ESP32 core',
        details: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function checkRp2040Core(): CheckResult {
  return runCheck('RP2040 core (optional)', () => {
    try {
      const output = execFileSync('arduino-cli', ['core', 'list'], { encoding: 'utf8', timeout: 10000 });
      if (output.includes('rp2040:rp2040')) {
        const match = /rp2040:rp2040\s+(\S+)/.exec(output);
        return {
          status: 'ok',
          message: `RP2040 core installed: ${match?.[1] ?? 'version unknown'}`,
        };
      }
      return {
        status: 'warn',
        message: 'RP2040 core not installed (optional)',
        details: 'Run: arduino-cli config add board_manager.additional_urls https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json && arduino-cli core install rp2040:rp2040',
      };
    } catch (error) {
      return {
        status: 'warn',
        message: 'Failed to check RP2040 core',
        details: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function checkCompilation(): CheckResult {
  return runCheck('Test compilation', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wireup-diagnose-'));
    const sketchDir = path.join(workDir, 'test_sketch');
    fs.mkdirSync(sketchDir, { recursive: true });

    try {
      fs.writeFileSync(path.join(sketchDir, 'test_sketch.ino'), TEST_SKETCH, 'utf8');

      const buildDir = path.join(workDir, 'build');
      execFileSync(
        'arduino-cli',
        ['compile', '--fqbn', 'arduino:avr:uno', '--build-path', buildDir, sketchDir],
        { encoding: 'utf8', timeout: 60000 },
      );

      const hexFiles = fs.readdirSync(buildDir).filter((f) => f.endsWith('.hex'));
      if (hexFiles.length > 0) {
        return {
          status: 'ok',
          message: 'Test sketch compiled successfully',
          details: `Output: ${hexFiles[0]}`,
        };
      }
      return {
        status: 'error',
        message: 'Compilation succeeded but no .hex file produced',
      };
    } catch (error) {
      return {
        status: 'error',
        message: 'Test compilation failed',
        details: error instanceof Error ? error.message : String(error),
      };
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    }
  });
}

function main(): void {
  console.log('=== Arduino-CLI Diagnostic ===\n');

  const checks = [
    checkArduinoCliOnPath(),
    checkCoreIndex(),
    checkAvrCore(),
    checkEsp32Core(),
    checkRp2040Core(),
    checkCompilation(),
  ];

  let errors = 0;
  let warnings = 0;

  for (const check of checks) {
    const icon = check.status === 'ok' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
    console.log(`${icon} ${check.name}: ${check.message}`);
    if (check.details) {
      console.log(`  ${check.details.split('\n').join('\n  ')}`);
    }
    console.log();

    if (check.status === 'error') errors++;
    if (check.status === 'warn') warnings++;
  }

  console.log('=== Summary ===');
  if (errors === 0 && warnings === 0) {
    console.log('✓ All checks passed! Real simulation loop is ready.');
    process.exit(0);
  } else if (errors === 0) {
    console.log(`⚠ ${warnings} warning(s). Core functionality works, optional features may be limited.`);
    process.exit(0);
  } else {
    console.log(`✗ ${errors} error(s), ${warnings} warning(s). Fix errors before enabling WIREUP_ENABLE_REAL_SIM_LOOP.`);
    process.exit(1);
  }
}

main();
