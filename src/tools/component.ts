/**
 * Component interrogation tools.
 *
 * Pipeline position:
 *   COMPONENT IDENTIFICATION -> REGISTER / PROTOCOL DISCOVERY
 *   -> CONFIGURATION INSPECTION -> CAPABILITY ENUMERATION
 *   -> SAFE FUNCTIONAL TESTING -> TELEMETRY CAPTURE
 *   -> PERFORMANCE CHARACTERISATION -> CAPABILITY MATRIX
 *   -> DOCUMENTED vs OBSERVED vs VERIFIED -> UNEXPLORED CAPABILITY ANALYSIS
 *
 * Every handler returns a plain object; nothing throws.
 */

import {
  validateByteArray,
  validateComponentIdentifier,
  validateGpioPin,
  validateI2CAddress,
  validateI2CFrequency,
  validateIterations,
  validateProbeBaudRate,
  validateSpiClock,
  validateSpiMode,
} from '../utils/validation.js';
import {
  buildCapabilityMatrix,
  dedupeCapabilities,
  makeCapability,
  mergeCapability,
} from '../hardware/capability.js';
import {
  knownValue,
  makeEvidence,
  rawInterpretation,
  timestamp,
  unknownValue,
} from '../hardware/evidence.js';
import { buildReproducibility, runExperiment } from '../hardware/experiment.js';
import { identifyComponent, noIdentification } from '../hardware/identify.js';
import {
  findBytePattern,
  hexValue,
  matchBytePattern,
  mean,
  median,
  stdDev,
  toHex,
} from '../hardware/patterns.js';
import { executeOperationSequence } from '../hardware/operations.js';
import {
  executeProbe,
  executeProbes,
  shouldRunProbe,
  depthRank,
  type ProbeContext,
} from '../hardware/probe.js';
import {
  decodeRegister,
  failedRegisterResult,
  formatRegisterAddress,
  isSafeToInspect,
  registerByteWidth,
  skipReason,
  skippedRegisterResult,
} from '../hardware/registers.js';
import { findProbe, findProfile, listProfiles } from '../hardware/registry.js';
import {
  agentUnavailableHelp,
  checkPins,
  coerceDepth,
  openSession,
  type InterrogationSession,
} from '../hardware/session.js';
import { analyseConsistency } from '../hardware/experiment.js';
import type {
  AnomalyRecord,
  BenchmarkMeasurement,
  OperationOutcome,
  RawOperation,
  CapabilityRecord,
  ComponentBenchmarkReport,
  ComponentProbeReport,
  ComponentProfile,
  ComponentTestReport,
  ExperimentDefinition,
  ExperimentReport,
  FunctionalTestResult,
  HardwareInterfaceKind,
  IdentificationReport,
  InterrogationDepth,
  ProbeExecutionResult,
  RawInterpretation,
  RegisterInspectionReport,
  RegisterInspectionResult,
  SafeProbe,
  SpiBitOrder,
} from '../types/hardware.js';

// ---------------------------------------------------------------------------
// Shared bus configuration
// ---------------------------------------------------------------------------

export interface BusOptions {
  port?: string;
  interface?: string;
  address?: number;
  controller?: number;
  sda?: number;
  scl?: number;
  frequencyHz?: number;
  mosi?: number;
  miso?: number;
  sclk?: number;
  cs?: number;
  mode?: number;
  clockHz?: number;
  bitOrder?: SpiBitOrder;
  rx?: number;
  tx?: number;
  baud?: number;
  timeoutMs?: number;
}

const INTERFACE_KINDS: HardwareInterfaceKind[] = [
  'I2C',
  'SPI',
  'UART',
  'GPIO',
  'ADC',
  'DAC',
  'PWM',
  'TOUCH',
  'I2S',
  'CAN',
  'USB',
  'WIFI',
  'BLUETOOTH',
];

function coerceInterface(value: unknown, fallback: HardwareInterfaceKind): HardwareInterfaceKind {
  const text = typeof value === 'string' ? value.toUpperCase() : '';
  return (INTERFACE_KINDS as string[]).includes(text)
    ? (text as HardwareInterfaceKind)
    : fallback;
}

/** Validate the bus parameters relevant to the chosen interface. */
function validateBusOptions(
  options: BusOptions,
  iface: HardwareInterfaceKind
): string[] {
  const errors: string[] = [];

  for (const [name, value] of [
    ['sda', options.sda],
    ['scl', options.scl],
    ['mosi', options.mosi],
    ['miso', options.miso],
    ['sclk', options.sclk],
    ['cs', options.cs],
    ['rx', options.rx],
    ['tx', options.tx],
  ] as const) {
    if (value !== undefined && !validateGpioPin(value)) errors.push(`Invalid ${name} pin: ${value}`);
  }

  if (options.address !== undefined && !validateI2CAddress(options.address)) {
    errors.push(`Invalid I2C address: ${options.address} (must be 0x00-0x7F)`);
  }
  if (options.frequencyHz !== undefined && !validateI2CFrequency(options.frequencyHz)) {
    errors.push(`I2C frequency out of range (1 kHz - 1 MHz): ${options.frequencyHz}`);
  }
  if (options.clockHz !== undefined && !validateSpiClock(options.clockHz)) {
    errors.push(`SPI clock out of range (10 kHz - 40 MHz): ${options.clockHz}`);
  }
  if (options.mode !== undefined && !validateSpiMode(options.mode)) {
    errors.push(`Invalid SPI mode: ${options.mode} (must be 0-3)`);
  }
  if (options.baud !== undefined && !validateProbeBaudRate(options.baud)) {
    errors.push(`Baud out of range (300 - 3000000): ${options.baud}`);
  }

  if (iface === 'SPI' && options.cs === undefined) {
    errors.push(
      'A chip-select (cs) pin is required for SPI. This tool will not assert an unspecified CS line.'
    );
  }
  if (iface === 'UART' && options.rx === undefined) {
    errors.push('An rx pin is required for UART interrogation.');
  }

  return errors;
}

function buildProbeContext(
  session: InterrogationSession,
  options: BusOptions,
  profile?: ComponentProfile | null
): ProbeContext {
  const ctx: ProbeContext = { transport: session.transport };

  if (options.address !== undefined) ctx.address = options.address;
  else if (profile) {
    const i2c = profile.interfaces.find((i) => i.kind === 'I2C');
    if (i2c?.addresses?.length === 1) ctx.address = i2c.addresses[0];
  }

  ctx.i2c = {
    ...(options.controller !== undefined ? { controller: options.controller } : {}),
    ...(options.sda !== undefined ? { sda: options.sda } : {}),
    ...(options.scl !== undefined ? { scl: options.scl } : {}),
    ...(options.frequencyHz !== undefined ? { frequencyHz: options.frequencyHz } : {}),
  };

  ctx.spi = {
    ...(options.mosi !== undefined ? { mosi: options.mosi } : {}),
    ...(options.miso !== undefined ? { miso: options.miso } : {}),
    ...(options.sclk !== undefined ? { sclk: options.sclk } : {}),
    ...(options.cs !== undefined ? { cs: options.cs } : {}),
    ...(options.mode !== undefined ? { mode: options.mode as 0 | 1 | 2 | 3 } : {}),
    ...(options.clockHz !== undefined ? { clockHz: options.clockHz } : {}),
    ...(options.bitOrder !== undefined ? { bitOrder: options.bitOrder } : {}),
  };

  ctx.uart = {
    ...(options.controller !== undefined ? { controller: options.controller } : {}),
    ...(options.rx !== undefined ? { rx: options.rx } : {}),
    ...(options.tx !== undefined ? { tx: options.tx } : {}),
    ...(options.baud !== undefined ? { baud: options.baud } : {}),
  };

  if (options.timeoutMs !== undefined) ctx.timeoutMs = options.timeoutMs;
  return ctx;
}

function pinChecksFor(
  session: InterrogationSession,
  options: BusOptions,
  iface: HardwareInterfaceKind
) {
  switch (iface) {
    case 'I2C':
      return checkPins(session.family, [
        { signal: 'SDA', gpio: options.sda, mustOutput: true },
        { signal: 'SCL', gpio: options.scl, mustOutput: true },
      ]);
    case 'SPI':
      return checkPins(session.family, [
        { signal: 'SCLK', gpio: options.sclk, mustOutput: true },
        { signal: 'MOSI', gpio: options.mosi, mustOutput: true },
        { signal: 'MISO', gpio: options.miso },
        { signal: 'CS', gpio: options.cs, mustOutput: true },
      ]);
    case 'UART':
      return checkPins(session.family, [
        { signal: 'RX', gpio: options.rx },
        { signal: 'TX', gpio: options.tx, mustOutput: true },
      ]);
    default:
      return { ok: true, errors: [], warnings: [] };
  }
}

// ===========================================================================
// 6. esp32_component_identify
// ===========================================================================

export interface ComponentIdentifyOptions extends BusOptions {
  candidates?: string[];
  markings?: string[];
  depth?: string;
}

/**
 * Identify a component from bus evidence, safe probe responses and any physical
 * markings the user supplies.
 *
 * Runs the identification probes of every candidate profile that declares the
 * requested interface, then scores all profiles against the combined evidence.
 */
