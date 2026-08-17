/**
 * Component identification engine.
 *
 * Scores every registered profile against the evidence gathered so far and
 * reports a ranked candidate list. Two rules govern the output:
 *
 * 1. A necessary rule that is *contradicted* disqualifies a profile. A necessary
 *    rule for which no evidence exists does not — absence of evidence is not
 *    evidence of absence, and it is reported as a reduced score instead.
 * 2. When the top two candidates are close, the result is marked ambiguous and
 *    confidence is capped. An uncertain identification is never reported as
 *    certain.
 */

import {
  type ComponentProfile,
  type ConfidenceLevel,
  type Evidence,
  type IdentificationCandidate,
  type IdentificationReport,
  type IdentificationRule,
  type ProbeExecutionResult,
  type RawInterpretation,
} from '../types/hardware.js';
import { makeEvidence, minConfidence, timestamp } from './evidence.js';
import { matchBytePattern, toHex, toPrintableAscii } from './patterns.js';
import { listProfiles } from './registry.js';

/** Score below which a candidate is not reported at all. */
export const REPORTING_THRESHOLD = 0.15;

/** Score gap within which the top two candidates are considered ambiguous. */
export const AMBIGUITY_MARGIN = 0.12;

export interface IdentificationEvidenceBundle {
  /** I2C address the device answered on, when the interface is I2C. */
  i2cAddress?: number;
  /** Probe results keyed by probe id. */
  probeResults?: ProbeExecutionResult[];
  /** Bytes captured from a UART or SPI stream with no associated profile probe. */
  streamBytes?: number[];
  /** Markings the user read off the physical part. */
  markings?: string[];
  /** Restrict scoring to these profile ids. */
  candidateIds?: string[];
}

type RuleOutcome = 'MATCH' | 'CONTRADICTED' | 'NO_EVIDENCE';

/**
 * Evaluate a single identification rule.
 *
 * The three-way outcome is what keeps the engine honest: a rule that could not
 * be evaluated is not silently treated as a failure.
 */
export function evaluateRule(
  rule: IdentificationRule,
  bundle: IdentificationEvidenceBundle
): { outcome: RuleOutcome; detail: string; raw?: string } {
  const matcher = rule.match;

  switch (matcher.kind) {
    case 'I2C_ADDRESS': {
      if (bundle.i2cAddress === undefined) {
        return { outcome: 'NO_EVIDENCE', detail: 'No I2C address observed' };
      }
      const hex = `0x${bundle.i2cAddress.toString(16).toUpperCase().padStart(2, '0')}`;
      return matcher.addresses.includes(bundle.i2cAddress)
        ? { outcome: 'MATCH', detail: `Device responded at ${hex}` }
        : { outcome: 'CONTRADICTED', detail: `Device responded at ${hex}, not a declared address` };
    }

    case 'PROBE_RESPONSE': {
      const result = bundle.probeResults?.find((r) => r.probeId === matcher.probeId);
      if (!result || !result.executed) {
        return { outcome: 'NO_EVIDENCE', detail: `Probe ${matcher.probeId} was not run` };
      }
      if (result.bytes.length === 0) {
        return {
          outcome: 'NO_EVIDENCE',
          detail: `Probe ${matcher.probeId} returned no bytes (${result.error ?? 'no response'})`,
        };
      }
      const hex = toHex(result.bytes);
      return matchBytePattern(result.bytes, matcher.pattern)
        ? { outcome: 'MATCH', detail: `Response matches "${matcher.pattern}"`, raw: hex }
        : {
            outcome: 'CONTRADICTED',
            detail: `Response ${hex} does not match "${matcher.pattern}"`,
            raw: hex,
          };
    }

    case 'REGISTER_VALUE': {
      const bytes = bundle.streamBytes ?? [];
      if (bytes.length === 0) {
        return { outcome: 'NO_EVIDENCE', detail: 'No register value captured' };
      }
      return matchBytePattern(bytes, matcher.pattern)
        ? { outcome: 'MATCH', detail: `Register value matches "${matcher.pattern}"`, raw: toHex(bytes) }
        : { outcome: 'CONTRADICTED', detail: `Register value does not match "${matcher.pattern}"`, raw: toHex(bytes) };
    }

    case 'UART_PATTERN': {
      const bytes = bundle.streamBytes ?? collectProbeBytes(bundle.probeResults);
      if (bytes.length === 0) {
        return { outcome: 'NO_EVIDENCE', detail: 'No stream capture available' };
      }
      const text = toPrintableAscii(bytes, 0.5);
      if (text === null) {
        // A binary stream cannot contradict a text pattern — it simply cannot
        // answer the question.
        return { outcome: 'NO_EVIDENCE', detail: 'Capture is not predominantly printable text' };
      }
      let matched: boolean;
      if (matcher.regex) {
        try {
          matched = new RegExp(matcher.pattern).test(text);
        } catch {
          return { outcome: 'NO_EVIDENCE', detail: `Invalid regex in rule: ${matcher.pattern}` };
        }
      } else {
        matched = text.includes(matcher.pattern);
      }
      return matched
        ? { outcome: 'MATCH', detail: `Capture matches "${matcher.pattern}"`, raw: text.slice(0, 200) }
        : { outcome: 'CONTRADICTED', detail: `Capture does not contain "${matcher.pattern}"`, raw: text.slice(0, 200) };
    }

    case 'MARKING': {
      if (!bundle.markings || bundle.markings.length === 0) {
        return { outcome: 'NO_EVIDENCE', detail: 'No markings supplied' };
      }
      const haystack = bundle.markings.join(' ').toLowerCase();
      const hit = matcher.patterns.find((p) => haystack.includes(p.toLowerCase()));
      return hit
        ? { outcome: 'MATCH', detail: `User-supplied marking contains "${hit}"` }
        : { outcome: 'CONTRADICTED', detail: 'No supplied marking matches this profile' };
    }
  }
}

