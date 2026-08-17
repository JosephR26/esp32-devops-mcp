/**
 * Capability model, status derivation and capability gap analysis.
 *
 * These are the tests that matter most: they pin down the guarantee that a
 * datasheet claim never becomes a verified capability.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyseCapabilityGaps,
  buildCapabilityMatrix,
  dedupeCapabilities,
  deriveCapabilityStatus,
  deriveCapabilityTier,
  makeCapability,
  mergeCapability,
  summariseGaps,
} from '../src/hardware/capability.js';
import {
  compareConfidence,
  confidenceForSources,
  firstKnown,
  knownValue,
  makeEvidence,
  maxConfidence,
  minConfidence,
  unknownValue,
} from '../src/hardware/evidence.js';

describe('capability status derivation', () => {
  it('matches the specified example: documented + software, nothing observed -> UNTESTED', () => {
    const capability = makeCapability({
      name: 'example_capability',
      documented: true,
      softwareSupported: true,
      firmwareExposed: false,
      observed: false,
      tested: false,
      verified: false,
    });

    assert.equal(capability.status, 'UNTESTED');
    assert.equal(capability.documented, true);
    assert.equal(capability.softwareSupported, true);
    assert.equal(capability.firmwareExposed, false);
    assert.equal(capability.observed, false);
    assert.equal(capability.verified, false);
  });

  it('reports the highest evidence tier separately from the overall status', () => {
    const capability = makeCapability({
      name: 'cap',
      documented: true,
      softwareSupported: true,
      firmwareExposed: true,
    });

    assert.equal(capability.status, 'UNTESTED', 'nothing physical was observed');
    assert.equal(capability.tier, 'FIRMWARE_EXPOSED', 'firmware exposure is the highest tier reached');
  });

  it('escalates through OBSERVED, TESTED and VERIFIED', () => {
    assert.equal(deriveCapabilityStatus(flags({ observed: true })), 'OBSERVED');
    assert.equal(deriveCapabilityStatus(flags({ observed: true, tested: true })), 'TESTED');
    assert.equal(
      deriveCapabilityStatus(flags({ observed: true, tested: true, verified: true })),
      'VERIFIED'
    );
  });

  it('returns UNKNOWN when there is no evidence of any kind', () => {
    assert.equal(deriveCapabilityStatus(flags({})), 'UNKNOWN');
    assert.equal(deriveCapabilityTier(flags({})), 'UNKNOWN');
  });

  it('returns INFERRED when inference is the only basis', () => {
    assert.equal(deriveCapabilityStatus(flags({ inferred: true })), 'INFERRED');
    assert.equal(deriveCapabilityTier(flags({ inferred: true })), 'INFERRED');
  });

  it('lets UNSUPPORTED override every other flag', () => {
    assert.equal(
      deriveCapabilityStatus(flags({ documented: true, observed: true, unsupported: true })),
      'UNSUPPORTED'
    );
  });

  it('never derives a verified capability from documentation alone', () => {
    const capability = makeCapability({
      name: 'documented_only',
      documented: true,
      evidence: [makeEvidence('DATASHEET', 'Datasheet says so')],
    });

    assert.equal(capability.verified, false);
    assert.equal(capability.observed, false);
    assert.equal(capability.confidence, 'DOCUMENTED');
    assert.notEqual(capability.status, 'VERIFIED');
  });
});

describe('confidence derivation', () => {
  it('caps documentation-only evidence at DOCUMENTED no matter how many sources agree', () => {
    assert.equal(
      confidenceForSources(['DATASHEET', 'COMPONENT_PROFILE', 'ESP32_CATALOG']),
      'DOCUMENTED'
    );
  });

  it('raises confidence once a physical observation is present', () => {
    assert.equal(confidenceForSources(['DEVICE_RESPONSE']), 'MEDIUM');
    assert.equal(confidenceForSources(['DEVICE_RESPONSE', 'DATASHEET']), 'HIGH');
    assert.equal(
      confidenceForSources(['DEVICE_RESPONSE', 'REGISTER_READ', 'DATASHEET']),
      'CONFIRMED'
    );
  });

  it('returns UNKNOWN for no sources', () => {
    assert.equal(confidenceForSources([]), 'UNKNOWN');
    assert.equal(confidenceForSources(['NONE']), 'UNKNOWN');
  });

  it('treats inference and user claims as weak', () => {
    assert.equal(confidenceForSources(['INFERENCE']), 'LOW');
    assert.equal(confidenceForSources(['USER_SUPPLIED']), 'LOW');
  });

  it('orders confidence levels with DOCUMENTED below corroborated observation', () => {
    assert.ok(compareConfidence('DOCUMENTED', 'LOW') > 0);
    assert.ok(compareConfidence('DOCUMENTED', 'MEDIUM') < 0);
    assert.ok(compareConfidence('CONFIRMED', 'HIGH') > 0);
    assert.equal(maxConfidence('LOW', 'HIGH'), 'HIGH');
    assert.equal(minConfidence('LOW', 'HIGH'), 'LOW');
  });
});

describe('observed values', () => {
  it('marks a missing value UNKNOWN rather than guessing', () => {
    const value = unknownValue<number>('Agent did not report it');
    assert.equal(value.known, false);
    assert.equal(value.value, null);
    assert.equal(value.confidence, 'UNKNOWN');
    assert.equal(value.source, 'NONE');
  });

  it('picks the first known value from several candidate sources', () => {
    const result = firstKnown(
      unknownValue<string>('agent silent'),
      knownValue('ESP32', 'ESP32_CATALOG', 'catalog'),
      knownValue('ESP32-S3', 'DATASHEET', 'other')
    );
    assert.equal(result.value, 'ESP32');
  });

  it('returns UNKNOWN when no candidate is known', () => {
    const result = firstKnown(unknownValue<string>('a'), unknownValue<string>('b'));
    assert.equal(result.known, false);
  });
});

describe('capability gap analysis', () => {
  it('classifies documented + software + no firmware as POTENTIAL_EXTENSION, not verified', () => {
    const gaps = analyseCapabilityGaps([
      makeCapability({ name: 'protocol.felica', documented: true, softwareSupported: true }),
    ]);

    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].kind, 'POTENTIAL_EXTENSION');
    assert.equal(gaps[0].confidence, 'DOCUMENTED');
    assert.match(gaps[0].caveat, /not a verified capability/i);
  });

  it('classifies documented without software support as SOFTWARE_GAP', () => {
    const gaps = analyseCapabilityGaps([
      makeCapability({ name: 'mode.card_emulation', documented: true, softwareSupported: false }),
    ]);
    assert.equal(gaps[0].kind, 'SOFTWARE_GAP');
  });

  it('classifies observed-but-undocumented behaviour as UNDOCUMENTED_OBSERVATION', () => {
    const gaps = analyseCapabilityGaps([
      makeCapability({ name: 'mystery.response', documented: false, observed: true }),
    ]);
    assert.equal(gaps[0].kind, 'UNDOCUMENTED_OBSERVATION');
    assert.match(gaps[0].caveat, /not a specification/i);
  });

  it('classifies a documented + firmware-exposed but unmeasured capability as UNVERIFIED_CLAIM', () => {
    const gaps = analyseCapabilityGaps([
      makeCapability({
        name: 'interface.i2c',
        documented: true,
        softwareSupported: true,
        firmwareExposed: true,
      }),
    ]);
    assert.equal(gaps[0].kind, 'UNVERIFIED_CLAIM');
    assert.match(gaps[0].caveat, /zero measurements/i);
  });

  it('reports a bare documented capability as UNEXPLORED', () => {
    const gaps = analyseCapabilityGaps([
      makeCapability({ name: 'feature.unknown', documented: true }),
    ]);
    const kinds = gaps.map((g) => g.kind);
    assert.ok(kinds.includes('SOFTWARE_GAP'));
    assert.ok(kinds.includes('UNEXPLORED'));
  });

  it('reports no gap for a fully verified capability', () => {
    const gaps = analyseCapabilityGaps([
      makeCapability({
        name: 'identification.firmware_version',
        documented: true,
        softwareSupported: true,
        firmwareExposed: true,
        observed: true,
        tested: true,
        verified: true,
      }),
    ]);
    assert.equal(gaps.length, 0);
  });

  it('skips capabilities positively determined to be unsupported', () => {
    const gaps = analyseCapabilityGaps([
      makeCapability({ name: 'peripheral.dac', documented: false, unsupported: true }),
    ]);
    assert.equal(gaps.length, 0);
  });

  it('summarises gaps by kind', () => {
    const summary = summariseGaps(
      analyseCapabilityGaps([
        makeCapability({ name: 'a', documented: true, softwareSupported: true }),
        makeCapability({ name: 'b', documented: true, softwareSupported: false }),
        makeCapability({ name: 'c', documented: false, observed: true }),
      ])
    );
    assert.equal(summary.POTENTIAL_EXTENSION, 1);
    assert.equal(summary.SOFTWARE_GAP, 1);
    assert.equal(summary.UNDOCUMENTED_OBSERVATION, 1);
  });
});

describe('capability matrix', () => {
  it('counts each evidence tier independently', () => {
    const matrix = buildCapabilityMatrix('test-target', [
      makeCapability({ name: 'a', documented: true, softwareSupported: true }),
      makeCapability({ name: 'b', documented: true, observed: true }),
      makeCapability({ name: 'c', documented: true, observed: true, tested: true, verified: true }),
      makeCapability({ name: 'd', documented: false, unsupported: true }),
    ]);

    assert.equal(matrix.summary.total, 4);
    assert.equal(matrix.summary.documented, 3);
    assert.equal(matrix.summary.softwareSupported, 1);
    assert.equal(matrix.summary.observed, 2);
    assert.equal(matrix.summary.verified, 1);
    assert.equal(matrix.summary.unsupported, 1);
    assert.ok(matrix.generatedAt.length > 0);
  });
});

describe('capability merging', () => {
  it('accumulates evidence and never withdraws a flag', () => {
    const base = makeCapability({
      name: 'interface.i2c',
      documented: true,
      evidence: [makeEvidence('DATASHEET', 'documented')],
    });

    const merged = mergeCapability(base, {
      observed: true,
      evidence: [makeEvidence('DEVICE_RESPONSE', 'device answered')],
    });

    assert.equal(merged.documented, true, 'documentation flag survives');
    assert.equal(merged.observed, true);
    assert.equal(merged.status, 'OBSERVED');
    assert.equal(merged.evidence.length, 2);
    assert.equal(merged.confidence, 'HIGH', 'documentation + observation');
  });

  it('clears UNSUPPORTED when the capability is later observed', () => {
    const base = makeCapability({ name: 'x', unsupported: true });
    const merged = mergeCapability(base, { observed: true });
    assert.equal(merged.unsupported, false);
    assert.equal(merged.status, 'OBSERVED');
  });

  it('deduplicates records for the same capability name', () => {
    const records = dedupeCapabilities([
      makeCapability({ name: 'dup', documented: true, evidence: [makeEvidence('DATASHEET', 'a')] }),
      makeCapability({ name: 'dup', observed: true, evidence: [makeEvidence('DEVICE_RESPONSE', 'b')] }),
      makeCapability({ name: 'other', documented: true }),
    ]);

    assert.equal(records.length, 2);
    const dup = records.find((r) => r.name === 'dup')!;
    assert.equal(dup.documented, true);
    assert.equal(dup.observed, true);
    assert.equal(dup.evidence.length, 2);
  });
});

function flags(overrides: Record<string, boolean>) {
  return {
    documented: false,
    inferred: false,
    softwareSupported: false,
    firmwareExposed: false,
    observed: false,
    tested: false,
    verified: false,
    unsupported: false,
    ...overrides,
  };
}