export async function componentIdentify(
  options: ComponentIdentifyOptions = {}
): Promise<IdentificationReport> {
  const iface = coerceInterface(options.interface, 'I2C');
  const depth = coerceDepth(options.depth, 'BASIC');

  const errors = validateBusOptions(options, iface);
  for (const candidate of options.candidates ?? []) {
    if (!validateComponentIdentifier(candidate)) {
      errors.push(`Invalid candidate identifier: ${candidate}`);
    }
  }
  if (errors.length > 0) return noIdentification(errors.join('; '));

  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });

  const pinCheck = pinChecksFor(session, options, iface);
  if (!pinCheck.ok) return noIdentification(pinCheck.errors.join('; '));

  const markings = (options.markings ?? []).filter((m) => typeof m === 'string' && m.length > 0);

  if (!session.agentPresent) {
    // Markings alone can still narrow the field, so identification is attempted
    // rather than refused — but the result carries no physical evidence and the
    // engine caps its confidence accordingly.
    if (markings.length === 0) {
      return noIdentification(agentUnavailableHelp(session.agentDetail).join(' '));
    }
    const report = identifyComponent({
      markings,
      ...(options.address !== undefined ? { i2cAddress: options.address } : {}),
      ...(options.candidates ? { candidateIds: resolveCandidateIds(options.candidates) } : {}),
    });
    report.notes.push(
      'No physical evidence was gathered: the interrogation agent did not respond. This ' +
        'identification rests entirely on user-supplied markings.'
    );
    return report;
  }

  // Candidate pool: explicit list, or every profile declaring this interface.
  const candidateProfiles = options.candidates
    ? options.candidates
        .map((id) => findProfile(id))
        .filter((p): p is ComponentProfile => p !== null)
    : listProfiles().filter((p) => p.interfaces.some((i) => i.kind === iface));

  const raw: RawInterpretation[] = [];
  const probeResults: ProbeExecutionResult[] = [];
  const seenProbeIds = new Set<string>();

  for (const profile of candidateProfiles) {
    // Only probes referenced by identification rules — this is identification,
    // not a full interrogation.
    const referenced = new Set(
      profile.identification
        .map((rule) => (rule.match.kind === 'PROBE_RESPONSE' ? rule.match.probeId : null))
        .filter((id): id is string => id !== null)
    );

    const probes = profile.safeProbes.filter(
      (p) => p.interface === iface && referenced.has(p.id) && shouldRunProbe(p, depth)
    );
    if (probes.length === 0) continue;

    const ctx = buildProbeContext(session, options, profile);
    const results = await executeProbes(probes, ctx, depth);

    for (const result of results) {
      if (seenProbeIds.has(result.probeId)) continue;
      seenProbeIds.add(result.probeId);
      probeResults.push(result);
      raw.push(result.raw);
    }
  }

  const report = identifyComponent(
    {
      ...(options.address !== undefined ? { i2cAddress: options.address } : {}),
      probeResults,
      streamBytes: probeResults.flatMap((r) => r.bytes),
      ...(markings.length > 0 ? { markings } : {}),
      ...(options.candidates ? { candidateIds: resolveCandidateIds(options.candidates) } : {}),
    },
    raw
  );

  if (probeResults.length === 0) {
    report.notes.push(
      `No identification probe was executed at depth ${depth} for the ${iface} interface. ` +
        'Raise the depth or name candidate components explicitly.'
    );
  }

  const nonResponding = probeResults.filter((r) => r.executed && r.bytes.length === 0);
  if (nonResponding.length > 0 && probeResults.every((r) => r.bytes.length === 0)) {
    report.notes.push(
      'Every identification probe ran but none returned data. The device did not respond — ' +
        'that is different from being unidentifiable, and different again from being absent.'
    );
  }

  return report;
}

function resolveCandidateIds(candidates: string[]): string[] {
  return candidates
    .map((id) => findProfile(id)?.id)
    .filter((id): id is string => id !== undefined);
}

// ===========================================================================
// 7. esp32_component_probe
// ===========================================================================

export interface ComponentProbeOptions extends BusOptions {
  component?: string;
  probeProfile?: string;
  depth?: string;
  markings?: string[];
  /**
   * Probe ids to run regardless of the depth preset. A depth is a default
   * breadth of investigation, not a limit — this is how you exceed it.
   */
  additionalProbes?: string[];
  /**
   * Arbitrary operations to run alongside the profile probes. Needs no profile
   * entry: this is the path for investigating behaviour nobody anticipated.
   */
  additionalOperations?: RawOperation[];
  /** Force register inspection on, regardless of depth. */
  inspectRegisters?: boolean;
}

/**
 * The core component interrogation tool.
 *
 * Depth selects how much is done by default:
 *   BASIC     connectivity, identification, interface
 *   STANDARD  + configuration, known registers, modes, capabilities
 *   DEEP      + all documented registers, feature discovery, timing
 *   FORENSIC  + repeated measurements, consistency, anomalies, gap analysis
 *
 * These are presets, not ceilings. FORENSIC is the most thorough default — not
 * the maximum possible investigation. `additionalProbes`, `additionalOperations`
 * and `inspectRegisters` extend any depth, and esp32_hardware_execute can always
 * go further still. Nothing here prevents another experiment afterwards.
 */
