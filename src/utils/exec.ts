/**
 * Command execution utilities for running Python scripts and batch files
 */

import { exec } from 'child_process';
import { promisify } from 'util';
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
  const pythonCommands = ['python', 'python3', 'py'];

  for (const pythonCmd of pythonCommands) {
    try {
      // Check if this Python is available
      const checkResult = await executeCommand(`${pythonCmd} --version`, {
        timeout: 5000
      });

      if (checkResult.success) {
        // Use this Python to run the script
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
 * Execute a batch file (Windows)
 */
export async function executeBatch(
  batchPath: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const command = `cmd /c "${batchPath}" ${args.join(' ')}`;
  return await executeCommand(command, options);
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const result = await executeCommand(`cmd /c "if exist "${filePath}" echo 1"`, {
      timeout: 5000
    });
    return result.stdout.includes('1');
  } catch {
    return false;
  }
}

/**
 * Resolve toolkit path from environment variable
 * @throws Error if FIRMWARE_TOOLKIT_PATH is not set
 */
export function getToolkitPath(): string {
  const toolkitPath = process.env.FIRMWARE_TOOLKIT_PATH;

  if (!toolkitPath) {
    throw new Error(
      'FIRMWARE_TOOLKIT_PATH environment variable is not set.\n' +
      'Please install FirmwareToolkit and set the environment variable:\n' +
      '  https://github.com/JosephR26/FirmwareToolkit\n\n' +
      'Windows: setx FIRMWARE_TOOLKIT_PATH "C:\\path\\to\\FirmwareToolkit"\n' +
      'Linux/Mac: export FIRMWARE_TOOLKIT_PATH="/path/to/FirmwareToolkit"'
    );
  }

  return toolkitPath;
}

/**
 * Get path to Python script in toolkit
 */
export function getPythonScriptPath(scriptName: string): string {
  return `${getToolkitPath()}\\scripts\\${scriptName}`;
}

/**
 * Get path to batch script in toolkit
 */
export function getBatchScriptPath(scriptName: string): string {
  return `${getToolkitPath()}\\scripts\\${scriptName}`;
}

/**
 * Get path to testing script in toolkit
 */
export function getTestingScriptPath(scriptName: string): string {
  return `${getToolkitPath()}\\testing\\${scriptName}`;
}
