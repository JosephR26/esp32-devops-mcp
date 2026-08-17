/**
 * Hardware transport layer.
 *
 * All physical interrogation runs through an *interrogation agent* — a small
 * firmware sketch (see firmware/interrogation-agent/) running on the ESP32 that
 * accepts newline-delimited JSON requests over the USB serial link and answers
 * with newline-delimited JSON responses.
 *
 * The MCP server never touches the serial port directly. It shells out to
 * scripts/hw_bridge.py (pyserial), mirroring how the rest of this repo delegates
 * serial work to Python. That keeps the npm dependency surface unchanged and
 * makes the transport trivially replaceable in tests.
 *
 * Raw response text is preserved on every result, successful or not.
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { executePython, fileExists } from '../utils/exec.js';
import { withPortLock } from '../utils/port-lock.js';
import { validateSerialPort, validateBaudRate } from '../utils/validation.js';
import type {
  HardwareTransport,
  TransportDescriptor,
  TransportErrorKind,
  TransportResult,
} from '../types/hardware.js';

/** Default request timeout for a single agent operation. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

/** Hard ceiling on any single agent operation, to bound long captures. */
export const MAX_REQUEST_TIMEOUT_MS = 120000;

/** Baud rate the interrogation agent firmware uses. */
export const AGENT_BAUD_RATE = 115200;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bundled pyserial bridge script. */
export function getBridgeScriptPath(): string {
  // Compiled layout: dist/hardware/transport.js -> <repo>/scripts/hw_bridge.py
  return resolve(join(MODULE_DIR, '..', '..', 'scripts', 'hw_bridge.py'));
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Build a failed TransportResult without throwing. */
export function transportFailure(
  op: string,
  error: string,
  errorKind: TransportErrorKind,
  raw = '',
  durationMs = 0
): TransportResult<never> {
  return {
    ok: false,
    op,
    data: null,
    raw,
    error,
    errorKind,
    durationMs,
    timestamp: nowIso(),
  };
}

/**
 * Transport that speaks to the interrogation agent through scripts/hw_bridge.py.
 */
export class PythonBridgeTransport implements HardwareTransport {
  private readonly port: string;
  private readonly baud: number;
  private readonly scriptPath: string;
  private scriptChecked = false;
  private scriptPresent = false;

  constructor(port: string, baud: number = AGENT_BAUD_RATE, scriptPath?: string) {
    this.port = port;
    this.baud = baud;
    this.scriptPath = scriptPath ?? getBridgeScriptPath();
  }

  describe(): TransportDescriptor {
    return {
      kind: 'python-bridge',
      port: this.port,
      baud: this.baud,
      detail: `scripts/hw_bridge.py -> ${this.port} @ ${this.baud}`,
    };
  }

  async request<T = unknown>(
    op: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {}
  ): Promise<TransportResult<T>> {
    const timeoutMs = clampTimeout(options.timeoutMs);
    const started = Date.now();

    if (!this.scriptChecked) {
      this.scriptPresent = await fileExists(this.scriptPath);
      this.scriptChecked = true;
    }
    if (!this.scriptPresent) {
      return transportFailure(
        op,
        `Serial bridge script not found: ${this.scriptPath}`,
        'NO_TRANSPORT',
        '',
        Date.now() - started
      );
    }

    const payload = JSON.stringify({ op, params });
    const args = [
      '--port',
      this.port,
      '--baud',
      String(this.baud),
      '--timeout',
      String(timeoutMs),
      '--request',
      payload,
    ];

    // Hold the cross-process port lock for the exchange.
    //
    // The serial port is exclusive at the OS level, and this project now has more than
    // one process wanting it: the MCP server and the control panel. Without this, the
    // loser of that race gets a PermissionError that the tools report as a
    // datasheet-only answer — a collision that looks like a hardware fault.
    //
    // The lock is only held for the duration of one bridge exchange, so a long-running
    // caller cannot starve a short one.
    //
    // Give the Python process headroom over the on-wire timeout so its own structured
    // timeout error wins over a hard process kill.
    const exec = await withPortLock(
      this.port,
      () => executePython(this.scriptPath, args, { timeout: timeoutMs + 5000 }),
      { waitMs: timeoutMs + 10000, owner: `transport ${op}` }
    );
    const durationMs = Date.now() - started;
    const raw = exec.stdout || '';

    if (!raw.trim()) {
      const stderr = exec.stderr || '';
      return transportFailure(
        op,
        stderr || 'Serial bridge produced no output',
        classifyBridgeError(stderr),
        stderr,
        durationMs
      );
    }

    let envelope: any;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return transportFailure(
        op,
        'Serial bridge returned malformed JSON',
        'MALFORMED_RESPONSE',
        raw,
        durationMs
      );
    }

    if (envelope?.ok !== true) {
      return {
        ok: false,
        op,
        data: null,
        raw: typeof envelope?.raw === 'string' ? envelope.raw : raw,
        error: envelope?.error ?? 'Agent reported an error',
        errorKind: normaliseErrorKind(envelope?.errorKind),
        durationMs,
        timestamp: nowIso(),
      };
    }

    return {
      ok: true,
      op,
      data: (envelope.data ?? null) as T,
      raw: typeof envelope.raw === 'string' ? envelope.raw : raw,
      durationMs,
      timestamp: nowIso(),
    };
  }
}

