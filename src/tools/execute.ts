/**
 * General-purpose hardware execution tools.
 *
 * These are the tools that make the ESP32 a physical instrument rather than a
 * catalogue reader: `hardwareExecute` runs arbitrary operations the caller
 * constructs, and `pinCapabilityReport` tells the caller what the chip can
 * actually do so they can construct them well.
 *
 * Neither consults a component profile. Neither knows what is attached.
 */

import {
  executeOperationSequence,
  MAX_OPERATIONS_PER_SEQUENCE,
  type OperationContext,
} from '../hardware/operations.js';
import { buildReproducibility } from '../hardware/experiment.js';
import {
  adcPins,
  dacPins,
  getFamilySpec,
  pinCapabilities,
  strappingPins,
  touchPins,
} from '../hardware/esp32-catalog.js';
import { knownValue, rawInterpretation, unknownValue } from '../hardware/evidence.js';
import { agentUnavailableHelp, openSession } from '../hardware/session.js';
import type {
  Esp32Family,
  I2CBusSpec,
  ObservedValue,
  OperationSequenceResult,
  PinCapabilityReport,
  PinReport,
  RawInterpretation,
  RawOperation,
  SpiBusSpec,
  UartBusSpec,
} from '../types/hardware.js';

// ===========================================================================
// esp32_hardware_execute
// ===========================================================================

export interface HardwareExecuteOptions {
  port?: string;
  /** The operations to run, in order. */
  operations?: RawOperation[];
  /** Bus defaults merged into any operation that omits its own bus spec. */
  defaults?: {
    i2c?: I2CBusSpec;
    spi?: SpiBusSpec;
    uart?: UartBusSpec;
  };
  /** Run the whole sequence this many times. */
  repetitions?: number;
  /** Stop at the first failure instead of continuing. */
  stopOnError?: boolean;
  timeoutMs?: number;
}

export interface HardwareExecuteReport extends OperationSequenceResult {
  repetitions: number;
  /** One entry per repetition when repetitions > 1. */
  runs?: OperationSequenceResult[];
  /** Agent operations this firmware build does not implement. */
  unavailable: { capability: string; reason: string }[];
}

/**
 * Execute arbitrary hardware operations.
 *
 * This is the general path. It requires no component profile, no probe
 * definition and no prior identification. An operation is refused only when the
 * requested configuration is physically invalid on this chip.
 */
export async function hardwareExecute(
  options: HardwareExecuteOptions = {}
): Promise<HardwareExecuteReport> {
  const operations = options.operations ?? [];
  const repetitions = Math.max(1, Math.min(options.repetitions ?? 1, 100));

  if (operations.length === 0) {
    return failedExecute(['No operations supplied. Pass at least one operation.'], repetitions);
  }
  if (operations.length > MAX_OPERATIONS_PER_SEQUENCE) {
    return failedExecute(
      [
        `${operations.length} operations exceeds the per-call limit of ` +
          `${MAX_OPERATIONS_PER_SEQUENCE}. Split across calls — results from one call can inform ` +
          'the next, which is the intended adaptive pattern.',
      ],
      repetitions
    );
  }

  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });

  if (!session.agentPresent) {
    return failedExecute(agentUnavailableHelp(session.agentDetail), repetitions);
  }

  const ctx: OperationContext = {
    transport: session.transport,
    family: session.family,
    ...(options.defaults !== undefined ? { defaults: options.defaults } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };

  const reproducibility = buildReproducibility(
    {
      operations,
      defaults: options.defaults ?? {},
      repetitions,
      stopOnError: options.stopOnError ?? false,
    },
    session.reproducibility
  );

  const unavailable = await queryUnavailable(session);

  const runs: OperationSequenceResult[] = [];
  for (let i = 0; i < repetitions; i++) {
    runs.push(
      await executeOperationSequence(operations, ctx, {
        ...(options.stopOnError !== undefined ? { stopOnError: options.stopOnError } : {}),
        reproducibility,
      })
    );
  }

  const first = runs[0];
  const merged: HardwareExecuteReport = {
    ...first,
    repetitions,
    unavailable,
    ...(repetitions > 1 ? { runs } : {}),
  };

  if (repetitions > 1) {
    merged.success = runs.every((r) => r.success);
    merged.executed = runs.reduce((sum, r) => sum + r.executed, 0);
    merged.rejected = runs.reduce((sum, r) => sum + r.rejected, 0);
    merged.failed = runs.reduce((sum, r) => sum + r.failed, 0);
    merged.durationMs = runs.reduce((sum, r) => sum + r.durationMs, 0);
    merged.errors = Array.from(new Set(runs.flatMap((r) => r.errors)));
    merged.warnings = Array.from(new Set(runs.flatMap((r) => r.warnings)));
    merged.notes = [
      ...first.notes,
      `Ran the sequence ${repetitions} times. \`operations\` shows the first run; \`runs\` holds ` +
        'every run. Compare them to judge stability — a single run cannot.',
    ];
  }

  return merged;
}