export async function componentProbe(
  options: ComponentProbeOptions = {}
): Promise<ComponentProbeReport> {
  const depth = coerceDepth(options.depth, 'STANDARD');
  const iface = coerceInterface(options.interface, 'I2C');

  const errors = validateBusOptions(options, iface);
  if (options.component !== undefined && !validateComponentIdentifier(options.component)) {
    errors.push(`Invalid component identifier: ${options.component}`);
  }
  if (errors.length > 0) return failedProbeReport(depth, iface, options, errors);

  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });
  const pinCheck = pinChecksFor(session, options, iface);
  if (!pinCheck.ok) return failedProbeReport(depth, iface, options, pinCheck.errors);

  if (!session.agentPresent) {
    return failedProbeReport(depth, iface, options, agentUnavailableHelp(session.agentDetail));
  }

  const warnings: string[] = [...pinCheck.warnings];
  const probeErrors: string[] = [];
  const raw: RawInterpretation[] = [];

  // --- Identification -----------------------------------------------------
  let profile = options.component ? findProfile(options.component) : null;
  if (options.component && !profile) {
    warnings.push(
      `No registered component profile matches "${options.component}". ` +
        'Falling back to identification across all profiles for this interface.'
    );
  }

  const identification = await componentIdentify({
    ...options,
    interface: iface,
    depth: 'BASIC',
    ...(profile ? { candidates: [profile.id] } : {}),
    ...(options.markings ? { markings: options.markings } : {}),
  });
  raw.push(...identification.raw);

  if (!profile && identification.identified) {
    profile = findProfile(identification.identified.componentId);
    if (profile) {
      warnings.push(
        `Component was not specified; proceeding with the identified profile ${profile.partNumber} ` +
          `(confidence ${identification.confidence}). Supply \`component\` to pin this down.`
      );
    }
  }

  // --- Connectivity -------------------------------------------------------
  const connectivity = await checkConnectivity(session, options, iface, profile);
  raw.push(connectivity.raw);

  if (!profile) {
    return {
      success: connectivity.reachable.value === true,
      depth,
      target: session.port.value ?? 'unresolved-port',
      ...(options.component !== undefined ? { requestedComponent: options.component } : {}),
      interface: iface,
      address: options.address ?? null,
      identification,
      connectivity: { reachable: connectivity.reachable, detail: connectivity.detail },
      probes: [],
      registers: null,
      capabilities: null,
      consistency: null,
      anomalies: [],
      modes: [],
      protocols: [],
      timing: [],
      warnings: [
        ...warnings,
        'No component profile matched, so there is no pre-declared probe set to run. That is ' +
          'a starting point, not a limit: the component remains fully investigable.',
        'Use esp32_hardware_execute to construct arbitrary I2C/SPI/UART transactions, GPIO ' +
          'stimulus, ADC sampling and timing measurements against it directly.',
        'Use esp32_register_inspect with explicit numeric `registers` to dump raw register ' +
          'values without a profile, and `writes` to test how the device responds to a write.',
        'A profile would accelerate this by naming registers and expected responses. Its ' +
          'absence means those things are UNKNOWN, not forbidden.',
      ],
      errors: probeErrors,
      raw,
      reproducibility: buildReproducibility(
        { interface: iface, ...options },
        session.reproducibility
      ),
    };
  }

  // --- Safe probes --------------------------------------------------------
  const ctx = buildProbeContext(session, options, profile);
  const applicable = profile.safeProbes.filter((p) => p.interface === iface);
  const probes = await executeProbes(applicable, ctx, depth);

  // Probes named explicitly run regardless of the depth preset — the preset
  // chooses a default set, it does not restrict what may be run.
  for (const probeId of options.additionalProbes ?? []) {
    if (probes.some((p) => p.probeId === probeId && p.executed)) continue;
    const probe = findProbe(profile, probeId);
    if (!probe) {
      warnings.push(`additionalProbes: "${probeId}" is not declared by ${profile.partNumber}.`);
      continue;
    }
    const result = await executeProbe(probe, ctx);
    const existing = probes.findIndex((p) => p.probeId === probeId);
    if (existing >= 0) probes[existing] = result;
    else probes.push(result);
  }
  raw.push(...probes.filter((p) => p.executed).map((p) => p.raw));

  for (const probe of probes) {
    if (probe.executed && !probe.success && probe.error) {
      probeErrors.push(`${probe.probeId}: ${probe.error}`);
    }
  }

  // --- Register inspection (DEEP and above) -------------------------------
  let registers: RegisterInspectionReport | null = null;
  if (options.inspectRegisters === true || depthRank(depth) >= depthRank('DEEP')) {
    registers = await inspectRegistersInternal(session, profile, options, iface, probes);
    raw.push(...registers.raw);
  }

  // --- Caller-constructed operations --------------------------------------
  const additionalOutcomes: OperationOutcome[] = [];
  if ((options.additionalOperations ?? []).length > 0) {
    const sequence = await executeOperationSequence(options.additionalOperations!, {
      transport: session.transport,
      family: session.family,
      defaults: {
        i2c: {
          ...(options.controller !== undefined ? { controller: options.controller } : {}),
          ...(options.sda !== undefined ? { sda: options.sda } : {}),
          ...(options.scl !== undefined ? { scl: options.scl } : {}),
          ...(options.frequencyHz !== undefined ? { frequencyHz: options.frequencyHz } : {}),
        },
        spi: {
          ...(options.mosi !== undefined ? { mosi: options.mosi } : {}),
          ...(options.miso !== undefined ? { miso: options.miso } : {}),
          ...(options.sclk !== undefined ? { sclk: options.sclk } : {}),
          ...(options.cs !== undefined ? { cs: options.cs } : {}),
        },
        uart: {
          ...(options.rx !== undefined ? { rx: options.rx } : {}),
          ...(options.tx !== undefined ? { tx: options.tx } : {}),
          ...(options.baud !== undefined ? { baud: options.baud } : {}),
        },
      },
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    additionalOutcomes.push(...sequence.operations);
    raw.push(...sequence.operations.map((o) => o.raw));
    warnings.push(...sequence.warnings);
    probeErrors.push(...sequence.errors);
  }

  // --- Timing -------------------------------------------------------------
  const timing = probes
    .filter((p) => p.executed)
    .map((probe) => {
      const samples = probe.operations.filter((o) => o.op !== 'DELAY').map((o) => o.durationMs);
      const avg = mean(samples) ?? 0;
      return {
        operation: probe.probeId,
        samples,
        meanMs: Number(avg.toFixed(3)),
        jitterMs:
          samples.length > 1
            ? Number((Math.max(...samples) - Math.min(...samples)).toFixed(3))
            : 0,
      };
    });

  // --- FORENSIC: repeated measurement and anomaly detection ---------------
  let consistency: ComponentProbeReport['consistency'] = null;
  const anomalies: AnomalyRecord[] = [];

  if (depthRank(depth) >= depthRank('FORENSIC')) {
    const reference = probes.find((p) => p.executed && p.success);
    if (reference) {
      const probeDefinition = findProbe(profile, reference.probeId);
      if (probeDefinition) {
        const repeats: number[][] = [reference.bytes];
        for (let i = 0; i < 4; i++) {
          const repeat = await executeProbe(probeDefinition, ctx);
          raw.push(repeat.raw);
          if (repeat.success) repeats.push(repeat.bytes);
        }
        consistency = analyseConsistency(repeats);
        if (!consistency.stable) {
          anomalies.push({
            kind: 'UNSTABLE_RESPONSE',
            description: `${probeDefinition.name}: ${consistency.note}`,
            confidence: 'HIGH',
          });
        }
      }
    }

    for (const probe of probes) {
      if (!probe.executed || probe.bytes.length === 0) continue;
      const definition = findProbe(profile, probe.probeId);
      if (definition?.expect?.pattern && probe.matchedExpectation === false) {
        anomalies.push({
          kind: 'UNDOCUMENTED_RESPONSE',
          description:
            `${definition.name} returned ${probe.hex}, which does not match the documented ` +
            `pattern "${definition.expect.pattern}". Recorded rather than discarded: it may be ` +
            'genuine undocumented behaviour, a clone part, or a framing offset.',
          raw: probe.raw.raw,
          confidence: 'MEDIUM',
        });
      }
    }

    const durations = timing.map((t) => t.meanMs).filter((d) => d > 0);
    const avg = mean(durations);
    const deviation = stdDev(durations);
    if (avg !== null && deviation !== null && deviation > 0) {
      for (const entry of timing) {
        if (Math.abs(entry.meanMs - avg) > 3 * deviation) {
          anomalies.push({
            kind: 'TIMING_OUTLIER',
            description: `${entry.operation} averaged ${entry.meanMs} ms against a probe-set mean of ${avg.toFixed(2)} ms.`,
            confidence: 'MEDIUM',
          });
        }
      }
    }
  }

  // --- Capability matrix --------------------------------------------------
  const capabilities =
    depthRank(depth) >= depthRank('STANDARD')
      ? buildCapabilityMatrix(
          `${profile.partNumber}@${iface}`,
          buildComponentCapabilities(profile, probes, registers),
          profile.id
        )
      : null;

  return {
    success: probes.some((p) => p.executed && p.success),
    depth,
    target: session.port.value ?? 'unresolved-port',
    ...(options.component !== undefined ? { requestedComponent: options.component } : {}),
    interface: iface,
    address: ctx.address ?? null,
    identification,
    connectivity: { reachable: connectivity.reachable, detail: connectivity.detail },
    probes,
    registers,
    capabilities,
    consistency,
    anomalies,
    modes: depthRank(depth) >= depthRank('STANDARD') ? profile.modes : [],
    protocols: depthRank(depth) >= depthRank('STANDARD') ? profile.protocols : [],
    additionalOperations: additionalOutcomes,
    timing,
    warnings: [
      ...warnings,
      ...(profile.limitations.length > 0
        ? [`Profile limitations for ${profile.partNumber}: ${profile.limitations.join(' | ')}`]
        : []),
    ],
    errors: probeErrors,
    raw,
    reproducibility: buildReproducibility(
      { interface: iface, depth, ...options },
      session.reproducibility,
      profile
    ),
  };
}

async function checkConnectivity(
  session: InterrogationSession,
  options: BusOptions,
  iface: HardwareInterfaceKind,
  profile: ComponentProfile | null
): Promise<{ reachable: ReturnType<typeof knownValue<boolean>>; detail: string; raw: RawInterpretation }> {
  const address =
    options.address ??
    profile?.interfaces.find((i) => i.kind === 'I2C')?.addresses?.[0];

  if (iface === 'I2C' && address !== undefined) {
    const response = await session.transport.request<{
      addresses?: { address: number; ackCount: number }[];
    }>(
      'i2c.scan',
      {
        ...(options.controller !== undefined ? { controller: options.controller } : {}),
        ...(options.sda !== undefined ? { sda: options.sda } : {}),
        ...(options.scl !== undefined ? { scl: options.scl } : {}),
        ...(options.frequencyHz !== undefined ? { frequencyHz: options.frequencyHz } : {}),
        start: address,
        end: address,
        repeats: 3,
      },
      { timeoutMs: 6000 }
    );

    const entry = response.data?.addresses?.find((a) => a.address === address);
    const acked = (entry?.ackCount ?? 0) > 0;
    const hex = `0x${address.toString(16).toUpperCase().padStart(2, '0')}`;
    const detail = response.ok
      ? acked
        ? `Device acknowledged at ${hex} (${entry!.ackCount}/3 probes).`
        : `Nothing acknowledged at ${hex}. Check wiring, power and pull-ups before concluding the device is absent.`
      : `Connectivity check failed: ${response.error}`;

    return {
      reachable: response.ok
        ? knownValue(acked, 'BUS_SCAN', detail, acked ? 'HIGH' : 'MEDIUM')
        : (unknownValue<boolean>(detail) as ReturnType<typeof knownValue<boolean>>),
      detail,
      raw: rawInterpretation(
        response.raw,
        response.data,
        detail,
        response.ok ? 'BUS_SCAN' : 'NONE',
        response.ok ? 'HIGH' : 'UNKNOWN'
      ),
    };
  }

  // SPI and UART have no acknowledgement, so connectivity is only established by
  // a probe that returns plausible data — reported by the probe results instead.
  const detail =
    `The ${iface} interface provides no bus-level acknowledgement, so reachability cannot be ` +
    'established independently of a probe response.';
  return {
    reachable: unknownValue<boolean>(detail) as ReturnType<typeof knownValue<boolean>>,
    detail,
    raw: rawInterpretation('', null, detail, 'NONE', 'UNKNOWN'),
  };
}

/**
 * Fold profile documentation and probe observations into capability records.
 *
 * Documentation sets `documented`/`softwareSupported`. Only a probe that
 * actually returned matching data sets `observed`.
 */
function buildComponentCapabilities(
  profile: ComponentProfile,
  probes: ProbeExecutionResult[],
  registers: RegisterInspectionReport | null,
  testResults: FunctionalTestResult[] = []
): CapabilityRecord[] {
  const byProbe = new Map(probes.map((p) => [p.probeId, p]));

  const records = profile.capabilities.map((declared) => {
    const evidence = [
      makeEvidence('COMPONENT_PROFILE', `${profile.partNumber} documentation declares ${declared.name}`, {
        ...(declared.reference !== undefined ? { reference: declared.reference } : {}),
        confidence: 'DOCUMENTED',
      }),
    ];

    let observed = false;
    for (const probeId of declared.evidenceProbes ?? []) {
      const result = byProbe.get(probeId);
      if (!result?.executed || result.bytes.length === 0) continue;
      // A probe that ran and got bytes back is an observation. A probe that ran
      // and got nothing is not.
      observed = true;
      evidence.push(
        makeEvidence('DEVICE_RESPONSE', `Probe ${probeId} returned ${result.bytes.length} byte(s): ${result.hex}`, {
          raw: result.raw.raw,
          confidence: 'HIGH',
        })
      );
    }

    const test = testResults.find((t) => t.capability === declared.name && t.executed);

    return makeCapability({
      name: declared.name,
      category: declared.category,
      ...(declared.description !== undefined ? { description: declared.description } : {}),
      documented: declared.documented,
      softwareSupported: declared.softwareSupported ?? false,
      // Firmware exposure is only ever set from positive evidence. The
      // interrogation agent is a generic bus bridge and exposes no
      // component-specific functionality, so it never sets this flag.
      firmwareExposed: false,
      observed,
      tested: test !== undefined,
      verified: test?.passed === true,
      evidence,
      ...(test ? { testId: test.testId } : {}),
      ...(declared.reference !== undefined ? { reference: declared.reference } : {}),
    });
  });

  // Register reads that succeeded are direct evidence of a readable register map.
  if (registers && registers.registers.some((r) => r.read)) {
    const readCount = registers.registers.filter((r) => r.read).length;
    records.push(
      makeCapability({
        name: 'diagnostic.register_map_readable',
        category: 'DIAGNOSTIC',
        description: `${readCount} documented register(s) read back successfully`,
        documented: profile.registers.length > 0,
        softwareSupported: true,
        observed: true,
        evidence: [
          makeEvidence('REGISTER_READ', `${readCount} register(s) read from the device`, {
            confidence: 'HIGH',
          }),
        ],
      })
    );
  }

  return dedupeCapabilities(records);
}

function failedProbeReport(
  depth: InterrogationDepth,
  iface: HardwareInterfaceKind,
  options: ComponentProbeOptions,
  errors: string[]
): ComponentProbeReport {
  return {
    success: false,
    depth,
    target: options.port ?? 'unresolved-port',
    ...(options.component !== undefined ? { requestedComponent: options.component } : {}),
    interface: iface,
    address: options.address ?? null,
    identification: null,
    connectivity: {
      reachable: unknownValue<boolean>(errors[0]) as ReturnType<typeof knownValue<boolean>>,
      detail: errors[0],
    },
    probes: [],
    registers: null,
    capabilities: null,
    consistency: null,
    anomalies: [],
    modes: [],
    protocols: [],
    timing: [],
    warnings: [],
    errors,
    raw: [],
    reproducibility: buildReproducibility({ interface: iface, depth, ...options }),
    error: errors[0],
  };
}

// ===========================================================================
// 8. esp32_register_inspect
// ===========================================================================

export interface RegisterInspectOptions extends BusOptions {
  /** Component profile to decode against. Optional — omit for a raw register dump. */
  component?: string;
  registers?: (string | number)[];
  /**
   * Register writes to perform, each as an explicit experiment.
   *
   * A write is a legitimate investigative act: entering a mode, selecting a
   * bank, triggering a measurement, clearing status, or testing undocumented
   * behaviour all require one. Each write is recorded verbatim with the state
   * observed before and after; nothing is inferred about what it means.
   */
  writes?: RegisterWriteRequest[];
  /** Read these registers back after the writes, to observe the effect. */
  readBackAfterWrite?: boolean;
}

/** An explicit, caller-constructed register write. */
export interface RegisterWriteRequest {
  /** Register address, or the first byte of the payload for command devices. */
  register: number;
  /** Value bytes following the register address. */
  value: number[];
  /** Why this write is being made — recorded in the report, never validated. */
  justification?: string;
}

/**
 * Register inspection and controlled register writing.
 *
 * Reads are the default and need no component profile: without one, the caller
 * names the registers and gets raw values back; with one, the same values are
 * decoded into named bitfields. A profile is a decoder, not a permission.
 *
 * Writes happen only when the caller explicitly supplies `writes`. Each is
 * executed as requested and recorded with before/after state. The tool does not
 * decide whether a write is meaningful — that is the experiment.
 */
export async function registerInspect(
  options: RegisterInspectOptions
): Promise<RegisterInspectionReport> {
  const iface = coerceInterface(options.interface, 'I2C');
  const errors = validateBusOptions(options, iface);

  if (options.component !== undefined && !validateComponentIdentifier(options.component)) {
    errors.push(`Invalid component identifier: ${options.component}`);
  }
  for (const [index, write] of (options.writes ?? []).entries()) {
    if (!Number.isInteger(write.register) || write.register < 0 || write.register > 0xff) {
      errors.push(`writes[${index}].register must be an integer 0-255.`);
    }
    if (!validateByteArray(write.value, 512)) {
      errors.push(`writes[${index}].value must be an array of 1-512 integers in 0-255.`);
    }
  }
  if (errors.length > 0) return failedRegisterReport(options, iface, errors);

  const profile = options.component ? findProfile(options.component) : null;
  const profileWarnings: string[] = [];

  if (options.component && !profile) {
    // Not knowing the part is a reason to investigate, not a reason to stop.
    profileWarnings.push(
      `No registered profile matches "${options.component}", so values are reported raw rather ` +
        'than decoded into named bitfields. Known profiles: ' +
        listProfiles().map((p) => p.id).join(', ')
    );
  }

  const explicitRegisters = (options.registers ?? []).filter(
    (r): r is number => typeof r === 'number'
  );
  const hasProfileRegisters = (profile?.registers.length ?? 0) > 0;

  if (!hasProfileRegisters && explicitRegisters.length === 0 && (options.writes ?? []).length === 0) {
    return failedRegisterReport(options, iface, [
      'Nothing to do: supply numeric `registers` to read, `writes` to perform, or a ' +
        '`component` whose profile declares a register map.',
    ]);
  }

  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });
  const pinCheck = pinChecksFor(session, options, iface);
  if (!pinCheck.ok) return failedRegisterReport(options, iface, pinCheck.errors);

  if (!session.agentPresent) {
    return failedRegisterReport(options, iface, agentUnavailableHelp(session.agentDetail));
  }

  const report = hasProfileRegisters
    ? await inspectRegistersInternal(session, profile!, options, iface, [], options.registers)
    : await inspectRawRegisters(session, options, iface, explicitRegisters);

  // Undecoded registers the caller named that the profile does not describe are
  // still read — an undocumented register is exactly what experimentation is for.
  if (hasProfileRegisters && explicitRegisters.length > 0) {
    const known = new Set(
      profile!.registers.filter((r) => typeof r.address === 'number').map((r) => r.address as number)
    );
    const undocumented = explicitRegisters.filter((r) => !known.has(r));
    if (undocumented.length > 0) {
      const extra = await inspectRawRegisters(session, options, iface, undocumented);
      report.registers.push(...extra.registers);
      report.raw.push(...extra.raw);
      report.warnings.push(
        `${undocumented.length} requested register(s) are absent from the ${profile!.partNumber} ` +
          'profile and were read raw, without field decoding.'
      );
    }
  }

  if ((options.writes ?? []).length > 0) {
    const writeReport = await performRegisterWrites(session, options, iface, profile);
    report.writes = writeReport.writes;
    // The flag reports what actually happened, so it must reflect the writes.
    report.readOnly = false;
    report.raw.push(...writeReport.raw);
    report.warnings.push(...writeReport.warnings);
    if (options.readBackAfterWrite !== false) {
      const readBack = await inspectRawRegisters(
        session,
        options,
        iface,
        options.writes!.map((w) => w.register)
      );
      report.registersAfterWrite = readBack.registers;
      report.raw.push(...readBack.raw);
    }
  }

  report.warnings.unshift(...pinCheck.warnings, ...profileWarnings);
  return report;
}

