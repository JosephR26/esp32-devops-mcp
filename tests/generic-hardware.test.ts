/**
 * The general-purpose hardware layer.
 *
 * These tests exist to prove one property: Claude can use the ESP32 as a
 * physical experimentation instrument and investigate a component beyond
 * anything the authors of this MCP anticipated.
 *
 * Everything here runs against mocked hardware. No physical device is required.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { hardwareExecute, pinCapabilityReport } from '../src/tools/execute.js';
import { componentProbe, hardwareExperiment, registerInspect } from '../src/tools/component.js';
import {
  buildAgentRequest,
  executeOperationSequence,
  validateOperation,
  MAX_OPERATIONS_PER_SEQUENCE,
} from '../src/hardware/operations.js';
import { pinCapabilities, pinCapability, strappingPins } from '../src/hardware/esp32-catalog.js';
import { resetTransportFactory, setTransportFactory } from '../src/hardware/transport.js';
import {
  GENERIC_AGENT_HANDLERS,
  MPU6050_I2C_HANDLERS,
  MockTransport,
  type MockHandler,
} from './helpers/mock-hardware.js';
import type { RawOperation } from '../src/types/hardware.js';

function useMock(handlers: Record<string, MockHandler> = GENERIC_AGENT_HANDLERS): MockTransport {
  const transport = new MockTransport({ handlers });
  setTransportFactory(() => transport);
  return transport;
}

afterEach(() => resetTransportFactory());

// ===========================================================================
// 1 & 16. No profile required
// ===========================================================================

describe('investigation without a component profile', () => {
  it('runs a full multi-interface investigation with no profile whatsoever', async () => {
    useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        { op: 'I2C_SCAN', bus: { sda: 21, scl: 22 } },
        { op: 'I2C_WRITE', address: 0x42, write: [0xab, 0xcd] },
        { op: 'SPI_TRANSFER', bus: { cs: 5, sclk: 18, miso: 19, mosi: 23 }, tx: [0x01, 0x02] },
        { op: 'GPIO_SAMPLE', pins: [32, 33], samples: 4 },
        { op: 'ADC_READ', pin: 34, samples: 8 },
      ],
    });

    assert.equal(report.success, true);
    assert.equal(report.executed, 5);
    assert.equal(report.rejected, 0);
  });

  it('reports an unknown component as investigable, not blocked', async () => {
    // A device that answers but matches no profile — the case that matters.
    useMock();
    const report = await componentProbe({
      port: '/dev/ttyUSB0',
      interface: 'I2C',
      address: 0x11,
    });

    assert.ok(report.warnings.some((w) => /starting point, not a limit/.test(w)));
    assert.ok(report.warnings.some((w) => /UNKNOWN, not forbidden/.test(w)));
  });

  it('runs an experiment made entirely of inline operations, with no targetComponent', async () => {
    useMock();
    const report = await hardwareExperiment({
      port: '/dev/ttyUSB0',
      objective: 'Characterise an entirely unknown device',
      interface: 'I2C',
      address: 0x42,
      procedure: [
        { operation: { op: 'I2C_WRITE', address: 0x42, write: [0x00] }, description: 'select' },
        { operation: { op: 'I2C_READ', address: 0x42, length: 8 }, description: 'read back' },
      ],
    });

    assert.equal(report.success, true);
    assert.equal(report.observations.length, 2);
    assert.equal(report.reproducibility.profileId, undefined);
  });
});

// ===========================================================================
// 2. A profile accelerates but does not gate
// ===========================================================================

describe('profiles accelerate rather than gate', () => {
  it('decodes bitfields when a profile is supplied', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      registers: ['PWR_MGMT_1'],
    });

    assert.equal(report.registers[0].name, 'PWR_MGMT_1');
    assert.ok(report.registers[0].fields.length > 0, 'the profile supplied field decoding');
  });

  it('reads the same register raw when no profile is supplied', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      address: 0x68,
      registers: [0x6b],
    });

    assert.equal(report.success, true, 'the read happens either way');
    assert.equal(report.registers[0].fields.length, 0, 'no profile means no decoding');
    assert.ok(report.registers[0].rawValue.known, 'the value is still obtained');
  });

  it('reads registers a profile does not describe, alongside those it does', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      registers: [0x75, 0x41],
    });

    // 0x75 is in the profile; 0x41 is TEMP_OUT which is also declared. Use a
    // genuinely undocumented address to prove the point.
    const undocumented = await registerInspect({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      registers: [0x1c],
    });

    assert.ok(report.registers.length >= 1);
    assert.ok(undocumented.success);
  });
});

// ===========================================================================
// 3-6. Arbitrary transactions on every bus, including writes
// ===========================================================================

describe('arbitrary transactions', () => {
  it('passes arbitrary I2C write bytes through unaltered', async () => {
    const transport = useMock();
    const payload = [0xde, 0xad, 0xbe, 0xef, 0x00, 0xff];

    await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'I2C_WRITE', address: 0x42, write: payload }],
    });

    const call = transport.calls.find((c) => c.op === 'i2c.write')!;
    assert.deepEqual(call.params.write, payload, 'no filtering, no allow-list');
  });

  it('supports an I2C write/read with a repeated start and an inter-phase delay', async () => {
    const transport = useMock();
    await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        {
          op: 'I2C_WRITE_READ',
          address: 0x42,
          write: [0x7f, 0x01],
          readLength: 16,
          delayMs: 25,
          repeatedStart: true,
        },
      ],
    });

    const call = transport.calls.find((c) => c.op === 'i2c.writeRead')!;
    assert.deepEqual(call.params.write, [0x7f, 0x01]);
    assert.equal(call.params.readLength, 16);
    assert.equal(call.params.delayMs, 25);
    assert.equal(call.params.repeatedStart, true);
  });

  it('passes arbitrary SPI bytes through with full bus control', async () => {
    const transport = useMock();
    await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        {
          op: 'SPI_TRANSFER',
          bus: { cs: 5, sclk: 18, miso: 19, mosi: 23, mode: 3, clockHz: 4_000_000, bitOrder: 'LSB_FIRST' },
          tx: [0x9f, 0x55, 0xaa],
          readLength: 4,
          padByte: 0xff,
        },
      ],
    });

    const call = transport.calls.find((c) => c.op === 'spi.transfer')!;
    assert.deepEqual(call.params.tx, [0x9f, 0x55, 0xaa]);
    assert.equal(call.params.mode, 3);
    assert.equal(call.params.clockHz, 4_000_000);
    assert.equal(call.params.lsbFirst, true);
    assert.equal(call.params.padByte, 0xff);
  });

  it('passes arbitrary UART bytes through with configurable framing', async () => {
    const transport = useMock();
    await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        {
          op: 'UART_WRITE_READ',
          bus: { rx: 16, tx: 17, baud: 57600, parity: 'even', stopBits: 2, dataBits: 7 },
          write: [0x01, 0x03, 0x00, 0x00],
          readLength: 8,
          timeoutMs: 500,
        },
      ],
    });

    const call = transport.calls.find((c) => c.op === 'uart.writeRead')!;
    assert.deepEqual(call.params.write, [0x01, 0x03, 0x00, 0x00]);
    assert.equal(call.params.baud, 57600);
    assert.equal(call.params.parity, 'even');
    assert.equal(call.params.stopBits, 2);
  });

  it('permits a register write to an undocumented address', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      address: 0x68,
      writes: [
        { register: 0x6b, value: [0x00], justification: 'Attempt to clear the sleep bit' },
      ],
      readBackAfterWrite: false,
    });

    assert.ok(report.writes);
    assert.equal(report.writes!.length, 1);
    assert.equal(report.writes![0].register, 0x6b);
    assert.equal(report.writes![0].justification, 'Attempt to clear the sleep bit');
    assert.equal(report.readOnly, false, 'the report states a write occurred');
  });

  it('records the value before a write so the effect is observable', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      address: 0x68,
      writes: [{ register: 0x6b, value: [0x00] }],
    });

    assert.equal(report.writes![0].valueBeforeHex, '01');
    assert.ok(report.registersAfterWrite, 'state is re-read after the write');
  });

  it('does not claim a write verified anything', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      address: 0x68,
      writes: [{ register: 0x6b, value: [0x00] }],
    });

    assert.match(report.writes![0].note, /does not establish that the device did what/);
  });
});

// ===========================================================================
// 7-9. GPIO, ADC and PWM stimulus
// ===========================================================================

describe('GPIO, ADC and stimulus operations', () => {
  it('drives a GPIO output', async () => {
    const transport = useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        { op: 'GPIO_CONFIGURE', pin: 25, mode: 'OUTPUT' },
        { op: 'GPIO_WRITE', pin: 25, level: 1 },
        { op: 'GPIO_PULSE', pin: 25, level: 0, durationUs: 500 },
      ],
    });

    assert.equal(report.success, true);
    assert.equal(transport.countOf('gpio.write'), 1);
    assert.equal(transport.countOf('gpio.pulse'), 1);
  });

  it('samples multiple GPIO on one timebase', async () => {
    useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'GPIO_SAMPLE', pins: [32, 33, 34], samples: 6, intervalUs: 500 }],
    });

    const outcome = report.operations[0];
    assert.equal(outcome.ok, true);
    assert.equal(outcome.samples.length, 18, '6 rounds x 3 pins');
    assert.ok(outcome.statistics);
  });

  it('samples the ADC and derives statistics without discarding the raw samples', async () => {
    useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'ADC_READ', pin: 34, samples: 10, intervalUs: 100 }],
    });

    const outcome = report.operations[0];
    assert.equal(outcome.samples.length, 10);
    assert.equal(outcome.statistics!.count, 10);
    assert.equal(outcome.statistics!.min, 2048);
    assert.ok(outcome.raw.raw.length > 0, 'raw retained alongside the statistics');
  });

  it('generates a PWM stimulus', async () => {
    const transport = useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        { op: 'PWM_START', pin: 25, frequencyHz: 5000, duty: 0.25, durationMs: 100 },
        { op: 'PWM_STOP', pin: 25 },
      ],
    });

    assert.equal(report.success, true);
    const start = transport.calls.find((c) => c.op === 'pwm.start')!;
    assert.equal(start.params.frequencyHz, 5000);
    assert.equal(start.params.duty, 0.25);
  });

  it('measures pulse width, frequency and edge timing', async () => {
    useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        { op: 'GPIO_MEASURE_PULSE', pin: 32, level: 1, timeoutUs: 100000 },
        { op: 'GPIO_MEASURE_FREQUENCY', pin: 32, windowMs: 100 },
        { op: 'GPIO_WAIT_EDGE', pin: 32, edge: 'RISING', timeoutMs: 500 },
      ],
    });

    assert.equal(report.success, true);
    assert.deepEqual(report.operations[0].samples, [1234]);
    assert.equal(report.operations[1].data!.frequencyHz, 1000);
  });

  it('drives a stimulus on one pin while capturing others', async () => {
    const transport = useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        {
          op: 'STIMULUS_CAPTURE',
          stimulus: { pin: 25, kind: 'PULSE', level: 1, durationUs: 200, cycles: 2 },
          capturePins: [32, 33],
          samples: 8,
          intervalUs: 100,
        },
      ],
    });

    assert.equal(report.success, true);
    const call = transport.calls.find((c) => c.op === 'gpio.stimulusCapture')!;
    assert.deepEqual(call.params.capturePins, [32, 33]);
    assert.ok(report.operations[0].data!.stimulusLevels, 'stimulus trace shares the timebase');
  });
});

// ===========================================================================
// 10 & 11. Repetition and adaptive sequencing
// ===========================================================================

describe('repeated and adaptive investigation', () => {
  it('repeats a sequence and keeps every run separately', async () => {
    useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'I2C_READ', address: 0x42, length: 4 }],
      repetitions: 5,
    });

    assert.equal(report.repetitions, 5);
    assert.equal(report.runs!.length, 5);
    assert.equal(report.executed, 5);
    assert.ok(report.notes.some((n) => /a single run cannot/.test(n)));
  });

  it('supports an adaptive loop: results from one call shape the next', async () => {
    useMock();

    // Step 1: observe.
    const first = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'I2C_READ', address: 0x42, length: 1 }],
    });
    assert.equal(first.success, true);
    const observed = first.operations[0].bytes[0];

    // Step 2: construct the next experiment from what was observed.
    const second = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'I2C_WRITE', address: 0x42, write: [observed ^ 0xff] }],
    });

    assert.equal(second.success, true);
    assert.equal(second.operations[0].request.op, 'I2C_WRITE');
  });

  it('continues past a failed operation so partial results survive', async () => {
    useMock({
      ...GENERIC_AGENT_HANDLERS,
      'i2c.read': () => ({ error: 'NACK', errorKind: 'DEVICE_ERROR' }),
    });

    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        { op: 'I2C_READ', address: 0x42, length: 1 },
        { op: 'GPIO_READ', pins: [32] },
      ],
    });

    assert.equal(report.operations.length, 2, 'the second operation still ran');
    assert.equal(report.operations[1].ok, true);
  });

  it('stops at the first failure when asked to', async () => {
    useMock({
      ...GENERIC_AGENT_HANDLERS,
      'i2c.read': () => ({ error: 'NACK', errorKind: 'DEVICE_ERROR' }),
    });

    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        { op: 'I2C_READ', address: 0x42, length: 1 },
        { op: 'GPIO_READ', pins: [32] },
      ],
      stopOnError: true,
    });

    assert.equal(report.operations.length, 1);
  });
});

// ===========================================================================
// 12. Raw evidence always retained
// ===========================================================================

describe('raw evidence retention', () => {
  it('retains the raw agent response on every successful operation', async () => {
    useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [
        { op: 'I2C_READ', address: 0x42, length: 4 },
        { op: 'ADC_READ', pin: 34, samples: 3 },
      ],
    });

    for (const outcome of report.operations) {
      assert.equal(typeof outcome.raw.raw, 'string');
      assert.ok(outcome.raw.raw.length > 0);
      assert.ok(outcome.raw.timestamp);
      assert.ok(outcome.data, 'structured agent data retained too');
    }
  });

  it('retains the raw capture even when the operation fails', async () => {
    useMock({
      ...GENERIC_AGENT_HANDLERS,
      'i2c.read': () => ({ error: 'bus error', errorKind: 'BUS_ERROR', raw: 'RAW-FAILURE-TEXT' }),
    });

    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'I2C_READ', address: 0x42, length: 4 }],
    });

    assert.equal(report.operations[0].ok, false);
    assert.equal(report.operations[0].raw.raw, 'RAW-FAILURE-TEXT');
  });

  it('echoes the exact request back for reproducibility', async () => {
    useMock();
    const operation: RawOperation = { op: 'I2C_WRITE', address: 0x42, write: [0x11, 0x22] };
    const report = await hardwareExecute({ port: '/dev/ttyUSB0', operations: [operation] });

    assert.deepEqual(report.operations[0].request, operation);
    assert.ok(report.operations[0].agentRequest);
    assert.ok(report.reproducibility.mcpVersion);
  });

  it('never replaces the raw response with only an interpretation', async () => {
    useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'GPIO_SAMPLE', pins: [32], samples: 4 }],
    });

    const outcome = report.operations[0];
    assert.ok(outcome.raw.interpretation.length > 0, 'interpretation present');
    assert.ok(outcome.raw.raw.length > 0, 'and the raw is still there');
    assert.notEqual(outcome.raw.raw, outcome.raw.interpretation);
  });
});

// ===========================================================================
// 13-15. Real hardware safety survives; artificial limits do not
// ===========================================================================

describe('hardware safety validation', () => {
  it('refuses a pin wired to SPI flash', () => {
    const result = validateOperation({ op: 'GPIO_WRITE', pin: 7, level: 1 }, 'ESP32');
    assert.equal(result.ok, false);
    assert.equal(result.rejections[0].kind, 'PIN_RESERVED');
    assert.match(result.rejections[0].detail, /SPI flash/);
  });

  it('refuses to drive an input-only pin', () => {
    const result = validateOperation({ op: 'GPIO_WRITE', pin: 34, level: 1 }, 'ESP32');
    assert.equal(result.ok, false);
    assert.equal(result.rejections[0].kind, 'PIN_NOT_OUTPUT_CAPABLE');
  });

  it('allows reading an input-only pin', () => {
    const result = validateOperation({ op: 'GPIO_READ', pins: [34] }, 'ESP32');
    assert.equal(result.ok, true);
  });

  it('refuses ADC on a pin with no ADC channel', () => {
    const result = validateOperation({ op: 'ADC_READ', pin: 21 }, 'ESP32');
    assert.equal(result.ok, false);
    assert.equal(result.rejections[0].kind, 'PIN_NOT_ADC_CAPABLE');
  });

  it('accepts ADC on a genuinely ADC-capable pin', () => {
    assert.equal(validateOperation({ op: 'ADC_READ', pin: 34 }, 'ESP32').ok, true);
    assert.equal(validateOperation({ op: 'ADC_READ', pin: 32 }, 'ESP32').ok, true);
  });

  it('refuses a PWM configuration the LEDC clock cannot produce', () => {
    const result = validateOperation(
      { op: 'PWM_START', pin: 25, frequencyHz: 1_000_000, duty: 0.5, resolutionBits: 16 },
      'ESP32'
    );
    assert.equal(result.ok, false);
    assert.match(result.rejections[0].detail, /LEDC clock/);
  });

  it('accepts a PWM configuration that fits the clock', () => {
    const result = validateOperation(
      { op: 'PWM_START', pin: 25, frequencyHz: 5000, duty: 0.5, resolutionBits: 10 },
      'ESP32'
    );
    assert.equal(result.ok, true);
  });

  it('refuses out-of-range bus parameters', () => {
    assert.equal(
      validateOperation({ op: 'I2C_READ', bus: { frequencyHz: 5_000_000 }, address: 0x10, length: 1 }, 'ESP32').ok,
      false
    );
    assert.equal(
      validateOperation({ op: 'I2C_READ', address: 0x99, length: 1 }, 'ESP32').ok,
      false
    );
  });

  it('refuses malformed byte payloads', () => {
    const result = validateOperation(
      { op: 'I2C_WRITE', address: 0x10, write: [0x00, 300] },
      'ESP32'
    );
    assert.equal(result.ok, false);
    assert.equal(result.rejections[0].kind, 'MALFORMED_ARGUMENTS');
  });

  it('refuses SPI without a named chip-select', () => {
    const result = validateOperation({ op: 'SPI_TRANSFER', tx: [0x01] }, 'ESP32');
    assert.equal(result.ok, false);
    assert.match(result.rejections[0].detail, /chip-select/);
  });

  it('refuses to sample the very pin it is driving as a stimulus', () => {
    const result = validateOperation(
      {
        op: 'STIMULUS_CAPTURE',
        stimulus: { pin: 25, kind: 'PULSE' },
        capturePins: [25],
        samples: 4,
      },
      'ESP32'
    );
    assert.equal(result.ok, false);
    assert.equal(result.rejections[0].kind, 'PIN_CONFLICT');
  });

  it('accepts valid dynamically-routed pins that are not board defaults', () => {
    // The GPIO matrix routes most signals to most pins; I2C on 13/14 is valid
    // even though the board default is 21/22.
    const result = validateOperation(
      { op: 'I2C_SCAN', bus: { sda: 13, scl: 14 } },
      'ESP32'
    );
    assert.equal(result.ok, true);
  });

  it('warns about a strapping pin without refusing it', () => {
    const result = validateOperation({ op: 'GPIO_WRITE', pin: 12, level: 1 }, 'ESP32');
    assert.equal(result.ok, true, 'strapping pins are usable');
    assert.ok(result.warnings.some((w) => /Strapping pin/.test(w)));
  });

  it('defers to the agent when the chip family is unknown rather than refusing', () => {
    const result = validateOperation({ op: 'GPIO_WRITE', pin: 7, level: 1 }, 'UNKNOWN');
    assert.equal(result.ok, true, 'the host cannot check, so the agent does');
  });

  it('bounds a sequence to a workable size and says why', async () => {
    useMock();
    const operations: RawOperation[] = Array.from(
      { length: MAX_OPERATIONS_PER_SEQUENCE + 1 },
      () => ({ op: 'DELAY', ms: 0 })
    );
    const report = await hardwareExecute({ port: '/dev/ttyUSB0', operations });

    assert.equal(report.success, false);
    assert.match(report.error!, /Split across calls/);
  });
});

// ===========================================================================
// 17. Depths are presets, not ceilings
// ===========================================================================

describe('interrogation depths are presets', () => {
  it('runs additional probes beyond what the depth preset selects', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const preset = await componentProbe({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      depth: 'BASIC',
    });
    const extended = await componentProbe({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      depth: 'BASIC',
      additionalProbes: ['mpu6050.read_accel'],
    });

    const ranInPreset = preset.probes.filter((p) => p.executed).length;
    const ranExtended = extended.probes.filter((p) => p.executed).length;
    assert.ok(ranExtended > ranInPreset, 'BASIC did not cap what could be run');
    assert.ok(extended.probes.some((p) => p.probeId === 'mpu6050.read_accel' && p.executed));
  });

  it('forces register inspection on regardless of depth', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await componentProbe({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      depth: 'BASIC',
      inspectRegisters: true,
    });

    assert.ok(report.registers, 'registers inspected at BASIC when asked');
  });

  it('runs arbitrary operations alongside profile probes at any depth', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const report = await componentProbe({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      depth: 'BASIC',
      additionalOperations: [{ op: 'I2C_READ', address: 0x68, length: 4 }],
    });

    assert.ok(report.additionalOperations);
    assert.equal(report.additionalOperations!.length, 1);
    assert.equal(report.additionalOperations![0].ok, true);
  });

  it('permits another experiment after FORENSIC completes', async () => {
    useMock(MPU6050_I2C_HANDLERS);
    const forensic = await componentProbe({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      depth: 'FORENSIC',
    });
    assert.equal(forensic.depth, 'FORENSIC');

    // FORENSIC is the most thorough preset, not the end of what is possible.
    const after = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'I2C_WRITE', address: 0x68, write: [0x1c, 0x18] }],
    });
    assert.equal(after.success, true);
  });
});

// ===========================================================================
// 18-20. Discovery beyond the profile; OBSERVED is not VERIFIED
// ===========================================================================

describe('evidence discipline for generic experimentation', () => {
  it('reports a successful arbitrary operation as OBSERVED, never VERIFIED', async () => {
    useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'I2C_READ', address: 0x42, length: 4 }],
    });

    assert.equal(report.success, true);
    assert.equal(report.evidenceTier, 'OBSERVED');
    assert.notEqual(report.evidenceTier as string, 'VERIFIED');
    assert.ok(
      report.notes.some((n) => /not a verification of device identity or capability/.test(n))
    );
  });

  it('reports UNKNOWN rather than OBSERVED when nothing succeeded', async () => {
    useMock({
      ...GENERIC_AGENT_HANDLERS,
      'i2c.read': () => ({ error: 'no device', errorKind: 'DEVICE_ERROR' }),
    });

    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'I2C_READ', address: 0x42, length: 4 }],
    });

    assert.equal(report.evidenceTier, 'UNKNOWN');
  });

  it('leaves interpretation to the caller rather than asserting meaning', async () => {
    useMock();
    const report = await hardwareExecute({
      port: '/dev/ttyUSB0',
      operations: [{ op: 'I2C_READ', address: 0x42, length: 2 }],
    });

    // The interpretation states what arrived, not what it signifies.
    assert.match(report.operations[0].raw.interpretation, /received 2 byte\(s\)/);
    assert.ok(report.notes.some((n) => /caller's to make/.test(n)));
  });

  it('retains an undocumented response rather than rejecting it', async () => {
    useMock({
      ...MPU6050_I2C_HANDLERS,
      'i2c.writeRead': () => ({
        data: { writeAck: true, writeStatus: 0, bytes: [0x99], durationUs: 300 },
      }),
    });

    // 0x99 is not the documented WHO_AM_I value, and the register is not in the
    // profile. The value must still come back.
    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      address: 0x68,
      registers: [0x0f],
    });

    assert.equal(report.success, true);
    assert.equal(report.registers[0].rawValue.value, 0x99);
  });

  it('discovers something absent from the component profile', async () => {
    useMock({
      ...MPU6050_I2C_HANDLERS,
      'i2c.writeRead': (params) => {
        const register = ((params.write as number[]) ?? [])[0];
        // An undocumented register that answers — exactly the case a
        // profile-gated system would never find.
        if (register === 0x7e) {
          return { data: { writeAck: true, writeStatus: 0, bytes: [0xc3], durationUs: 300 } };
        }
        return { data: { writeAck: true, writeStatus: 0, bytes: [0x68], durationUs: 300 } };
      },
    });

    const report = await registerInspect({
      port: '/dev/ttyUSB0',
      component: 'mpu6050',
      address: 0x68,
      registers: [0x7e],
    });

    const found = report.registers.find((r) => r.rawValue.value === 0xc3);
    assert.ok(found, 'the undocumented register was read');
    assert.ok(report.warnings.some((w) => /absent from the MPU-6050 profile/.test(w)));
  });
});

// ===========================================================================
// Pin capability reporting
// ===========================================================================

describe('esp32_pin_capabilities', () => {
  it('reports real per-pin capability for the detected chip', async () => {
    useMock();
    const report = await pinCapabilityReport({ port: '/dev/ttyUSB0' });

    assert.equal(report.success, true);
    assert.equal(report.chip.value, 'ESP32');

    const flash = report.pins.find((p) => p.gpio === 7)!;
    assert.equal(flash.usable, false);
    assert.match(flash.unusableReason!, /SPI flash/);

    const inputOnly = report.pins.find((p) => p.gpio === 34)!;
    assert.equal(inputOnly.digitalInput, true);
    assert.equal(inputOnly.digitalOutput, false);
    assert.equal(inputOnly.adc, true);
  });

  it('filters to pins supporting a given capability', async () => {
    useMock();
    const report = await pinCapabilityReport({ port: '/dev/ttyUSB0', filter: 'DAC' });
    assert.deepEqual(report.pins.map((p) => p.gpio).sort((a, b) => a - b), [25, 26]);
  });

  it('reports what the running firmware currently has allocated', async () => {
    useMock();
    const report = await pinCapabilityReport({ port: '/dev/ttyUSB0', pins: [21, 22] });
    assert.ok(report.pins.find((p) => p.gpio === 21)!.currentAllocation.includes('default I2C SDA'));
  });

  it('states which capabilities the agent build does not provide', async () => {
    useMock();
    const report = await pinCapabilityReport({ port: '/dev/ttyUSB0' });
    assert.ok(report.unavailable.some((u) => /i2s/i.test(u.capability)));
    assert.ok(report.unavailable.every((u) => u.reason.length > 0));
  });

  it('labels datasheet-derived pin data as DOCUMENTED, not measured', async () => {
    useMock();
    const report = await pinCapabilityReport({ port: '/dev/ttyUSB0' });
    assert.ok(report.notes.some((n) => /DOCUMENTED, not measured/.test(n)));
    assert.equal(report.peripherals.i2cControllers!.confidence, 'DOCUMENTED');
  });

  it('notes GPIO matrix flexibility rather than implying fixed pinouts', async () => {
    useMock();
    const report = await pinCapabilityReport({ port: '/dev/ttyUSB0' });
    assert.ok(report.notes.some((n) => /GPIO matrix routes most peripheral signals/.test(n)));
  });
});

describe('pin capability catalog', () => {
  it('knows family-specific differences', () => {
    assert.equal(pinCapability('ESP32', 25)!.dac, true);
    assert.equal(pinCapability('ESP32-S3', 25)?.dac ?? false, false, 'S3 has no DAC');
    assert.equal(pinCapability('ESP32-C3', 2)!.usable, true);
  });

  it('marks flash pins unusable only on the families that reserve them', () => {
    assert.equal(pinCapability('ESP32', 7)!.usable, false);
    assert.equal(pinCapability('ESP32-C3', 7)!.usable, true);
  });

  it('lists strapping pins as notes rather than refusals', () => {
    const pin = pinCapability('ESP32', 0)!;
    assert.equal(pin.usable, true);
    assert.ok(pin.notes.some((n) => /Strapping pin/.test(n)));
    assert.ok(strappingPins('ESP32').includes(0));
  });

  it('produces a complete pin map for each supported family', () => {
    for (const family of ['ESP32', 'ESP32-S2', 'ESP32-S3', 'ESP32-C3'] as const) {
      const pins = pinCapabilities(family);
      assert.ok(pins.length > 0, `${family} has pins`);
      assert.ok(pins.some((p) => p.usable), `${family} has usable pins`);
    }
  });
});

describe('agent request construction', () => {
  it('maps every operation kind to an agent op', () => {
    const operations: RawOperation[] = [
      { op: 'I2C_SCAN' },
      { op: 'I2C_READ', address: 1, length: 1 },
      { op: 'I2C_WRITE', address: 1, write: [1] },
      { op: 'I2C_WRITE_READ', address: 1, write: [1], readLength: 1 },
      { op: 'SPI_TRANSFER', tx: [1] },
      { op: 'UART_WRITE', write: [1] },
      { op: 'UART_READ', durationMs: 10 },
      { op: 'UART_WRITE_READ', write: [1], readLength: 1, timeoutMs: 10 },
      { op: 'GPIO_CONFIGURE', pin: 1, mode: 'INPUT' },
      { op: 'GPIO_READ', pins: [1] },
      { op: 'GPIO_WRITE', pin: 1, level: 1 },
      { op: 'GPIO_PULSE', pin: 1, level: 1, durationUs: 10 },
      { op: 'GPIO_SAMPLE', pins: [1], samples: 1 },
      { op: 'GPIO_MEASURE_PULSE', pin: 1, level: 1 },
      { op: 'GPIO_MEASURE_FREQUENCY', pin: 1, windowMs: 10 },
      { op: 'GPIO_WAIT_EDGE', pin: 1, edge: 'RISING', timeoutMs: 10 },
      { op: 'ADC_READ', pin: 34 },
      { op: 'PWM_START', pin: 1, frequencyHz: 100, duty: 0.5 },
      { op: 'PWM_STOP', pin: 1 },
      { op: 'STIMULUS_CAPTURE', stimulus: { pin: 1, kind: 'PULSE' }, capturePins: [2], samples: 1 },
    ];

    for (const operation of operations) {
      const request = buildAgentRequest(operation);
      assert.ok(request, `${operation.op} maps to an agent op`);
      assert.ok(request!.op.includes('.'), `${operation.op} -> ${request!.op}`);
    }

    assert.equal(buildAgentRequest({ op: 'DELAY', ms: 1 }), null, 'DELAY is host-side');
  });

  it('flags an operation the agent firmware does not implement', async () => {
    const transport = new MockTransport({ handlers: { 'sys.ping': () => ({ data: {} }) } });
    const result = await executeOperationSequence([{ op: 'GPIO_READ', pins: [32] }], {
      transport,
      family: 'ESP32',
    });

    assert.equal(result.operations[0].ok, false);
    assert.ok(
      result.operations[0].warnings.some((w) => /does not implement/.test(w)),
      'an unimplemented op is reported as unavailable, not as a mysterious failure'
    );
  });
});