/** Transport used when no port is available — fails cleanly instead of throwing. */
export class UnavailableTransport implements HardwareTransport {
  constructor(private readonly reason: string) {}

  describe(): TransportDescriptor {
    return { kind: 'unavailable', port: null, baud: 0, detail: this.reason };
  }

  async request<T = unknown>(op: string): Promise<TransportResult<T>> {
    return transportFailure(op, this.reason, 'NO_TRANSPORT');
  }
}

function clampTimeout(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.min(Math.round(value), MAX_REQUEST_TIMEOUT_MS);
}

const ERROR_KINDS: TransportErrorKind[] = [
  'NO_TRANSPORT',
  'PORT_UNAVAILABLE',
  'AGENT_NOT_PRESENT',
  'TIMEOUT',
  'MALFORMED_RESPONSE',
  'BUS_ERROR',
  'UNSUPPORTED_OPERATION',
  'DEVICE_ERROR',
  'INTERNAL',
];

function normaliseErrorKind(value: unknown): TransportErrorKind {
  return ERROR_KINDS.includes(value as TransportErrorKind)
    ? (value as TransportErrorKind)
    : 'INTERNAL';
}

function classifyBridgeError(stderr: string): TransportErrorKind {
  const text = stderr.toLowerCase();
  if (text.includes('no module named serial') || text.includes('pyserial')) {
    return 'NO_TRANSPORT';
  }
  if (text.includes('could not open port') || text.includes('permission denied')) {
    return 'PORT_UNAVAILABLE';
  }
  if (text.includes('python not found')) {
    return 'NO_TRANSPORT';
  }
  if (text.includes('timeout') || text.includes('timed out')) {
    return 'TIMEOUT';
  }
  return 'INTERNAL';
}

// ---------------------------------------------------------------------------
// Factory + injection point
// ---------------------------------------------------------------------------

export type TransportFactory = (
  port: string | undefined,
  baud: number
) => HardwareTransport | Promise<HardwareTransport>;

const defaultFactory: TransportFactory = (port, baud) => {
  if (!port) {
    return new UnavailableTransport(
      'No serial port supplied and no default port could be resolved. ' +
        'Pass `port`, or set one with esp32_set_default_port.'
    );
  }
  if (!validateSerialPort(port)) {
    return new UnavailableTransport(`Invalid serial port: ${port}`);
  }
  if (!validateBaudRate(baud)) {
    return new UnavailableTransport(`Invalid baud rate: ${baud}`);
  }
  return new PythonBridgeTransport(port, baud);
};

let activeFactory: TransportFactory = defaultFactory;

/**
 * Replace the transport factory. Used by tests to inject mocked hardware so the
 * whole interrogation pipeline runs in CI with no physical device attached.
 */
export function setTransportFactory(factory: TransportFactory): void {
  activeFactory = factory;
}

/** Restore the real serial-bridge transport factory. */
export function resetTransportFactory(): void {
  activeFactory = defaultFactory;
}

/** Obtain a transport for the given port. */
export async function createTransport(
  port?: string,
  baud: number = AGENT_BAUD_RATE
): Promise<HardwareTransport> {
  return activeFactory(port, baud);
}
