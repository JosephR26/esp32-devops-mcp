/**
 * Interrogation session helpers shared by the hardware tool handlers.
 *
 * Resolves the serial port, opens a transport, checks pin safety against the
 * chip's reserved ranges, and gathers the identity facts that make a result
 * reproducible.
 */

import {
  type ConfidenceLevel,
  type Esp32Family,
  type HardwareTransport,
  type InterrogationDepth,
  type ObservedValue,
  type ReproducibilityRecord,
  type TransportErrorKind,
} from '../types/hardware.js';
import { validateSerialPort } from '../utils/validation.js';
import { AGENT_BAUD_RATE, createTransport } from './transport.js';
import { captureReproducibilityFacts } from './experiment.js';
import { inputOnlyPins, normaliseFamily, reservedPins } from './esp32-catalog.js';
import { knownValue, unknownValue } from './evidence.js';

export interface SessionOptions {
  port?: string;
  baud?: number;
}

export interface InterrogationSession {
  transport: HardwareTransport;
  port: ObservedValue<string>;
  /** True when the interrogation agent answered sys.ping. */
  agentPresent: boolean;
  agentDetail: string;
  /**
   * Why the agent was unreachable, when it was. Carried so callers can give a remedy
   * that matches the actual failure — a busy port and missing firmware need opposite
   * advice, and conflating them sends people to reflash working boards.
   */
  agentErrorKind?: TransportErrorKind;
  family: Esp32Family;
  reproducibility: Partial<ReproducibilityRecord>;
}

/**
 * Resolve which serial port to use.
 *
 * Falls back to the existing port-manager tooling when no port is supplied. That
 * lookup depends on FirmwareToolkit, which the interrogation subsystem otherwise
 * does not need, so a missing toolkit degrades to "no port resolved" rather than
 * failing the whole call.
 */
export async function resolvePort(port?: string): Promise<ObservedValue<string>> {
  if (port) {
    return validateSerialPort(port)
      ? knownValue(port, 'USER_SUPPLIED', 'Port supplied by the caller')
      : unknownValue<string>(`Invalid serial port: ${port}`);
  }

  try {
    const serialTools = await import('../tools/serial.js');
    const recommended = await serialTools.getRecommendedPort();
    if (recommended.port && validateSerialPort(recommended.port)) {
      return knownValue(
        recommended.port,
        'TOOLCHAIN_REPORT',
        'Resolved by esp32_get_recommended_port'
      );
    }
    return unknownValue<string>(
      recommended.error ?? 'No recommended port available. Pass `port` explicitly.'
    );
  } catch (error: any) {
    return unknownValue<string>(
      'Port auto-resolution is unavailable (FirmwareToolkit not configured): ' +
        `${error?.message ?? error}. Pass \`port\` explicitly.`
    );
  }
}

/**
 * One-line account of why the target was not reached.
 *
 * Separate templates per case rather than one string patched afterwards: naming the
 * port is optional, and an earlier version papered over the missing name with a
 * `.replace('  ', ' ')`, which silently depends on the exact spacing of a sentence
 * nobody will remember to preserve.
 */
function describeUnreachable(kind: TransportErrorKind | undefined, port: string | null): string {
  switch (kind) {
    case 'PORT_UNAVAILABLE':
      return port
        ? `The serial port ${port} could not be opened, so the target was never contacted.`
        : 'The serial port could not be opened, so the target was never contacted.';

    case 'NO_TRANSPORT':
      return 'No serial transport is available on this host, so the target was never contacted.';

    default:
      return (
        'The interrogation agent did not respond. Flash firmware/interrogation-agent to the ' +
        'target, or pass a port that has it running.'
      );
  }
}

