/**
 * Capability model, capability matrix construction, and capability gap analysis.
 *
 * The distinction this module enforces:
 *
 *   DOCUMENTED         a datasheet says the part can do it
 *   SOFTWARE_SUPPORTED a driver exists that implements it
 *   FIRMWARE_EXPOSED   the firmware currently on the target offers it
 *   OBSERVED           we saw a physical response consistent with it
 *   TESTED             we ran a functional test against it
 *   VERIFIED           we ran a functional test and it behaved as expected
 *
 * These are not synonyms and are never collapsed. A capability that is
 * DOCUMENTED and SOFTWARE_SUPPORTED but not observed is UNTESTED, and the gap
 * analysis reports it as a POTENTIAL EXTENSION — never as a verified capability.
 */

import {
  type CapabilityCategory,
  type CapabilityFlags,
  type CapabilityGap,
  type CapabilityGapKind,
  type CapabilityMatrix,
  type CapabilityRecord,
  type CapabilityStatus,
  type ConfidenceLevel,
  type Evidence,
  type EvidenceSource,
} from '../types/hardware.js';
import { confidenceForSources, maxConfidence, timestamp } from './evidence.js';

/**
 * Overall verdict for a capability.
 *
 * Note the deliberate treatment of the paper tiers: documentation, software
 * support and firmware exposure are all claims. Until something is physically
 * observed the verdict is UNTESTED, regardless of how many claims agree.
 */
export function deriveCapabilityStatus(flags: CapabilityFlags): CapabilityStatus {
  if (flags.unsupported) return 'UNSUPPORTED';
  if (flags.verified) return 'VERIFIED';
  if (flags.tested) return 'TESTED';
  if (flags.observed) return 'OBSERVED';
  if (flags.documented || flags.softwareSupported || flags.firmwareExposed) return 'UNTESTED';
  if (flags.inferred) return 'INFERRED';
  return 'UNKNOWN';
}

/**
 * Highest evidence tier actually reached, which is a different question from the
 * overall verdict: `status` answers "how far along is this?", `tier` answers
 * "what is the strongest thing we can say?".
 */
export function deriveCapabilityTier(flags: CapabilityFlags): CapabilityStatus {
  if (flags.verified) return 'VERIFIED';
  if (flags.tested) return 'TESTED';
  if (flags.observed) return 'OBSERVED';
  if (flags.firmwareExposed) return 'FIRMWARE_EXPOSED';
  if (flags.softwareSupported) return 'SOFTWARE_SUPPORTED';
  if (flags.documented) return 'DOCUMENTED';
  if (flags.inferred) return 'INFERRED';
  return 'UNKNOWN';
}

export interface CapabilityInput extends Partial<CapabilityFlags> {
  name: string;
  category?: CapabilityCategory;
  description?: string;
  evidence?: Evidence[];
  reference?: string;
  testId?: string;
  /** Override the derived confidence. Used sparingly; the derivation is safer. */
  confidence?: ConfidenceLevel;
}

/** Build a fully-derived capability record from partial flags. */
export function makeCapability(input: CapabilityInput): CapabilityRecord {
  const flags: CapabilityFlags = {
    documented: input.documented ?? false,
    inferred: input.inferred ?? false,
    softwareSupported: input.softwareSupported ?? false,
    firmwareExposed: input.firmwareExposed ?? false,
    observed: input.observed ?? false,
    tested: input.tested ?? false,
    verified: input.verified ?? false,
    unsupported: input.unsupported ?? false,
  };

  const evidence = input.evidence ?? [];
  const sources = Array.from(new Set(evidence.map((e) => e.source)));
  const derived = confidenceForSources(sources);

  return {
    name: input.name,
    category: input.category ?? 'FEATURE',
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...flags,
    status: deriveCapabilityStatus(flags),
    tier: deriveCapabilityTier(flags),
    confidence: input.confidence ?? derived,
    evidence,
    source: sources,
    timestamp: timestamp(),
    ...(input.testId !== undefined ? { testId: input.testId } : {}),
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
  };
}

