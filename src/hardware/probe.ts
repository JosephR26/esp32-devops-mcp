/**
 * Safe probe execution.
 *
 * Translates the declarative ProbeOperation list from a component profile into
 * agent requests. The engine knows nothing about any specific component — it
 * only knows how to run I2C, SPI and UART operations and how to keep the raw
 * bytes attached to the result.
 */

import {
  INTERROGATION_DEPTHS,
  type HardwareTransport,
  type InterrogationDepth,
  type ProbeExecutionResult,
  type ProbeOperation,
  type SafeProbe,
  type SpiBitOrder,
} from '../types/hardware.js';
import { rawInterpretation, timestamp } from './evidence.js';
import { matchBytePattern, toHex } from './patterns.js';

export interface I2CBusConfig {
  controller?: number;
  sda?: number;
  scl?: number;
  frequencyHz?: number;
}

export interface SpiBusConfig {
  controller?: number;
  mosi?: number;
  miso?: number;
  sclk?: number;
  cs?: number;
  mode?: 0 | 1 | 2 | 3;
  clockHz?: number;
  bitOrder?: SpiBitOrder;
}

export interface UartBusConfig {
  controller?: number;
  tx?: number;
  rx?: number;
  baud?: number;
  dataBits?: number;
  parity?: 'none' | 'even' | 'odd';
  stopBits?: 1 | 2;
}

export interface ProbeContext {
  transport: HardwareTransport;
  /** Overrides the address declared in the probe operations, when supplied. */
  address?: number;
  i2c?: I2CBusConfig;
  spi?: SpiBusConfig;
  uart?: UartBusConfig;
  timeoutMs?: number;
}

/** Rank a depth so gates can be compared numerically. */
export function depthRank(depth: InterrogationDepth): number {
  return INTERROGATION_DEPTHS.indexOf(depth);
}

/**
 * Whether a depth preset includes this probe by default.
 *
 * `minDepth` on a profile probe is scheduling guidance — it keeps a slow probe
 * out of a quick connectivity check — not a permission boundary. A caller can
 * always run any probe by naming it explicitly, and can always construct the
 * equivalent operation directly. Depth selects a default breadth of
 * investigation; it never caps what may be investigated.
 */
export function shouldRunProbe(probe: SafeProbe, depth: InterrogationDepth): boolean {
  return depthRank(depth) >= depthRank(probe.minDepth ?? 'BASIC');
}

/** Non-blocking-friendly pause used by DELAY operations. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function coerceBytes(data: unknown): number[] {
  if (!data || typeof data !== 'object') return [];
  const bytes = (data as { bytes?: unknown }).bytes;
  if (!Array.isArray(bytes)) return [];
  return bytes
    .map((value) => (typeof value === 'number' ? value & 0xff : Number.NaN))
    .filter((value) => Number.isFinite(value));
}

/** Build the agent request for a single probe operation. */
export function buildOperationRequest(
  operation: ProbeOperation,
  ctx: ProbeContext
): { op: string; params: Record<string, unknown> } | null {
  switch (operation.op) {
    case 'I2C_READ':
      return {
        op: 'i2c.read',
        params: {
          ...i2cParams(ctx),
          address: ctx.address ?? operation.address,
          ...(operation.register !== undefined ? { register: operation.register } : {}),
          length: operation.length,
        },
      };

    case 'I2C_WRITE_READ':
      return {
        op: 'i2c.writeRead',
        params: {
          ...i2cParams(ctx),
          address: ctx.address ?? operation.address,
          write: operation.write,
          readLength: operation.readLength,
          ...(operation.delayMs !== undefined ? { delayMs: operation.delayMs } : {}),
        },
      };

    case 'SPI_TRANSFER':
      return {
        op: 'spi.transfer',
        params: {
          ...spiParams(ctx),
          tx: operation.tx,
          ...(operation.readLength !== undefined ? { readLength: operation.readLength } : {}),
          // Profile values win over context defaults: they encode part-specific
          // requirements such as the PN532's LSB-first SPI framing.
          ...(operation.mode !== undefined ? { mode: operation.mode } : {}),
          ...(operation.clockHz !== undefined ? { clockHz: operation.clockHz } : {}),
          ...(operation.bitOrder !== undefined
            ? { lsbFirst: operation.bitOrder === 'LSB_FIRST' }
            : {}),
        },
      };

    case 'UART_LISTEN':
      return {
        op: 'uart.listen',
        params: {
          ...uartParams(ctx),
          ...(operation.baud !== undefined ? { baud: operation.baud } : {}),
          durationMs: operation.durationMs,
        },
      };

    case 'UART_WRITE_READ':
      return {
        op: 'uart.writeRead',
        params: {
          ...uartParams(ctx),
          write: operation.write,
          readLength: operation.readLength,
          timeoutMs: operation.timeoutMs,
        },
      };

    case 'DELAY':
      return null; // Handled locally, no agent round-trip.
  }
}

function i2cParams(ctx: ProbeContext): Record<string, unknown> {
  const cfg = ctx.i2c ?? {};
  return {
    ...(cfg.controller !== undefined ? { controller: cfg.controller } : {}),
    ...(cfg.sda !== undefined ? { sda: cfg.sda } : {}),
    ...(cfg.scl !== undefined ? { scl: cfg.scl } : {}),
    ...(cfg.frequencyHz !== undefined ? { frequencyHz: cfg.frequencyHz } : {}),
  };
}