async function queryUnavailable(
  session: Awaited<ReturnType<typeof openSession>>
): Promise<{ capability: string; reason: string }[]> {
  const response = await session.transport.request<{
    unavailable?: { capability: string; reason: string }[];
  }>('sys.capabilities', {}, { timeoutMs: 4000 });

  if (response.ok && Array.isArray(response.data?.unavailable)) {
    return response.data!.unavailable!;
  }
  if (response.errorKind === 'UNSUPPORTED_OPERATION') {
    return [
      {
        capability: 'sys.capabilities',
        reason:
          'This agent build predates capability reporting, so unavailable operations cannot be ' +
          'listed. Reflash firmware/interrogation-agent/ to enumerate them.',
      },
    ];
  }
  return [];
}

function failedExecute(errors: string[], repetitions: number): HardwareExecuteReport {
  return {
    success: false,
    operations: [],
    executed: 0,
    rejected: 0,
    failed: 0,
    pinUsage: [],
    warnings: [],
    errors,
    durationMs: 0,
    reproducibility: buildReproducibility({}),
    evidenceTier: 'UNKNOWN',
    notes: [],
    repetitions,
    unavailable: [],
    error: errors[0],
  };
}

// ===========================================================================
// esp32_pin_capabilities
// ===========================================================================

export interface PinCapabilityOptions {
  port?: string;
  /** Restrict the report to these pins. */
  pins?: number[];
  /** Only report pins supporting this capability. */
  filter?: 'OUTPUT' | 'ADC' | 'DAC' | 'TOUCH' | 'PWM' | 'USABLE';
}

/**
 * Report what each pin on this chip can actually do.
 *
 * This is how a caller plans an experiment without guessing: it lists every
 * pin's real capabilities, what is reserved and why, what the running firmware
 * currently has allocated, and which agent capabilities are unavailable.
 *
 * The system reports; the caller decides. No pin is chosen implicitly.
 */