/**
 * Read registers with no profile: raw values, no field decoding.
 *
 * This is the path that makes an unknown component investigable. It reports what
 * each address returned and nothing more, because nothing more is known.
 */
async function inspectRawRegisters(
  session: InterrogationSession,
  options: BusOptions,
  iface: HardwareInterfaceKind,
  registers: number[]
): Promise<RegisterInspectionReport> {
  const raw: RawInterpretation[] = [];
  const results: RegisterInspectionResult[] = [];
  const warnings: string[] = [];
  const ctx = buildProbeContext(session, options, null);
  const address = ctx.address;

  if (iface !== 'I2C') {
    warnings.push(
      `Raw register reads are implemented for I2C. For ${iface}, use esp32_hardware_execute ` +
        'with an explicit transaction.'
    );
  }

  if (address === undefined) {
    warnings.push('No I2C address supplied, so no raw register read could be addressed.');
  }

  if (iface === 'I2C' && address !== undefined) {
    for (const register of registers) {
      const response = await session.transport.request<{ bytes?: number[] }>(
        'i2c.writeRead',
        {
          ...(options.controller !== undefined ? { controller: options.controller } : {}),
          ...(options.sda !== undefined ? { sda: options.sda } : {}),
          ...(options.scl !== undefined ? { scl: options.scl } : {}),
          ...(options.frequencyHz !== undefined ? { frequencyHz: options.frequencyHz } : {}),
          address,
          write: [register],
          readLength: 1,
        },
        { ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) }
      );

      const bytes =
        response.ok && Array.isArray(response.data?.bytes)
          ? response.data!.bytes!.map((b) => b & 0xff)
          : [];

      raw.push(
        rawInterpretation(
          response.raw,
          response.data,
          `Raw read of register ${hexValue(register)}`,
          response.ok ? 'REGISTER_READ' : 'NONE',
          response.ok ? 'HIGH' : 'UNKNOWN'
        )
      );

      const definition = {
        address: register,
        name: `REG_${hexValue(register)}`,
        description: 'Undocumented register — read raw, with no field decoding.',
        width: 8,
        access: 'R' as const,
        fields: [],
        safeToRead: true,
      };

      results.push(
        bytes.length > 0
          ? decodeRegister(definition, bytes.slice(0, 1), response.raw)
          : failedRegisterResult(
              definition,
              response.error ?? 'No data returned',
              response.raw
            )
      );
    }
  }

  return {
    success: results.some((r) => r.read),
    componentId: 'unidentified',
    partNumber: 'UNKNOWN',
    interface: iface,
    address: address ?? null,
    readOnly: true,
    registers: results,
    skipped: [],
    warnings,
    raw,
  };
}

/**
 * Perform explicit register writes.
 *
 * Each write is executed exactly as given. The report records the bytes sent,
 * the bus acknowledgement, and the caller's stated justification — it makes no
 * claim about what the write accomplished, because that is not knowable from the
 * write alone.
 */
async function performRegisterWrites(
  session: InterrogationSession,
  options: RegisterInspectOptions,
  iface: HardwareInterfaceKind,
  profile: ComponentProfile | null
): Promise<{
  writes: NonNullable<RegisterInspectionReport['writes']>;
  raw: RawInterpretation[];
  warnings: string[];
}> {
  const raw: RawInterpretation[] = [];
  const warnings: string[] = [];
  const writes: NonNullable<RegisterInspectionReport['writes']> = [];
  const ctx = buildProbeContext(session, options, profile);
  const address = ctx.address;

  if (iface !== 'I2C') {
    warnings.push(
      `Register writes are implemented for I2C. For ${iface}, use esp32_hardware_execute with ` +
        'an explicit SPI or UART transaction.'
    );
    return { writes, raw, warnings };
  }
  if (address === undefined) {
    warnings.push('No I2C address supplied, so no register write could be addressed.');
    return { writes, raw, warnings };
  }

  for (const request of options.writes ?? []) {
    // Capture the prior value so the effect of the write is observable.
    const before = await session.transport.request<{ bytes?: number[] }>(
      'i2c.writeRead',
      { ...i2cBusParams(options), address, write: [request.register], readLength: 1 },
      { ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) }
    );
    const beforeBytes =
      before.ok && Array.isArray(before.data?.bytes) ? before.data!.bytes!.map((b) => b & 0xff) : [];

    const payload = [request.register, ...request.value];
    const response = await session.transport.request<{
      writeAck?: boolean;
      writeStatus?: number;
      statusText?: string;
    }>(
      'i2c.write',
      { ...i2cBusParams(options), address, write: payload },
      { ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) }
    );

    raw.push(
      rawInterpretation(
        response.raw,
        response.data,
        `Wrote ${toHex(payload)} to ${hexValue(request.register)} at ` +
          `${hexValue(address)} — acknowledgement: ${response.data?.statusText ?? 'unknown'}`,
        response.ok ? 'DEVICE_RESPONSE' : 'NONE',
        response.ok ? 'HIGH' : 'UNKNOWN'
      )
    );

    writes.push({
      register: request.register,
      registerHex: hexValue(request.register),
      value: request.value,
      valueHex: toHex(request.value),
      ...(request.justification !== undefined ? { justification: request.justification } : {}),
      acknowledged: response.data?.writeAck === true,
      busStatus: response.data?.statusText ?? response.error ?? 'unknown',
      valueBeforeHex: beforeBytes.length > 0 ? toHex(beforeBytes) : null,
      executed: response.ok,
      ...(response.error !== undefined ? { error: response.error } : {}),
      note:
        'A bus acknowledgement confirms the device accepted the bytes. It does not establish ' +
        'that the device did what the caller intended — read the state back and compare.',
    });
  }

  return { writes, raw, warnings };
}