function spiParams(ctx: ProbeContext): Record<string, unknown> {
  const cfg = ctx.spi ?? {};
  return {
    ...(cfg.mosi !== undefined ? { mosi: cfg.mosi } : {}),
    ...(cfg.miso !== undefined ? { miso: cfg.miso } : {}),
    ...(cfg.sclk !== undefined ? { sclk: cfg.sclk } : {}),
    ...(cfg.cs !== undefined ? { cs: cfg.cs } : {}),
    ...(cfg.mode !== undefined ? { mode: cfg.mode } : {}),
    ...(cfg.clockHz !== undefined ? { clockHz: cfg.clockHz } : {}),
    ...(cfg.bitOrder !== undefined ? { lsbFirst: cfg.bitOrder === 'LSB_FIRST' } : {}),
  };
}

function uartParams(ctx: ProbeContext): Record<string, unknown> {
  const cfg = ctx.uart ?? {};
  return {
    ...(cfg.controller !== undefined ? { controller: cfg.controller } : {}),
    ...(cfg.tx !== undefined ? { tx: cfg.tx } : {}),
    ...(cfg.rx !== undefined ? { rx: cfg.rx } : {}),
    ...(cfg.baud !== undefined ? { baud: cfg.baud } : {}),
    ...(cfg.dataBits !== undefined ? { dataBits: cfg.dataBits } : {}),
    ...(cfg.parity !== undefined ? { parity: cfg.parity } : {}),
    ...(cfg.stopBits !== undefined ? { stopBits: cfg.stopBits } : {}),
  };
}

/** Result shape used when a probe is not executed at all. */
export function skippedProbeResult(probe: SafeProbe, reason: string): ProbeExecutionResult {
  return {
    probeId: probe.id,
    name: probe.name,
    executed: false,
    success: false,
    skippedReason: reason,
    writes: probe.writes,
    operations: [],
    bytes: [],
    hex: '',
    matchedExpectation: null,
    durationMs: 0,
    raw: {
      raw: '',
      parsed: null,
      interpretation: reason,
      confidence: 'UNKNOWN',
      source: 'NONE',
      timestamp: timestamp(),
    },
  };
}

/**
 * Execute a probe end to end.
 *
 * Never throws: a transport failure, a bus error and a device that simply does
 * not answer are all observations, and each is reported with its raw capture
 * intact.
 */
export async function executeProbe(
  probe: SafeProbe,
  ctx: ProbeContext
): Promise<ProbeExecutionResult> {
  const started = Date.now();
  const operations: ProbeExecutionResult['operations'] = [];
  const collected: number[] = [];
  const rawParts: string[] = [];
  let failure: string | undefined;

  for (const operation of probe.operations) {
    if (operation.op === 'DELAY') {
      await sleep(Math.min(operation.ms, 5000));
      operations.push({
        op: 'DELAY',
        request: { ms: operation.ms },
        raw: '',
        bytes: [],
        durationMs: operation.ms,
        ok: true,
      });
      continue;
    }

    const request = buildOperationRequest(operation, ctx);
    if (!request) continue;

    const result = await ctx.transport.request(request.op, request.params, {
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });

    const bytes = result.ok ? coerceBytes(result.data) : [];
    collected.push(...bytes);
    if (result.raw) rawParts.push(result.raw);

    operations.push({
      op: operation.op,
      request: request.params,
      raw: result.raw,
      bytes,
      durationMs: result.durationMs,
      ok: result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });

    if (!result.ok && failure === undefined) {
      failure = `${operation.op} failed: ${result.error ?? 'unknown transport error'}`;
    }
  }

  const durationMs = Date.now() - started;
  const raw = rawParts.join('\n');
  const hex = toHex(collected);

  let matchedExpectation: boolean | null = null;
  if (probe.expect) {
    if (probe.expect.pattern !== undefined) {
      matchedExpectation = matchBytePattern(collected, probe.expect.pattern);
    }
    if (probe.expect.minBytes !== undefined) {
      const enough = collected.length >= probe.expect.minBytes;
      matchedExpectation = matchedExpectation === null ? enough : matchedExpectation && enough;
    }
  }

  const success = failure === undefined && collected.length > 0;

  return {
    probeId: probe.id,
    name: probe.name,
    executed: true,
    success,
    writes: probe.writes,
    operations,
    bytes: collected,
    hex,
    matchedExpectation,
    durationMs,
    raw: rawInterpretation(
      raw,
      collected,
      success
        ? `${probe.name}: received ${collected.length} byte(s) [${hex}]`
        : `${probe.name}: ${failure ?? 'no bytes received'}`,
      success ? 'DEVICE_RESPONSE' : 'NONE',
      success ? 'HIGH' : 'UNKNOWN'
    ),
    ...(failure !== undefined ? { error: failure } : {}),
  };
}

/** Run several probes in sequence, returning results in the same order. */
export async function executeProbes(
  probes: SafeProbe[],
  ctx: ProbeContext,
  depth: InterrogationDepth = 'STANDARD'
): Promise<ProbeExecutionResult[]> {
  const results: ProbeExecutionResult[] = [];
  for (const probe of probes) {
    if (!shouldRunProbe(probe, depth)) {
      results.push(
        skippedProbeResult(
          probe,
          `Requires interrogation depth ${probe.minDepth ?? 'BASIC'}; running at ${depth}.`
        )
      );
      continue;
    }
    results.push(await executeProbe(probe, ctx));
  }
  return results;
}
