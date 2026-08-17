/**
 * Mocked hardware for CI.
 *
 * The whole interrogation pipeline runs against these fakes, so no physical
 * device is required to test it. The mocks model the failure modes that matter:
 * silence, malformed responses, timeouts, unstable devices and bus errors — not
 * just the happy path.
 */

import type {
  HardwareTransport,
  TransportDescriptor,
  TransportErrorKind,
  TransportResult,
} from '../../src/types/hardware.js';

export interface MockCall {
  op: string;
  params: Record<string, unknown>;
}

export type MockHandler = (
  params: Record<string, unknown>,
  callIndex: number
) => { data?: unknown; raw?: string; error?: string; errorKind?: TransportErrorKind } | undefined;

export interface MockTransportOptions {
  /** Per-op handlers. An op with no handler returns UNSUPPORTED_OPERATION. */
  handlers?: Record<string, MockHandler>;
  /** Fail every request with this error, simulating an absent agent. */
  failAll?: { error: string; errorKind: TransportErrorKind };
  /**
   * Simulated round-trip time. The mock genuinely waits this long so wall-clock
   * timing in the benchmark path has something real to measure.
   */
  latencyMs?: number;
  descriptor?: Partial<TransportDescriptor>;
}

/** Transport that answers from a scripted handler table instead of a serial port. */
export class MockTransport implements HardwareTransport {
  readonly calls: MockCall[] = [];
  private readonly counts = new Map<string, number>();

  constructor(private readonly options: MockTransportOptions = {}) {}

  describe(): TransportDescriptor {
    return {
      kind: 'mock',
      port: '/dev/ttyUSB0',
      baud: 115200,
      detail: 'Mocked hardware transport',
      ...this.options.descriptor,
    };
  }