/**
 * Merge two records for the same capability, taking the union of the evidence.
 * Flags are OR-ed: evidence only ever accumulates, it is never withdrawn here.
 */
export function mergeCapability(
  base: CapabilityRecord,
  update: Partial<CapabilityFlags> & {
    evidence?: Evidence[];
    testId?: string;
    description?: string;
  }
): CapabilityRecord {
  const evidence = [...base.evidence, ...(update.evidence ?? [])];
  const flags: CapabilityFlags = {
    documented: base.documented || (update.documented ?? false),
    inferred: (base.inferred ?? false) || (update.inferred ?? false),
    softwareSupported: base.softwareSupported || (update.softwareSupported ?? false),
    firmwareExposed: base.firmwareExposed || (update.firmwareExposed ?? false),
    observed: base.observed || (update.observed ?? false),
    tested: base.tested || (update.tested ?? false),
    verified: base.verified || (update.verified ?? false),
    // An explicit UNSUPPORTED finding is only cleared by positive observation.
    unsupported:
      ((base.unsupported ?? false) || (update.unsupported ?? false)) &&
      !(base.observed || (update.observed ?? false)),
  };
  const sources = Array.from(new Set(evidence.map((e) => e.source)));

  return {
    ...base,
    ...flags,
    description: update.description ?? base.description,
    status: deriveCapabilityStatus(flags),
    tier: deriveCapabilityTier(flags),
    confidence: confidenceForSources(sources),
    evidence,
    source: sources,
    timestamp: timestamp(),
    testId: update.testId ?? base.testId,
  };
}

/**
 * Capability gap analysis.
 *
 * This is the analysis that keeps the system honest: it names exactly what is
 * claimed, what is proven, and what the difference implies — without letting a
 * claim masquerade as a result.
 */
export function analyseCapabilityGaps(capabilities: CapabilityRecord[]): CapabilityGap[] {
  const gaps: CapabilityGap[] = [];

  for (const cap of capabilities) {
    if (cap.unsupported) continue;

    const physicallyEstablished = cap.observed || cap.tested || cap.verified;

    // OBSERVED + NOT DOCUMENTED -> undocumented observation.
    if (physicallyEstablished && !cap.documented) {
      gaps.push({
        capability: cap.name,
        kind: 'UNDOCUMENTED_OBSERVATION',
        rationale:
          'A physical response consistent with this capability was recorded, but no ' +
          'documentation held by this system describes it.',
        caveat:
          'An undocumented observation is not a specification. The behaviour may be ' +
          'incidental, version-specific, or a misreading of the response.',
        confidence: cap.verified ? 'HIGH' : 'MEDIUM',
        suggestedNextStep:
          'Repeat the observation across power cycles and, where possible, a second ' +
          'physical unit before relying on it.',
      });
      continue;
    }

    if (!cap.documented) continue;

    // DOCUMENTED + NOT SUPPORTED BY SOFTWARE -> software gap.
    if (!cap.softwareSupported) {
      gaps.push({
        capability: cap.name,
        kind: 'SOFTWARE_GAP',
        rationale:
          'Documented by the component, but no software support is known to this system.',
        caveat:
          'This describes tooling availability only. It says nothing about whether the ' +
          'hardware actually performs the capability.',
        confidence: 'DOCUMENTED',
        suggestedNextStep:
          'Identify or write a driver, then re-run interrogation to move this from ' +
          'DOCUMENTED to OBSERVED.',
      });
      continue;
    }

    // DOCUMENTED + SOFTWARE SUPPORT + NOT EXPOSED BY FIRMWARE -> potential extension.
    if (!cap.firmwareExposed) {
      gaps.push({
        capability: cap.name,
        kind: 'POTENTIAL_EXTENSION',
        rationale:
          'Documented by the hardware and supported by available software, but the ' +
          'firmware currently on the target does not expose it.',
        caveat:
          'POTENTIAL EXTENSION is not a verified capability. Nothing here has been ' +
          'physically demonstrated on this unit.',
        confidence: 'DOCUMENTED',
        suggestedNextStep:
          'Add firmware exposure, then verify experimentally before treating it as real.',
      });
      continue;
    }

    // DOCUMENTED + FIRMWARE EXPOSED + never physically confirmed.
    if (!physicallyEstablished) {
      gaps.push({
        capability: cap.name,
        kind: 'UNVERIFIED_CLAIM',
        rationale:
          'Both documentation and the running firmware claim this capability, but no ' +
          'measurement on this unit has confirmed it.',
        caveat: 'Two claims agreeing is still zero measurements.',
        confidence: 'DOCUMENTED',
        suggestedNextStep: 'Run esp32_component_test against this capability.',
      });
    }
  }

  // Anything documented with no other tier at all is simply unexplored.
  for (const cap of capabilities) {
    if (
      cap.documented &&
      !cap.softwareSupported &&
      !cap.firmwareExposed &&
      !cap.observed &&
      !cap.tested &&
      !cap.verified &&
      !cap.unsupported &&
      !gaps.some((g) => g.capability === cap.name && g.kind === 'UNEXPLORED')
    ) {
      gaps.push({
        capability: cap.name,
        kind: 'UNEXPLORED',
        rationale:
          'Documented by the component profile and untouched by every other tier of ' +
          'evidence — no software, no firmware exposure, no observation.',
        caveat: 'Unexplored means unknown, not unsupported.',
        confidence: 'DOCUMENTED',
        suggestedNextStep:
          'Select a deeper interrogation depth, or add a safe probe to the profile.',
      });
    }
  }

  return gaps;
}

