/**
 * Command execution utilities for running Python scripts and batch files.
 * Cross-platform: works on Windows, Linux, and macOS.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { access } from 'fs/promises';
import type { ExecOptions, ExecResult } from '../types/index.js';

const execAsync = promisify(exec);

/**
 * Execute a command with timeout and error handling
 */
export async function executeCommand(
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const {
    cwd = process.cwd(),
    timeout = 120000, // 2 minutes default
    env = process.env as Record<string, string>
  } = options;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      env: { ...env },
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
      windowsHide: true
    });

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
      success: true
    };
  } catch (error: any) {
    return {
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || error.message,
      exitCode: error.code || 1,
      success: false
    };
  }
}

/**
 * Execute a Python script
 */
export async function executePython(
  scriptPath: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  // Try python3 first, then python, then py (Windows launcher)
  const pythonCommands = ['python3', 'python', 'py'];

  for (const pythonCmd of pythonCommands) {
    try {
      const checkResult = await executeCommand(`${pythonCmd} --version`, {
        timeout: 5000
      });

      if (checkResult.success) {
        const command = `${pythonCmd} "${scriptPath}" ${args.join(' ')}`;
        return await executeCommand(command, options);
      }
    } catch {
      continue;
    }
  }

  return {
    stdout: '',
    stderr: 'Python not found. Please install Python 3.x',
    exitCode: 1,
    success: false
  };
}

/**
 * Execute a batch file (Windows) or shell script (Linux/macOS)
 */
export async function executeBatch(
  scriptPath: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const isWindows = process.platform === 'win32';
  const command = isWindows
    ? `cmd /c "${scriptPath}" ${args.join(' ')}`
    : `bash "${scriptPath}" ${args.join(' ')}`;
  return await executeCommand(command, options);
}

/**
 * Check if a file exists (cross-platform)
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve toolkit path from environment variable.
 * @throws Error if FIRMWARE_TOOLKIT_PATH is not set
 */
export function getToolkitPath(): string {
  const toolkitPath = process.env.FIRMWARE_TOOLKIT_PATH;

  if (!toolkitPath) {
    throw new Error(
      'FIRMWARE_TOOLKIT_PATH environment variable is not set.\n' +
      'Please install FirmwareToolkit and set the environment variable:\n' +
      '  https://github.com/JosephR26/FirmwareToolkit\n\n' +
      'Windows:   setx FIRMWARE_TOOLKIT_PATH "C:\\path\\to\\FirmwareToolkit"\n' +
      'Linux/Mac: export FIRMWARE_TOOLKIT_PATH="/path/to/FirmwareToolkit"'
    );
  }

  return toolkitPath;
}

/**
 * Get path to a Python script in the toolkit's scripts/ directory
 */
export function getPythonScriptPath(scriptName: string): string {
  return join(getToolkitPath(), 'scripts', scriptName);
}

/**
 * Get path to a batch/shell script in the toolkit's scripts/ directory
 */
export function getBatchScriptPath(scriptName: string): string {
  return join(getToolkitPath(), 'scripts', scriptName);
}

/**
 * Get path to a testing script in the toolkit's testing/ directory
 */
export function getTestingScriptPath(scriptName: string): string {
  return join(getToolkitPath(), 'testing', scriptName);
}
