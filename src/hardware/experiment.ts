/**
 * Experiment orchestration.
 *
 * Drives the lifecycle:
 *
 *   PREPARE -> VERIFY CONFIGURATION -> EXECUTE -> OBSERVE -> CAPTURE
 *   -> VALIDATE -> ANALYSE -> REPEAT (if required) -> REPORT
 *
 * The output is a machine-readable artifact carrying everything needed to re-run
 * the experiment: hardware identity, firmware identity, MCP version, full
 * configuration, every raw capture and the derived analysis.
 */

import { randomUUID } from 'crypto';
import {
  type AnomalyRecord,
  type ComponentProfile,
  type ConfidenceLevel,
  type ConsistencyAnalysis,
  type ExperimentDefinition,
  type ExperimentObservation,
  type ExperimentPhase,
  type ExperimentPhaseRecord,
  type ExperimentReport,
  type HardwareTransport,
  type ObservedValue,
  type ProbeExecutionResult,
  type Esp32Family,
  type RawOperation,
  type ReproducibilityRecord,
  type SafeProbe,
} from '../types/hardware.js';
import { knownValue, timestamp, unknownValue } from './evidence.js';
import { matchBytePattern, mean, stdDev, toHex } from './patterns.js';
import { executeProbe, type ProbeContext } from './probe.js';
import { executeOperation, type OperationContext } from './operations.js';
import { findProbe } from './registry.js';

/** Version reported in reproducibility records. Kept in step with package.json. */
export const MCP_VERSION = '1.3.0';

/** Upper bound on repetitions, so a REPEAT phase cannot run unbounded. */
export const MAX_REPETITIONS = 50;

export interface ExperimentContext extends ProbeContext {
  profile?: ComponentProfile | null;
  /** Chip family, used to validate inline operations against real pin capability. */
  family?: Esp32Family;
  /** Default bus configuration applied to inline operations. */
  operationDefaults?: OperationContext['defaults'];
  /** Reproducibility facts gathered before the experiment started. */
  reproducibility?: Partial<ReproducibilityRecord>;
}

/**
 * A prepared step: either a profile probe or a caller-constructed operation.
 * The runner treats both identically once resolved.
 */
type ResolvedStep = {
  label: string;
  critical: boolean;
  expectPattern?: string;
  expectMinBytes?: number;
} & (
  | { kind: 'PROBE'; probe: SafeProbe | null }
  | { kind: 'OPERATION'; operation: RawOperation }
);

class PhaseRecorder {
  private readonly records: ExperimentPhaseRecord[] = [];

  begin(phase: ExperimentPhase): {
    ok: (detail: string, warnings?: string[]) => void;
    fail: (detail: string, errors: string[]) => void;
  } {
    const startedAt = new Date();
    const finish = (ok: boolean, detail: string, warnings: string[], errors: string[]) => {
      const completedAt = new Date();
      this.records.push({
        phase,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        ok,
        detail,
        warnings,
        errors,
      });
    };
    return {
      ok: (detail, warnings = []) => finish(true, detail, warnings, []),
      fail: (detail, errors) => finish(false, detail, [], errors),
    };
  }

  all(): ExperimentPhaseRecord[] {
    return this.records;
  }
}

/** Build a reproducibility record from whatever facts are available. */
export function buildReproducibility(
  configuration: Record<string, unknown>,
  partial: Partial<ReproducibilityRecord> = {},
  profile?: ComponentProfile | null
): ReproducibilityRecord {
  return {
    mcpVersion: MCP_VERSION,
    hardware: {
      port: partial.hardware?.port ?? unknownValue<string>('Port not recorded'),
      chip: partial.hardware?.chip ?? unknownValue<string>('Chip not identified'),
      chipRevision: partial.hardware?.chipRevision ?? unknownValue<string>('Revision not read'),
      mac: partial.hardware?.mac ?? unknownValue<string>('MAC not read'),
    },
    firmware: {
      agentVersion: partial.firmware?.agentVersion ?? unknownValue<string>('Agent version not read'),
      applicationName:
        partial.firmware?.applicationName ?? unknownValue<string>('Application name not read'),
      applicationVersion:
        partial.firmware?.applicationVersion ?? unknownValue<string>('Application version not read'),
    },
    configuration,
    ...(profile ? { profileId: profile.id, profileConfidence: profile.confidence } : {}),
    timestamp: timestamp(),
  };
}