function collectProbeBytes(results?: ProbeExecutionResult[]): number[] {
  if (!results) return [];
  return results.flatMap((r) => r.bytes);
}

/** Score one profile against the evidence bundle. */
export function scoreProfile(
  profile: ComponentProfile,
  bundle: IdentificationEvidenceBundle
): IdentificationCandidate | null {
  const matched: IdentificationCandidate['matchedRules'] = [];
  const contradicted: IdentificationCandidate['contradictedRules'] = [];
  const evidence: Evidence[] = [];

  let achieved = 0;
  let evaluableWeight = 0;

  for (const rule of profile.identification) {
    const { outcome, detail, raw } = evaluateRule(rule, bundle);

    if (outcome === 'NO_EVIDENCE') continue;

    evaluableWeight += rule.weight;

    if (outcome === 'MATCH') {
      achieved += rule.weight;
      matched.push({ ruleId: rule.id, description: rule.description, weight: rule.weight });
      evidence.push(
        makeEvidence(
          rule.match.kind === 'MARKING' ? 'USER_SUPPLIED' : 'DEVICE_RESPONSE',
          `${rule.description} — ${detail}`,
          {
            ...(raw !== undefined ? { raw } : {}),
            ...(rule.reference !== undefined ? { reference: rule.reference } : {}),
          }
        )
      );
      continue;
    }

    contradicted.push({ ruleId: rule.id, description: rule.description });

    // A contradicted necessary rule rules the profile out entirely.
    if (rule.necessary) return null;
  }

  if (evaluableWeight === 0) return null;

  const score = achieved / evaluableWeight;
  if (score <= 0) return null;

  // Coverage discount: matching one weak rule out of many is not the same as
  // matching a comprehensive rule set, and the score must reflect that.
  const totalWeight = profile.identification.reduce((sum, r) => sum + r.weight, 0);
  const coverage = totalWeight > 0 ? evaluableWeight / totalWeight : 0;
  const adjusted = score * (0.5 + 0.5 * coverage);

  return {
    componentId: profile.id,
    partNumber: profile.partNumber,
    manufacturer: profile.manufacturer,
    score: Number(adjusted.toFixed(4)),
    confidence: scoreToConfidence(adjusted, matched, bundle),
    matchedRules: matched,
    contradictedRules: contradicted,
    evidence,
  };
}