export async function pinCapabilityReport(
  options: PinCapabilityOptions = {}
): Promise<PinCapabilityReport> {
  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });
  const raw: RawInterpretation[] = [];
  const warnings: string[] = [];

  const family: Esp32Family = session.family;
  const chip: ObservedValue<Esp32Family> =
    family === 'UNKNOWN'
      ? unknownValue<Esp32Family>(
          session.agentPresent
            ? 'The agent did not report a recognisable chip family.'
            : session.agentDetail
        )
      : knownValue(family, 'FIRMWARE_REPORT', 'Reported by the interrogation agent', 'HIGH');

  if (family === 'UNKNOWN') {
    warnings.push(
      'Chip family is UNKNOWN, so per-pin capabilities cannot be reported. Operations will ' +
        'still be attempted and validated by the agent itself, which checks pins on-target.'
    );
    warnings.push(...(session.agentPresent ? [] : agentUnavailableHelp(session.agentDetail)));
  }

  // What the running firmware says it currently has configured.
  const allocation = new Map<number, string[]>();
  if (session.agentPresent) {
    const response = await session.transport.request<Record<string, unknown>>('sys.interfaces');
    if (response.ok && response.data) {
      raw.push(
        rawInterpretation(
          response.raw,
          response.data,
          'Default pin assignments reported by the running firmware',
          'FIRMWARE_REPORT',
          'HIGH'
        )
      );
      const record = (key: string, role: string) => {
        const gpio = response.data![key];
        if (typeof gpio !== 'number') return;
        allocation.set(gpio, [...(allocation.get(gpio) ?? []), role]);
      };
      record('defaultI2CSda', 'default I2C SDA');
      record('defaultI2CScl', 'default I2C SCL');
      record('defaultSpiMosi', 'default SPI MOSI');
      record('defaultSpiMiso', 'default SPI MISO');
      record('defaultSpiSclk', 'default SPI SCLK');
      record('defaultSpiCs', 'default SPI CS');
    }
  }

  const capabilities = pinCapabilities(family);
  const wanted = options.pins ? new Set(options.pins) : null;

  let pins: PinReport[] = capabilities
    .filter((p) => (wanted ? wanted.has(p.gpio) : true))
    .map((p) => ({
      gpio: p.gpio,
      usable: p.usable,
      ...(p.unusableReason !== undefined ? { unusableReason: p.unusableReason } : {}),
      digitalInput: p.digitalInput,
      digitalOutput: p.digitalOutput,
      pwm: p.pwm,
      adc: p.adc,
      dac: p.dac,
      touch: p.touch,
      matrixRoutable: p.matrixRoutable,
      notes: p.notes,
      currentAllocation: allocation.get(p.gpio) ?? [],
    }));

  if (options.filter) {
    const matches = (pin: PinReport): boolean => {
      switch (options.filter) {
        case 'OUTPUT': return pin.digitalOutput;
        case 'ADC': return pin.adc;
        case 'DAC': return pin.dac;
        case 'TOUCH': return pin.touch;
        case 'PWM': return pin.pwm;
        case 'USABLE': return pin.usable;
        default: return true;
      }
    };
    pins = pins.filter(matches);
  }

  if (wanted) {
    const missing = [...wanted].filter((gpio) => !capabilities.some((p) => p.gpio === gpio));
    for (const gpio of missing) {
      warnings.push(`GPIO${gpio} is outside the pin range of ${family}.`);
    }
  }

  const spec = getFamilySpec(family);
  const documented = <T>(value: T, label: string): ObservedValue<T> =>
    family === 'UNKNOWN'
      ? unknownValue<T>('Chip family unknown')
      : knownValue(value, 'ESP32_CATALOG', `${family} datasheet: ${label}`, 'DOCUMENTED');

  const unavailable = session.agentPresent ? await queryUnavailable(session) : [
    {
      capability: 'all hardware operations',
      reason: session.agentDetail,
    },
  ];

  return {
    success: true,
    chip,
    pins,
    summary: {
      total: pins.length,
      usable: pins.filter((p) => p.usable).length,
      reserved: pins.filter((p) => !p.usable).length,
      outputCapable: pins.filter((p) => p.digitalOutput).length,
      adcCapable: pins.filter((p) => p.adc).length,
      dacCapable: pins.filter((p) => p.dac).length,
      touchCapable: pins.filter((p) => p.touch).length,
    },
    peripherals: {
      i2cControllers: documented(spec.i2cControllers, 'I2C controllers'),
      spiControllers: documented(spec.usableSpiControllers, 'user-usable SPI controllers'),
      uartControllers: documented(spec.uartControllers, 'UART controllers'),
      pwmChannels: documented(spec.pwmChannels, 'LEDC channels'),
      hardwareTimers: documented(spec.hardwareTimers, 'hardware timers'),
      adcChannels: documented(adcPins(family).length, 'ADC-capable pins'),
      dacChannels: documented(dacPins(family).length, 'DAC-capable pins'),
      touchChannels: documented(touchPins(family).length, 'touch-capable pins'),
      wifi: documented(spec.wifi, 'Wi-Fi radio'),
      bluetooth: documented(spec.bluetooth ?? 'none', 'Bluetooth support'),
    },
    unavailable,
    warnings,
    notes: [
      'Pin capabilities come from the chip datasheet and are DOCUMENTED, not measured. They ' +
        'describe what the silicon supports, not what is wired to it.',
      'Reserved pins are refused because driving them corrupts execution — that is a physical ' +
        'constraint, not a policy.',
      'Strapping pins are usable. Their level at reset selects boot mode, so an experiment ' +
        'holding one may prevent a normal reboot; this is reported as a note, not a refusal.',
      'The ESP32 GPIO matrix routes most peripheral signals to most pins, so bus assignments ' +
        'are far more flexible than the board silkscreen suggests.',
      'currentAllocation lists only what the running firmware reports as a default. It is not ' +
        'an exhaustive record of what is physically wired.',
      `Strapping pins on ${family}: ${strappingPins(family).join(', ') || 'none'}.`,
    ],
    raw,
  };
}
