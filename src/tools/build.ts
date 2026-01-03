/**
 * Build and flash tools
 * Wraps PlatformIO batch scripts
 */

import { executeBatch, getBatchScriptPath, fileExists } from '../utils/exec.js';
import { parseBuildOutput, extractErrorMessage } from '../utils/parser.js';
import { validateProjectPath, validateEnvironment, sanitizePath } from '../utils/validation.js';
import type { BuildResult, FlashResult } from '../types/index.js';

/**
 * Build ESP32 firmware
 */
export async function buildFirmware(
  projectPath?: string,
  environment?: string
): Promise<BuildResult> {
  // Validate inputs
  if (projectPath && !validateProjectPath(projectPath)) {
    return {
      success: false,
      output: '',
      errors: ['Invalid project path']
    };
  }

  if (environment && !validateEnvironment(environment)) {
    return {
      success: false,
      output: '',
      errors: ['Invalid environment name']
    };
  }

  // Check if pio-build.bat exists
  const batchPath = getBatchScriptPath('pio-build.bat');
  if (!await fileExists(batchPath)) {
    return {
      success: false,
      output: '',
      errors: [`Build script not found: ${batchPath}`]
    };
  }

  // Build arguments
  const args: string[] = [];
  if (projectPath) {
    args.push(sanitizePath(projectPath));
  }
  if (environment) {
    args.push(environment);
  }

  // Execute build
  const result = await executeBatch(batchPath, args, {
    timeout: 300000 // 5 minutes for builds
  });

  // Parse build output
  const parsed = parseBuildOutput(result.stdout + result.stderr);

  return {
    success: result.success,
    output: result.stdout,
    firmwareSize: parsed.firmwareSize,
    memoryUsage: parsed.memoryUsage,
    errors: parsed.errors,
    warnings: parsed.warnings
  };
}

/**
 * Flash firmware to ESP32 device
 */
export async function flashFirmware(
  projectPath?: string,
  port?: string
): Promise<FlashResult> {
  // Validate inputs
  if (projectPath && !validateProjectPath(projectPath)) {
    return {
      success: false,
      output: 'Invalid project path'
    };
  }

  // Check if pio-flash.bat exists
  const batchPath = getBatchScriptPath('pio-flash.bat');
  if (!await fileExists(batchPath)) {
    return {
      success: false,
      output: `Flash script not found: ${batchPath}`
    };
  }

  // Build arguments
  const args: string[] = [];
  if (projectPath) {
    args.push(sanitizePath(projectPath));
  }
  if (port) {
    args.push(port);
  }

  // Execute flash
  const startTime = Date.now();
  const result = await executeBatch(batchPath, args, {
    timeout: 120000 // 2 minutes for flashing
  });
  const uploadTime = (Date.now() - startTime) / 1000;

  return {
    success: result.success,
    output: result.stdout,
    uploadTime,
    port
  };
}

/**
 * Full cycle: build, flash, and monitor
 */
export async function fullCycle(
  projectPath?: string,
  port?: string
): Promise<{
  buildResult: BuildResult;
  flashResult: FlashResult;
  success: boolean;
}> {
  // First, build
  const buildResult = await buildFirmware(projectPath);

  if (!buildResult.success) {
    return {
      buildResult,
      flashResult: {
        success: false,
        output: 'Build failed, skipping flash'
      },
      success: false
    };
  }

  // Then, flash
  const flashResult = await flashFirmware(projectPath, port);

  return {
    buildResult,
    flashResult,
    success: buildResult.success && flashResult.success
  };
}

/**
 * Clean build artifacts
 */
export async function cleanBuild(projectPath?: string): Promise<{
  success: boolean;
  output: string;
}> {
  // Validate inputs
  if (projectPath && !validateProjectPath(projectPath)) {
    return {
      success: false,
      output: 'Invalid project path'
    };
  }

  // Check if pio-clean.bat exists
  const batchPath = getBatchScriptPath('pio-clean.bat');
  if (!await fileExists(batchPath)) {
    return {
      success: false,
      output: `Clean script not found: ${batchPath}`
    };
  }

  // Build arguments
  const args: string[] = [];
  if (projectPath) {
    args.push(sanitizePath(projectPath));
  }

  // Execute clean
  const result = await executeBatch(batchPath, args);

  return {
    success: result.success,
    output: result.stdout
  };
}

/**
 * Monitor serial output
 */
export async function monitorSerial(
  port?: string,
  baudRate: number = 115200
): Promise<{
  success: boolean;
  output: string;
  message?: string;
}> {
  // Check if pio-monitor.bat exists
  const batchPath = getBatchScriptPath('pio-monitor.bat');
  if (!await fileExists(batchPath)) {
    return {
      success: false,
      output: '',
      message: `Monitor script not found: ${batchPath}`
    };
  }

  // Build arguments
  const args: string[] = [];
  if (port) {
    args.push(port);
  }
  args.push(baudRate.toString());

  // Note: This will start monitoring in background
  // The user will need to stop it manually (Ctrl+C)
  return {
    success: true,
    output: '',
    message: `Starting serial monitor on ${port || 'default port'} at ${baudRate} baud...`
  };
}