function i2cBusParams(options: BusOptions): Record<string, unknown> {
  return {
    ...(options.controller !== undefined ? { controller: options.controller } : {}),
    ...(options.sda !== undefined ? { sda: options.sda } : {}),
    ...(options.scl !== undefined ? { scl: options.scl } : {}),
    ...(options.frequencyHz !== undefined ? { frequencyHz: options.frequencyHz } : {}),
  };
}

/**
 * Shared register-read implementation, used by both esp32_register_inspect and
 * the DEEP tier of esp32_component_probe.
 */
async function inspectRegistersInternal(
  session: InterrogationSession,
  profile: ComponentProfile,
  options: BusOptions,
  iface: HardwareInterfaceKind,
  existingProbes: ProbeExecutionResult[],
  requested?: (string | number)[]
): Promise<RegisterInspectionReport> {
  const raw: RawInterpretation[] = [];
  const warnings: string[] = [];
  const results: RegisterInspectionResult[] = [];
  const skipped: { address: string; reason: string }[] = [];

  const ctx = buildProbeContext(session, options, profile);
  const wanted = requested?.map((r) =>
    typeof r === 'number' ? r : r.trim().toLowerCase()
  );

  const selected = profile.registers.filter((definition) => {
    if (!wanted || wanted.length === 0) return true;
    return wanted.some(
      (w) =>
        w === definition.address ||
        (typeof w === 'string' &&
          (w === String(definition.address).toLowerCase() ||
            w === definition.name.toLowerCase() ||
            w === formatRegisterAddress(definition.address).toLowerCase()))
    );
  });

  if (wanted && wanted.length > 0 && selected.length === 0) {
    warnings.push(
      `None of the requested registers exist in the ${profile.partNumber} profile. ` +
        `Available: ${profile.registers.map((r) => r.name).join(', ')}`
    );
  }

  const probeCache = new Map(existingProbes.map((p) => [p.probeId, p]));

  for (const definition of selected) {
    if (!isSafeToInspect(definition)) {
      const reason = skipReason(definition);
      results.push(skippedRegisterResult(definition, reason));
      skipped.push({ address: formatRegisterAddress(definition.address), reason });
      continue;
    }

    const width = registerByteWidth(definition);

    // Path A: a profile-declared probe reads this register (command-protocol parts).
    if (definition.readProbeId) {
      const probe = findProbe(profile, definition.readProbeId);
      if (!probe) {
        results.push(
          failedRegisterResult(
            definition,
            `Profile references read probe "${definition.readProbeId}", which does not exist.`
          )
        );
        continue;
      }

      const result = probeCache.get(probe.id) ?? (await executeProbe(probe, ctx));
      probeCache.set(probe.id, result);
      raw.push(result.raw);

      if (!result.executed || result.bytes.length === 0) {
        results.push(
          failedRegisterResult(
            definition,
            result.error ?? `Probe ${probe.id} returned no data`,
            result.raw.raw
          )
        );
        continue;
      }

      const bytes = extractRegisterBytes(result.bytes, probe, definition, width);
      if (bytes === null) {
        results.push(
          failedRegisterResult(
            definition,
            `Probe ${probe.id} returned ${result.hex} but the register value could not be ` +
              'located within it. The raw response is retained for manual interpretation.',
            result.raw.raw
          )
        );
        continue;
      }

      results.push(decodeRegister(definition, bytes, result.raw.raw));
      continue;
    }

    // Path B: a direct addressed bus read.
    if (iface !== 'I2C' || typeof definition.address !== 'number') {
      const reason =
        iface !== 'I2C'
          ? `Direct register reads are implemented for I2C only; ${iface} registers need a profile read probe.`
          : 'Register has a symbolic address but no read probe.';
      results.push(skippedRegisterResult(definition, reason));
      skipped.push({ address: formatRegisterAddress(definition.address), reason });
      continue;
    }

    const address = ctx.address;
    if (address === undefined) {
      const reason = 'No I2C address resolved for this component.';
      results.push(skippedRegisterResult(definition, reason));
      skipped.push({ address: formatRegisterAddress(definition.address), reason });
      continue;
    }

    const response = await session.transport.request<{ bytes?: number[] }>(
      'i2c.writeRead',
      {
        ...(options.controller !== undefined ? { controller: options.controller } : {}),
        ...(options.sda !== undefined ? { sda: options.sda } : {}),
        ...(options.scl !== undefined ? { scl: options.scl } : {}),
        ...(options.frequencyHz !== undefined ? { frequencyHz: options.frequencyHz } : {}),
        address,
        // A register-pointer write. It selects which register to read and never
        // carries a data payload.
        write: [definition.address],
        readLength: width,
      },
      { ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) }
    );

    raw.push(
      rawInterpretation(
        response.raw,
        response.data,
        `Read ${definition.name} at ${formatRegisterAddress(definition.address)}`,
        response.ok ? 'REGISTER_READ' : 'NONE',
        response.ok ? 'HIGH' : 'UNKNOWN'
      )
    );

    const bytes = response.ok && Array.isArray(response.data?.bytes)
      ? response.data!.bytes!.map((b) => b & 0xff)
      : [];

    if (bytes.length < width) {
      results.push(
        failedRegisterResult(
          definition,
          response.ok
            ? `Expected ${width} byte(s), received ${bytes.length}`
            : (response.error ?? 'Register read failed'),
          response.raw
        )
      );
      continue;
    }

    results.push(decodeRegister(definition, bytes.slice(0, width), response.raw));
  }

  const readCount = results.filter((r) => r.read).length;
  if (readCount === 0 && selected.length > 0) {
    warnings.push(
      'No register could be read. Verify the device address, bus wiring and that the component ' +
        'matches the selected profile.'
    );
  }

  const changed = results.filter((r) => r.changedFromReset === true);
  if (changed.length > 0) {
    warnings.push(
      `${changed.length} register(s) differ from their documented reset value ` +
        `(${changed.map((r) => r.name).join(', ')}). The device has been configured since power-up, ` +
        'or the profile reset values do not apply to this variant.'
    );
  }

  return {
    success: readCount > 0 || selected.length === 0,
    componentId: profile.id,
    partNumber: profile.partNumber,
    interface: iface,
    address: ctx.address ?? null,
    readOnly: true,
    registers: results,
    skipped,
    warnings,
    raw,
  };
}

/**
 * Locate a register value inside a probe response.
 *
 * Uses an explicit responseOffset when the profile gives one; otherwise anchors
 * on the probe's documented expectation pattern and takes the bytes that follow.
 * Returns null rather than grabbing arbitrary bytes when neither applies.
 */
function extractRegisterBytes(
  response: number[],
  probe: SafeProbe,
  definition: { responseOffset?: number },
  width: number
): number[] | null {
  if (definition.responseOffset !== undefined) {
    const slice = response.slice(definition.responseOffset, definition.responseOffset + width);
    return slice.length === width ? slice : null;
  }

  if (probe.expect?.pattern) {
    const offset = findBytePattern(response, probe.expect.pattern);
    if (offset >= 0) {
      const patternLength = probe.expect.pattern.trim().split(/[\s,]+/).filter(Boolean).length;
      const start = offset + patternLength;
      const slice = response.slice(start, start + width);
      if (slice.length === width) return slice;
    }
  }

  return null;
}

function failedRegisterReport(
  options: RegisterInspectOptions | BusOptions,
  iface: HardwareInterfaceKind,
  errors: string[]
): RegisterInspectionReport {
  return {
    success: false,
    componentId: (options as RegisterInspectOptions).component ?? 'unknown',
    partNumber: 'UNKNOWN',
    interface: iface,
    address: options.address ?? null,
    readOnly: true,
    registers: [],
    skipped: [],
    warnings: [],
    raw: [],
    error: errors.join('; '),
  };
}

// ===========================================================================
// 9. esp32_component_capabilities
// ===========================================================================

export interface ComponentCapabilitiesOptions extends BusOptions {
  component: string;
  depth?: string;
  /**
   * Capabilities the caller knows the target firmware exposes.
   * Firmware exposure cannot be discovered from the bus, so it is only ever set
   * from an explicit, sourced statement.
   */
  firmwareCapabilities?: string[];
  /** Skip all hardware access and report the documentation tier only. */
  offline?: boolean;
}

/**
 * Build the capability matrix: DOCUMENTED vs SOFTWARE vs FIRMWARE vs OBSERVED vs
 * TESTED vs VERIFIED, plus the gap analysis derived from it.
 *
 * Runs offline when no hardware is attached, producing an honest
 * documentation-only matrix in which nothing is observed and every documented
 * capability is UNTESTED.
 */