/** Open a session, probing for the interrogation agent. */
export async function openSession(options: SessionOptions = {}): Promise<InterrogationSession> {
  const port = await resolvePort(options.port);
  const transport = await createTransport(
    port.known ? (port.value as string) : undefined,
    options.baud ?? AGENT_BAUD_RATE
  );

  const ping = await transport.request<{ agentVersion?: string }>('sys.ping', {}, { timeoutMs: 4000 });
  const agentPresent = ping.ok;
  const agentErrorKind = agentPresent ? undefined : ping.errorKind;

  // The fallback wording must not assume missing firmware. A port held by a serial
  // monitor never reaches the target at all, and saying "the agent did not respond"
  // there blames a board that was never asked anything.
  const agentDetail = agentPresent
    ? `Interrogation agent ${ping.data?.agentVersion ?? 'present'} responded on ${
        port.value ?? 'the configured port'
      }.`
    : ping.error ?? describeUnreachable(agentErrorKind, port.value);

  const reproducibility = agentPresent
    ? await captureReproducibilityFacts(transport)
    : { hardware: { port, chip: unknownValue<string>(agentDetail), chipRevision: unknownValue<string>(agentDetail), mac: unknownValue<string>(agentDetail) } };

  const family = normaliseFamily(reproducibility.hardware?.chip?.value ?? null);

  return { transport, port, agentPresent, agentDetail, agentErrorKind, family, reproducibility };
}

export interface PinCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Check that the caller-supplied pins are safe to configure on this chip.
 *
 * Reserved flash pins are a hard refusal. Driving them corrupts execution, and
 * "the user asked for it" is not a good enough reason to brick a running board.
 */
export function checkPins(
  family: Esp32Family,
  pins: { signal: string; gpio: number | undefined; mustOutput?: boolean }[]
): PinCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const reserved = reservedPins(family);
  const inputOnly = inputOnlyPins(family);
  const seen = new Map<number, string>();

  for (const pin of pins) {
    if (pin.gpio === undefined) continue;

    if (reserved.includes(pin.gpio)) {
      errors.push(
        `${pin.signal}: GPIO${pin.gpio} is reserved on ${family} (SPI flash/PSRAM). ` +
          'Refusing to configure it.'
      );
      continue;
    }

    if (pin.mustOutput && inputOnly.includes(pin.gpio)) {
      errors.push(
        `${pin.signal}: GPIO${pin.gpio} is input-only on ${family} and cannot drive ${pin.signal}.`
      );
      continue;
    }

    const previous = seen.get(pin.gpio);
    if (previous) {
      errors.push(`GPIO${pin.gpio} is assigned to both ${previous} and ${pin.signal}.`);
      continue;
    }
    seen.set(pin.gpio, pin.signal);

    if (family === 'UNKNOWN') {
      warnings.push(
        `${pin.signal}: chip family is UNKNOWN, so GPIO${pin.gpio} could not be checked ` +
          'against a reserved-pin list.'
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Coerce an arbitrary value to a valid interrogation depth. */
export function coerceDepth(value: unknown, fallback: InterrogationDepth = 'STANDARD'): InterrogationDepth {
  const text = typeof value === 'string' ? value.toUpperCase() : '';
  return text === 'BASIC' || text === 'STANDARD' || text === 'DEEP' || text === 'FORENSIC'
    ? text
    : fallback;
}

/**
 * Explanation appended to reports that could not reach the target.
 *
 * The remedy depends on WHY the agent was unreachable, and getting it wrong is
 * expensive: telling someone to reflash when a serial monitor was holding the port
 * sends them to rewrite a working board. The transport already distinguishes these
 * cases, so the advice must too.
 *
 * `kind` is optional so callers with no error kind to hand still compile; without one
 * the generic firmware advice remains the safest default.
 */
export function agentUnavailableHelp(detail: string, kind?: TransportErrorKind): string[] {
  const lines = [detail];

  switch (kind) {
    case 'PORT_UNAVAILABLE':
      lines.push(
        'The serial port could not be opened, so nothing was asked of the target.',
        'Something else holds it: a serial monitor, another interrogation still in flight, or a stale process.',
        'Close whatever holds the port and retry. The firmware on the target is not implicated by this error.'
      );
      break;

    case 'NO_TRANSPORT':
      lines.push(
        'The host cannot open serial ports at all: pyserial is missing.',
        'Install it with: pip install -r requirements.txt',
        'The firmware on the target is not implicated by this error.'
      );
      break;

    case 'AGENT_NOT_PRESENT':
    case 'TIMEOUT':
    default:
      lines.push(
        'Physical interrogation requires the interrogation agent firmware on the target.',
        'Build and flash it with: pio run -e esp32dev -t upload (from firmware/interrogation-agent/).',
        'It also requires pyserial on the host: pip install -r requirements.txt'
      );
  }

  return lines;
}

/** Confidence for a value that came from the agent rather than a datasheet. */
export const AGENT_CONFIDENCE: ConfidenceLevel = 'HIGH';
