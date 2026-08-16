/**
 * Evidence and confidence helpers.
 *
 * The single most important rule in this subsystem lives here: a datasheet claim
 * never becomes a verified capability. `confidenceForSources` caps confidence at
 * DOCUMENTED unless at least one physical observation backs the assertion.
 */

import {
  CONFIDENCE_RANK,
  PHYSICAL_EVIDENCE_SOURCES,
  type ConfidenceLevel,
  type Evidence,
  type EvidenceSource,
  type ObservedValue,
  type RawInterpretation,
} from '../types/hardware.js';

/** Current timestamp in ISO-8601, used across every report. */
export function timestamp(): string {
  return new Date().toISOString();
}

/** True when the source represents a measurement rather than a claim. */
export function isPhysicalSource(source: EvidenceSource): boolean {
  return PHYSICAL_EVIDENCE_SOURCES.includes(source);
}

/** Return the stronger of two confidence levels. */
export function maxConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

/** Return the weaker of two confidence levels. */
export function minConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/** Compare confidence levels: negative when `a` is weaker than `b`. */
export function compareConfidence(a: ConfidenceLevel, b: ConfidenceLevel): number {
  return CONFIDENCE_RANK[a] - CONFIDENCE_RANK[b];
}

/**
 * Derive an overall confidence from a set of evidence sources.
 *
 * Without a physical observation the result is capped at DOCUMENTED, no matter
 * how many paper sources agree. Agreement between documents is not measurement.
 */
export function confidenceForSources(sources: EvidenceSource[]): ConfidenceLevel {
  const distinct = Array.from(new Set(sources)).filter((s) => s !== 'NONE');
  if (distinct.length === 0) return 'UNKNOWN';

  const physical = distinct.filter(isPhysicalSource);
  const documented = distinct.some(
    (s) => s === 'DATASHEET' || s === 'COMPONENT_PROFILE' || s === 'ESP32_CATALOG'
  );

  if (physical.length === 0) {
    if (documented) return 'DOCUMENTED';
    if (distinct.includes('USER_SUPPLIED') || distinct.includes('SOFTWARE_INSPECTION')) {
      return 'LOW';
    }
    return distinct.includes('INFERENCE') ? 'LOW' : 'UNKNOWN';
  }

  if (physical.length >= 2 && documented) return 'CONFIRMED';
  if (physical.length >= 2 || documented) return 'HIGH';
  return 'MEDIUM';
}

/** Build an Evidence record. */
export function makeEvidence(
  source: EvidenceSource,
  description: string,
  extra: Partial<Omit<Evidence, 'source' | 'description'>> = {}
): Evidence {
  return {
    source,
    description,
    timestamp: extra.timestamp ?? timestamp(),
    confidence: extra.confidence ?? (isPhysicalSource(source) ? 'MEDIUM' : 'DOCUMENTED'),
    ...(extra.raw !== undefined ? { raw: extra.raw } : {}),
    ...(extra.reference !== undefined ? { reference: extra.reference } : {}),
    ...(extra.experimentId !== undefined ? { experimentId: extra.experimentId } : {}),
    ...(extra.testId !== undefined ? { testId: extra.testId } : {}),
  };
}

/** A value that is genuinely unknown. Preferred over guessing. */
export function unknownValue<T>(reason?: string): ObservedValue<T> {
  return {
    value: null,
    known: false,
    confidence: 'UNKNOWN',
    source: 'NONE',
    ...(reason ? { evidence: reason } : {}),
  };
}

/** A value backed by evidence. */
export function knownValue<T>(
  value: T,
  source: EvidenceSource,
  evidence?: string,
  confidence?: ConfidenceLevel,
  raw?: string
): ObservedValue<T> {
  return {
    value,
    known: true,
    confidence: confidence ?? confidenceForSources([source]),
    source,
    ...(evidence ? { evidence } : {}),
    ...(raw !== undefined ? { raw } : {}),
  };
}

/**
 * Return the first known value from the candidates, or UNKNOWN.
 * Used when several data sources may answer the same inventory question.
 */
export function firstKnown<T>(
  ...candidates: (ObservedValue<T> | undefined)[]
): ObservedValue<T> {
  for (const candidate of candidates) {
    if (candidate && candidate.known) return candidate;
  }
  return unknownValue<T>('No data source reported this value');
}

/** Pair a raw observation with its interpretation, retaining the raw text. */
export function rawInterpretation<T>(
  raw: string,
  parsed: T | null,
  interpretation: string,
  source: EvidenceSource,
  confidence?: ConfidenceLevel
): RawInterpretation<T> {
  return {
    raw,
    parsed,
    interpretation,
    confidence: confidence ?? confidenceForSources([source]),
    source,
    timestamp: timestamp(),
  };
}