export async function componentCapabilities(
  options: ComponentCapabilitiesOptions
): Promise<{
  success: boolean;
  componentId: string;
  partNumber: string;
  mode: 'OFFLINE' | 'LIVE';
  matrix: ReturnType<typeof buildCapabilityMatrix>;
  interpretation: string[];
  warnings: string[];
  raw: RawInterpretation[];
  error?: string;
}> {
  const iface = coerceInterface(options.interface, 'I2C');

  if (!options.component || !validateComponentIdentifier(options.component)) {
    return capabilitiesError(
      options.component ?? 'unknown',
      'A `component` is required: the capability matrix is built from a profile\'s documented ' +
        'capability list. Without a profile there is no documentation tier to compare against — ' +
        'investigate directly with esp32_hardware_execute and record what you observe.'
    );
  }

  const profile = findProfile(options.component);
  if (!profile) {
    return capabilitiesError(
      options.component,
      `No registered component profile matches "${options.component}". ` +
        `Known profiles: ${listProfiles().map((p) => p.id).join(', ')}`
    );
  }

  const firmwareCapabilities = new Set(options.firmwareCapabilities ?? []);
  const warnings: string[] = [];
  const raw: RawInterpretation[] = [];
  let probes: ProbeExecutionResult[] = [];
  let registers: RegisterInspectionReport | null = null;
  let mode: 'OFFLINE' | 'LIVE' = 'OFFLINE';

  if (!options.offline) {
    const errors = validateBusOptions(options, iface);
    if (errors.length > 0) {
      warnings.push(...errors, 'Falling back to an offline, documentation-only matrix.');
    } else {
      const probeReport = await componentProbe({
        ...options,
        component: profile.id,
        interface: iface,
        depth: options.depth ?? 'DEEP',
      });
      raw.push(...probeReport.raw);
      warnings.push(...probeReport.warnings);
      probes = probeReport.probes;
      registers = probeReport.registers;
      mode = probeReport.probes.some((p) => p.executed) ? 'LIVE' : 'OFFLINE';
      if (mode === 'OFFLINE') {
        warnings.push(
          'No probe executed against hardware, so the matrix reports the documentation tier only.'
        );
      }
    }
  }

  let capabilities = buildComponentCapabilities(profile, probes, registers);

  if (firmwareCapabilities.size > 0) {
    capabilities = capabilities.map((cap) =>
      firmwareCapabilities.has(cap.name)
        ? mergeCapability(cap, {
            firmwareExposed: true,
            evidence: [
              makeEvidence(
                'USER_SUPPLIED',
                'Caller stated that the target firmware exposes this capability',
                { confidence: 'LOW' }
              ),
            ],
          })
        : cap
    );

    const unknownNames = [...firmwareCapabilities].filter(
      (name) => !capabilities.some((c) => c.name === name)
    );
    if (unknownNames.length > 0) {
      warnings.push(
        `firmwareCapabilities named capabilities absent from the ${profile.partNumber} profile ` +
          `and therefore ignored: ${unknownNames.join(', ')}`
      );
    }
  }

  const matrix = buildCapabilityMatrix(profile.partNumber, capabilities, profile.id);

  const interpretation = [
    'DOCUMENTED means a datasheet says so. It is not a measurement.',
    'SOFTWARE SUPPORT means a driver is known to exist. It says nothing about this unit.',
    'FIRMWARE EXPOSED is only set from an explicit statement — it cannot be discovered from ' +
      'the bus, so the default of false means "not established", not "proven absent".',
    'OBSERVED means a probe returned data consistent with the capability on this unit.',
    'VERIFIED means a functional test ran and produced the expected result.',
    `POTENTIAL EXTENSION (${matrix.gaps.filter((g) => g.kind === 'POTENTIAL_EXTENSION').length}) ` +
      'is documented + software-supported + not exposed by firmware. It is a development ' +
      'opportunity, never a verified capability.',
    `SOFTWARE GAP (${matrix.gaps.filter((g) => g.kind === 'SOFTWARE_GAP').length}) is documented ` +
      'with no known driver.',
    `UNDOCUMENTED OBSERVATION (${matrix.gaps.filter((g) => g.kind === 'UNDOCUMENTED_OBSERVATION').length}) ` +
      'is behaviour seen but not described by any documentation held here.',
    `UNEXPLORED (${matrix.gaps.filter((g) => g.kind === 'UNEXPLORED').length}) means unknown, ` +
      'not unsupported.',
  ];

  if (mode === 'OFFLINE') {
    interpretation.unshift(
      'OFFLINE matrix: no hardware was interrogated. Every row reflects documentation only, ' +
        'and nothing here is evidence about a physical unit.'
    );
  }

  return {
    success: true,
    componentId: profile.id,
    partNumber: profile.partNumber,
    mode,
    matrix,
    interpretation,
    warnings,
    raw,
  };
}

function capabilitiesError(componentId: string, message: string) {
  return {
    success: false,
    componentId,
    partNumber: 'UNKNOWN',
    mode: 'OFFLINE' as const,
    matrix: buildCapabilityMatrix(componentId, []),
    interpretation: [],
    warnings: [message],
    raw: [] as RawInterpretation[],
    error: message,
  };
}

// ===========================================================================
// 10. esp32_component_test
// ===========================================================================

export interface ComponentTestOptions extends BusOptions {
  component: string;
  tests?: string[];
  depth?: string;
}

/**
 * Controlled functional testing.
 *
 * Every test records its objective, configuration, procedure, expected result,
 * observed result, verdict, evidence, confidence and duration — the minimum for
 * a result that someone else can check.
 */
export async function componentTest(
  options: ComponentTestOptions
): Promise<ComponentTestReport> {
  const depth = coerceDepth(options.depth, 'STANDARD');
  const iface = coerceInterface(options.interface, 'I2C');

  const errors = validateBusOptions(options, iface);
  if (!options.component || !validateComponentIdentifier(options.component)) {
    errors.push(
      'A `component` is required: functional tests are declared by component profiles. ' +
        'To exercise a component that has no profile, use esp32_hardware_execute to construct ' +
        'the transactions directly, or esp32_hardware_experiment with inline operations — ' +
        'both work without any profile.'
    );
  }
  if (errors.length > 0) return failedTestReport(options.component ?? 'unknown', depth, errors);

  const profile = findProfile(options.component!);
  if (!profile) {
    return failedTestReport(options.component!, depth, [
      `No registered component profile matches "${options.component}". Profiles supply the ` +
        'declared tests for this tool; interrogation without one is done through ' +
        'esp32_hardware_execute or esp32_hardware_experiment.',
    ]);
  }

  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });
  const pinCheck = pinChecksFor(session, options, iface);
  if (!pinCheck.ok) return failedTestReport(profile.id, depth, pinCheck.errors);

  if (!session.agentPresent) {
    return failedTestReport(profile.id, depth, agentUnavailableHelp(session.agentDetail));
  }

  const ctx = buildProbeContext(session, options, profile);
  const warnings: string[] = [...pinCheck.warnings];

  const requested = options.tests?.map((t) => t.toLowerCase());
  const selected = profile.functionalTests.filter((test) => {
    if (requested && requested.length > 0) {
      return requested.includes(test.id.toLowerCase()) || requested.includes(test.name.toLowerCase());
    }
    return true;
  });

  if (requested && requested.length > 0 && selected.length === 0) {
    warnings.push(
      `No test matched the requested names. Available: ${profile.functionalTests
        .map((t) => t.id)
        .join(', ')}`
    );
  }

  const configuration: Record<string, unknown> = {
    interface: iface,
    address: ctx.address ?? null,
    ...(options.sda !== undefined ? { sda: options.sda } : {}),
    ...(options.scl !== undefined ? { scl: options.scl } : {}),
    ...(options.frequencyHz !== undefined ? { frequencyHz: options.frequencyHz } : {}),
    ...(options.cs !== undefined ? { cs: options.cs } : {}),
    ...(options.mode !== undefined ? { spiMode: options.mode } : {}),
    ...(options.clockHz !== undefined ? { clockHz: options.clockHz } : {}),
    ...(options.rx !== undefined ? { rx: options.rx } : {}),
    ...(options.baud !== undefined ? { baud: options.baud } : {}),
    depth,
  };

  const results: FunctionalTestResult[] = [];

  for (const definition of selected) {
    const started = Date.now();

    if (depthRank(depth) < depthRank(definition.minDepth ?? 'BASIC')) {
      results.push({
        testId: definition.id,
        name: definition.name,
        capability: definition.capability,
        objective: definition.objective,
        configuration,
        procedure: definition.procedure,
        expectedResult: definition.expectedResult,
        observedResult: 'Not executed.',
        passed: false,
        executed: false,
        skippedReason: `Requires depth ${definition.minDepth}; running at ${depth}.`,
        evidence: [],
        confidence: 'UNKNOWN',
        durationMs: 0,
        raw: [],
      });
      continue;
    }

    const probeResults: ProbeExecutionResult[] = [];
    for (const probeId of definition.probes) {
      const probe = findProbe(profile, probeId);
      if (!probe) {
        probeResults.push({
          probeId,
          name: probeId,
          executed: false,
          success: false,
          skippedReason: 'Probe not found in the profile',
          writes: false,
          operations: [],
          bytes: [],
          hex: '',
          matchedExpectation: null,
          durationMs: 0,
          raw: rawInterpretation<number[]>(
            '',
            null,
            `Probe ${probeId} is not declared by the profile`,
            'NONE'
          ),
        });
        continue;
      }
      probeResults.push(await executeProbe(probe, ctx));
    }

    const bytes = probeResults.flatMap((r) => r.bytes);
    const executedProbes = probeResults.filter((r) => r.executed);
    const durationMs = Date.now() - started;

    const patternOk =
      definition.expectPattern === undefined
        ? null
        : matchBytePattern(bytes, definition.expectPattern);
    const sizeOk =
      definition.expectMinBytes === undefined ? null : bytes.length >= definition.expectMinBytes;

    let passed: boolean;
    let observedResult: string;

    if (executedProbes.length === 0) {
      passed = false;
      observedResult = 'No probe could be executed.';
    } else if (bytes.length === 0) {
      passed = false;
      observedResult = `No data returned. ${
        probeResults.map((r) => r.error).filter(Boolean).join('; ') || 'Device did not respond.'
      }`;
    } else if (patternOk === null && sizeOk === null) {
      // No objective criterion — record the observation, do not claim a pass.
      passed = false;
      observedResult =
        `Received ${bytes.length} byte(s): ${toHex(bytes)}. The test declares no expected ` +
        'pattern or minimum size, so no pass verdict can be reached objectively.';
    } else {
      passed = (patternOk ?? true) && (sizeOk ?? true);
      observedResult = passed
        ? `Received ${bytes.length} byte(s): ${toHex(bytes)} — matches the expected result.`
        : `Received ${bytes.length} byte(s): ${toHex(bytes)} — does not match ` +
          [
            patternOk === false ? `expected pattern "${definition.expectPattern}"` : null,
            sizeOk === false ? `minimum length ${definition.expectMinBytes}` : null,
          ]
            .filter(Boolean)
            .join(' and ') +
          '.';
    }

    results.push({
      testId: definition.id,
      name: definition.name,
      capability: definition.capability,
      objective: definition.objective,
      configuration,
      procedure: definition.procedure,
      expectedResult: definition.expectedResult,
      observedResult,
      passed,
      executed: true,
      evidence: [
        makeEvidence('COMPONENT_PROFILE', `Test declared by the ${profile.partNumber} profile`, {
          ...(definition.reference !== undefined ? { reference: definition.reference } : {}),
          confidence: 'DOCUMENTED',
          testId: definition.id,
        }),
        ...probeResults
          .filter((r) => r.executed)
          .map((r) =>
            makeEvidence('DEVICE_RESPONSE', `${r.name}: ${r.hex || 'no data'}`, {
              raw: r.raw.raw,
              confidence: r.bytes.length > 0 ? 'HIGH' : 'LOW',
              testId: definition.id,
            })
          ),
      ],
      // A single passing run establishes the behaviour once. CONFIRMED is
      // reserved for repeated measurement, which esp32_hardware_experiment does.
      confidence: passed ? 'HIGH' : bytes.length > 0 ? 'MEDIUM' : 'LOW',
      durationMs,
      raw: probeResults.map((r) => r.raw),
    });
  }

  const passed = results.filter((r) => r.executed && r.passed).length;
  const failed = results.filter((r) => r.executed && !r.passed).length;
  const skipped = results.filter((r) => !r.executed).length;

  // Rebuild the matrix so verified capabilities reflect these test outcomes.
  const probesForMatrix = results.flatMap((r) =>
    r.raw.map((raw, index) => ({
      probeId: `${r.testId}:${index}`,
      name: r.name,
      executed: r.executed,
      success: r.passed,
      writes: false,
      operations: [],
      bytes: (raw.parsed as number[]) ?? [],
      hex: toHex((raw.parsed as number[]) ?? []),
      matchedExpectation: r.passed,
      durationMs: r.durationMs,
      raw,
    }))
  );

  return {
    success: failed === 0 && passed > 0,
    componentId: profile.id,
    partNumber: profile.partNumber,
    depth,
    tests: results,
    passed,
    failed,
    skipped,
    capabilities: buildCapabilityMatrix(
      profile.partNumber,
      buildComponentCapabilities(profile, probesForMatrix, null, results),
      profile.id
    ),
    reproducibility: buildReproducibility(configuration, session.reproducibility, profile),
    warnings,
  };
}