/**
 * Query the agent for the identity facts that make an experiment reproducible.
 * Missing facts stay UNKNOWN rather than being invented.
 */
export async function captureReproducibilityFacts(
  transport: HardwareTransport
): Promise<Partial<ReproducibilityRecord>> {
  const descriptor = transport.describe();
  const port: ObservedValue<string> = descriptor.port
    ? knownValue(descriptor.port, 'TOOLCHAIN_REPORT', 'Transport descriptor')
    : unknownValue<string>('Transport reports no port');

  const info = await transport.request<Record<string, unknown>>('sys.info');
  if (!info.ok || !info.data) {
    return {
      hardware: {
        port,
        chip: unknownValue<string>('Agent did not answer sys.info'),
        chipRevision: unknownValue<string>('Agent did not answer sys.info'),
        mac: unknownValue<string>('Agent did not answer sys.info'),
      },
      firmware: {
        agentVersion: unknownValue<string>('Agent did not answer sys.info'),
        applicationName: unknownValue<string>('Agent did not answer sys.info'),
        applicationVersion: unknownValue<string>('Agent did not answer sys.info'),
      },
    };
  }

  const data = info.data;
  const str = (key: string): ObservedValue<string> =>
    typeof data[key] === 'string' && data[key] !== ''
      ? knownValue(data[key] as string, 'FIRMWARE_REPORT', `sys.info.${key}`, 'HIGH', info.raw)
      : unknownValue<string>(`sys.info did not report ${key}`);

  const revision =
    typeof data.revision === 'number'
      ? knownValue(String(data.revision), 'FIRMWARE_REPORT', 'sys.info.revision', 'HIGH', info.raw)
      : unknownValue<string>('sys.info did not report a chip revision');

  return {
    hardware: { port, chip: str('family'), chipRevision: revision, mac: str('mac') },
    firmware: {
      agentVersion: str('agentVersion'),
      applicationName: str('appName'),
      applicationVersion: str('appVersion'),
    },
  };
}

/** Consistency analysis across repeated observations of the same probe. */
export function analyseConsistency(responses: number[][]): ConsistencyAnalysis {
  if (responses.length === 0) {
    return {
      repetitions: 0,
      stable: false,
      distinctResponses: [],
      agreement: 0,
      note: 'No responses were captured, so consistency could not be assessed.',
    };
  }

  const counts = new Map<string, number>();
  for (const response of responses) {
    const key = toHex(response);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const distinct = Array.from(counts.entries())
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count);

  const agreement = distinct[0].count / responses.length;
  const stable = distinct.length === 1;

  return {
    repetitions: responses.length,
    stable,
    distinctResponses: distinct,
    agreement: Number(agreement.toFixed(4)),
    note: stable
      ? `All ${responses.length} repetitions returned an identical response.`
      : `${distinct.length} distinct responses across ${responses.length} repetitions ` +
        `(modal response seen ${distinct[0].count} time(s)). An unstable response may indicate ` +
        'marginal wiring, a busy device, or genuinely varying state.',
  };
}

