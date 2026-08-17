/**
 * Experiment lifecycle, transport behaviour and pin-safety enforcement.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { hardwareExperiment } from '../src/tools/component.js';
import {
  analyseConsistency,
  buildReproducibility,
  captureReproducibilityFacts,
  runExperiment,
  MAX_REPETITIONS,
  MCP_VERSION,
} from '../src/hardware/experiment.js';
import {
  PythonBridgeTransport,
  UnavailableTransport,
  createTransport,
  resetTransportFactory,
  setTransportFactory,
  transportFailure,
} from '../src/hardware/transport.js';
import { checkPins, coerceDepth, resolvePort } from '../src/hardware/session.js';
import { depthRank, shouldRunProbe } from '../src/hardware/probe.js';
import { getFamilySpec, identifyUsbBridge, normaliseFamily, reservedPins } from '../src/hardware/esp32-catalog.js';
import { EXPERIMENT_PHASES } from '../src/types/hardware.js';
import {
  EMPTY_BUS_HANDLERS,
  MockTransport,
  PN532_I2C_HANDLERS,
  absentAgentTransport,
  type MockHandler,
} from './helpers/mock-hardware.js';
import { PN532_PROFILE } from '../src/hardware/profiles/index.js';

function useMock(handlers: Record<string, MockHandler>): MockTransport {
  const transport = new MockTransport({ handlers });
  setTransportFactory(() => transport);
  return transport;
}

afterEach(() => resetTransportFactory());

describe('experiment lifecycle', () => {
  it('walks every phase in order and reports each one', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Confirm the PN532 reports its firmware version',
      targetComponent: 'pn532',
      address: 0x24,
      hypothesis: 'The device returns D5 03 32 followed by version bytes',
      expectedResult: 'GetFirmwareVersion response frame',
      procedure: [{ probeId: 'pn532.firmware_version', critical: true }],
    });

    assert.equal(report.success, true);
    const phases = report.phases.map((p) => p.phase);
    for (const phase of EXPERIMENT_PHASES) {
      assert.ok(phases.includes(phase), `missing phase ${phase}`);
    }
    assert.deepEqual(phases, [...EXPERIMENT_PHASES], 'phases run in the specified order');
    assert.ok(report.phases.every((p) => p.durationMs >= 0 && p.startedAt && p.completedAt));
  });

  it('produces a complete machine-readable report', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Baseline PN532 identity',
      targetComponent: 'pn532',
      address: 0x24,
      hypothesis: 'Identity is readable',
      expectedResult: 'D5 03 32 ...',
      procedure: [{ probeId: 'pn532.firmware_version' }],
      telemetry: [{ name: 'raw response bytes', required: true }],
    });

    assert.ok(report.experimentId.startsWith('exp-'));
    assert.equal(report.objective, 'Baseline PN532 identity');
    assert.equal(report.hypothesis.known, true);
    assert.equal(report.expectedResult.known, true);
    assert.ok(report.observations.length > 0);
    assert.ok(report.telemetry.length === 1 && report.telemetry[0].satisfied);
    assert.ok(report.analysis.findings.length > 0);
    assert.ok(report.analysis.capabilityImplications.length > 0);
    assert.ok(report.conclusion.length > 0);
    assert.ok(report.durationMs >= 0);
  });

  it('validates the hypothesis against the probe expectation', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Validate identity',
      targetComponent: 'pn532',
      address: 0x24,
      procedure: [{ probeId: 'pn532.firmware_version' }],
    });

    assert.equal(report.validation.hypothesisSupported, true);
    assert.ok(['MEDIUM', 'HIGH', 'CONFIRMED'].includes(report.confidence));
  });

  it('reports a failed hypothesis when nothing responds', async () => {
    useMock(EMPTY_BUS_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Validate identity on an empty bus',
      targetComponent: 'pn532',
      address: 0x24,
      procedure: [{ probeId: 'pn532.firmware_version' }],
    });

    assert.equal(report.success, false);
    assert.equal(report.validation.hypothesisSupported, false);
    assert.match(report.validation.detail, /equally consistent with a wiring or configuration fault/);
    assert.ok(report.analysis.capabilityImplications.some((i) => /No capability may be marked OBSERVED/.test(i)));
  });

  it('runs repetitions and analyses consistency', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Assess identity response stability',
      targetComponent: 'pn532',
      address: 0x24,
      procedure: [{ probeId: 'pn532.firmware_version' }],
      repetitions: 4,
    });

    assert.equal(report.repetitions, 4);
    assert.ok(report.consistency);
    assert.equal(report.consistency!.stable, true);
    assert.equal(report.consistency!.agreement, 1);
    assert.equal(report.observations.length, 4);
  });

  it('says explicitly that one measurement does not establish stability', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Single-shot read',
      targetComponent: 'pn532',
      address: 0x24,
      procedure: [{ probeId: 'pn532.firmware_version' }],
    });

    const repeat = report.phases.find((p) => p.phase === 'REPEAT')!;
    assert.match(repeat.detail, /not its stability/);
  });

  it('aborts on a failing critical step', async () => {
    useMock(EMPTY_BUS_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Critical step abort',
      targetComponent: 'pn532',
      address: 0x24,
      procedure: [{ probeId: 'pn532.firmware_version', critical: true }],
      repetitions: 3,
    });

    assert.equal(report.success, false);
    assert.ok(report.errors.some((e) => /Critical step/.test(e)));
    assert.ok(report.observations.length < 3, 'stopped before completing all repetitions');
  });

  it('records safety constraints on every experiment', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Safety constraints',
      targetComponent: 'pn532',
      address: 0x24,
      procedure: [{ probeId: 'pn532.firmware_version' }],
      safetyConstraints: ['Do not exceed 100 kHz'],
    });

    assert.ok(report.safetyConstraints.includes('Do not exceed 100 kHz'));
    assert.ok(report.safetyConstraints.some((c) => /no register writes/i.test(c)));
    assert.ok(report.safetyConstraints.some((c) => /No unknown GPIO is driven/i.test(c)));
  });

  it('records everything needed to reproduce the run', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Reproducibility',
      targetComponent: 'pn532',
      address: 0x24,
      frequencyHz: 100000,
      procedure: [{ probeId: 'pn532.firmware_version' }],
    });

    const record = report.reproducibility;
    assert.equal(record.mcpVersion, MCP_VERSION);
    assert.equal(record.hardware.chip.value, 'ESP32');
    assert.equal(record.hardware.chipRevision.value, '3');
    assert.equal(record.hardware.mac.value, '24:6F:28:AA:BB:CC');
    assert.equal(record.firmware.agentVersion.value, '1.0.0');
    assert.equal(record.profileId, 'pn532');
    assert.equal(record.configuration.frequencyHz, 100000);
    assert.ok(record.timestamp);
  });

  it('rejects an experiment with no objective before touching hardware', async () => {
    const transport = useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      objective: '',
      targetComponent: 'pn532',
      procedure: [{ probeId: 'pn532.firmware_version' }],
    });

    assert.equal(report.success, false);
    assert.ok(report.errors.some((e) => /objective` is required/.test(e)));
    assert.equal(transport.calls.length, 0, 'no hardware access on a rejected definition');
  });

  it('rejects a procedure with no resolvable steps', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'No steps',
      interface: 'I2C',
    });
    assert.equal(report.success, false);
    assert.ok(report.errors.some((e) => /No procedure steps/.test(e)));
  });

  it('rejects an unknown target component', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Unknown part',
      targetComponent: 'no-such-part',
    });
    assert.equal(report.success, false);
    assert.match(report.error!, /No registered component profile/);
  });

  it('defaults the procedure to the profile probes when none is supplied', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Default procedure',
      targetComponent: 'pn532',
      address: 0x24,
    });

    assert.ok(report.observations.length > 0);
    assert.ok(report.observations.some((o) => o.probeId.startsWith('pn532.')));
  });

  it('fails configuration verification when the agent does not respond', async () => {
    setTransportFactory(() => absentAgentTransport());
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Agent absent',
      targetComponent: 'pn532',
      address: 0x24,
      procedure: [{ probeId: 'pn532.firmware_version' }],
    });

    assert.equal(report.success, false);
    const verify = report.phases.find((p) => p.phase === 'VERIFY_CONFIGURATION')!;
    assert.equal(verify.ok, false);
  });

  it('requires an I2C address for an I2C experiment', async () => {
    const transport = new MockTransport({ handlers: PN532_I2C_HANDLERS });
    const report = await runExperiment(
      {
        objective: 'Missing address',
        interface: 'I2C',
        configuration: { interface: 'I2C' },
        procedure: [{ probeId: 'pn532.presence' }],
      },
      { transport, profile: PN532_PROFILE }
    );

    const verify = report.phases.find((p) => p.phase === 'VERIFY_CONFIGURATION')!;
    assert.equal(verify.ok, false);
    assert.ok(verify.errors.some((e) => /requires an address/.test(e)));
  });

  it('caps repetitions at the documented maximum', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Too many repetitions',
      targetComponent: 'pn532',
      address: 0x24,
      procedure: [{ probeId: 'pn532.presence' }],
      repetitions: 500,
    });

    // The tool-level validator rejects >50 before the runner's own cap applies.
    assert.equal(report.success, false);
    assert.match(report.error!, /repetitions must be between 1 and 50/);
    assert.equal(MAX_REPETITIONS, 50);
  });
});

describe('consistency analysis', () => {
  it('reports a stable device as stable with full agreement', () => {
    const result = analyseConsistency([[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
    assert.equal(result.stable, true);
    assert.equal(result.agreement, 1);
    assert.equal(result.distinctResponses.length, 1);
  });

  it('reports an unstable device with partial agreement', () => {
    const result = analyseConsistency([[1], [1], [2]]);
    assert.equal(result.stable, false);
    assert.equal(result.agreement, 0.6667, 'agreement is reported rounded to 4 decimal places');
    assert.equal(result.distinctResponses.length, 2);
    assert.match(result.note, /marginal wiring|busy device|varying state/);
  });

  it('handles the no-response case without inventing an answer', () => {
    const result = analyseConsistency([]);
    assert.equal(result.stable, false);
    assert.equal(result.agreement, 0);
    assert.match(result.note, /could not be assessed/);
  });
});

describe('reproducibility records', () => {
  it('marks unavailable facts UNKNOWN rather than blank', () => {
    const record = buildReproducibility({ interface: 'I2C' });
    assert.equal(record.hardware.chip.known, false);
    assert.equal(record.firmware.agentVersion.known, false);
    assert.equal(record.mcpVersion, MCP_VERSION);
  });

  it('reports UNKNOWN facts when the agent cannot answer sys.info', async () => {
    const facts = await captureReproducibilityFacts(absentAgentTransport());
    assert.equal(facts.hardware?.chip.known, false);
    assert.equal(facts.firmware?.agentVersion.known, false);
  });

  it('captures identity facts when the agent answers', async () => {
    const facts = await captureReproducibilityFacts(
      new MockTransport({ handlers: PN532_I2C_HANDLERS })
    );
    assert.equal(facts.hardware?.chip.value, 'ESP32');
    assert.equal(facts.hardware?.chip.source, 'FIRMWARE_REPORT');
    assert.equal(facts.firmware?.applicationName.value, 'esp32-interrogation-agent');
  });
});

describe('transport', () => {
  it('fails cleanly with no port instead of throwing', async () => {
    const transport = await createTransport(undefined);
    const result = await transport.request('sys.ping');
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'NO_TRANSPORT');
    assert.equal(transport.describe().port, null);
  });

  it('rejects an invalid port name', async () => {
    const transport = await createTransport('not-a-port');
    const result = await transport.request('sys.ping');
    assert.equal(result.ok, false);
    assert.match(result.error!, /Invalid serial port/);
  });

  it('builds a python-bridge transport for a valid port', async () => {
    const transport = await createTransport('/dev/ttyUSB0');
    assert.ok(transport instanceof PythonBridgeTransport);
    const descriptor = transport.describe();
    assert.equal(descriptor.kind, 'python-bridge');
    assert.equal(descriptor.port, '/dev/ttyUSB0');
    assert.equal(descriptor.baud, 115200);
  });

  it('describes an unavailable transport with the reason', () => {
    const transport = new UnavailableTransport('nothing attached');
    assert.equal(transport.describe().detail, 'nothing attached');
  });

  it('builds a failure result that preserves the raw capture', () => {
    const failure = transportFailure('i2c.scan', 'boom', 'BUS_ERROR', 'RAW', 12);
    assert.equal(failure.ok, false);
    assert.equal(failure.raw, 'RAW');
    assert.equal(failure.durationMs, 12);
    assert.equal(failure.data, null);
  });

  it('reports an unhandled op rather than pretending to succeed', async () => {
    const transport = new MockTransport({ handlers: {} });
    const result = await transport.request('i2c.scan');
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'UNSUPPORTED_OPERATION');
  });
});

describe('pin safety', () => {
  it('refuses SPI-flash pins on the classic ESP32', () => {
    const result = checkPins('ESP32', [{ signal: 'SDA', gpio: 6, mustOutput: true }]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /reserved on ESP32/);
  });

  it('refuses an input-only pin for an output signal', () => {
    const result = checkPins('ESP32', [{ signal: 'MOSI', gpio: 36, mustOutput: true }]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /input-only/);
  });

  it('allows an input-only pin for an input signal', () => {
    const result = checkPins('ESP32', [{ signal: 'MISO', gpio: 36 }]);
    assert.equal(result.ok, true);
  });

  it('detects a pin assigned to two signals', () => {
    const result = checkPins('ESP32', [
      { signal: 'SDA', gpio: 21 },
      { signal: 'SCL', gpio: 21 },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /assigned to both/);
  });

  it('warns rather than blocking when the chip family is unknown', () => {
    const result = checkPins('UNKNOWN', [{ signal: 'SDA', gpio: 21 }]);
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => /could not be checked/.test(w)));
  });

  it('ignores unspecified pins', () => {
    const result = checkPins('ESP32', [{ signal: 'SDA', gpio: undefined }]);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });
});

describe('esp32 catalog', () => {
  it('maps chip strings to families, longest match first', () => {
    assert.equal(normaliseFamily('ESP32-S3'), 'ESP32-S3');
    assert.equal(normaliseFamily('esp32s3'), 'ESP32-S3');
    assert.equal(normaliseFamily('ESP32-C3'), 'ESP32-C3');
    assert.equal(normaliseFamily('ESP32'), 'ESP32');
    assert.equal(normaliseFamily('ESP8266'), 'ESP8266');
  });

  it('returns UNKNOWN for an unrecognised chip rather than defaulting', () => {
    assert.equal(normaliseFamily('STM32F4'), 'UNKNOWN');
    assert.equal(normaliseFamily(null), 'UNKNOWN');
    assert.equal(normaliseFamily(''), 'UNKNOWN');
    assert.equal(getFamilySpec('UNKNOWN').cores, 0);
  });

  it('reports family-specific peripheral differences', () => {
    assert.equal(getFamilySpec('ESP32').dacChannels, 2);
    assert.equal(getFamilySpec('ESP32-S3').dacChannels, 0, 'S3 has no DAC');
    assert.equal(getFamilySpec('ESP32-C3').i2cControllers, 1);
    assert.equal(getFamilySpec('ESP32-H2').wifi, false);
  });

  it('lists reserved flash pins per family', () => {
    assert.deepEqual(reservedPins('ESP32'), [6, 7, 8, 9, 10, 11]);
    assert.deepEqual(reservedPins('ESP32-C3'), []);
  });

  it('identifies USB-UART bridges from a port description', () => {
    assert.equal(identifyUsbBridge('Silicon Labs CP2102 USB to UART Bridge'), 'Silicon Labs CP210x');
    assert.equal(identifyUsbBridge('USB Serial CH340'), 'WCH CH34x');
    assert.equal(identifyUsbBridge('Something unrecognised'), null);
    assert.equal(identifyUsbBridge(null), null);
  });
});

describe('interrogation depth', () => {
  it('orders the depths', () => {
    assert.ok(depthRank('BASIC') < depthRank('STANDARD'));
    assert.ok(depthRank('STANDARD') < depthRank('DEEP'));
    assert.ok(depthRank('DEEP') < depthRank('FORENSIC'));
  });

  it('gates probes by their minimum depth', () => {
    const probe = { ...PN532_PROFILE.safeProbes[0], minDepth: 'DEEP' as const };
    assert.equal(shouldRunProbe(probe, 'BASIC'), false);
    assert.equal(shouldRunProbe(probe, 'DEEP'), true);
    assert.equal(shouldRunProbe(probe, 'FORENSIC'), true);
  });

  it('treats a probe with no minimum depth as BASIC', () => {
    const probe = { ...PN532_PROFILE.safeProbes[0] };
    delete probe.minDepth;
    assert.equal(shouldRunProbe(probe, 'BASIC'), true);
  });

  it('falls back to a safe default for an unrecognised depth string', () => {
    assert.equal(coerceDepth('nonsense'), 'STANDARD');
    assert.equal(coerceDepth('forensic'), 'FORENSIC');
    assert.equal(coerceDepth(undefined, 'BASIC'), 'BASIC');
  });
});

describe('port resolution', () => {
  it('accepts a valid explicit port', async () => {
    const result = await resolvePort('/dev/ttyUSB0');
    assert.equal(result.known, true);
    assert.equal(result.value, '/dev/ttyUSB0');
    assert.equal(result.source, 'USER_SUPPLIED');
  });

  it('rejects an invalid explicit port', async () => {
    const result = await resolvePort('; rm -rf /');
    assert.equal(result.known, false);
    assert.match(result.evidence!, /Invalid serial port/);
  });

  it('degrades to UNKNOWN when auto-resolution is unavailable', async () => {
    const previous = process.env.FIRMWARE_TOOLKIT_PATH;
    delete process.env.FIRMWARE_TOOLKIT_PATH;
    try {
      const result = await resolvePort();
      assert.equal(result.known, false);
      assert.ok(result.evidence);
    } finally {
      if (previous !== undefined) process.env.FIRMWARE_TOOLKIT_PATH = previous;
    }
  });
});