function failedTestReport(
  componentId: string,
  depth: InterrogationDepth,
  errors: string[]
): ComponentTestReport {
  return {
    success: false,
    componentId,
    partNumber: 'UNKNOWN',
    depth,
    tests: [],
    passed: 0,
    failed: 0,
    skipped: 0,
    capabilities: null,
    reproducibility: buildReproducibility({}),
    warnings: [],
    error: errors.join('; '),
  };
}

// ===========================================================================
// 11. esp32_component_benchmark
// ===========================================================================

export interface ComponentBenchmarkOptions extends BusOptions {
  component: string;
  benchmarks?: string[];
  iterations?: number;
}

/**
 * Component performance characterisation.
 *
 * Reports a MEASURED maximum, clearly separated from any DOCUMENTED maximum.
 * The measured figure is what this setup sustained — host, bridge, agent and
 * device combined — and is never presented as a hardware limit.
 */
export async function componentBenchmark(
  options: ComponentBenchmarkOptions
): Promise<ComponentBenchmarkReport> {
  const iface = coerceInterface(options.interface, 'I2C');
  const errors = validateBusOptions(options, iface);

  if (!options.component || !validateComponentIdentifier(options.component)) {
    errors.push(
      'A `component` is required: benchmarks are declared by component profiles. To time ' +
        'arbitrary transactions on a component with no profile, use esp32_hardware_execute ' +
        'with repetitions — it reports per-operation timing.'
    );
  }
  if (options.iterations !== undefined && !validateIterations(options.iterations, 200)) {
    errors.push('iterations must be between 1 and 200');
  }
  if (errors.length > 0) return failedBenchmarkReport(options.component ?? 'unknown', errors);

  const profile = findProfile(options.component);
  if (!profile) {
    return failedBenchmarkReport(options.component, [
      `No registered component profile matches "${options.component}".`,
    ]);
  }

  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });
  const pinCheck = pinChecksFor(session, options, iface);
  if (!pinCheck.ok) return failedBenchmarkReport(profile.id, pinCheck.errors);
  if (!session.agentPresent) {
    return failedBenchmarkReport(profile.id, agentUnavailableHelp(session.agentDetail));
  }

  const ctx = buildProbeContext(session, options, profile);
  const warnings: string[] = [...pinCheck.warnings];

  const requested = options.benchmarks?.map((b) => b.toLowerCase());
  const selected = profile.benchmarks.filter((b) =>
    !requested || requested.length === 0
      ? true
      : requested.includes(b.id.toLowerCase()) || requested.includes(b.name.toLowerCase())
  );

  if (selected.length === 0) {
    warnings.push(
      `No benchmark matched. Available: ${profile.benchmarks.map((b) => b.id).join(', ') || 'none'}`
    );
  }

  const measurements: BenchmarkMeasurement[] = [];

  for (const definition of selected) {
    const probe = findProbe(profile, definition.probeId);
    if (!probe) {
      measurements.push(
        emptyMeasurement(definition, `Probe "${definition.probeId}" is not declared by the profile.`)
      );
      continue;
    }

    // The caller may lower the iteration count but never silently raise it above
    // what the profile considers reasonable for the part.
    const iterations = Math.min(options.iterations ?? definition.iterations, definition.iterations);
    if (options.iterations !== undefined && options.iterations > definition.iterations) {
      warnings.push(
        `${definition.id}: requested ${options.iterations} iterations, capped at the profile ` +
          `limit of ${definition.iterations}.`
      );
    }

    const samples: number[] = [];
    const raw: RawInterpretation<number[]>[] = [];
    const responses: number[][] = [];
    let failures = 0;

    for (let i = 0; i < iterations; i++) {
      const result = await executeProbe(probe, ctx);
      if (i === 0 || i === iterations - 1) raw.push(result.raw);
      if (result.success) {
        samples.push(result.durationMs);
        responses.push(result.bytes);
      } else {
        failures++;
      }
    }

    measurements.push(
      buildMeasurement(definition, samples, responses, failures, iterations, raw)
    );
  }

  return {
    success: measurements.some((m) => m.successfulIterations > 0),
    componentId: profile.id,
    partNumber: profile.partNumber,
    measurements,
    reproducibility: buildReproducibility(
      { interface: iface, ...options },
      session.reproducibility,
      profile
    ),
    warnings,
    notes: [
      'Every timing figure is an end-to-end round trip: host process, Python serial bridge, ' +
        'USB-UART link, agent firmware and device. It is not the device response time alone.',
      'measuredMaximum is the highest rate this setup sustained. It is a floor on the hardware ' +
        'capability, never a ceiling.',
      'documentedMaximum comes from the datasheet and has not been verified here.',
    ],
  };
}

function buildMeasurement(
  definition: ComponentProfile['benchmarks'][number],
  samples: number[],
  responses: number[][],
  failures: number,
  iterations: number,
  raw: RawInterpretation<number[]>[]
): BenchmarkMeasurement {
  const min = samples.length > 0 ? Math.min(...samples) : null;
  const max = samples.length > 0 ? Math.max(...samples) : null;
  const avg = mean(samples);
  const errorRate = iterations > 0 ? failures / iterations : 0;

  let measuredMaximum = unknownValue<number>('Not derivable from this metric');
  let interpretation: string;

  switch (definition.metric) {
    case 'POLLING_RATE':
      if (avg !== null && avg > 0) {
        const rate = 1000 / avg;
        measuredMaximum = knownValue(
          Number(rate.toFixed(2)),
          'DEVICE_RESPONSE',
          `Derived from a mean round trip of ${avg.toFixed(2)} ms over ${samples.length} iterations`,
          'MEDIUM'
        );
      } else if (avg === 0) {
        // Every round trip completed inside one millisecond. Reporting a rate
        // here would be a division by the timer resolution, not a measurement.
        measuredMaximum = unknownValue<number>(
          'Every round trip measured 0 ms — below the millisecond timer resolution. The rate ' +
            'exceeds what this timing method can express; use a longer transaction to measure it.'
        );
      }
      interpretation =
        'Sustained polling rate through the full host-to-device path. The device itself will ' +
        'support a higher rate than this figure shows.';
      break;

    case 'THROUGHPUT': {
      const totalBytes = responses.reduce((sum, r) => sum + r.length, 0);
      const totalSeconds = samples.reduce((sum, s) => sum + s, 0) / 1000;
      if (totalSeconds > 0 && totalBytes > 0) {
        measuredMaximum = knownValue(
          Number((totalBytes / totalSeconds).toFixed(2)),
          'DEVICE_RESPONSE',
          `${totalBytes} byte(s) over ${totalSeconds.toFixed(3)} s`,
          'MEDIUM'
        );
      }
      interpretation =
        'Application-level throughput including all protocol and transport overhead, not the ' +
        'raw bus line rate.';
      break;
    }

    case 'READ_CONSISTENCY':
    case 'STABILITY': {
      const consistency = analyseConsistency(responses);
      measuredMaximum =
        responses.length > 0
          ? knownValue(
              consistency.agreement,
              'DEVICE_RESPONSE',
              consistency.note,
              consistency.stable && responses.length >= 5 ? 'HIGH' : 'MEDIUM'
            )
          : unknownValue<number>('No successful response to compare');
      interpretation = consistency.note;
      break;
    }

    case 'ERROR_RATE':
      measuredMaximum = knownValue(
        Number(errorRate.toFixed(4)),
        'DEVICE_RESPONSE',
        `${failures} failure(s) across ${iterations} attempt(s)`,
        iterations >= 20 ? 'MEDIUM' : 'LOW'
      );
      interpretation =
        iterations >= 20
          ? 'Error rate over the sampled attempts. A zero rate over a short run does not ' +
            'establish long-term reliability.'
          : 'Sample size is too small for a meaningful error rate.';
      break;

    default:
      interpretation =
        avg !== null
          ? `Mean round trip ${avg.toFixed(2)} ms across ${samples.length} successful iteration(s).`
          : 'No successful iteration, so no latency could be measured.';
      break;
  }

  if (samples.length === 0) {
    interpretation = `No iteration succeeded (${failures}/${iterations} failed). ${interpretation}`;
  }

  return {
    benchmarkId: definition.id,
    name: definition.name,
    metric: definition.metric,
    unit: definition.unit,
    iterations,
    successfulIterations: samples.length,
    samples,
    min,
    max,
    mean: avg !== null ? Number(avg.toFixed(3)) : null,
    median: median(samples),
    stdDev: (() => {
      const value = stdDev(samples);
      return value !== null ? Number(value.toFixed(3)) : null;
    })(),
    errorRate: Number(errorRate.toFixed(4)),
    measuredMaximum,
    documentedMaximum:
      definition.documentedValue !== undefined
        ? knownValue(
            definition.documentedValue,
            'DATASHEET',
            definition.reference ?? 'Datasheet figure',
            'DOCUMENTED'
          )
        : unknownValue<number>('No datasheet figure in the component profile'),
    interpretation,
    confidence: samples.length >= 10 ? 'HIGH' : samples.length > 0 ? 'MEDIUM' : 'UNKNOWN',
    raw,
  };
}

