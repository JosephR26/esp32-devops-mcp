/**
 * Command execution utilities for running Python scripts and batch files.
 * Cross-platform: works on Windows, Linux, and macOS.
 */

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { access } from 'fs/promises';
import type { ExecOptions, ExecResult } from '../types/index.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
 * Execute a Python script.
 * Uses execFile with an argv array to avoid shell interpolation of args.
 */
export async function executePython(
  scriptPath: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  // Try python3 first, then python, then py (Windows launcher)
  const pythonCommands = ['python3', 'python', 'py'];

  const execOpts = {
    cwd: options.cwd ?? process.cwd(),
    timeout: options.timeout ?? 120000,
    env: { ...(options.env ?? process.env) } as Record<string, string>,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  };

  for (const pythonCmd of pythonCommands) {
    try {
      // Probe availability without shell interpolation
      await execFileAsync(pythonCmd, ['--version'], { timeout: 5000 });

      const { stdout, stderr } = await execFileAsync(
        pythonCmd,
        [scriptPath, ...args],
        execOpts
      );
      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
        success: true
      };
    } catch (error: any) {
      // If the error is "not found", try the next candidate
      if (error.code === 'ENOENT') continue;
      // Script ran but exited non-zero — return the output, stop trying
      return {
        stdout: error.stdout?.trim() || '',
        stderr: error.stderr?.trim() || error.message,
        exitCode: error.code ?? 1,
        success: false
      };
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
 * Execute a batch file (Windows) or shell script (Linux/macOS).
 * Uses execFile with an argv array — no shell interpolation of args.
 * Uses /bin/sh on POSIX for maximum portability (no bash dependency).
 */
export async function executeBatch(
  scriptPath: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const execOpts = {
    cwd: options.cwd ?? process.cwd(),
    timeout: options.timeout ?? 120000,
    env: { ...(options.env ?? process.env) } as Record<string, string>,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  };

  try {
    const isWindows = process.platform === 'win32';
    const [interpreter, interpArgs] = isWindows
      ? ['cmd', ['/c', scriptPath, ...args]]
      : ['/bin/sh', [scriptPath, ...args]];

    const { stdout, stderr } = await execFileAsync(interpreter, interpArgs, execOpts);
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
      exitCode: error.code ?? 1,
      success: false
    };
  }
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
