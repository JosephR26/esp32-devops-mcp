/**
 * Type definitions for the Hardware Interrogation subsystem.
 *
 * These types model the interrogation pipeline:
 *
 *   PHYSICAL TARGET -> ESP32 IDENTIFICATION -> INTERFACE DISCOVERY -> BUS DISCOVERY
 *   -> DEVICE DETECTION -> DEVICE FINGERPRINTING -> COMPONENT IDENTIFICATION
 *   -> REGISTER / PROTOCOL DISCOVERY -> CONFIGURATION INSPECTION
 *   -> CAPABILITY ENUMERATION -> SAFE FUNCTIONAL TESTING -> TELEMETRY CAPTURE
 *   -> PERFORMANCE CHARACTERISATION -> CAPABILITY MATRIX
 *   -> DOCUMENTED vs OBSERVED vs VERIFIED -> UNEXPLORED CAPABILITY ANALYSIS
 *
 * The central design rule: a claim sourced from a datasheet is never the same thing
 * as a claim sourced from a measurement. Every value carries its evidence.
 */

// ---------------------------------------------------------------------------
// Confidence and evidence
// ---------------------------------------------------------------------------

/**
 * Confidence in an assertion, ordered weakest to strongest.
 *
 * DOCUMENTED sits deliberately between LOW and MEDIUM: a datasheet claim is
 * stronger than a guess, but weaker than a corroborated physical observation.
 * A paper claim must never be reported as CONFIRMED.
 */
export type ConfidenceLevel =
  | 'UNKNOWN'
  | 'LOW'
  | 'DOCUMENTED'
  | 'MEDIUM'
  | 'HIGH'
  | 'CONFIRMED';

/** Numeric rank for comparing/ordering confidence levels. */
export const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  UNKNOWN: 0,
  LOW: 1,
  DOCUMENTED: 2,
  MEDIUM: 3,
  HIGH: 4,
  CONFIRMED: 5,
};

/** Where a piece of evidence came from. */
export type EvidenceSource =
  | 'DATASHEET'
  | 'COMPONENT_PROFILE'
  | 'ESP32_CATALOG'
  | 'DEVICE_RESPONSE'
  | 'BUS_SCAN'
  | 'REGISTER_READ'
  | 'PROTOCOL_SIGNATURE'
  | 'FIRMWARE_REPORT'
  | 'SOFTWARE_INSPECTION'
  | 'TOOLCHAIN_REPORT'
  | 'USER_SUPPLIED'
  | 'INFERENCE'
  | 'NONE';

/** Evidence sources that represent a physical measurement rather than a claim. */
export const PHYSICAL_EVIDENCE_SOURCES: readonly EvidenceSource[] = [
  'DEVICE_RESPONSE',
  'BUS_SCAN',
  'REGISTER_READ',
  'PROTOCOL_SIGNATURE',
  'FIRMWARE_REPORT',
];

/** A single, timestamped piece of evidence backing an assertion. */
export interface Evidence {
  source: EvidenceSource;
  description: string;
  /** Raw hardware response, preserved verbatim. Never discarded after parsing. */
  raw?: string;
  /** Datasheet section, profile id, or other citation. */
  reference?: string;
  timestamp: string;
  /** Set when the evidence came from a recorded experiment. */
  experimentId?: string;
  /** Set when the evidence came from a recorded functional test. */
  testId?: string;
  confidence: ConfidenceLevel;
}

/**
 * A value that may or may not be knowable.
 * `known: false` means UNKNOWN — the system reports UNKNOWN rather than guessing.
 */
export interface ObservedValue<T> {
  value: T | null;
  known: boolean;
  confidence: ConfidenceLevel;
  source: EvidenceSource;
  evidence?: string;
  /** Raw text the value was extracted from, where applicable. */
  raw?: string;
}

/**
 * Raw observation paired with its interpretation. Raw data is always retained so
 * a later analysis can re-interpret it without repeating the physical experiment.
 */