function detectAnomalies(
  observations: ExperimentObservation[],
  consistency: ConsistencyAnalysis | null,
  probesById: Map<string, SafeProbe>
): AnomalyRecord[] {
  const anomalies: AnomalyRecord[] = [];

  if (consistency && consistency.repetitions > 1 && !consistency.stable) {
    anomalies.push({
      kind: 'UNSTABLE_RESPONSE',
      description: consistency.note,
      confidence: 'HIGH',
    });
  }

  const durations = observations.filter((o) => o.ok).map((o) => o.durationMs);
  const avg = mean(durations);
  const deviation = stdDev(durations);
  if (avg !== null && deviation !== null && deviation > 0) {
    for (const observation of observations) {
      if (!observation.ok) continue;
      if (Math.abs(observation.durationMs - avg) > 3 * deviation) {
        anomalies.push({
          kind: 'TIMING_OUTLIER',
          description:
            `Step ${observation.stepIndex} (${observation.probeId}) took ` +
            `${observation.durationMs} ms against a mean of ${avg.toFixed(1)} ms ` +
            `(σ ${deviation.toFixed(1)} ms).`,
          confidence: 'MEDIUM',
        });
      }
    }
  }

  for (const observation of observations) {
    if (!observation.ok || !observation.raw.parsed) continue;
    const probe = probesById.get(observation.probeId);
    if (!probe?.expect?.pattern) continue;
    const bytes = observation.raw.parsed;
    if (bytes.length === 0) continue;
    // A response arrived, but not the documented one — worth recording rather
    // than discarding, since it may be genuine undocumented behaviour.
    if (!matchBytePattern(bytes, probe.expect.pattern)) {
      anomalies.push({
        kind: 'UNDOCUMENTED_RESPONSE',
        description:
          `${probe.name} returned ${toHex(bytes)}, which does not match the documented ` +
          `pattern "${probe.expect.pattern}".`,
        raw: observation.raw.raw,
        confidence: 'MEDIUM',
      });
    }
  }

  return anomalies;
}

/**
 * Run an experiment through the full lifecycle.
 *
 * Never throws. A failure at any phase is recorded on that phase and the report
 * is still produced, because a failed experiment is a result.
 */