  /** How many times an op was requested. */
  countOf(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  async request<T = unknown>(
    op: string,
    params: Record<string, unknown> = {}
  ): Promise<TransportResult<T>> {
    this.calls.push({ op, params });
    const index = this.counts.get(op) ?? 0;
    this.counts.set(op, index + 1);

    if (this.options.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    }

    const base = {
      op,
      durationMs: this.options.latencyMs ?? 3,
      timestamp: new Date().toISOString(),
    };

    if (this.options.failAll) {
      return {
        ...base,
        ok: false,
        data: null,
        raw: '',
        error: this.options.failAll.error,
        errorKind: this.options.failAll.errorKind,
      };
    }

    const handler = this.options.handlers?.[op];
    if (!handler) {
      return {
        ...base,
        ok: false,
        data: null,
        raw: '',
        error: `Mock has no handler for op "${op}"`,
        errorKind: 'UNSUPPORTED_OPERATION',
      };
    }

    const result = handler(params, index);
    if (!result || result.error !== undefined) {
      return {
        ...base,
        ok: false,
        data: null,
        raw: result?.raw ?? '',
        error: result?.error ?? `Mock handler for "${op}" returned nothing`,
        errorKind: result?.errorKind ?? 'DEVICE_ERROR',
      };
    }

    return {
      ...base,
      ok: true,
      data: (result.data ?? null) as T,
      raw: result.raw ?? JSON.stringify({ ok: true, data: result.data }),
    };
  }
}

/** sys.ping / sys.info / sys.interfaces answers for a healthy ESP32 DevKitC-32. */
export const ESP32_DEVKITC_SYS_HANDLERS: Record<string, MockHandler> = {
  'sys.ping': () => ({ data: { agentVersion: '1.0.0', uptimeMs: 42000 } }),
  'sys.info': () => ({
    data: {
      agentVersion: '1.0.0',
      family: 'ESP32',
      cores: 2,
      revision: 3,
      cpuFrequencyMHz: 240,
      sdkVersion: 'v4.4.6',
      framework: 'arduino-esp32',
      resetReason: 'POWERON',
      uptimeMs: 42000,
      freeHeap: 285000,
      heapSize: 327680,
      minFreeHeap: 280000,
      sketchSize: 262144,
      sketchMD5: 'd41d8cd98f00b204e9800998ecf8427e',
      flashSizeBytes: 4194304,
      psramBytes: 0,
      mac: '24:6F:28:AA:BB:CC',
      features: ['WIFI_BGN', 'BT_CLASSIC', 'BLE', 'EMBEDDED_FLASH'],
      appName: 'esp32-interrogation-agent',
      appVersion: '1.0.0',
      buildInfo: 'Jan  1 2026 12:00:00',
      idfVersion: 'v4.4.6',
    },
    raw: '{"id":1,"ok":true,"data":{"family":"ESP32"}}',
  }),
  'sys.interfaces': () => ({
    data: {
      agentVersion: '1.0.0',
      cores: 2,
      cpuFrequencyMHz: 240,
      defaultI2CSda: 21,
      defaultI2CScl: 22,
      defaultSpiMosi: 23,
      defaultSpiMiso: 19,
      defaultSpiSclk: 18,
      defaultSpiCs: 5,
      monitorBaud: 115200,
      configuredPeripherals: ['UART0 (console, in use by this agent)'],
    },
  }),
};

/** A PN532 responding at 0x24 with the documented GetFirmwareVersion answer. */
export const PN532_I2C_HANDLERS: Record<string, MockHandler> = {
  ...ESP32_DEVKITC_SYS_HANDLERS,
  'i2c.scan': (params) => {
    const start = Number(params.start ?? 0x08);
    const end = Number(params.end ?? 0x77);
    const repeats = Number(params.repeats ?? 1);
    const addresses = [];
    if (start <= 0x24 && end >= 0x24) {
      addresses.push({ address: 0x24, ackCount: repeats, probeCount: repeats, busErrors: 0, responseTimeUs: 120 });
    }
    return { data: { addresses, scanDurationMs: 35, start, end } };
  },
  'i2c.read': (params) => {
    if (Number(params.address) !== 0x24) {
      return { error: 'No device at that address', errorKind: 'DEVICE_ERROR' };
    }
    const length = Number(params.length ?? 1);
    // Status byte 0x01 (ready) then the GetFirmwareVersion response frame:
    // 00 00 FF 06 FA D5 03 32 01 06 07 E8 00
    const frame = [
      0x01, 0x00, 0x00, 0xff, 0x06, 0xfa, 0xd5, 0x03, 0x32, 0x01, 0x06, 0x07, 0xe8, 0x00,
    ];
    return {
      data: { bytes: frame.slice(0, length), durationUs: 900, requested: length, received: Math.min(length, frame.length) },
      raw: '{"id":2,"ok":true,"data":{"bytes":[1,0,0,255]}}',
    };
  },
  'i2c.writeRead': (params) => {
    if (Number(params.address) !== 0x24) {
      return { data: { writeAck: false, writeStatus: 2, bytes: [], durationUs: 80 } };
    }
    const write = (params.write as number[]) ?? [];
    const readLength = Number(params.readLength ?? 0);
    // The ACK frame, prefixed by the I2C ready-status byte.
    const ack = [0x01, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00];

    // ReadRegister (D4 06) responses carry D5 07 followed by the value.
    if (write[5] === 0xd4 && write[6] === 0x06) {
      return { data: { writeAck: true, writeStatus: 0, bytes: ack.slice(0, readLength), durationUs: 1100 } };
    }
    return { data: { writeAck: true, writeStatus: 0, bytes: ack.slice(0, readLength), durationUs: 1000 } };
  },
};

/**
 * PN532 mock where the follow-up read returns the register response frame.
 * Used by register-inspection tests.
 */
export function pn532RegisterHandlers(registerValue: number): Record<string, MockHandler> {
  let lastWasRegisterRead = false;
  return {
    ...PN532_I2C_HANDLERS,
    'i2c.writeRead': (params) => {
      const write = (params.write as number[]) ?? [];
      lastWasRegisterRead = write[5] === 0xd4 && write[6] === 0x06;
      const readLength = Number(params.readLength ?? 0);
      const ack = [0x01, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00];
      return { data: { writeAck: true, writeStatus: 0, bytes: ack.slice(0, readLength), durationUs: 1000 } };
    },
    'i2c.read': (params) => {
      const length = Number(params.length ?? 1);
      const frame = lastWasRegisterRead
        ? [0x01, 0x00, 0x00, 0xff, 0x03, 0xfd, 0xd5, 0x07, registerValue, 0x00, 0x00]
        : [0x01, 0x00, 0x00, 0xff, 0x06, 0xfa, 0xd5, 0x03, 0x32, 0x01, 0x06, 0x07, 0xe8, 0x00];
      return { data: { bytes: frame.slice(0, length), durationUs: 900 } };
    },
  };
}

/** An MPU-6050 at 0x68 with a flat, directly readable register file. */
export const MPU6050_I2C_HANDLERS: Record<string, MockHandler> = {
  ...ESP32_DEVKITC_SYS_HANDLERS,
  'i2c.scan': (params) => {
    const repeats = Number(params.repeats ?? 1);
    return {
      data: {
        addresses: [{ address: 0x68, ackCount: repeats, probeCount: repeats, busErrors: 0, responseTimeUs: 95 }],
        scanDurationMs: 30,
      },
    };
  },
  'i2c.read': () => ({ data: { bytes: [0x68, 0x00, 0x00, 0x00], durationUs: 400 } }),
  'i2c.write': (params) => ({
    data: {
      address: params.address,
      bytesQueued: (params.write as number[]).length,
      writeAck: true,
      writeStatus: 0,
      statusText: 'ACK',
      durationUs: 250,
      bytes: [],
    },
  }),
  'i2c.writeRead': (params) => {
    const register = ((params.write as number[]) ?? [])[0];
    const readLength = Number(params.readLength ?? 1);
    const REGISTERS: Record<number, number[]> = {
      0x75: [0x68], // WHO_AM_I
      0x6b: [0x01], // PWR_MGMT_1, differs from the 0x40 reset value
      0x1b: [0x00, 0x00], // GYRO_CONFIG + ACCEL_CONFIG
      0x1c: [0x00],
      0x3b: [0x01, 0x20, 0xff, 0x30, 0x00, 0x40], // accelerometer burst
      0x41: [0x0d, 0x80], // TEMP_OUT
      0x3a: [0x01], // INT_STATUS — clear-on-read, should never be requested
    };
    const bytes = REGISTERS[register];
    if (!bytes) return { error: `Mock MPU6050 has no register 0x${register?.toString(16)}` };
    return { data: { writeAck: true, writeStatus: 0, bytes: bytes.slice(0, readLength), durationUs: 500 } };
  },
};

/** A bus where nothing answers. */
export const EMPTY_BUS_HANDLERS: Record<string, MockHandler> = {
  ...ESP32_DEVKITC_SYS_HANDLERS,
  'i2c.scan': () => ({ data: { addresses: [], scanDurationMs: 40 } }),
  'i2c.read': () => ({ error: 'No device responded', errorKind: 'DEVICE_ERROR' }),
  'i2c.writeRead': () => ({ data: { writeAck: false, writeStatus: 2, bytes: [], durationUs: 60 } }),
};

/** A device that ACKs only some of the time. */
export const UNSTABLE_DEVICE_HANDLERS: Record<string, MockHandler> = {
  ...ESP32_DEVKITC_SYS_HANDLERS,
  'i2c.scan': (params) => {
    const repeats = Number(params.repeats ?? 3);
    return {
      data: {
        addresses: [{ address: 0x3c, ackCount: 1, probeCount: repeats, busErrors: 0, responseTimeUs: 300 }],
        scanDurationMs: 50,
      },
    };
  },
  'i2c.read': (_params, index) => ({
    // Different data on each read — the signature of an address conflict.
    data: { bytes: index === 0 ? [0x11, 0x22, 0x33, 0x44] : [0xaa, 0xbb, 0xcc, 0xdd], durationUs: 500 },
  }),
};

/** A bus stuck low or shorted: every address reports an error. */
export const BUS_ERROR_HANDLERS: Record<string, MockHandler> = {
  ...ESP32_DEVKITC_SYS_HANDLERS,
  'i2c.scan': (params) => {
    const start = Number(params.start ?? 0x08);
    const repeats = Number(params.repeats ?? 3);
    return {
      data: {
        addresses: [{ address: start, ackCount: 0, probeCount: repeats, busErrors: repeats }],
        scanDurationMs: 900,
      },
    };
  },
};

/** An nRF24L01+ answering register reads over SPI. */
export const NRF24_SPI_HANDLERS: Record<string, MockHandler> = {
  ...ESP32_DEVKITC_SYS_HANDLERS,
  'spi.transfer': (params) => {
    const tx = (params.tx as number[]) ?? [];
    const command = tx[0] ?? 0xff;
    // The STATUS byte is returned during the command phase on every transfer.
    const status = 0x0e;
    if (command === 0xff) return { data: { bytes: [status], durationUs: 60 } };

    const register = command & 0x1f;
    const VALUES: Record<number, number> = { 0x00: 0x08, 0x03: 0x03, 0x05: 0x02, 0x06: 0x0e, 0x07: 0x0e, 0x17: 0x11 };
    const value = VALUES[register];
    if (value === undefined) return { data: { bytes: [status, 0x00], durationUs: 60 } };
    return { data: { bytes: [status, value], durationUs: 60 }, raw: `{"bytes":[${status},${value}]}` };
  },
};

/** SPI with nothing attached: MISO floats high. */
export const SPI_FLOATING_HANDLERS: Record<string, MockHandler> = {
  ...ESP32_DEVKITC_SYS_HANDLERS,
  'spi.transfer': (params) => {
    const tx = (params.tx as number[]) ?? [];
    return { data: { bytes: new Array(tx.length).fill(0xff), durationUs: 50 } };
  },
};

/** Convert an ASCII string to a byte array, for building UART fixtures. */
export function ascii(text: string): number[] {
  return Array.from(text).map((c) => c.charCodeAt(0) & 0xff);
}

/** A NEO-6M emitting NMEA sentences. */
export const NEO6M_UART_HANDLERS: Record<string, MockHandler> = {
  ...ESP32_DEVKITC_SYS_HANDLERS,
  'uart.listen': (params) => {
    const sentences =
      '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47\r\n' +
      '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A\r\n';
    const bytes = ascii(sentences);
    return {
      data: {
        bytes,
        gapsUs: bytes.map((_, i) => (i === 0 ? 0 : 1042)),
        baud: Number(params.baud ?? 9600),
        durationMs: Number(params.durationMs ?? 3000),
        truncated: false,
      },
      raw: '{"ok":true,"data":{"bytes":[36,71,80]}}',
    };
  },
};

/** A silent UART line. */
export const SILENT_UART_HANDLERS: Record<string, MockHandler> = {
  ...ESP32_DEVKITC_SYS_HANDLERS,
  'uart.listen': () => ({ data: { bytes: [], gapsUs: [], durationMs: 3000, truncated: false } }),
};

/**
 * A generic agent with no device attached: every primitive answers structurally,
 * so the operation layer can be exercised without assuming any component.
 */
export const GENERIC_AGENT_HANDLERS: Record<string, MockHandler> = {
  ...ESP32_DEVKITC_SYS_HANDLERS,
  'sys.capabilities': () => ({
    data: {
      agentVersion: '2.0.0',
      operations: [
        'sys.ping', 'sys.info', 'sys.interfaces', 'sys.capabilities',
        'i2c.scan', 'i2c.read', 'i2c.write', 'i2c.writeRead',
        'spi.transfer', 'uart.listen', 'uart.writeRead',
        'gpio.read', 'gpio.configure', 'gpio.write', 'gpio.pulse', 'gpio.sample',
        'gpio.measurePulse', 'gpio.measureFrequency', 'gpio.waitEdge', 'gpio.stimulusCapture',
        'adc.read', 'pwm.start', 'pwm.stop',
      ],
      limits: { maxPayloadBytes: 512, maxSamples: 1024, maxCaptureMs: 30000 },
      unavailable: [
        { capability: 'i2s.*', reason: 'Not implemented; I2S needs continuous DMA streaming.' },
        { capability: 'can.* (TWAI)', reason: 'Not implemented; needs an external transceiver.' },
      ],
    },
  }),
  'i2c.scan': () => ({ data: { addresses: [], scanDurationMs: 20 } }),
  'i2c.read': (params) => ({
    data: { bytes: new Array(Number(params.length ?? 1)).fill(0x5a), durationUs: 300 },
  }),
  // Echoes what it was asked to write, so tests can prove bytes pass through
  // unaltered rather than being filtered against any allow-list.
  'i2c.write': (params) => ({
    data: {
      address: params.address,
      bytesQueued: (params.write as number[]).length,
      writeAck: true,
      writeStatus: 0,
      statusText: 'ACK',
      durationUs: 200,
      bytes: [],
      echo: params.write,
    },
  }),
  'i2c.writeRead': (params) => ({
    data: {
      writeAck: true,
      writeStatus: 0,
      bytes: new Array(Number(params.readLength ?? 0)).fill(0xa5),
      durationUs: 400,
      echo: params.write,
    },
  }),
  'spi.transfer': (params) => {
    const tx = (params.tx as number[]) ?? [];
    const total = tx.length + Number(params.readLength ?? 0);
    return { data: { bytes: new Array(total).fill(0x3c), durationUs: 120, echo: tx } };
  },
  'uart.listen': (params) => ({
    data: { bytes: [0x4f, 0x4b], gapsUs: [0, 100], durationMs: params.durationMs, truncated: false },
  }),
  'uart.writeRead': (params) => ({
    data: { bytes: [0x4f, 0x4b], durationUs: 500, complete: true, echo: params.write },
  }),
  'gpio.configure': (params) => ({ data: { pin: params.pin, mode: params.mode, level: 0 } }),
  'gpio.read': (params) => ({
    data: {
      pins: (params.pins as number[]).map((gpio) => ({ gpio, usable: true, level: 1 })),
      levels: (params.pins as number[]).map(() => 1),
    },
  }),
  'gpio.write': (params) => ({ data: { pin: params.pin, level: params.level, readback: params.level } }),
  'gpio.pulse': (params) => ({
    data: { pin: params.pin, requestedUs: params.durationUs, actualUs: Number(params.durationUs) + 3 },
  }),
  'gpio.sample': (params) => {
    const pins = params.pins as number[];
    const samples = Number(params.samples ?? 4);
    const rounds = Array.from({ length: samples }, (_, i) => pins.map(() => i % 2));
    return {
      data: {
        pins,
        rounds,
        levels: rounds.flat(),
        timestampsUs: rounds.map((_, i) => i * 1000),
        sampleCount: samples,
        durationUs: samples * 1000,
      },
    };
  },
  'gpio.measurePulse': () => ({ data: { widthUs: 1234, timedOut: false } }),
  'gpio.measureFrequency': () => ({ data: { edgeCount: 100, windowUs: 100000, frequencyHz: 1000 } }),
  'gpio.waitEdge': () => ({ data: { observed: true, elapsedUs: 250, timedOut: false } }),
  'gpio.stimulusCapture': (params) => {
    const capturePins = params.capturePins as number[];
    const samples = Number(params.samples ?? 8);
    const rounds = Array.from({ length: samples }, (_, i) => capturePins.map(() => (i > 2 ? 1 : 0)));
    return {
      data: {
        capturePins,
        rounds,
        levels: rounds.flat(),
        stimulusLevels: rounds.map((_, i) => (i > 1 ? 1 : 0)),
        timestampsUs: rounds.map((_, i) => i * 100),
        sampleCount: samples,
      },
    };
  },
  'adc.read': (params) => {
    const samples = Number(params.samples ?? 1);
    return {
      data: {
        pin: params.pin,
        values: Array.from({ length: samples }, (_, i) => 2048 + i),
        timestampsUs: Array.from({ length: samples }, (_, i) => i * 100),
        sampleCount: samples,
        resolutionBits: 12,
      },
    };
  },
  'pwm.start': (params) => ({
    data: {
      pin: params.pin,
      channel: 0,
      frequencyHz: params.frequencyHz,
      dutyValue: 512,
      dutyMax: 1023,
      running: params.durationMs === undefined,
    },
  }),
  'pwm.stop': (params) => ({ data: { pin: params.pin, wasRunning: true, channel: 0 } }),
};

/** Transport whose agent never answers. */
export function absentAgentTransport(): MockTransport {
  return new MockTransport({
    failAll: {
      error: 'No response from the interrogation agent.',
      errorKind: 'AGENT_NOT_PRESENT',
    },
  });
}

/** Transport that times out on every request. */
export function timeoutTransport(): MockTransport {
  return new MockTransport({
    failAll: { error: 'Timed out waiting for a matching agent response.', errorKind: 'TIMEOUT' },
  });
}

/** Transport that returns unparseable output. */
export function malformedTransport(): MockTransport {
  return new MockTransport({
    handlers: {
      'sys.ping': () => ({ data: { agentVersion: '1.0.0' } }),
      'i2c.scan': () => ({ error: 'Serial bridge returned malformed JSON', errorKind: 'MALFORMED_RESPONSE', raw: '<<not json>>' }),
      'i2c.read': () => ({ error: 'Serial bridge returned malformed JSON', errorKind: 'MALFORMED_RESPONSE', raw: 'garbage' }),
      'i2c.writeRead': () => ({ error: 'Serial bridge returned malformed JSON', errorKind: 'MALFORMED_RESPONSE', raw: 'garbage' }),
    },
  });
}
