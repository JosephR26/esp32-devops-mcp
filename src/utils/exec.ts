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

/** Interpreter names tried, in order, when none is specified. */
export const DEFAULT_PYTHON_COMMANDS: readonly string[] = ['python3', 'python', 'py'];

/**
 * Decides whether an interpreter candidate is usable.
 * Returns false — never throws — so every kind of unusability is handled alike.
 */
export type PythonProbe = (command: string) => Promise<boolean>;

/**
 * Default probe: run `<command> --version` and treat any failure as unusable.
 *
 * "Any failure" is deliberate. ENOENT is not the only way a candidate can be
 * useless: on Windows, `python3` is commonly a Microsoft Store alias stub that
 * exists on PATH — so it never raises ENOENT — but runs nothing and exits 9009.
 * An earlier version distinguished the two and abandoned the search on anything
 * that was not ENOENT, which meant the stub masked a working `python` sitting
 * next in the list.
 */
const defaultPythonProbe: PythonProbe = async (command) => {
  try {
    await execFileAsync(command, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve the first usable interpreter, or null if none of the candidates work.
 *
 * Exported with both parameters injectable so interpreter discovery can be tested
 * without depending on what happens to be installed on the test machine.
 */
export async function resolvePythonCommand(
  candidates: readonly string[] = DEFAULT_PYTHON_COMMANDS,
  probe: PythonProbe = defaultPythonProbe
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await probe(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Execute a Python script.
 * Uses execFile with an argv array to avoid shell interpolation of args.
 */
export async function executePython(
  scriptPath: string,
  args: string[] = [],
  options: ExecOptions & {
    pythonCandidates?: readonly string[];
    pythonProbe?: PythonProbe;
  } = {}
): Promise<ExecResult> {
  const execOpts = {
    cwd: options.cwd ?? process.cwd(),
    timeout: options.timeout ?? 120000,
    env: { ...(options.env ?? process.env) } as Record<string, string>,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  };

  const pythonCmd = await resolvePythonCommand(
    options.pythonCandidates,
    options.pythonProbe
  );

  if (pythonCmd === null) {
    return {
      stdout: '',
      stderr: 'Python not found. Please install Python 3.x',
      exitCode: 1,
      success: false
    };
  }

  try {
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
    // The interpreter ran the script and it failed — that is a real result, not a
    // reason to try another interpreter.
    return {
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || error.message,
      exitCode: error.code ?? 1,
      success: false
    };
  }
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