export interface RawInterpretation<TParsed = unknown> {
  raw: string;
  parsed: TParsed | null;
  interpretation: string;
  confidence: ConfidenceLevel;
  source: EvidenceSource;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Capability model
// ---------------------------------------------------------------------------

/**
 * Capability state. `status` (overall verdict) and `tier` (highest evidence level
 * reached) are both drawn from this union — see deriveCapabilityStatus /
 * deriveCapabilityTier for exactly which values each can take.
 */
export type CapabilityStatus =
  | 'DOCUMENTED'
  | 'INFERRED'
  | 'SOFTWARE_SUPPORTED'
  | 'FIRMWARE_EXPOSED'
  | 'OBSERVED'
  | 'TESTED'
  | 'VERIFIED'
  | 'UNTESTED'
  | 'UNKNOWN'
  | 'UNSUPPORTED';

/** Broad grouping used when presenting a capability matrix. */
export type CapabilityCategory =
  | 'INTERFACE'
  | 'PROTOCOL'
  | 'MODE'
  | 'FEATURE'
  | 'MEASUREMENT'
  | 'POWER'
  | 'DIAGNOSTIC'
  | 'OTHER';

/** The evidence flags that drive status/tier derivation. */
export interface CapabilityFlags {
  /** Asserted by a datasheet or component profile. */
  documented: boolean;
  /** Asserted only by inference from other evidence. */
  inferred?: boolean;
  /** A driver/library on the host or target is known to implement it. */
  softwareSupported: boolean;
  /** The firmware currently running on the target exposes it. */
  firmwareExposed: boolean;
  /** Some physical response consistent with the capability was seen. */
  observed: boolean;
  /** A functional test exercised it. */
  tested: boolean;
  /** A functional test exercised it AND the result matched expectations. */
  verified: boolean;
  /** Positively determined not to be supported. */
  unsupported?: boolean;
}

/** A single row of the capability matrix. */
export interface CapabilityRecord extends CapabilityFlags {
  name: string;
  category: CapabilityCategory;
  description?: string;
  /** Overall verdict. */
  status: CapabilityStatus;
  /** Highest evidence tier actually reached. */
  tier: CapabilityStatus;
  confidence: ConfidenceLevel;
  evidence: Evidence[];
  /** Distinct evidence sources contributing to this record. */
  source: EvidenceSource[];
  timestamp: string;
  /** Test id, when the capability was experimentally verified. */
  testId?: string;
  /** Related documentation references from the component profile. */
  reference?: string;
}

/** Classification of the difference between what is claimed and what is proven. */
export type CapabilityGapKind =
  /** Documented + software support exists, but firmware does not expose it. */
  | 'POTENTIAL_EXTENSION'
  /** Documented by hardware, but no software support known. */
  | 'SOFTWARE_GAP'
  /** Physically observed, but not present in any documentation we hold. */
  | 'UNDOCUMENTED_OBSERVATION'
  /** Claimed by documentation/firmware but never physically confirmed. */
  | 'UNVERIFIED_CLAIM'
  /** Documented and nothing else — no software, no firmware, no observation. */
  | 'UNEXPLORED';

export interface CapabilityGap {
  capability: string;
  kind: CapabilityGapKind;
  rationale: string;
  /** Explicitly NOT a verified capability — what this gap does and does not mean. */
  caveat: string;
  confidence: ConfidenceLevel;
  suggestedNextStep: string;
}

export interface CapabilityMatrix {
  target: string;
  componentId?: string;
  generatedAt: string;
  capabilities: CapabilityRecord[];
  gaps: CapabilityGap[];
  summary: {
    total: number;
    documented: number;
    softwareSupported: number;
    firmwareExposed: number;
    observed: number;
    tested: number;
    verified: number;
    unexplored: number;
    unsupported: number;
  };
}

// ---------------------------------------------------------------------------
// Interfaces, buses and pins
// ---------------------------------------------------------------------------

export type HardwareInterfaceKind =
  | 'I2C'
  | 'SPI'
  | 'UART'
  | 'GPIO'
  | 'ADC'
  | 'DAC'
  | 'PWM'
  | 'TOUCH'
  | 'I2S'
  | 'CAN'
  | 'USB'
  | 'WIFI'
  | 'BLUETOOTH'
  | 'UNKNOWN';

/**
 * Depth presets, ordered by how much investigation they perform by default.
 *
 * These are starting points, not ceilings. FORENSIC is the most thorough
 * preset — it is not the maximum possible investigation, and nothing prevents
 * further experiments after any depth completes. To go beyond a preset, name
 * additional probes or construct operations directly.
 */
export type InterrogationDepth = 'BASIC' | 'STANDARD' | 'DEEP' | 'FORENSIC';

export const INTERROGATION_DEPTHS: readonly InterrogationDepth[] = [
  'BASIC',
  'STANDARD',
  'DEEP',
  'FORENSIC',
];

export interface PinAssignment {
  signal: string;
  gpio: number | null;
  known: boolean;
  note?: string;
}

export interface DiscoveredInterface {
  kind: HardwareInterfaceKind;
  controller: string;
  available: ObservedValue<boolean>;
  pins: PinAssignment[];
  configuration: Record<string, unknown>;
  configuredPeripherals: string[];
  conflicts: string[];
  warnings: string[];
  confidence: ConfidenceLevel;
  source: EvidenceSource;
}

export interface InterfaceDiscoveryReport {
  success: boolean;
  target: string;
  chip: ObservedValue<string>;
  interfaces: DiscoveredInterface[];
  warnings: string[];
  /** Safety note: unknown GPIO are never driven automatically. */
  notes: string[];
  raw: RawInterpretation[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Bus scanning
// ---------------------------------------------------------------------------

/** Outcome for a single probed I2C address. */
export type I2CAddressState =
  | 'RESPONDS'
  | 'NO_RESPONSE'
  | 'BUS_ERROR'
  | 'UNSTABLE'
  | 'ADDRESS_CONFLICT'
  | 'RESERVED_SKIPPED';

export interface I2CAddressResult {
  address: number;
  hex: string;
  decimal: number;
  state: I2CAddressState;
  ack: boolean;
  /** Response time in milliseconds, when measurable. */
  responseTimeMs: ObservedValue<number>;
  /** How many of the repeated probes acknowledged. */
  ackCount: number;
  probeCount: number;
  errors: string[];
  /** Address-based guesses. Never treated as identification on their own. */
  possibleMatches: ComponentMatchHint[];
  confidence: ConfidenceLevel;
  /** Extra read-only fingerprint bytes, when a safe fingerprint probe ran. */
  fingerprint?: RawInterpretation<number[]>;
}

export interface ComponentMatchHint {
  componentId: string;
  partNumber: string;
  reason: string;
  confidence: ConfidenceLevel;
  /** True when the hint rests only on the bus address. */
  addressOnly: boolean;
}

export interface I2CScanReport {
  success: boolean;
  controller: string;
  sda: number | null;
  scl: number | null;
  frequencyHz: number;
  addressRange: { start: number; end: number };
  scanDurationMs: number;
  responding: I2CAddressResult[];
  results: I2CAddressResult[];
  busErrors: string[];
  errors: string[];
  warnings: string[];
  raw: RawInterpretation[];
  error?: string;
}

export type SpiBitOrder = 'MSB_FIRST' | 'LSB_FIRST';

export interface SpiProbeResult {
  probeId: string;
  description: string;
  mode: 0 | 1 | 2 | 3;
  clockHz: number;
  bitOrder: SpiBitOrder;
  tx: number[];
  rx: number[];
  rxHex: string;
  /** True when every received byte is 0x00 or every byte is 0xFF. */
  degenerate: boolean;
  repeated: boolean;
  durationMs: number;
  raw: RawInterpretation<number[]>;
}

export interface SpiDiscoveryReport {
  success: boolean;
  controller: string;
  pins: PinAssignment[];
  probes: SpiProbeResult[];
  patterns: string[];
  protocolSignatures: string[];
  identification: IdentificationReport | null;
  confidence: ConfidenceLevel;
  warnings: string[];
  errors: string[];
  raw: RawInterpretation[];
  error?: string;
}

export interface UartCapturePacket {
  offset: number;
  timestampMs: number;
  bytes: number[];
  hex: string;
  ascii: string | null;
  printable: boolean;
}

export interface UartDiscoveryReport {
  success: boolean;
  controller: string;
  pins: PinAssignment[];
  baud: number;
  dataBits: number;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
  flowControl: 'none' | 'rtscts';
  mode: 'PASSIVE' | 'ACTIVE';
  captureDurationMs: number;
  totalBytes: number;
  packets: UartCapturePacket[];
  hex: string;
  ascii: string | null;
  repeatedPatterns: { pattern: string; count: number }[];
  baudClues: string[];
  protocolCandidates: ComponentMatchHint[];
  confidence: ConfidenceLevel;
  warnings: string[];
  errors: string[];
  raw: RawInterpretation[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Component profiles
// ---------------------------------------------------------------------------

export interface DocumentationReference {
  title: string;
  section?: string;
  url?: string;
  note?: string;
}

export interface ComponentInterfaceDescriptor {
  kind: HardwareInterfaceKind;
  /** Fixed or selectable addresses, for addressable buses. */
  addresses?: number[];
  /** Default/typical bus speed in Hz. */
  defaultClockHz?: number;
  spiMode?: 0 | 1 | 2 | 3;
  defaultBaud?: number;
  signals?: string[];
  note?: string;
}

/** Byte-pattern matcher, e.g. "?? 32 01 06 07" where ?? is a wildcard byte. */
export type BytePattern = string;

export type IdentificationMatcher =
  | { kind: 'I2C_ADDRESS'; addresses: number[] }
  | { kind: 'PROBE_RESPONSE'; probeId: string; pattern: BytePattern }
  | { kind: 'REGISTER_VALUE'; register: number | string; pattern: BytePattern }
  | { kind: 'UART_PATTERN'; pattern: string; regex?: boolean }
  | { kind: 'MARKING'; patterns: string[] };

export interface IdentificationRule {
  id: string;
  description: string;
  /** Relative contribution to the identification score, 0..1. */
  weight: number;
  /**
   * When true, a definite mismatch disqualifies the profile outright.
   * Absence of the evidence does not disqualify — only contradiction does.
   */
  necessary?: boolean;
  match: IdentificationMatcher;
  reference?: string;
}

export interface RegisterField {
  name: string;
  bitOffset: number;
  bitWidth: number;
  description?: string;
  /** Human-readable meanings for specific field values. */
  enumerations?: Record<string, string>;
}

export interface RegisterDefinition {
  address: number | string;
  name: string;
  description?: string;
  /** Register width in bits. */
  width: number;
  access: 'R' | 'W' | 'RW';
  /** Documented reset/default value, when the datasheet specifies one. */
  resetValue?: number;
  fields: RegisterField[];
  reference?: string;
  /**
   * Whether reading the register is free of side effects.
   * Registers marked false are never read by automated inspection.
   */
  safeToRead: boolean;
  /** True when reading clears bits or otherwise mutates device state. */
  readHasSideEffects?: boolean;
  /**
   * Probe used to read this register, for parts whose registers are not
   * reachable by a plain addressed bus read (e.g. command-protocol devices).
   * When absent, a direct interface read of `address` is used.
   */
  readProbeId?: string;
  /** Byte offset of the register value within the probe response. */
  responseOffset?: number;
}

export interface ProtocolDescriptor {
  name: string;
  description?: string;
  /** Bytes/pattern that indicate this protocol is in use. */
  signatures?: BytePattern[];
  reference?: string;
}

export interface OperatingMode {
  name: string;
  description?: string;
  /** Register writes required to enter the mode, for documentation only. */
  entryNote?: string;
  reference?: string;
}

/** A capability as claimed by the component profile (documentation tier). */
export interface ProfileCapability {
  name: string;
  category: CapabilityCategory;
  description?: string;
  documented: boolean;
  /** Known host/target driver support, e.g. a widely used Arduino library. */
  softwareSupported?: boolean;
  /** Probe ids or test ids that can move this capability to OBSERVED/VERIFIED. */
  evidenceProbes?: string[];
  reference?: string;
}

export type ProbeOperation =
  | { op: 'I2C_READ'; address: number; register?: number; length: number }
  | {
      op: 'I2C_WRITE_READ';
      address: number;
      write: number[];
      readLength: number;
      delayMs?: number;
    }
  | {
      op: 'SPI_TRANSFER';
      tx: number[];
      readLength?: number;
      mode?: 0 | 1 | 2 | 3;
      clockHz?: number;
      bitOrder?: SpiBitOrder;
    }
  | { op: 'UART_LISTEN'; durationMs: number; baud?: number }
  | { op: 'UART_WRITE_READ'; write: number[]; readLength: number; timeoutMs: number }
  | { op: 'DELAY'; ms: number };

/**
 * A read-oriented probe declared by a component profile.
 *
 * A probe that emits bytes onto the bus must set `writes: true` and supply a
 * `writeJustification`, so a profile's declared operations are self-documenting.
 *
 * Profile probes are a curated, reusable set — they are not the only way to
 * reach the hardware. Arbitrary transactions, including register writes, go
 * through RawOperation via esp32_hardware_execute or esp32_register_inspect.
 */
export interface SafeProbe {
  id: string;
  name: string;
  description: string;
  interface: HardwareInterfaceKind;
  /** Why this probe is safe to run against an unidentified device. */
  justification: string;
  writes: boolean;
  writeJustification?: string;
  /** Whether the device returns to its prior state without action. */
  reversible: boolean;
  operations: ProbeOperation[];
  expect?: { pattern?: BytePattern; minBytes?: number };
  /** What information a successful run yields. */
  yields?: string[];
  /** Minimum interrogation depth at which this probe runs. */
  minDepth?: InterrogationDepth;
  reference?: string;
}

export interface FunctionalTestDefinition {
  id: string;
  name: string;
  /** Capability this test exercises — links results back to the matrix. */
  capability: string;
  objective: string;
  procedure: string[];
  expectedResult: string;
  probes: string[];
  /** Pattern the concatenated probe response must match to pass. */
  expectPattern?: BytePattern;
  /** Minimum number of response bytes required to pass. */
  expectMinBytes?: number;
  minDepth?: InterrogationDepth;
  reference?: string;
}

export type BenchmarkMetric =
  | 'RESPONSE_LATENCY'
  | 'TRANSACTION_TIME'
  | 'THROUGHPUT'
  | 'POLLING_RATE'
  | 'READ_CONSISTENCY'
  | 'ERROR_RATE'
  | 'STABILITY';

export interface BenchmarkDefinition {
  id: string;
  name: string;
  metric: BenchmarkMetric;
  probeId: string;
  /** Default repetition count; the caller may lower it, never silently raise it. */
  iterations: number;
  /** Documented figure from the datasheet, for measured-vs-documented comparison. */
  documentedValue?: number;
  unit: string;
  reference?: string;
}

export interface ComponentProfile {
  id: string;
  manufacturer: string;
  partNumber: string;
  aliases: string[];
  description: string;
  interfaces: ComponentInterfaceDescriptor[];
  identification: IdentificationRule[];
  registers: RegisterDefinition[];
  protocols: ProtocolDescriptor[];
  modes: OperatingMode[];
  capabilities: ProfileCapability[];
  safeProbes: SafeProbe[];
  functionalTests: FunctionalTestDefinition[];
  benchmarks: BenchmarkDefinition[];
  limitations: string[];
  documentation: DocumentationReference[];
  /** Confidence in the profile data itself (i.e. how well sourced it is). */
  confidence: ConfidenceLevel;
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

export interface IdentificationCandidate {
  componentId: string;
  partNumber: string;
  manufacturer: string;
  /** Normalised 0..1 score across matched identification rules. */
  score: number;
  confidence: ConfidenceLevel;
  matchedRules: { ruleId: string; description: string; weight: number }[];
  contradictedRules: { ruleId: string; description: string }[];
  evidence: Evidence[];
}

export interface IdentificationReport {
  success: boolean;
  /** Best candidate, or null when nothing scores above the reporting threshold. */
  identified: IdentificationCandidate | null;
  alternatives: IdentificationCandidate[];
  /** True when two or more candidates are within the ambiguity margin. */
  ambiguous: boolean;
  method: string[];
  confidence: ConfidenceLevel;
  evidence: Evidence[];
  raw: RawInterpretation[];
  notes: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Register inspection
// ---------------------------------------------------------------------------

export interface DecodedField {
  name: string;
  bitOffset: number;
  bitWidth: number;
  value: number;
  binary: string;
  meaning?: string;
  description?: string;
}

export interface RegisterInspectionResult {
  address: number | string;
  addressHex: string;
  name: string;
  description?: string;
  read: boolean;
  rawValue: ObservedValue<number>;
  rawBytes: string | null;
  hex: string | null;
  binary: string | null;
  fields: DecodedField[];
  resetValue: ObservedValue<number>;
  /** null when either the reset value or the current value is unknown. */
  changedFromReset: boolean | null;
  reference?: string;
  confidence: ConfidenceLevel;
  skipped?: string;
  error?: string;
}

/** Record of one explicit, caller-requested register write. */
export interface RegisterWriteRecord {
  register: number;
  registerHex: string;
  value: number[];
  valueHex: string;
  /** The caller's stated reason. Recorded verbatim, never validated. */
  justification?: string;
  /** Whether the device acknowledged the bytes on the bus. */
  acknowledged: boolean;
  busStatus: string;
  /** Value read immediately before the write, when it could be read. */
  valueBeforeHex: string | null;
  executed: boolean;
  error?: string;
  note: string;
}

export interface RegisterInspectionReport {
  success: boolean;
  componentId: string;
  partNumber: string;
  interface: HardwareInterfaceKind;
  address: number | null;
  /**
   * True when the call performed reads only. Writes happen only when the caller
   * explicitly supplies them, so this reports what occurred rather than
   * asserting a policy.
   */
  readOnly: boolean;
  registers: RegisterInspectionResult[];
  /** Writes performed, when the caller requested any. */
  writes?: RegisterWriteRecord[];
  /** Registers re-read after the writes, so the effect is observable. */
  registersAfterWrite?: RegisterInspectionResult[];
  skipped: { address: string; reason: string }[];
  warnings: string[];
  raw: RawInterpretation[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Probing, testing and benchmarking
// ---------------------------------------------------------------------------

export interface ProbeExecutionResult {
  probeId: string;
  name: string;
  executed: boolean;
  success: boolean;
  /** Reason the probe was not executed (depth gating, safety, missing config). */
  skippedReason?: string;
  writes: boolean;
  operations: {
    op: string;
    request: Record<string, unknown>;
    raw: string;
    bytes: number[];
    durationMs: number;
    ok: boolean;
    error?: string;
  }[];
  bytes: number[];
  hex: string;
  matchedExpectation: boolean | null;
  durationMs: number;
  raw: RawInterpretation<number[]>;
  error?: string;
}

export interface ComponentProbeReport {
  success: boolean;
  depth: InterrogationDepth;
  target: string;
  requestedComponent?: string;
  interface: HardwareInterfaceKind;
  address: number | null;
  identification: IdentificationReport | null;
  connectivity: {
    reachable: ObservedValue<boolean>;
    detail: string;
  };
  probes: ProbeExecutionResult[];
  registers: RegisterInspectionReport | null;
  capabilities: CapabilityMatrix | null;
  /** FORENSIC only: repeated-measurement consistency analysis. */
  consistency: ConsistencyAnalysis | null;
  /** FORENSIC only: responses that no profile rule accounts for. */
  anomalies: AnomalyRecord[];
  modes: OperatingMode[];
  protocols: ProtocolDescriptor[];
  /** Outcomes of caller-constructed operations run alongside the profile probes. */
  additionalOperations?: OperationOutcome[];
  timing: { operation: string; samples: number[]; meanMs: number; jitterMs: number }[];
  warnings: string[];
  errors: string[];
  raw: RawInterpretation[];
  reproducibility: ReproducibilityRecord;
  error?: string;
}

export interface ConsistencyAnalysis {
  repetitions: number;
  stable: boolean;
  /** Distinct responses seen, with how often each occurred. */
  distinctResponses: { hex: string; count: number }[];
  /** Fraction of repetitions returning the modal response. */
  agreement: number;
  note: string;
}

export interface AnomalyRecord {
  kind:
    | 'UNDOCUMENTED_RESPONSE'
    | 'UNSTABLE_RESPONSE'
    | 'UNEXPECTED_PATTERN'
    | 'TIMING_OUTLIER'
    | 'PROTOCOL_DEVIATION';
  description: string;
  raw?: string;
  confidence: ConfidenceLevel;
}

export interface FunctionalTestResult {
  testId: string;
  name: string;
  capability: string;
  objective: string;
  configuration: Record<string, unknown>;
  procedure: string[];
  expectedResult: string;
  observedResult: string;
  passed: boolean;
  executed: boolean;
  skippedReason?: string;
  evidence: Evidence[];
  confidence: ConfidenceLevel;
  durationMs: number;
  raw: RawInterpretation<number[]>[];
  error?: string;
}

export interface ComponentTestReport {
  success: boolean;
  componentId: string;
  partNumber: string;
  depth: InterrogationDepth;
  tests: FunctionalTestResult[];
  passed: number;
  failed: number;
  skipped: number;
  capabilities: CapabilityMatrix | null;
  reproducibility: ReproducibilityRecord;
  warnings: string[];
  error?: string;
}

export interface BenchmarkMeasurement {
  benchmarkId: string;
  name: string;
  metric: BenchmarkMetric;
  unit: string;
  iterations: number;
  successfulIterations: number;
  samples: number[];
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  stdDev: number | null;
  /** Errors observed / iterations attempted. */
  errorRate: number;
  /** Highest rate actually sustained during this run. Not a hardware limit. */
  measuredMaximum: ObservedValue<number>;
  /** Datasheet figure, when the profile supplies one. */
  documentedMaximum: ObservedValue<number>;
  /** Explicit statement of what the measurement does and does not establish. */
  interpretation: string;
  confidence: ConfidenceLevel;
  raw: RawInterpretation<number[]>[];
  error?: string;
}

export interface ComponentBenchmarkReport {
  success: boolean;
  componentId: string;
  partNumber: string;
  measurements: BenchmarkMeasurement[];
  reproducibility: ReproducibilityRecord;
  warnings: string[];
  notes: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

export type ExperimentPhase =
  | 'PREPARE'
  | 'VERIFY_CONFIGURATION'
  | 'EXECUTE'
  | 'OBSERVE'
  | 'CAPTURE'
  | 'VALIDATE'
  | 'ANALYSE'
  | 'REPEAT'
  | 'REPORT';

export const EXPERIMENT_PHASES: readonly ExperimentPhase[] = [
  'PREPARE',
  'VERIFY_CONFIGURATION',
  'EXECUTE',
  'OBSERVE',
  'CAPTURE',
  'VALIDATE',
  'ANALYSE',
  'REPEAT',
  'REPORT',
];

export interface ExperimentConfiguration {
  port?: string;
  interface: HardwareInterfaceKind;
  controller?: string;
  address?: number;
  pins?: Record<string, number>;
  frequencyHz?: number;
  baud?: number;
  spiMode?: 0 | 1 | 2 | 3;
  [key: string]: unknown;
}

export interface TelemetryRequirement {
  name: string;
  description?: string;
  required: boolean;
}

/**
 * One step of an experiment.
 *
 * A step is either a named probe from a component profile (the accelerated
 * path) or a raw operation constructed inline (the general path). Neither is
 * privileged: an experiment can mix them freely, and an experiment made
 * entirely of inline operations needs no profile at all.
 */
export interface ExperimentStep {
  /** Probe id from the component profile. Mutually exclusive with `operation`. */
  probeId?: string;
  /** Raw operation constructed by the caller. Needs no profile. */
  operation?: RawOperation;
  description?: string;
  /** Marks a step whose failure aborts the experiment. */
  critical?: boolean;
  /**
   * Byte pattern the response must match for this step to count as meeting its
   * expectation. Lets an inline operation carry a pass criterion the way a
   * profile probe does.
   */
  expectPattern?: BytePattern;
  expectMinBytes?: number;
}

export interface ExperimentDefinition {
  id?: string;
  objective: string;
  targetComponent?: string;
  interface: HardwareInterfaceKind;
  configuration: ExperimentConfiguration;
  hypothesis?: string;
  expectedResult?: string;
  procedure: ExperimentStep[];
  safetyConstraints?: string[];
  timeoutMs?: number;
  telemetry?: TelemetryRequirement[];
  /** Number of executions; >1 drives the REPEAT phase. */
  repetitions?: number;
}

export interface ExperimentPhaseRecord {
  phase: ExperimentPhase;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  detail: string;
  warnings: string[];
  errors: string[];
}

/** Everything needed to re-run an experiment and compare results. */
export interface ReproducibilityRecord {
  mcpVersion: string;
  hardware: {
    port: ObservedValue<string>;
    chip: ObservedValue<string>;
    chipRevision: ObservedValue<string>;
    mac: ObservedValue<string>;
  };
  firmware: {
    agentVersion: ObservedValue<string>;
    applicationName: ObservedValue<string>;
    applicationVersion: ObservedValue<string>;
  };
  configuration: Record<string, unknown>;
  profileId?: string;
  profileConfidence?: ConfidenceLevel;
  timestamp: string;
}

export interface ExperimentObservation {
  stepIndex: number;
  probeId: string;
  repetition: number;
  raw: RawInterpretation<number[]>;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface ExperimentReport {
  success: boolean;
  experimentId: string;
  objective: string;
  hypothesis: ObservedValue<string>;
  expectedResult: ObservedValue<string>;
  targetComponent?: string;
  interface: HardwareInterfaceKind;
  configuration: ExperimentConfiguration;
  safetyConstraints: string[];
  phases: ExperimentPhaseRecord[];
  observations: ExperimentObservation[];
  telemetry: { name: string; satisfied: boolean; detail: string }[];
  repetitions: number;
  consistency: ConsistencyAnalysis | null;
  validation: {
    hypothesisSupported: boolean | null;
    detail: string;
    confidence: ConfidenceLevel;
  };
  analysis: {
    findings: string[];
    anomalies: AnomalyRecord[];
    capabilityImplications: string[];
  };
  conclusion: string;
  confidence: ConfidenceLevel;
  reproducibility: ReproducibilityRecord;
  durationMs: number;
  warnings: string[];
  errors: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// ESP32 inventory
// ---------------------------------------------------------------------------

export type Esp32Family =
  | 'ESP32'
  | 'ESP32-S2'
  | 'ESP32-S3'
  | 'ESP32-C3'
  | 'ESP32-C6'
  | 'ESP32-H2'
  | 'ESP8266'
  | 'UNKNOWN';

/** Static, datasheet-sourced peripheral counts for an ESP32 family. */
export interface Esp32FamilySpec {
  family: Esp32Family;
  architecture: string;
  cores: number;
  maxCpuMHz: number;
  i2cControllers: number;
  spiControllers: number;
  /** SPI controllers actually usable by application code (host-attached). */
  usableSpiControllers: number;
  uartControllers: number;
  hardwareTimers: number;
  adcChannels: number;
  dacChannels: number;
  touchChannels: number;
  pwmChannels: number;
  gpioCount: number;
  wifi: boolean;
  bluetooth: string | null;
  psramCapable: boolean;
  note?: string;
}

export interface HardwareInventoryReport {
  success: boolean;
  port: ObservedValue<string>;
  /** Which data sources actually answered. */
  sources: { name: string; available: boolean; detail: string }[];
  chip: {
    family: ObservedValue<Esp32Family>;
    model: ObservedValue<string>;
    revision: ObservedValue<string>;
    architecture: ObservedValue<string>;
    cores: ObservedValue<number>;
    cpuFrequencyMHz: ObservedValue<number>;
    flashSizeBytes: ObservedValue<number>;
    psramBytes: ObservedValue<number>;
    macAddress: ObservedValue<string>;
    features: ObservedValue<string[]>;
    resetReason: ObservedValue<string>;
    bootInfo: ObservedValue<string>;
  };
  firmware: {
    applicationName: ObservedValue<string>;
    applicationVersion: ObservedValue<string>;
    buildInfo: ObservedValue<string>;
    sdkVersion: ObservedValue<string>;
    framework: ObservedValue<string>;
    agentVersion: ObservedValue<string>;
  };
  toolchain: {
    platformioEnvironment: ObservedValue<string>;
    platformioBoard: ObservedValue<string>;
  };
  serial: {
    port: ObservedValue<string>;
    description: ObservedValue<string>;
    usbBridge: ObservedValue<string>;
  };
  peripherals: {
    gpio: ObservedValue<number>;
    adcChannels: ObservedValue<number>;
    dacChannels: ObservedValue<number>;
    pwmChannels: ObservedValue<number>;
    touchChannels: ObservedValue<number>;
    hardwareTimers: ObservedValue<number>;
    i2cControllers: ObservedValue<number>;
    spiControllers: ObservedValue<number>;
    uartControllers: ObservedValue<number>;
    wifi: ObservedValue<boolean>;
    bluetooth: ObservedValue<string>;
  };
  capabilities: CapabilityMatrix;
  raw: RawInterpretation[];
  warnings: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type TransportErrorKind =
  | 'NO_TRANSPORT'
  | 'PORT_UNAVAILABLE'
  | 'AGENT_NOT_PRESENT'
  | 'TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'BUS_ERROR'
  | 'UNSUPPORTED_OPERATION'
  | 'DEVICE_ERROR'
  | 'INTERNAL';

export interface TransportResult<T = unknown> {
  ok: boolean;
  op: string;
  data: T | null;
  /** Raw response text, always preserved even when parsing fails. */
  raw: string;
  error?: string;
  errorKind?: TransportErrorKind;
  durationMs: number;
  timestamp: string;
}

export interface TransportDescriptor {
  kind: string;
  port: string | null;
  baud: number;
  detail: string;
}

export interface HardwareTransport {
  request<T = unknown>(
    op: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<TransportResult<T>>;
  describe(): TransportDescriptor;
}

// ---------------------------------------------------------------------------
// Generic raw operations
// ---------------------------------------------------------------------------

/**
 * Arbitrary hardware operations, constructed by the caller at call time.
 *
 * These are the general-purpose primitives: the ESP32 as a physical instrument.
 * Nothing here references a component profile, a probe definition, or a known
 * command set. An operation is permitted when the requested configuration is
 * physically valid on this chip — not when someone anticipated it.
 *
 * Validation is against silicon capability (pin exists, pin can drive, clock in
 * range, peripheral available), never against a catalogue of expected devices.
 */
export type RawOperation =
  // --- I2C ---------------------------------------------------------------
  | {
      op: 'I2C_SCAN';
      bus?: I2CBusSpec;
      startAddress?: number;
      endAddress?: number;
      repeats?: number;
    }
  | { op: 'I2C_READ'; bus?: I2CBusSpec; address: number; register?: number; length: number }
  /** Write arbitrary bytes with no read phase. Includes register writes. */
  | { op: 'I2C_WRITE'; bus?: I2CBusSpec; address: number; write: number[] }
  | {
      op: 'I2C_WRITE_READ';
      bus?: I2CBusSpec;
      address: number;
      write: number[];
      readLength: number;
      /** Delay between the write and the read phase. */
      delayMs?: number;
      /** Emit a repeated START instead of a STOP between phases. */
      repeatedStart?: boolean;
    }
  // --- SPI ---------------------------------------------------------------
  | {
      op: 'SPI_TRANSFER';
      bus?: SpiBusSpec;
      /** Arbitrary bytes clocked out. Any value is permitted. */
      tx: number[];
      /** Extra bytes to clock in after tx, using `padByte` as filler. */
      readLength?: number;
      padByte?: number;
      /** Hold CS asserted across the whole transfer (default true). */
      keepCsAsserted?: boolean;
    }
  // --- UART --------------------------------------------------------------
  | { op: 'UART_WRITE'; bus?: UartBusSpec; write: number[] }
  | { op: 'UART_READ'; bus?: UartBusSpec; durationMs: number; maxBytes?: number }
  | {
      op: 'UART_WRITE_READ';
      bus?: UartBusSpec;
      write: number[];
      readLength: number;
      timeoutMs: number;
    }
  // --- GPIO --------------------------------------------------------------
  | { op: 'GPIO_CONFIGURE'; pin: number; mode: GpioMode }
  | { op: 'GPIO_READ'; pins: number[] }
  /** Drive a pin. Requires an output-capable pin; the caller names it explicitly. */
  | { op: 'GPIO_WRITE'; pin: number; level: 0 | 1 }
  | { op: 'GPIO_PULSE'; pin: number; level: 0 | 1; durationUs: number; returnToLevel?: 0 | 1 }
  | {
      op: 'GPIO_SAMPLE';
      pins: number[];
      samples: number;
      intervalUs?: number;
    }
  /** Measure the width of a single pulse, like Arduino pulseIn. */
  | { op: 'GPIO_MEASURE_PULSE'; pin: number; level: 0 | 1; timeoutUs?: number }
  /** Count edges over a window and derive frequency. */
  | { op: 'GPIO_MEASURE_FREQUENCY'; pin: number; windowMs: number; edge?: GpioEdge }
  /** Block until an edge occurs, reporting how long it took. */
  | { op: 'GPIO_WAIT_EDGE'; pin: number; edge: GpioEdge; timeoutMs: number }
  // --- ADC ---------------------------------------------------------------
  | {
      op: 'ADC_READ';
      pin: number;
      samples?: number;
      intervalUs?: number;
      /** Attenuation selects the input range; family-dependent. */
      attenuationDb?: 0 | 2.5 | 6 | 11;
    }
  // --- PWM / stimulus ----------------------------------------------------
  | {
      op: 'PWM_START';
      pin: number;
      frequencyHz: number;
      /** Duty as a fraction of the resolution's full scale, 0..1. */
      duty: number;
      resolutionBits?: number;
      /** Stop automatically after this long. Omit to leave it running. */
      durationMs?: number;
    }
  | { op: 'PWM_STOP'; pin: number }
  // --- Multi-signal ------------------------------------------------------
  /**
   * Drive a stimulus on one pin while sampling others, so cause and effect are
   * captured on the same timebase. Correlation across signals is often the only
   * way a component's behaviour becomes visible.
   */
  | {
      op: 'STIMULUS_CAPTURE';
      stimulus: {
        pin: number;
        kind: 'PULSE' | 'TOGGLE' | 'LEVEL';
        level?: 0 | 1;
        durationUs?: number;
        cycles?: number;
      };
      capturePins: number[];
      samples: number;
      intervalUs?: number;
    }
  // --- Control -----------------------------------------------------------
  | { op: 'DELAY'; ms: number };

export type GpioMode =
  | 'INPUT'
  | 'INPUT_PULLUP'
  | 'INPUT_PULLDOWN'
  | 'OUTPUT'
  | 'OUTPUT_OPEN_DRAIN';

export type GpioEdge = 'RISING' | 'FALLING' | 'CHANGE';

/** Bus configuration supplied per operation, so a sequence can switch buses. */
export interface I2CBusSpec {
  controller?: number;
  sda?: number;
  scl?: number;
  frequencyHz?: number;
}

export interface SpiBusSpec {
  controller?: number;
  mosi?: number;
  miso?: number;
  sclk?: number;
  cs?: number;
  mode?: 0 | 1 | 2 | 3;
  clockHz?: number;
  bitOrder?: SpiBitOrder;
}

export interface UartBusSpec {
  controller?: number;
  tx?: number;
  rx?: number;
  baud?: number;
  dataBits?: 5 | 6 | 7 | 8;
  parity?: 'none' | 'even' | 'odd';
  stopBits?: 1 | 2;
}

/** Why an operation was refused. Every value is a physical/config fact. */
export type OperationRejectionKind =
  | 'PIN_DOES_NOT_EXIST'
  | 'PIN_RESERVED'
  | 'PIN_NOT_OUTPUT_CAPABLE'
  | 'PIN_NOT_ADC_CAPABLE'
  | 'PIN_LACKS_PERIPHERAL'
  | 'PIN_CONFLICT'
  | 'PARAMETER_OUT_OF_RANGE'
  | 'MALFORMED_ARGUMENTS'
  | 'PERIPHERAL_UNAVAILABLE'
  | 'UNSUPPORTED_BY_AGENT';

export interface OperationRejection {
  kind: OperationRejectionKind;
  detail: string;
  /** What would make the operation valid, when that is knowable. */
  remedy?: string;
}

/** Result of one raw operation, with the raw capture always retained. */
export interface OperationOutcome {
  index: number;
  op: RawOperation['op'];
  /** Exactly what was requested, echoed for reproducibility. */
  request: RawOperation;
  /** Parameters actually sent to the agent. */
  agentRequest: { op: string; params: Record<string, unknown> } | null;
  executed: boolean;
  ok: boolean;
  /** Populated when the operation was refused before execution. */
  rejections: OperationRejection[];
  /** Bytes received, when the operation reads bytes. */
  bytes: number[];
  hex: string;
  ascii: string | null;
  /** Numeric samples, for ADC/GPIO sampling and timing operations. */
  samples: number[];
  /** Derived statistics over `samples`. Interpretation, not primary evidence. */
  statistics: {
    count: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    median: number | null;
    stdDev: number | null;
  } | null;
  /** Operation-specific structured data straight from the agent. */
  data: Record<string, unknown> | null;
  durationMs: number;
  warnings: string[];
  error?: string;
  errorKind?: TransportErrorKind;
  /** Primary evidence: the verbatim agent response. */
  raw: RawInterpretation<number[]>;
  timestamp: string;
}

/** A named sequence of raw operations plus the pins it touches. */
export interface OperationSequenceResult {
  success: boolean;
  operations: OperationOutcome[];
  executed: number;
  rejected: number;
  failed: number;
  /** Pins the sequence used, and in what role. */
  pinUsage: { gpio: number; roles: string[]; conflict: boolean }[];
  warnings: string[];
  errors: string[];
  durationMs: number;
  reproducibility: ReproducibilityRecord;
  /**
   * Evidence tier for a successful raw operation. Always OBSERVED — executing a
   * caller-constructed operation shows what the device did, it does not verify
   * what the device is.
   */
  evidenceTier: 'OBSERVED' | 'UNKNOWN';
  notes: string[];
  error?: string;
}

/** Per-pin capability and current allocation, for experiment planning. */
export interface PinReport {
  gpio: number;
  usable: boolean;
  unusableReason?: string;
  digitalInput: boolean;
  digitalOutput: boolean;
  pwm: boolean;
  adc: boolean;
  dac: boolean;
  touch: boolean;
  matrixRoutable: boolean;
  notes: string[];
  /** Roles the running firmware currently reports for this pin. */
  currentAllocation: string[];
}

export interface PinCapabilityReport {
  success: boolean;
  chip: ObservedValue<Esp32Family>;
  pins: PinReport[];
  summary: {
    total: number;
    usable: number;
    reserved: number;
    outputCapable: number;
    adcCapable: number;
    dacCapable: number;
    touchCapable: number;
  };
  /** Peripheral counts from the datasheet — DOCUMENTED, not measured. */
  peripherals: Record<string, ObservedValue<number | boolean | string>>;
  /** Capabilities the agent firmware does not implement, stated explicitly. */
  unavailable: { capability: string; reason: string }[];
  warnings: string[];
  notes: string[];
  raw: RawInterpretation[];
  error?: string;
}