export async function runExperiment(
  definition: ExperimentDefinition,
  ctx: ExperimentContext
): Promise<ExperimentReport> {
  const experimentId = definition.id ?? `exp-${randomUUID()}`;
  const started = Date.now();
  const phases = new PhaseRecorder();
  const observations: ExperimentObservation[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  const repetitions = Math.min(Math.max(definition.repetitions ?? 1, 1), MAX_REPETITIONS);
  if ((definition.repetitions ?? 1) > MAX_REPETITIONS) {
    warnings.push(
      `Requested ${definition.repetitions} repetitions; capped at ${MAX_REPETITIONS}.`
    );
  }

  const safetyConstraints = [
    ...(definition.safetyConstraints ?? []),
    'Every pin used is named explicitly in the configuration — none is chosen implicitly.',
    'Operations are validated against this chip\'s real pin and peripheral capabilities.',
    'A successful operation is OBSERVED evidence; promotion to VERIFIED requires the result ' +
      'to match a stated expectation.',
  ];

  // --- PREPARE -----------------------------------------------------------
  const prepare = phases.begin('PREPARE');
  const profile = ctx.profile ?? null;
  const probesById = new Map<string, SafeProbe>();
  const resolvedSteps: ResolvedStep[] = [];

  for (const step of definition.procedure) {
    // An inline operation resolves without any profile; a probeId resolves
    // against one when it is present. Both are first-class.
    if (step.operation) {
      resolvedSteps.push({
        kind: 'OPERATION',
        operation: step.operation,
        label: step.description ?? step.operation.op,
        critical: step.critical ?? false,
        ...(step.expectPattern !== undefined ? { expectPattern: step.expectPattern } : {}),
        ...(step.expectMinBytes !== undefined ? { expectMinBytes: step.expectMinBytes } : {}),
      });
      continue;
    }

    const probe = step.probeId && profile ? findProbe(profile, step.probeId) : null;
    if (probe) probesById.set(probe.id, probe);
    resolvedSteps.push({
      kind: 'PROBE',
      probe,
      label: step.probeId ?? '(no probeId or operation)',
      critical: step.critical ?? false,
      ...(step.expectPattern !== undefined ? { expectPattern: step.expectPattern } : {}),
      ...(step.expectMinBytes !== undefined ? { expectMinBytes: step.expectMinBytes } : {}),
    });
  }

  const unresolved = resolvedSteps.filter((s) => s.kind === 'PROBE' && s.probe === null);
  const inlineCount = resolvedSteps.filter((s) => s.kind === 'OPERATION').length;

  if (definition.procedure.length === 0) {
    prepare.fail('Experiment procedure is empty.', ['No steps to execute']);
    errors.push('Experiment procedure is empty.');
  } else if (unresolved.length === definition.procedure.length) {
    // Only a hard failure when nothing at all is runnable. An experiment made of
    // inline operations never reaches this branch.
    prepare.fail(
      profile
        ? `None of the ${definition.procedure.length} step(s) named a probe present in profile ${profile.id}.`
        : 'No step could be resolved: each named a probeId, but no component profile was supplied.',
      [
        ...unresolved.map((s) => `Unresolved probe: ${s.label}`),
        'Supply an inline `operation` on each step to run it without a profile.',
      ]
    );
    errors.push(
      'No experiment step was runnable. Steps may name a profile probe, or carry an inline ' +
        'operation that needs no profile.'
    );
  } else {
    if (unresolved.length > 0) {
      warnings.push(
        `${unresolved.length} step(s) name probes absent from the profile and will be skipped: ` +
          unresolved.map((s) => s.label).join(', ')
      );
    }
    const resolvedCount = resolvedSteps.length - unresolved.length;
    prepare.ok(
      `Resolved ${resolvedCount}/${resolvedSteps.length} step(s)` +
        (inlineCount > 0 ? ` (${inlineCount} inline operation(s))` : '') +
        (profile ? ` against profile ${profile.id}.` : ' with no component profile.'),
      warnings
    );
  }

  // --- VERIFY CONFIGURATION ---------------------------------------------
  const verify = phases.begin('VERIFY_CONFIGURATION');
  const configIssues = verifyConfiguration(definition, ctx);
  if (configIssues.length > 0) {
    verify.fail('Configuration verification failed.', configIssues);
    errors.push(...configIssues);
  } else {
    const ping = await ctx.transport.request('sys.ping', {}, { timeoutMs: 3000 });
    if (ping.ok) {
      verify.ok('Configuration is complete and the interrogation agent responded to sys.ping.');
    } else {
      verify.fail('Interrogation agent did not respond.', [
        ping.error ?? 'sys.ping failed',
      ]);
      errors.push(`Interrogation agent unreachable: ${ping.error ?? 'sys.ping failed'}`);
    }
  }

  const reproducibility = buildReproducibility(
    { ...definition.configuration, repetitions },
    ctx.reproducibility ?? {},
    profile
  );

  const aborted = errors.length > 0;

  // --- EXECUTE / OBSERVE / CAPTURE --------------------------------------
  const execute = phases.begin('EXECUTE');
  if (aborted) {
    execute.fail('Skipped: preparation or configuration verification failed.', errors);
  } else {
    let executed = 0;
    let abort = false;

    for (let repetition = 1; repetition <= repetitions && !abort; repetition++) {
      for (let stepIndex = 0; stepIndex < resolvedSteps.length; stepIndex++) {
        const step = resolvedSteps[stepIndex];

        let ok: boolean;
        let raw: ExperimentObservation['raw'];
        let durationMs: number;
        let stepError: string | undefined;
        let bytes: number[];

        if (step.kind === 'PROBE') {
          if (!step.probe) continue;
          const result = await executeProbe(step.probe, ctx);
          ok = result.success;
          raw = result.raw;
          durationMs = result.durationMs;
          stepError = result.error;
          bytes = result.bytes;
        } else {
          // Inline operation: validated against the chip, executed as written.
          const outcome = await executeOperation(step.operation, {
            transport: ctx.transport,
            family: ctx.family ?? 'UNKNOWN',
            ...(ctx.operationDefaults !== undefined ? { defaults: ctx.operationDefaults } : {}),
            ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
          });
          ok = outcome.ok;
          raw = outcome.raw;
          durationMs = outcome.durationMs;
          stepError = outcome.error;
          bytes = outcome.bytes;
        }

        // A step-level expectation lets an inline operation carry a pass
        // criterion, exactly as a profile probe's `expect` does.
        if (ok && step.expectPattern !== undefined) {
          ok = matchBytePattern(bytes, step.expectPattern);
          if (!ok) {
            stepError = `Response ${toHex(bytes)} does not match "${step.expectPattern}"`;
          }
        }
        if (ok && step.expectMinBytes !== undefined && bytes.length < step.expectMinBytes) {
          ok = false;
          stepError = `Received ${bytes.length} byte(s); expected at least ${step.expectMinBytes}`;
        }

        executed++;
        observations.push({
          stepIndex,
          probeId: step.label,
          repetition,
          raw,
          durationMs,
          ok,
          ...(stepError !== undefined ? { error: stepError } : {}),
        });

        if (!ok && step.critical) {
          abort = true;
          errors.push(
            `Critical step ${stepIndex} (${step.label}) failed: ${stepError ?? 'no response'}`
          );
          break;
        }
      }
    }

    if (abort) {
      execute.fail(`Aborted after ${executed} probe execution(s) on a critical failure.`, errors);
    } else {
      execute.ok(`Executed ${executed} probe run(s) across ${repetitions} repetition(s).`);
    }
  }

  const observe = phases.begin('OBSERVE');
  const successful = observations.filter((o) => o.ok);
  observe.ok(
    `Recorded ${observations.length} observation(s); ${successful.length} returned data.`
  );

  const capture = phases.begin('CAPTURE');
  const telemetry = (definition.telemetry ?? []).map((requirement) => {
    const satisfied = successful.length > 0;
    return {
      name: requirement.name,
      satisfied,
      detail: satisfied
        ? `Raw captures are attached to ${successful.length} observation(s).`
        : 'No successful observation produced a capture.',
    };
  });
  const unmetRequired = telemetry.filter(
    (t, index) => !t.satisfied && (definition.telemetry ?? [])[index]?.required
  );
  if (unmetRequired.length > 0) {
    warnings.push(
      `Required telemetry not captured: ${unmetRequired.map((t) => t.name).join(', ')}`
    );
  }
  capture.ok(
    `Retained ${observations.length} raw capture(s). Raw data is preserved alongside every interpretation.`
  );

  // --- VALIDATE ----------------------------------------------------------
  const validate = phases.begin('VALIDATE');
  const validation = validateAgainstHypothesis(definition, observations, probesById);
  validate.ok(validation.detail);

  // --- ANALYSE / REPEAT --------------------------------------------------
  const analyse = phases.begin('ANALYSE');
  const consistency =
    repetitions > 1 && successful.length > 0
      ? analyseConsistency(successful.map((o) => o.raw.parsed ?? []))
      : null;
  const anomalies = detectAnomalies(observations, consistency, probesById);
  const findings = buildFindings(observations, consistency, definition);
  analyse.ok(
    `Derived ${findings.length} finding(s) and ${anomalies.length} anomaly record(s).`
  );

  const repeat = phases.begin('REPEAT');
  if (repetitions > 1) {
    repeat.ok(
      `Completed ${repetitions} repetitions; consistency agreement ${
        consistency ? consistency.agreement.toFixed(2) : 'n/a'
      }.`
    );
  } else {
    repeat.ok(
      'Single execution requested. A single measurement establishes the value at one ' +
        'moment, not its stability — request repetitions to assess that.'
    );
  }

  // --- REPORT ------------------------------------------------------------
  const report = phases.begin('REPORT');
  const confidence = deriveExperimentConfidence(observations, consistency, validation);
  report.ok('Experiment report assembled.');

  const conclusion = buildConclusion(definition, validation, successful.length, observations.length);

  return {
    success: errors.length === 0 && successful.length > 0,
    experimentId,
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
    safetyConstraints,
    phases: phases.all(),
    observations,
    telemetry,
    repetitions,
    consistency,
    validation,
    analysis: {
      findings,
      anomalies,
      capabilityImplications: buildCapabilityImplications(definition, validation, successful.length),
    },
    conclusion,
    confidence,
    reproducibility,
    durationMs: Date.now() - started,
    warnings,
    errors,
    ...(errors.length > 0 ? { error: errors[0] } : {}),
  };
}

function verifyConfiguration(
  definition: ExperimentDefinition,
  ctx: ExperimentContext
): string[] {
  const issues: string[] = [];
  const config = definition.configuration;

  if (config.interface !== definition.interface) {
    issues.push(
      `Configuration interface (${String(config.interface)}) does not match the declared ` +
        `experiment interface (${definition.interface}).`
    );
  }

  switch (definition.interface) {
    case 'I2C':
      if (config.address === undefined && ctx.address === undefined) {
        issues.push('I2C experiment requires an address in the configuration.');
      }
      break;
    case 'SPI':
      if (!ctx.spi?.cs && config.pins?.cs === undefined) {
        issues.push(
          'SPI experiment requires a chip-select pin. Refusing to drive an unspecified CS line.'
        );
      }
      break;
    case 'UART':
      if (!ctx.uart?.rx && config.pins?.rx === undefined) {
        issues.push('UART experiment requires an RX pin in the configuration.');
      }
      break;
    default:
      break;
  }

  return issues;
}

function validateAgainstHypothesis(
  definition: ExperimentDefinition,
  observations: ExperimentObservation[],
  probesById: Map<string, SafeProbe>
): ExperimentReport['validation'] {
  const successful = observations.filter((o) => o.ok);

  if (observations.length === 0) {
    return {
      hypothesisSupported: null,
      detail: 'No observation was recorded, so the hypothesis could not be evaluated.',
      confidence: 'UNKNOWN',
    };
  }

  if (successful.length === 0) {
    return {
      hypothesisSupported: false,
      detail:
        'Every observation failed to return data. This is evidence against the hypothesis, ' +
        'but it is equally consistent with a wiring or configuration fault.',
      confidence: 'LOW',
    };
  }

  // Where probes declare an expected pattern, use it as the objective criterion.
  const withExpectations = successful.filter((o) => probesById.get(o.probeId)?.expect?.pattern);
  if (withExpectations.length === 0) {
    return {
      hypothesisSupported: null,
      detail:
        `${successful.length} of ${observations.length} observation(s) returned data, but no ` +
        'executed probe declares an expected pattern, so pass/fail cannot be determined ' +
        'objectively. The raw captures are retained for manual interpretation.',
      confidence: 'LOW',
    };
  }

  const matches = withExpectations.filter((o) => {
    const pattern = probesById.get(o.probeId)!.expect!.pattern!;
    return matchBytePattern(o.raw.parsed ?? [], pattern);
  });

  const ratio = matches.length / withExpectations.length;
  if (ratio === 1) {
    return {
      hypothesisSupported: true,
      detail:
        `All ${withExpectations.length} observation(s) with a declared expectation matched it. ` +
        (definition.expectedResult
          ? `Stated expectation: ${definition.expectedResult}`
          : 'No expected result was stated in the definition.'),
      confidence: withExpectations.length > 1 ? 'HIGH' : 'MEDIUM',
    };
  }

  if (ratio === 0) {
    return {
      hypothesisSupported: false,
      detail: `None of the ${withExpectations.length} observation(s) matched the declared expectation.`,
      confidence: 'MEDIUM',
    };
  }

  return {
    hypothesisSupported: false,
    detail:
      `${matches.length} of ${withExpectations.length} observation(s) matched the declared ` +
      'expectation. A partial match is not support — it indicates an unstable or ' +
      'misconfigured setup.',
    confidence: 'LOW',
  };
}

function buildFindings(
  observations: ExperimentObservation[],
  consistency: ConsistencyAnalysis | null,
  definition: ExperimentDefinition
): string[] {
  const findings: string[] = [];
  const successful = observations.filter((o) => o.ok);

  findings.push(
    `${successful.length} of ${observations.length} probe execution(s) returned data over ` +
      `the ${definition.interface} interface.`
  );

  const durations = successful.map((o) => o.durationMs);
  const avg = mean(durations);
  if (avg !== null) {
    const deviation = stdDev(durations);
    findings.push(
      `Mean probe round-trip ${avg.toFixed(1)} ms` +
        (deviation !== null ? ` (σ ${deviation.toFixed(1)} ms).` : '.') +
        ' This is host-to-agent-to-device latency, not the device response time alone.'
    );
  }

  if (consistency) {
    findings.push(consistency.note);
  }

  const failures = observations.filter((o) => !o.ok);
  if (failures.length > 0) {
    const reasons = Array.from(new Set(failures.map((f) => f.error ?? 'no response')));
    findings.push(`Failure modes observed: ${reasons.join('; ')}`);
  }

  return findings;
}

function buildCapabilityImplications(
  definition: ExperimentDefinition,
  validation: ExperimentReport['validation'],
  successCount: number
): string[] {
  const implications: string[] = [];

  if (successCount === 0) {
    implications.push(
      'No capability may be marked OBSERVED from this experiment — nothing responded.'
    );
    return implications;
  }

  implications.push(
    `The ${definition.interface} interface may be marked OBSERVED: the device returned data ` +
      'over it.'
  );

  if (validation.hypothesisSupported === true) {
    implications.push(
      'Capabilities exercised by the matched probes may be marked VERIFIED for this unit at ' +
        'this point in time. That is not a claim about other units or other firmware.'
    );
  } else if (validation.hypothesisSupported === false) {
    implications.push(
      'No capability may be promoted to VERIFIED: the declared expectation was not met.'
    );
  } else {
    implications.push(
      'Capabilities may be marked OBSERVED but not VERIFIED: data was returned, but no ' +
        'objective pass criterion was available.'
    );
  }

  return implications;
}

function buildConclusion(
  definition: ExperimentDefinition,
  validation: ExperimentReport['validation'],
  successCount: number,
  totalCount: number
): string {
  if (totalCount === 0) {
    return `Experiment "${definition.objective}" produced no observations and is inconclusive.`;
  }
  if (successCount === 0) {
    return (
      `Experiment "${definition.objective}" recorded ${totalCount} attempt(s), none of which ` +
      'returned data. Inconclusive as to the hypothesis; check wiring and configuration first.'
    );
  }
  switch (validation.hypothesisSupported) {
    case true:
      return (
        `Experiment "${definition.objective}" completed with ${successCount}/${totalCount} ` +
        'successful observations and the declared expectation met. Result applies to this ' +
        'unit, this firmware and this configuration only.'
      );
    case false:
      return (
        `Experiment "${definition.objective}" completed with ${successCount}/${totalCount} ` +
        'successful observations but the declared expectation was not met.'
      );
    default:
      return (
        `Experiment "${definition.objective}" completed with ${successCount}/${totalCount} ` +
        'successful observations. No objective pass criterion was available, so the result is ' +
        'recorded as an observation rather than a verification.'
      );
  }
}

function deriveExperimentConfidence(
  observations: ExperimentObservation[],
  consistency: ConsistencyAnalysis | null,
  validation: ExperimentReport['validation']
): ConfidenceLevel {
  const successful = observations.filter((o) => o.ok).length;
  if (successful === 0) return 'UNKNOWN';
  if (validation.hypothesisSupported !== true) return 'LOW';
  if (consistency?.stable && consistency.repetitions >= 3) return 'CONFIRMED';
  if (successful >= 2) return 'HIGH';
  return 'MEDIUM';
}

/** Re-export so callers can build probe results without importing probe.ts directly. */
export type { ProbeExecutionResult };
