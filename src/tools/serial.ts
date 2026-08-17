/**
 * Serial port management tools
 * Wraps serial-port-manager.py functionality
 */

import { executePython, getPythonScriptPath } from '../utils/exec.js';
import { parseSerialPorts, identifyUsbSerialBridge } from '../utils/parser.js';
import { validateSerialPort } from '../utils/validation.js';
import type { SerialPort } from '../types/index.js';

/**
 * Resolve the port-manager script path lazily.
 *
 * Resolved per call rather than at module load so that a missing
 * FIRMWARE_TOOLKIT_PATH degrades to a per-tool error instead of preventing the
 * whole MCP server from starting. Tools that need no toolkit (hardware
 * interrogation, log parsing, OTA packaging) stay usable either way.
 */
function resolveScript(): { path: string; error?: never } | { path?: never; error: string } {
  try {
    return { path: getPythonScriptPath('serial-port-manager.py') };
  } catch (error: any) {
    return { error: error.message };
  }
}

/**
 * List all available ESP32 serial ports
 */
export async function listSerialPorts(): Promise<{
  ports: SerialPort[];
  default?: string;
  recommended?: string;
  error?: string;
}> {
  const script = resolveScript();
  if (script.error !== undefined) {
    return { ports: [], error: script.error };
  }

  const result = await executePython(script.path, ['--list']);

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
  const script = resolveScript();
  if (script.error !== undefined) {
    return { ports: [], error: script.error };
  }

  const result = await executePython(script.path, ['--detect']);

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
        // Report what the description actually supports. Claiming every enumerated
        // port is an ESP32 is worse than not guessing: it invites flashing a
        // host-internal serial device that merely has "UART" in its name.
        const bridge = identifyUsbSerialBridge(match[2]);
        ports.push({
          port: match[1],
          description: match[2],
          isESP32: bridge !== null,
          ...(bridge ? { bridge } : {})
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

  const script = resolveScript();
  if (script.error !== undefined) {
    return { success: false, error: script.error };
  }

  const result = await executePython(script.path, ['--set-default', port]);

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

  const script = resolveScript();
  if (script.error !== undefined) {
    return { success: false, error: script.error };
  }

  const result = await executePython(script.path, args);

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

  const script = resolveScript();
  if (script.error !== undefined) {
    return { success: false, error: script.error };
  }

  const result = await executePython(script.path, ['--remove-favorite', port]);

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
  const script = resolveScript();
  if (script.error !== undefined) {
    return { error: script.error };
  }

  const result = await executePython(script.path, ['--get-recommended']);

  if (!result.success || !result.stdout) {
    return {
      error: 'No recommended port available'
    };
  }

  return {
    port: result.stdout.trim()
  };
}