function emptyMeasurement(
  definition: ComponentProfile['benchmarks'][number],
  error: string
): BenchmarkMeasurement {
  return {
    benchmarkId: definition.id,
    name: definition.name,
    metric: definition.metric,
    unit: definition.unit,
    iterations: 0,
    successfulIterations: 0,
    samples: [],
    min: null,
    max: null,
    mean: null,
    median: null,
    stdDev: null,
    errorRate: 0,
    measuredMaximum: unknownValue<number>(error),
    documentedMaximum:
      definition.documentedValue !== undefined
        ? knownValue(definition.documentedValue, 'DATASHEET', 'Datasheet figure', 'DOCUMENTED')
        : unknownValue<number>('No datasheet figure in the component profile'),
    interpretation: error,
    confidence: 'UNKNOWN',
    raw: [],
    error,
  };
}

function failedBenchmarkReport(
  componentId: string,
  errors: string[]
): ComponentBenchmarkReport {
  return {
    success: false,
    componentId,
    partNumber: 'UNKNOWN',
    measurements: [],
    reproducibility: buildReproducibility({}),
    warnings: [],
    notes: [],
    error: errors.join('; '),
  };
}

// ===========================================================================
// 12. esp32_hardware_experiment
// ===========================================================================

export interface HardwareExperimentOptions extends BusOptions {
  experimentId?: string;
  objective: string;
  targetComponent?: string;
  hypothesis?: string;
  expectedResult?: string;
  procedure?: {
    /** Probe id from the target component profile. Optional. */
    probeId?: string;
    /** Raw operation constructed inline. Needs no profile. */
    operation?: RawOperation;
    description?: string;
    critical?: boolean;
    expectPattern?: string;
    expectMinBytes?: number;
  }[];
  safetyConstraints?: string[];
  telemetry?: { name: string; description?: string; required?: boolean }[];
  repetitions?: number;
}

/**
 * High-level experiment orchestrator.
 *
 * Produces a complete, machine-readable experiment report covering the full
 * lifecycle, including everything needed to reproduce the run.
 */
export async function hardwareExperiment(
  options: HardwareExperimentOptions
): Promise<ExperimentReport> {
  const iface = coerceInterface(options.interface, 'I2C');
  const errors = validateBusOptions(options, iface);

  if (!options.objective || options.objective.trim().length === 0) {
    errors.push('An `objective` is required — an experiment without a stated purpose is not one.');
  }
  if (options.targetComponent !== undefined && !validateComponentIdentifier(options.targetComponent)) {
    errors.push(`Invalid target component identifier: ${options.targetComponent}`);
  }
  if (options.repetitions !== undefined && !validateIterations(options.repetitions, 50)) {
    errors.push('repetitions must be between 1 and 50');
  }

  const profile = options.targetComponent ? findProfile(options.targetComponent) : null;
  const experimentWarnings: string[] = [];

  if (options.targetComponent && !profile) {
    // Worth saying either way: it tells the caller no documented context is
    // available. It is not a failure — inline operations are unaffected.
    experimentWarnings.push(
      `No registered profile matches "${options.targetComponent}", so no documented context ` +
        'is available for it. Steps naming a probeId cannot resolve; steps carrying an inline ' +
        '`operation` run regardless.'
    );
  }

  // Default the procedure to the profile's own probes, when there is one.
  const procedure =
    options.procedure && options.procedure.length > 0
      ? options.procedure.map((step) => ({
          ...(step.probeId !== undefined ? { probeId: step.probeId } : {}),
          ...(step.operation !== undefined ? { operation: step.operation } : {}),
          ...(step.description !== undefined ? { description: step.description } : {}),
          critical: step.critical ?? false,
          ...(step.expectPattern !== undefined ? { expectPattern: step.expectPattern } : {}),
          ...(step.expectMinBytes !== undefined ? { expectMinBytes: step.expectMinBytes } : {}),
        }))
      : (profile?.safeProbes ?? [])
          .filter((p) => p.interface === iface && shouldRunProbe(p, 'STANDARD'))
          .map((p) => ({
            probeId: p.id,
            description: p.description,
            critical: false,
          })) as ExperimentDefinition['procedure'];

  for (const [index, step] of procedure.entries()) {
    if (!step.probeId && !step.operation) {
      errors.push(`procedure[${index}] must carry either a probeId or an inline operation.`);
    }
  }

  if (procedure.length === 0) {
    errors.push(
      'No procedure steps. Supply `procedure` — each step carries either an inline ' +
        '`operation` (no profile needed) or a `probeId` from a named `targetComponent`.'
    );
  }

  const definition: ExperimentDefinition = {
    ...(options.experimentId !== undefined ? { id: options.experimentId } : {}),
    objective: options.objective ?? '(none)',
    ...(options.targetComponent !== undefined ? { targetComponent: options.targetComponent } : {}),
    interface: iface,
    configuration: {
      interface: iface,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.address !== undefined ? { address: options.address } : {}),
      ...(options.frequencyHz !== undefined ? { frequencyHz: options.frequencyHz } : {}),
      ...(options.baud !== undefined ? { baud: options.baud } : {}),
      ...(options.mode !== undefined ? { spiMode: options.mode as 0 | 1 | 2 | 3 } : {}),
      pins: {
        ...(options.sda !== undefined ? { sda: options.sda } : {}),
        ...(options.scl !== undefined ? { scl: options.scl } : {}),
        ...(options.mosi !== undefined ? { mosi: options.mosi } : {}),
        ...(options.miso !== undefined ? { miso: options.miso } : {}),
        ...(options.sclk !== undefined ? { sclk: options.sclk } : {}),
        ...(options.cs !== undefined ? { cs: options.cs } : {}),
        ...(options.rx !== undefined ? { rx: options.rx } : {}),
        ...(options.tx !== undefined ? { tx: options.tx } : {}),
      },
    },
    ...(options.hypothesis !== undefined ? { hypothesis: options.hypothesis } : {}),
    ...(options.expectedResult !== undefined ? { expectedResult: options.expectedResult } : {}),
    procedure,
    ...(options.safetyConstraints !== undefined
      ? { safetyConstraints: options.safetyConstraints }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.telemetry !== undefined
      ? {
          telemetry: options.telemetry.map((t) => ({
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            required: t.required ?? false,
          })),
        }
      : {}),
    ...(options.repetitions !== undefined ? { repetitions: options.repetitions } : {}),
  };

  if (errors.length > 0) {
    return failedExperiment(definition, errors);
  }

  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });
  const pinCheck = pinChecksFor(session, options, iface);
  if (!pinCheck.ok) return failedExperiment(definition, pinCheck.errors);

  const ctx = buildProbeContext(session, options, profile);

  const report = await runExperiment(definition, {
    ...ctx,
    profile,
    family: session.family,
    operationDefaults: {
      i2c: {
        ...(options.controller !== undefined ? { controller: options.controller } : {}),
        ...(options.sda !== undefined ? { sda: options.sda } : {}),
        ...(options.scl !== undefined ? { scl: options.scl } : {}),
        ...(options.frequencyHz !== undefined ? { frequencyHz: options.frequencyHz } : {}),
      },
      spi: {
        ...(options.mosi !== undefined ? { mosi: options.mosi } : {}),
        ...(options.miso !== undefined ? { miso: options.miso } : {}),
        ...(options.sclk !== undefined ? { sclk: options.sclk } : {}),
        ...(options.cs !== undefined ? { cs: options.cs } : {}),
        ...(options.mode !== undefined ? { mode: options.mode as 0 | 1 | 2 | 3 } : {}),
        ...(options.clockHz !== undefined ? { clockHz: options.clockHz } : {}),
      },
      uart: {
        ...(options.rx !== undefined ? { rx: options.rx } : {}),
        ...(options.tx !== undefined ? { tx: options.tx } : {}),
        ...(options.baud !== undefined ? { baud: options.baud } : {}),
      },
    },
    reproducibility: session.reproducibility,
  });

  report.warnings.push(...experimentWarnings);
  return report;
}

function failedExperiment(
  definition: ExperimentDefinition,
  errors: string[]
): ExperimentReport {
  const now = timestamp();
  return {
    success: false,
    experimentId: definition.id ?? 'exp-rejected',
    objective: definition.objective,
    hypothesis: definition.hypothesis
      ? knownValue(definition.hypothesis, 'USER_SUPPLIED', 'Supplied with the experiment definition')
      : unknownValue<string>('No hypothesis was stated'),
    expectedResult: definition.expectedResult
      ? knownValue(definition.expectedResult, 'USER_SUPPLIED', 'Supplied with the experiment definition')
      : unknownValue<string>('No expected result was stated'),
    ...(definition.targetComponent !== undefined
      ? { targetComponent: definition.targetComponent }
      : {}),
    interface: definition.interface,
    configuration: definition.configuration,
    safetyConstraints: definition.safetyConstraints ?? [],
    phases: [
      {
        phase: 'PREPARE',
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        ok: false,
        detail: 'Experiment definition was rejected before any hardware access.',
        warnings: [],
        errors,
      },
    ],
    observations: [],
    telemetry: [],
    repetitions: 0,
    consistency: null,
    validation: {
      hypothesisSupported: null,
      detail: 'The experiment did not run, so nothing was tested.',
      confidence: 'UNKNOWN',
    },
    analysis: { findings: [], anomalies: [], capabilityImplications: [] },
    conclusion: 'Experiment rejected before execution.',
    confidence: 'UNKNOWN',
    reproducibility: buildReproducibility(definition.configuration),
    durationMs: 0,
    warnings: [],
    errors,
    error: errors[0],
  };
}