/** Assemble a complete capability matrix with derived summary counts. */
export function buildCapabilityMatrix(
  target: string,
  capabilities: CapabilityRecord[],
  componentId?: string
): CapabilityMatrix {
  const gaps = analyseCapabilityGaps(capabilities);

  return {
    target,
    ...(componentId !== undefined ? { componentId } : {}),
    generatedAt: timestamp(),
    capabilities,
    gaps,
    summary: {
      total: capabilities.length,
      documented: capabilities.filter((c) => c.documented).length,
      softwareSupported: capabilities.filter((c) => c.softwareSupported).length,
      firmwareExposed: capabilities.filter((c) => c.firmwareExposed).length,
      observed: capabilities.filter((c) => c.observed).length,
      tested: capabilities.filter((c) => c.tested).length,
      verified: capabilities.filter((c) => c.verified).length,
      unexplored: gaps.filter((g) => g.kind === 'UNEXPLORED').length,
      unsupported: capabilities.filter((c) => c.unsupported).length,
    },
  };
}

/** Collapse duplicate capability names, merging their evidence. */
export function dedupeCapabilities(records: CapabilityRecord[]): CapabilityRecord[] {
  const byName = new Map<string, CapabilityRecord>();
  for (const record of records) {
    const existing = byName.get(record.name);
    byName.set(
      record.name,
      existing
        ? mergeCapability(existing, {
            ...record,
            evidence: record.evidence,
            ...(record.testId !== undefined ? { testId: record.testId } : {}),
          })
        : record
    );
  }
  return Array.from(byName.values());
}

/** Gap kinds grouped for reporting. */
export function summariseGaps(gaps: CapabilityGap[]): Record<CapabilityGapKind, number> {
  const summary: Record<CapabilityGapKind, number> = {
    POTENTIAL_EXTENSION: 0,
    SOFTWARE_GAP: 0,
    UNDOCUMENTED_OBSERVATION: 0,
    UNVERIFIED_CLAIM: 0,
    UNEXPLORED: 0,
  };
  for (const gap of gaps) summary[gap.kind]++;
  return summary;
}

/** Convenience: capability confidence given the evidence sources behind it. */
export function capabilityConfidence(
  sources: EvidenceSource[],
  floor: ConfidenceLevel = 'UNKNOWN'
): ConfidenceLevel {
  return maxConfidence(confidenceForSources(sources), floor);
}
