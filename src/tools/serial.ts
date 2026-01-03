/**
 * Serial port management tools
 * Wraps serial-port-manager.py functionality
 */

import { executePython, getPythonScriptPath } from '../utils/exec.js';
import { parseSerialPorts } from '../utils/parser.js';
import { validateSerialPort } from '../utils/validation.js';
import type { SerialPort } from '../types/index.js';

const SCRIPT_PATH = getPythonScriptPath('serial-port-manager.py');

/**
 * List all available ESP32 serial ports
 */
export async function listSerialPorts(): Promise<{
  ports: SerialPort[];
  default?: string;
  recommended?: string;
  error?: string;
}> {
  const result = await executePython(SCRIPT_PATH, ['--list']);

  if (!result.success) {
    return {
      ports: [],
      error: result.stderr || 'Failed to list serial ports'
    };
  }

  try {
    const parsed = parseSerialPorts(result.stdout);
    return {
      ports: parsed.ports || [],
      default: parsed.default,
      recommended: parsed.recommended
    };
  } catch (error) {
    return {
      ports: [],
      error: 'Failed to parse serial port list'
    };
  }
}

/**
 * Detect ESP32 ports automatically
 */
export async function detectESP32Ports(): Promise<{
  ports: SerialPort[];
  error?: string;
}> {
  const result = await executePython(SCRIPT_PATH, ['--detect']);

  if (!result.success) {
    return {
      ports: [],
      error: result.stderr || 'Failed to detect ESP32 ports'
    };
  }

  try {
    const ports: SerialPort[] = [];
    const lines = result.stdout.split('\n');

    for (const line of lines) {
      const match = line.match(/(COM\d+|\/dev\/tty\w+):\s+(.+)/);
      if (match) {
        ports.push({
          port: match[1],
          description: match[2],
          isESP32: true
        });
      }
    }

    return { ports };
  } catch (error) {
    return {
      ports: [],
      error: 'Failed to parse detected ports'
    };
  }
}

/**
 * Set default serial port
 */
export async function setDefaultPort(port: string): Promise<{
  success: boolean;
  error?: string;
}> {
  if (!validateSerialPort(port)) {
    return {
      success: false,
      error: `Invalid serial port: ${port}`
    };
  }

  const result = await executePython(SCRIPT_PATH, ['--set-default', port]);

  return {
    success: result.success,
    error: result.success ? undefined : result.stderr
  };
}

/**
 * Add port to favorites
 */
export async function addFavoritePort(
  port: string,
  name?: string
): Promise<{
  success: boolean;
  error?: string;
}> {
  if (!validateSerialPort(port)) {
    return {
      success: false,
      error: `Invalid serial port: ${port}`
    };
  }

  const args = ['--add-favorite', port];
  if (name) {
    args.push('--name', name);
  }

  const result = await executePython(SCRIPT_PATH, args);

  return {
    success: result.success,
    error: result.success ? undefined : result.stderr
  };
}

/**
 * Remove port from favorites
 */
export async function removeFavoritePort(port: string): Promise<{
  success: boolean;
  error?: string;
}> {
  if (!validateSerialPort(port)) {
    return {
      success: false,
      error: `Invalid serial port: ${port}`
    };
  }

  const result = await executePython(SCRIPT_PATH, ['--remove-favorite', port]);

  return {
    success: result.success,
    error: result.success ? undefined : result.stderr
  };
}

/**
 * Get recommended port (default > last used > auto-detected)
 */
export async function getRecommendedPort(): Promise<{
  port?: string;
  error?: string;
}> {
  const result = await executePython(SCRIPT_PATH, ['--get-recommended']);

  if (!result.success || !result.stdout) {
    return {
      error: 'No recommended port available'
    };
  }

  return {
    port: result.stdout.trim()
  };
}