/**
 * Map a numeric score to a confidence level.
 *
 * An identification resting only on a bus address is capped at LOW no matter how
 * cleanly it "matches" — many unrelated parts share any given I2C address.
 */
function scoreToConfidence(
  score: number,
  matched: IdentificationCandidate['matchedRules'],
  bundle: IdentificationEvidenceBundle
): ConfidenceLevel {
  const hasPhysicalResponse = (bundle.probeResults ?? []).some(
    (r) => r.executed && r.bytes.length > 0
  );
  const onlyAddressEvidence =
    matched.length > 0 && matched.every((rule) => rule.ruleId.includes('address'));

  if (onlyAddressEvidence || !hasPhysicalResponse) return 'LOW';
  if (score >= 0.85) return 'HIGH';
  if (score >= 0.6) return 'MEDIUM';
  if (score >= 0.3) return 'LOW';
  return 'LOW';
}

/**
 * Identify a component from the supplied evidence.
 *
 * Returns a report with `identified: null` when nothing scores above the
 * reporting threshold, rather than promoting the least-bad candidate.
 */
export function identifyComponent(
  bundle: IdentificationEvidenceBundle,
  raw: RawInterpretation[] = []
): IdentificationReport {
  const pool = bundle.candidateIds
    ? listProfiles().filter((p) => bundle.candidateIds!.includes(p.id))
    : listProfiles();

  const candidates = pool
    .map((profile) => scoreProfile(profile, bundle))
    .filter((c): c is IdentificationCandidate => c !== null && c.score >= REPORTING_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const method: string[] = [];
  if (bundle.i2cAddress !== undefined) method.push('I2C address');
  if ((bundle.probeResults ?? []).some((r) => r.executed)) method.push('safe probe responses');
  if (bundle.streamBytes?.length) method.push('stream capture');
  if (bundle.markings?.length) method.push('user-supplied markings');

  const notes: string[] = [];

  if (candidates.length === 0) {
    return {
      success: true,
      identified: null,
      alternatives: [],
      ambiguous: false,
      method,
      confidence: 'UNKNOWN',
      evidence: [],
      raw,
      notes: [
        'No registered component profile matched the available evidence above the ' +
          'reporting threshold. This means UNIDENTIFIED, not "no device present".',
        'Add a component profile, supply physical markings, or run a deeper ' +
          'interrogation to gather more evidence.',
      ],
    };
  }

  const [best, second] = candidates;
  const ambiguous =
    second !== undefined && best.score - second.score < AMBIGUITY_MARGIN;

  let confidence = best.confidence;
  if (ambiguous) {
    // Two plausible answers means the answer is not established.
    confidence = minConfidence(confidence, 'LOW');
    notes.push(
      `Ambiguous: ${best.partNumber} (${best.score.toFixed(2)}) and ${second.partNumber} ` +
        `(${second.score.toFixed(2)}) score within ${AMBIGUITY_MARGIN} of each other. ` +
        'Neither is established.'
    );
  }

  if (best.matchedRules.length === 1) {
    notes.push(
      'Identification rests on a single matched rule. Treat it as a lead, not a conclusion.'
    );
  }

  if (best.contradictedRules.length > 0) {
    notes.push(
      `${best.contradictedRules.length} identification rule(s) for ${best.partNumber} were ` +
        'contradicted by the observed evidence.'
    );
  }

  return {
    success: true,
    identified: { ...best, confidence },
    alternatives: candidates.slice(1, 5),
    ambiguous,
    method,
    confidence,
    evidence: best.evidence,
    raw,
    notes,
  };
}

/** Empty identification report, used when identification could not be attempted. */
export function noIdentification(reason: string): IdentificationReport {
  return {
    success: false,
    identified: null,
    alternatives: [],
    ambiguous: false,
    method: [],
    confidence: 'UNKNOWN',
    evidence: [],
    raw: [],
    notes: [reason],
    error: reason,
  };
}

/** Timestamped note helper, kept here so reports read consistently. */
export function identificationNote(text: string): string {
  return `[${timestamp()}] ${text}`;
}
