/**
 * Component identification, probing, register inspection, capability
 * enumeration, functional testing and benchmarking — against mocked hardware.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  componentBenchmark,
  componentCapabilities,
  componentIdentify,
  componentProbe,
  componentTest,
  registerInspect,
} from '../src/tools/component.js';
import { resetTransportFactory, setTransportFactory } from '../src/hardware/transport.js';
import {
  listProfiles,
  registerProfile,
  unregisterProfile,
  validateAllProfiles,
  validateProfile,
} from '../src/hardware/registry.js';
import { identifyComponent, scoreProfile } from '../src/hardware/identify.js';
import {
  EMPTY_BUS_HANDLERS,
  MPU6050_I2C_HANDLERS,
  MockTransport,
  NRF24_SPI_HANDLERS,
  PN532_I2C_HANDLERS,
  absentAgentTransport,
  pn532RegisterHandlers,
  type MockHandler,
} from './helpers/mock-hardware.js';
import type { ComponentProfile } from '../src/types/hardware.js';

function useMock(handlers: Record<string, MockHandler>, latencyMs = 0): MockTransport {
  const transport = new MockTransport({ handlers, latencyMs });
  setTransportFactory(() => transport);
  return transport;
}

afterEach(() => resetTransportFactory());

describe('component profile registry', () => {
  it('validates every built-in profile', () => {
    assert.doesNotThrow(() => validateAllProfiles());
  });

  it('ships profiles spanning many component classes, not just one', () => {
    const ids = listProfiles().map((p) => p.id);
    for (const expected of ['pn532', 'mpu6050', 'ads1115', 'mcp4725', 'mcp23017', 'ssd1306', 'nrf24l01', 'mcp2515', 'neo-6m', 'eeprom-24cxx']) {
      assert.ok(ids.includes(expected), `expected profile ${expected}`);
    }
    assert.ok(ids.length >= 10);
  });

  it('rejects a probe that emits bytes without declaring writes: true', () => {
    assert.throws(
      () => validateProfile(makeProfile({ safeProbes: [{ ...BARE_PROBE, writes: false }] })),
      /emits bytes but is not marked writes: true/
    );
  });

  it('rejects a writing probe with no justification', () => {
    assert.throws(
      () =>
        validateProfile(
          makeProfile({ safeProbes: [{ ...BARE_PROBE, writes: true, writeJustification: undefined }] })
        ),
      /supplies no writeJustification/
    );
  });

  it('rejects an identification rule referencing a probe that does not exist', () => {
    assert.throws(
      () =>
        validateProfile(
          makeProfile({
            identification: [
              {
                id: 'r',
                description: 'd',
                weight: 1,
                match: { kind: 'PROBE_RESPONSE', probeId: 'ghost', pattern: 'FF' },
              },
            ],
          })
        ),
      /references unknown probe/
    );
  });

  it('rejects a probe whose byte payload is out of range', () => {
    assert.throws(
      () =>
        validateProfile(
          makeProfile({
            safeProbes: [
              {
                ...BARE_PROBE,
                operations: [
                  { op: 'I2C_WRITE_READ', address: 0x10, write: [0x00, 300], readLength: 1 },
                ],
              },
            ],
          })
        ),
      /invalid byte payload/
    );
  });

  it('rejects a probe with an empty byte payload', () => {
    assert.throws(
      () =>
        validateProfile(
          makeProfile({
            safeProbes: [
              {
                ...BARE_PROBE,
                operations: [{ op: 'SPI_TRANSFER', tx: [] }],
              },
            ],
          })
        ),
      /invalid byte payload/
    );
  });

  it('rejects an out-of-range identification weight', () => {
    assert.throws(
      () =>
        validateProfile(
          makeProfile({
            identification: [
              { id: 'r', description: 'd', weight: 5, match: { kind: 'I2C_ADDRESS', addresses: [1] } },
            ],
          })
        ),
      /weight must be in/
    );
  });

  it('registers and removes a third-party profile at runtime', () => {
    const custom = makeProfile({ id: 'test-widget', partNumber: 'WIDGET-1' });
    registerProfile(custom);
    assert.equal(listProfiles().some((p) => p.id === 'test-widget'), true);
    assert.equal(unregisterProfile('test-widget'), true);
    assert.equal(listProfiles().some((p) => p.id === 'test-widget'), false);
  });
});

describe('esp32_component_identify', () => {
  it('identifies a PN532 from its documented firmware-version signature', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentIdentify({
      port: '/dev/ttyUSB0',
      interface: 'I2C',
      address: 0x24,
    });

    assert.equal(report.success, true);
    assert.equal(report.identified?.componentId, 'pn532');
    assert.equal(report.identified?.partNumber, 'PN532');
    assert.ok(['MEDIUM', 'HIGH'].includes(report.confidence));
    assert.ok(report.evidence.length > 0);
    assert.ok(report.method.includes('safe probe responses'));
  });

  it('caps an address-only identification at LOW confidence', () => {
    const report = identifyComponent({ i2cAddress: 0x24 });
    if (report.identified) {
      assert.equal(report.confidence, 'LOW');
    }
    assert.ok(report.identified === null || report.identified.score < 1);
  });

  it('reports no identification rather than the least-bad guess', async () => {
    useMock(EMPTY_BUS_HANDLERS);
    const report = await componentIdentify({
      port: '/dev/ttyUSB0',
      interface: 'I2C',
      address: 0x11,
    });

    assert.equal(report.identified, null);
    assert.equal(report.confidence, 'UNKNOWN');
    assert.ok(report.notes.some((n) => /UNIDENTIFIED, not "no device present"/.test(n)));
  });

  it('marks two close candidates as ambiguous and caps confidence', () => {
    const twinA = makeProfile({
      id: 'twin-a',
      partNumber: 'TWIN-A',
      identification: [
        { id: 'twin-a.sig', description: 'sig', weight: 1, match: { kind: 'I2C_ADDRESS', addresses: [0x55] } },
      ],
    });
    const twinB = makeProfile({
      id: 'twin-b',
      partNumber: 'TWIN-B',
      identification: [
        { id: 'twin-b.sig', description: 'sig', weight: 1, match: { kind: 'I2C_ADDRESS', addresses: [0x55] } },
      ],
    });
    registerProfile(twinA);
    registerProfile(twinB);

    try {
      const report = identifyComponent({ i2cAddress: 0x55, candidateIds: ['twin-a', 'twin-b'] });
      assert.equal(report.ambiguous, true);
      assert.equal(report.confidence, 'LOW');
      assert.ok(report.notes.some((n) => /Ambiguous/.test(n)));
      assert.ok(report.alternatives.length >= 1);
    } finally {
      unregisterProfile('twin-a');
      unregisterProfile('twin-b');
    }
  });

  it('disqualifies a profile whose necessary rule is contradicted', () => {
    const profile = makeProfile({
      id: 'strict',
      identification: [
        {
          id: 'strict.addr',
          description: 'must be at 0x10',
          weight: 1,
          necessary: true,
          match: { kind: 'I2C_ADDRESS', addresses: [0x10] },
        },
      ],
    });
    assert.equal(scoreProfile(profile, { i2cAddress: 0x20 }), null);
  });

  it('does not disqualify a necessary rule that simply has no evidence', () => {
    const profile = makeProfile({
      id: 'lenient',
      identification: [
        {
          id: 'lenient.probe',
          description: 'needs a probe',
          weight: 1,
          necessary: true,
          match: { kind: 'PROBE_RESPONSE', probeId: 'bare.probe', pattern: 'FF' },
        },
        { id: 'lenient.addr', description: 'address', weight: 0.5, match: { kind: 'I2C_ADDRESS', addresses: [0x30] } },
      ],
    });
    // The necessary rule could not be evaluated; the address rule still matches.
    const candidate = scoreProfile(profile, { i2cAddress: 0x30 });
    assert.notEqual(candidate, null);
    assert.ok(candidate!.score > 0);
  });

  it('uses user-supplied markings when no hardware is reachable', async () => {
    setTransportFactory(() => absentAgentTransport());
    const report = await componentIdentify({
      port: '/dev/ttyUSB0',
      markings: ['PN532 NFC MODULE V3'],
    });

    assert.equal(report.identified?.componentId, 'pn532');
    assert.equal(report.confidence, 'LOW', 'markings alone are weak evidence');
    assert.ok(report.notes.some((n) => /rests entirely on user-supplied markings/.test(n)));
  });

  it('refuses to identify with no evidence at all', async () => {
    setTransportFactory(() => absentAgentTransport());
    const report = await componentIdentify({ port: '/dev/ttyUSB0' });
    assert.equal(report.success, false);
    assert.equal(report.identified, null);
  });
});

describe('esp32_component_probe', () => {
  it('runs BASIC depth: connectivity and identification only', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentProbe({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      depth: 'BASIC',
    });

    assert.equal(report.depth, 'BASIC');
    assert.equal(report.connectivity.reachable.value, true);
    assert.ok(report.identification);
    assert.equal(report.registers, null, 'registers are a DEEP-tier concern');
    assert.equal(report.capabilities, null, 'the matrix starts at STANDARD');
    assert.equal(report.consistency, null);
  });

  it('runs STANDARD depth: adds the capability matrix, modes and protocols', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentProbe({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      depth: 'STANDARD',
    });

    assert.ok(report.capabilities);
    assert.ok(report.capabilities!.capabilities.length > 0);
    assert.ok(report.modes.length > 0);
    assert.ok(report.protocols.length > 0);
    assert.equal(report.registers, null);
  });

  it('runs DEEP depth: adds register inspection', async () => {
    useMock(pn532RegisterHandlers(0x86));
    const report = await componentProbe({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      depth: 'DEEP',
    });

    assert.ok(report.registers);
    assert.equal(report.registers!.readOnly, true);
    assert.ok(report.registers!.registers.length > 0);
  });

  it('runs FORENSIC depth: adds repeated measurement and consistency analysis', async () => {
    useMock(pn532RegisterHandlers(0x86));
    const report = await componentProbe({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      depth: 'FORENSIC',
    });

    assert.ok(report.consistency);
    assert.ok(report.consistency!.repetitions >= 2);
    assert.ok(typeof report.consistency!.agreement === 'number');
  });

  it('never sets firmwareExposed from probe evidence', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentProbe({ port: '/dev/ttyUSB0', component: 'pn532', depth: 'DEEP' });

    assert.ok(report.capabilities);
    assert.ok(
      report.capabilities!.capabilities.every((c) => c.firmwareExposed === false),
      'firmware exposure cannot be discovered from the bus'
    );
  });

  it('marks capabilities OBSERVED only when a probe returned data', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentProbe({ port: '/dev/ttyUSB0', component: 'pn532', depth: 'DEEP' });

    const identity = report.capabilities!.capabilities.find(
      (c) => c.name === 'identification.firmware_version'
    )!;
    assert.equal(identity.documented, true);
    assert.equal(identity.observed, true);
    assert.equal(identity.verified, false, 'probing observes; only a test verifies');

    const felica = report.capabilities!.capabilities.find((c) => c.name === 'protocol.felica')!;
    assert.equal(felica.documented, true);
    assert.equal(felica.observed, false, 'no probe exercises FeliCa');
    assert.equal(felica.status, 'UNTESTED');
  });

  it('produces a capability gap analysis at STANDARD and above', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentProbe({ port: '/dev/ttyUSB0', component: 'pn532', depth: 'DEEP' });

    const kinds = new Set(report.capabilities!.gaps.map((g) => g.kind));
    assert.ok(kinds.has('POTENTIAL_EXTENSION') || kinds.has('SOFTWARE_GAP'));
  });

  it('records a reproducibility block with hardware, firmware and MCP version', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentProbe({ port: '/dev/ttyUSB0', component: 'pn532' });

    assert.ok(report.reproducibility.mcpVersion);
    assert.equal(report.reproducibility.hardware.chip.value, 'ESP32');
    assert.equal(report.reproducibility.firmware.agentVersion.value, '1.0.0');
    assert.equal(report.reproducibility.profileId, 'pn532');
    assert.ok(report.reproducibility.timestamp);
  });

  it('preserves raw captures alongside every interpretation', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentProbe({ port: '/dev/ttyUSB0', component: 'pn532' });

    assert.ok(report.raw.length > 0);
    for (const entry of report.raw) {
      assert.equal(typeof entry.raw, 'string');
      assert.equal(typeof entry.interpretation, 'string');
      assert.ok(entry.timestamp);
    }
    const executed = report.probes.filter((p) => p.executed);
    assert.ok(executed.length > 0);
    assert.ok(executed.every((p) => typeof p.raw.raw === 'string'));
  });

  it('stops after connectivity when no profile can be resolved', async () => {
    useMock(EMPTY_BUS_HANDLERS);
    const report = await componentProbe({
      port: '/dev/ttyUSB0',
      interface: 'I2C',
      address: 0x11,
    });

    assert.equal(report.probes.length, 0);
    assert.equal(report.capabilities, null);
    assert.ok(report.warnings.some((w) => /No component profile could be resolved/.test(w)));
  });

  it('reports an unreachable device without claiming it is absent', async () => {
    useMock(EMPTY_BUS_HANDLERS);
    const report = await componentProbe({ port: '/dev/ttyUSB0', component: 'pn532' });

    assert.equal(report.connectivity.reachable.value, false);
    assert.match(report.connectivity.detail, /Check wiring, power and pull-ups/);
  });

  it('fails cleanly when the agent is absent', async () => {
    setTransportFactory(() => absentAgentTransport());
    const report = await componentProbe({ port: '/dev/ttyUSB0', component: 'pn532' });
    assert.equal(report.success, false);
    assert.ok(report.errors.length > 0);
  });

  it('rejects an invalid component identifier', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentProbe({ port: '/dev/ttyUSB0', component: 'bad;rm -rf /' });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /Invalid component identifier/);
  });
});

describe('esp32_register_inspect', () => {
  it('reads a flat I2C register file and decodes the bitfields', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      registers: ['PWR_MGMT_1'],
    });

    assert.equal(report.success, true);
    assert.equal(report.readOnly, true);
    const pwr = report.registers.find((r) => r.name === 'PWR_MGMT_1')!;
    assert.equal(pwr.read, true);
    assert.equal(pwr.rawValue.value, 0x01);
    assert.equal(pwr.hex, '0x01');
    assert.equal(pwr.changedFromReset, true, 'reset value is 0x40');
    const clksel = pwr.fields.find((f) => f.name === 'CLKSEL')!;
    assert.equal(clksel.value, 1);
    assert.equal(clksel.meaning, 'PLL with X-axis gyro reference');
  });

  it('skips a clear-on-read register instead of reading it', async () => {
    const transport = useMock(MPU6050_I2C_HANDLERS);
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
    });

    const intStatus = report.registers.find((r) => r.name === 'INT_STATUS')!;
    assert.equal(intStatus.read, false);
    assert.match(intStatus.skipped!, /mutates device state/);
    assert.ok(report.skipped.some((s) => /mutates device state/.test(s.reason)));

    const readRegisters = transport.calls
      .filter((c) => c.op === 'i2c.writeRead')
      .map((c) => (c.params.write as number[])[0]);
    assert.equal(readRegisters.includes(0x3a), false, 'INT_STATUS must never be read');
  });

  it('reads a command-protocol register through the profile read probe', async () => {
    useMock(pn532RegisterHandlers(0x86));
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      registers: ['CIU_Status2'],
    });

    const status2 = report.registers.find((r) => r.name === 'CIU_Status2')!;
    assert.equal(status2.read, true);
    assert.equal(status2.rawValue.value, 0x86);
    const modem = status2.fields.find((f) => f.name === 'ModemState')!;
    assert.equal(modem.value, 0x86 & 0b111);
  });

  it('explains that a profile with no register map is a command-protocol device', async () => {
    const report = await registerInspect({ port: '/dev/ttyUSB0', component: 'eeprom-24cxx' });
    assert.equal(report.success, true);
    assert.equal(report.registers.length, 0);
    assert.ok(report.warnings.some((w) => /declares no register map/.test(w)));
  });

  it('warns when the requested register does not exist in the profile', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      registers: ['NO_SUCH_REGISTER'],
    });
    assert.ok(report.warnings.some((w) => /None of the requested registers exist/.test(w)));
  });

  it('rejects an unknown component', async () => {
    const report = await registerInspect({ port: '/dev/ttyUSB0', component: 'not-a-real-part' });
    assert.equal(report.success, false);
    assert.match(report.error!, /No registered component profile/);
  });

  it('flags registers that differ from their documented reset values', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      registers: ['PWR_MGMT_1'],
    });
    assert.ok(report.warnings.some((w) => /differ from their documented reset value/.test(w)));
  });
});

describe('esp32_component_capabilities', () => {
  it('builds an honest documentation-only matrix offline', async () => {
    const result = await componentCapabilities({ component: 'pn532', offline: true });

    assert.equal(result.success, true);
    assert.equal(result.mode, 'OFFLINE');
    assert.ok(result.matrix.capabilities.length > 0);
    assert.ok(result.matrix.capabilities.every((c) => c.observed === false));
    assert.ok(result.matrix.capabilities.every((c) => c.verified === false));
    assert.ok(result.interpretation.some((i) => /OFFLINE matrix/.test(i)));
  });

  it('classifies documented + software + no firmware as POTENTIAL EXTENSION', async () => {
    const result = await componentCapabilities({ component: 'pn532', offline: true });
    const extensions = result.matrix.gaps.filter((g) => g.kind === 'POTENTIAL_EXTENSION');
    assert.ok(extensions.length > 0);
    assert.ok(extensions.every((g) => g.confidence === 'DOCUMENTED'));
  });

  it('classifies documented + no software as a SOFTWARE GAP', async () => {
    const result = await componentCapabilities({ component: 'pn532', offline: true });
    const softwareGaps = result.matrix.gaps.filter((g) => g.kind === 'SOFTWARE_GAP');
    assert.ok(softwareGaps.some((g) => g.capability === 'mode.card_emulation'));
  });

  it('accepts an explicit statement of firmware exposure', async () => {
    const result = await componentCapabilities({
      component: 'pn532',
      offline: true,
      firmwareCapabilities: ['interface.i2c', 'protocol.iso14443a'],
    });

    const i2c = result.matrix.capabilities.find((c) => c.name === 'interface.i2c')!;
    assert.equal(i2c.firmwareExposed, true);
    assert.equal(i2c.tier, 'FIRMWARE_EXPOSED');
    assert.equal(i2c.status, 'UNTESTED', 'exposure is still a claim, not a measurement');
  });

  it('warns when firmwareCapabilities names a capability the profile does not have', async () => {
    const result = await componentCapabilities({
      component: 'pn532',
      offline: true,
      firmwareCapabilities: ['not.a.capability'],
    });
    assert.ok(result.warnings.some((w) => /absent from the PN532 profile/.test(w)));
  });

  it('promotes capabilities to OBSERVED in live mode', async () => {
    useMock(PN532_I2C_HANDLERS);
    const result = await componentCapabilities({
      component: 'pn532',
      port: '/dev/ttyUSB0',
      depth: 'DEEP',
    });

    assert.equal(result.mode, 'LIVE');
    const identity = result.matrix.capabilities.find(
      (c) => c.name === 'identification.firmware_version'
    )!;
    assert.equal(identity.observed, true);
  });

  it('rejects an unknown component', async () => {
    const result = await componentCapabilities({ component: 'no-such-part', offline: true });
    assert.equal(result.success, false);
    assert.match(result.error!, /No registered component profile/);
  });
});

describe('esp32_component_test', () => {
  it('records objective, procedure, expected and observed results for each test', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentTest({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      tests: ['pn532.test.identity'],
    });

    assert.equal(report.tests.length, 1);
    const test = report.tests[0];
    assert.equal(test.testId, 'pn532.test.identity');
    assert.ok(test.objective.length > 0);
    assert.ok(test.procedure.length > 0);
    assert.ok(test.expectedResult.length > 0);
    assert.ok(test.observedResult.length > 0);
    assert.ok(test.evidence.length > 0);
    assert.ok(test.durationMs >= 0);
    assert.equal(test.executed, true);
    assert.equal(test.passed, true);
  });

  it('promotes a capability to VERIFIED when its test passes', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentTest({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      tests: ['pn532.test.identity'],
    });

    const capability = report.capabilities!.capabilities.find(
      (c) => c.name === 'identification.firmware_version'
    )!;
    assert.equal(capability.tested, true);
    assert.equal(capability.verified, true);
    assert.equal(capability.status, 'VERIFIED');
    assert.equal(capability.testId, 'pn532.test.identity');
  });

  it('caps a single passing run at HIGH, never CONFIRMED', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentTest({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      tests: ['pn532.test.identity'],
    });
    assert.equal(report.tests[0].confidence, 'HIGH');
  });

  it('fails a test when the device returns nothing', async () => {
    useMock(EMPTY_BUS_HANDLERS);
    const report = await componentTest({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      tests: ['pn532.test.identity'],
    });

    assert.equal(report.success, false);
    assert.equal(report.tests[0].passed, false);
    assert.equal(report.failed, 1);
    assert.match(report.tests[0].observedResult, /No data returned|does not match/);
  });

  it('skips a test that needs a deeper interrogation depth', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentTest({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      tests: ['pn532.test.register_read'],
      depth: 'BASIC',
    });

    assert.equal(report.tests[0].executed, false);
    assert.match(report.tests[0].skippedReason!, /Requires depth DEEP/);
    assert.equal(report.skipped, 1);
  });

  it('runs an MPU-6050 measurement test end to end', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await componentTest({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      tests: ['mpu6050.test.accel_read'],
    });

    assert.equal(report.tests[0].passed, true);
    assert.match(report.tests[0].observedResult, /6 byte\(s\)/);
  });

  it('warns when a requested test name does not exist', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentTest({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      tests: ['no.such.test'],
    });
    assert.ok(report.warnings.some((w) => /No test matched/.test(w)));
  });
});

describe('esp32_component_benchmark', () => {
  it('measures latency across iterations with full statistics', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentBenchmark({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      benchmarks: ['pn532.bench.identity_latency'],
      iterations: 5,
    });

    assert.equal(report.success, true);
    const measurement = report.measurements[0];
    assert.equal(measurement.iterations, 5);
    assert.equal(measurement.successfulIterations, 5);
    assert.equal(measurement.samples.length, 5);
    assert.ok(measurement.mean !== null);
    assert.ok(measurement.median !== null);
    assert.ok(measurement.min !== null && measurement.max !== null);
    assert.equal(measurement.errorRate, 0);
  });

  it('separates the measured maximum from the documented maximum', async () => {
    // Real latency so the wall-clock round trip is above the millisecond timer
    // resolution and a rate can actually be derived.
    useMock(MPU6050_I2C_HANDLERS, 2);
    const report = await componentBenchmark({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      benchmarks: ['mpu6050.bench.sample_rate'],
      iterations: 5,
    });

    const measurement = report.measurements[0];
    assert.equal(measurement.documentedMaximum.value, 1000);
    assert.equal(measurement.documentedMaximum.source, 'DATASHEET');
    assert.equal(measurement.documentedMaximum.confidence, 'DOCUMENTED');
    assert.equal(measurement.measuredMaximum.source, 'DEVICE_RESPONSE');
    assert.notEqual(measurement.measuredMaximum.value, measurement.documentedMaximum.value);
  });

  it('states that a measured figure is not a hardware limit', async () => {
    useMock(PN532_I2C_HANDLERS, 2);
    const report = await componentBenchmark({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      benchmarks: ['pn532.bench.status_poll_rate'],
      iterations: 3,
    });

    assert.ok(report.notes.some((n) => /floor on the hardware capability, never a ceiling/.test(n)));
    assert.match(report.measurements[0].interpretation, /higher rate than this figure shows/);
  });

  it('reports UNKNOWN documented maximum when the profile has no datasheet figure', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentBenchmark({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      benchmarks: ['pn532.bench.identity_latency'],
      iterations: 3,
    });
    assert.equal(report.measurements[0].documentedMaximum.known, false);
  });

  it('caps iterations at the profile limit rather than raising them silently', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentBenchmark({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      benchmarks: ['pn532.bench.identity_latency'],
      iterations: 199,
    });

    assert.equal(report.measurements[0].iterations, 20, 'profile declares 20');
    assert.ok(report.warnings.some((w) => /capped at the profile limit/.test(w)));
  });

  it('records failures as an error rate rather than pretending success', async () => {
    useMock(EMPTY_BUS_HANDLERS);
    const report = await componentBenchmark({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      benchmarks: ['pn532.bench.identity_latency'],
      iterations: 4,
    });

    const measurement = report.measurements[0];
    assert.equal(measurement.successfulIterations, 0);
    assert.equal(measurement.errorRate, 1);
    assert.equal(measurement.mean, null);
    assert.equal(measurement.confidence, 'UNKNOWN');
  });

  it('rejects an out-of-range iteration count', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await componentBenchmark({
      port: '/dev/ttyUSB0',
      component: 'pn532',
      iterations: 5000,
    });
    assert.equal(report.success, false);
    assert.match(report.error!, /iterations must be between/);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BARE_PROBE = {
  id: 'bare.probe',
  name: 'Bare probe',
  description: 'test',
  interface: 'I2C' as const,
  justification: 'test',
  writes: true,
  writeJustification: 'test',
  reversible: true,
  operations: [{ op: 'I2C_WRITE_READ' as const, address: 0x10, write: [0x00], readLength: 1 }],
};

function makeProfile(overrides: Partial<ComponentProfile> = {}): ComponentProfile {
  return {
    id: 'fixture',
    manufacturer: 'Test',
    partNumber: 'FIXTURE-1',
    aliases: [],
    description: 'Test fixture profile',
    interfaces: [{ kind: 'I2C', addresses: [0x10] }],
    identification: [],
    registers: [],
    protocols: [],
    modes: [],
    capabilities: [],
    safeProbes: [BARE_PROBE],
    functionalTests: [],
    benchmarks: [],
    limitations: [],
    documentation: [],
    confidence: 'DOCUMENTED',
    ...overrides,
  };
}
