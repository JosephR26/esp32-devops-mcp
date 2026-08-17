/**
 * Generic raw hardware operations.
 *
 * This is the general-purpose layer: the ESP32 as a physical instrument that the
 * caller drives directly. Operations are constructed at call time, not selected
 * from a catalogue.
 *
 * The validation rule that governs this module:
 *
 *   An operation is permitted when the requested configuration is physically
 *   valid on this chip. It is refused only because something is electrically
 *   impossible, unsupported by the silicon, out of range, conflicting, or
 *   malformed — never because nobody anticipated it.
 *
 * There is no profile lookup here, no probe registry, no command allow-list, and
 * no notion of a "known" device. Arbitrary bytes are arbitrary.
 */

import {
  type Esp32Family,
  type GpioMode,
  type HardwareTransport,
  type I2CBusSpec,
  type OperationOutcome,
  type OperationRejection,
  type OperationSequenceResult,
  type RawOperation,
  type ReproducibilityRecord,
  type SpiBusSpec,
  type UartBusSpec,
} from '../types/hardware.js';
import { pinCapability, strappingPins } from './esp32-catalog.js';
import { rawInterpretation, timestamp } from './evidence.js';
import { mean, median, stdDev, toHex, toPrintableAscii } from './patterns.js';

/** Hard ceilings that come from the agent's fixed buffers, not from policy. */
export const MAX_PAYLOAD_BYTES = 512;
export const MAX_SAMPLES = 1024;
export const MAX_CAPTURE_MS = 30000;
export const MAX_OPERATIONS_PER_SEQUENCE = 64;
export const MAX_PWM_FREQUENCY_HZ = 40_000_000;

export interface OperationContext {
  transport: HardwareTransport;
  family: Esp32Family;
  /** Default bus configuration merged into operations that omit one. */
  defaults?: {
    i2c?: I2CBusSpec;
    spi?: SpiBusSpec;
    uart?: UartBusSpec;
  };
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Pin validation — against silicon, not against expectations
// ---------------------------------------------------------------------------

type PinRequirement = 'INPUT' | 'OUTPUT' | 'ADC' | 'DAC' | 'TOUCH' | 'PWM';

function checkPinFor(
  family: Esp32Family,
  gpio: number,
  requirement: PinRequirement,
  role: string
): OperationRejection[] {
  const rejections: OperationRejection[] = [];

  if (!Number.isInteger(gpio) || gpio < 0) {
    rejections.push({
      kind: 'MALFORMED_ARGUMENTS',
      detail: `${role}: "${gpio}" is not a valid GPIO number.`,
    });
    return rejections;
  }

  const capability = pinCapability(family, gpio);

  if (!capability) {
    // Family unknown: the host cannot check, so it defers to the agent rather
    // than refusing an operation that may well be valid.
    return rejections;
  }

  if (!capability.usable) {
    rejections.push({
      kind: capability.unusableReason?.includes('flash') ? 'PIN_RESERVED' : 'PIN_DOES_NOT_EXIST',
      detail: `${role}: ${capability.unusableReason}`,
      remedy: 'Choose a pin that is bonded out and not wired to flash/PSRAM.',
    });
    return rejections;
  }

  switch (requirement) {
    case 'OUTPUT':
    case 'PWM':
      if (!capability.digitalOutput) {
        rejections.push({
          kind: requirement === 'PWM' ? 'PIN_LACKS_PERIPHERAL' : 'PIN_NOT_OUTPUT_CAPABLE',
          detail: `${role}: GPIO${gpio} is input-only on ${family} and has no output driver.`,
          remedy: 'Choose an output-capable pin.',
        });
      }
      break;
    case 'ADC':
      if (!capability.adc) {
        rejections.push({
          kind: 'PIN_NOT_ADC_CAPABLE',
          detail: `${role}: GPIO${gpio} has no ADC channel on ${family}.`,
          remedy: 'Choose an ADC-capable pin — see esp32_pin_capabilities.',
        });
      }
      break;
    case 'DAC':
      if (!capability.dac) {
        rejections.push({
          kind: 'PIN_LACKS_PERIPHERAL',
          detail: `${role}: GPIO${gpio} has no DAC channel on ${family}.`,
        });
      }
      break;
    case 'TOUCH':
      if (!capability.touch) {
        rejections.push({
          kind: 'PIN_LACKS_PERIPHERAL',
          detail: `${role}: GPIO${gpio} has no touch channel on ${family}.`,
        });
      }
      break;
    case 'INPUT':
      // Every usable pin can be read.
      break;
  }

  return rejections;
}

/** Advisory notes for a pin — never a refusal. */
function pinWarnings(family: Esp32Family, gpio: number, role: string): string[] {
  const capability = pinCapability(family, gpio);
  if (!capability) return [];
  return capability.notes.map((note) => `${role} (GPIO${gpio}): ${note}`);
}

function rangeCheck(
  value: number | undefined,
  min: number,
  max: number,
  name: string
): OperationRejection[] {
  if (value === undefined) return [];
  if (!Number.isFinite(value) || value < min || value > max) {
    return [
      {
        kind: 'PARAMETER_OUT_OF_RANGE',
        detail: `${name} must be between ${min} and ${max} (got ${value}).`,
      },
    ];
  }
  return [];
}

function byteArrayCheck(bytes: unknown, name: string, allowEmpty = false): OperationRejection[] {
  if (!Array.isArray(bytes)) {
    return [{ kind: 'MALFORMED_ARGUMENTS', detail: `${name} must be an array of bytes.` }];
  }
  if (!allowEmpty && bytes.length === 0) {
    return [{ kind: 'MALFORMED_ARGUMENTS', detail: `${name} must not be empty.` }];
  }
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    return [
      {
        kind: 'PARAMETER_OUT_OF_RANGE',
        detail: `${name} has ${bytes.length} bytes; the agent buffer holds ${MAX_PAYLOAD_BYTES}.`,
        remedy: 'Split the transaction across several operations.',
      },
    ];
  }
  const bad = bytes.findIndex((b) => !Number.isInteger(b) || b < 0 || b > 0xff);
  if (bad >= 0) {
    return [
      {
        kind: 'MALFORMED_ARGUMENTS',
        detail: `${name}[${bad}] is ${bytes[bad]}; every element must be an integer 0-255.`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Operation validation
// ---------------------------------------------------------------------------

export interface OperationValidation {
  ok: boolean;
  rejections: OperationRejection[];
  warnings: string[];
  /** Pins the operation uses, keyed by role, for conflict detection. */
  pinRoles: { gpio: number; role: string }[];
}

/**
 * Validate one operation against the chip's real capabilities.
 *
 * Note what is deliberately NOT checked: what bytes are being sent, whether a
 * register is "documented", whether the address belongs to a known part, or
 * whether the operation is a read or a write. Those are the caller's business.
 */
export function validateOperation(
  operation: RawOperation,
  family: Esp32Family,
  defaults: OperationContext['defaults'] = {}
): OperationValidation {
  const rejections: OperationRejection[] = [];
  const warnings: string[] = [];
  const pinRoles: { gpio: number; role: string }[] = [];

  const usePin = (gpio: number | undefined, requirement: PinRequirement, role: string) => {
    if (gpio === undefined) return;
    rejections.push(...checkPinFor(family, gpio, requirement, role));
    warnings.push(...pinWarnings(family, gpio, role));
    pinRoles.push({ gpio, role });
  };

  switch (operation.op) {
    case 'I2C_SCAN':
    case 'I2C_READ':
    case 'I2C_WRITE':
    case 'I2C_WRITE_READ': {
      const bus = { ...defaults.i2c, ...operation.bus };
      usePin(bus.sda, 'OUTPUT', 'I2C SDA');
      usePin(bus.scl, 'OUTPUT', 'I2C SCL');
      rejections.push(...rangeCheck(bus.frequencyHz, 1000, 1_000_000, 'I2C frequencyHz'));
      rejections.push(...rangeCheck(bus.controller, 0, 1, 'I2C controller'));

      if (operation.op !== 'I2C_SCAN') {
        rejections.push(...rangeCheck(operation.address, 0x00, 0x7f, 'I2C address'));
      }
      if (operation.op === 'I2C_SCAN') {
        rejections.push(...rangeCheck(operation.startAddress, 0x00, 0x7f, 'startAddress'));
        rejections.push(...rangeCheck(operation.endAddress, 0x00, 0x7f, 'endAddress'));
        rejections.push(...rangeCheck(operation.repeats, 1, 16, 'repeats'));
        if (
          operation.startAddress !== undefined &&
          operation.endAddress !== undefined &&
          operation.startAddress > operation.endAddress
        ) {
          rejections.push({
            kind: 'MALFORMED_ARGUMENTS',
            detail: 'startAddress must not exceed endAddress.',
          });
        }
      }
      if (operation.op === 'I2C_READ') {
        rejections.push(...rangeCheck(operation.length, 1, MAX_PAYLOAD_BYTES, 'length'));
        rejections.push(...rangeCheck(operation.register, 0, 0xff, 'register'));
      }
      if (operation.op === 'I2C_WRITE') {
        rejections.push(...byteArrayCheck(operation.write, 'write'));
      }
      if (operation.op === 'I2C_WRITE_READ') {
        rejections.push(...byteArrayCheck(operation.write, 'write'));
        rejections.push(...rangeCheck(operation.readLength, 0, MAX_PAYLOAD_BYTES, 'readLength'));
        rejections.push(...rangeCheck(operation.delayMs, 0, 5000, 'delayMs'));
      }
      break;
    }

    case 'SPI_TRANSFER': {
      const bus = { ...defaults.spi, ...operation.bus };
      usePin(bus.sclk, 'OUTPUT', 'SPI SCLK');
      usePin(bus.mosi, 'OUTPUT', 'SPI MOSI');
      usePin(bus.miso, 'INPUT', 'SPI MISO');
      usePin(bus.cs, 'OUTPUT', 'SPI CS');
      rejections.push(...rangeCheck(bus.clockHz, 10_000, 40_000_000, 'SPI clockHz'));
      rejections.push(...rangeCheck(bus.mode, 0, 3, 'SPI mode'));
      rejections.push(...byteArrayCheck(operation.tx, 'tx', true));
      rejections.push(...rangeCheck(operation.readLength, 0, MAX_PAYLOAD_BYTES, 'readLength'));
      rejections.push(...rangeCheck(operation.padByte, 0, 0xff, 'padByte'));

      const total = (operation.tx?.length ?? 0) + (operation.readLength ?? 0);
      if (total === 0) {
        rejections.push({
          kind: 'MALFORMED_ARGUMENTS',
          detail: 'An SPI transfer needs at least one byte of tx or readLength.',
        });
      } else if (total > MAX_PAYLOAD_BYTES) {
        rejections.push({
          kind: 'PARAMETER_OUT_OF_RANGE',
          detail: `Total SPI transaction is ${total} bytes; the agent buffer holds ${MAX_PAYLOAD_BYTES}.`,
        });
      }
      if (bus.cs === undefined) {
        rejections.push({
          kind: 'MALFORMED_ARGUMENTS',
          detail: 'SPI needs a chip-select pin — an unspecified CS would select an unknown device.',
          remedy: 'Name the cs pin in the bus spec or in the sequence defaults.',
        });
      }
      break;
    }

    case 'UART_WRITE':
    case 'UART_READ':
    case 'UART_WRITE_READ': {
      const bus = { ...defaults.uart, ...operation.bus };
      usePin(bus.rx, 'INPUT', 'UART RX');
      usePin(bus.tx, 'OUTPUT', 'UART TX');
      rejections.push(...rangeCheck(bus.baud, 300, 3_000_000, 'UART baud'));

      if (bus.controller !== undefined && (bus.controller < 1 || bus.controller > 2)) {
        rejections.push({
          kind: 'PERIPHERAL_UNAVAILABLE',
          detail: 'UART controller must be 1 or 2 — UART0 carries the agent link.',
          remedy: 'Use controller 1 or 2.',
        });
      }
      if (operation.op !== 'UART_READ' && bus.tx === undefined) {
        rejections.push({
          kind: 'MALFORMED_ARGUMENTS',
          detail: 'Transmitting on UART requires a tx pin.',
        });
      }
      if (operation.op !== 'UART_WRITE' && bus.rx === undefined) {
        rejections.push({
          kind: 'MALFORMED_ARGUMENTS',
          detail: 'Receiving on UART requires an rx pin.',
        });
      }
      if (operation.op === 'UART_WRITE' || operation.op === 'UART_WRITE_READ') {
        rejections.push(...byteArrayCheck(operation.write, 'write'));
      }
      if (operation.op === 'UART_READ') {
        rejections.push(...rangeCheck(operation.durationMs, 1, MAX_CAPTURE_MS, 'durationMs'));
        rejections.push(...rangeCheck(operation.maxBytes, 1, MAX_PAYLOAD_BYTES, 'maxBytes'));
      }
      if (operation.op === 'UART_WRITE_READ') {
        rejections.push(...rangeCheck(operation.readLength, 0, MAX_PAYLOAD_BYTES, 'readLength'));
        rejections.push(...rangeCheck(operation.timeoutMs, 1, MAX_CAPTURE_MS, 'timeoutMs'));
      }
      break;
    }

    case 'GPIO_CONFIGURE': {
      const needsOutput =
        operation.mode === 'OUTPUT' || operation.mode === 'OUTPUT_OPEN_DRAIN';
      usePin(operation.pin, needsOutput ? 'OUTPUT' : 'INPUT', `GPIO ${operation.mode}`);
      const modes: GpioMode[] = [
        'INPUT',
        'INPUT_PULLUP',
        'INPUT_PULLDOWN',
        'OUTPUT',
        'OUTPUT_OPEN_DRAIN',
      ];
      if (!modes.includes(operation.mode)) {
        rejections.push({
          kind: 'MALFORMED_ARGUMENTS',
          detail: `Unknown GPIO mode "${operation.mode}". Valid: ${modes.join(', ')}.`,
        });
      }
      if (
        (operation.mode === 'INPUT_PULLUP' || operation.mode === 'INPUT_PULLDOWN') &&
        pinCapability(family, operation.pin)?.digitalOutput === false
      ) {
        rejections.push({
          kind: 'PIN_LACKS_PERIPHERAL',
          detail: `GPIO${operation.pin} is input-only and has no internal pull-up/pull-down.`,
          remedy: 'Use an external resistor, or choose a pin with internal pulls.',
        });
      }
      break;
    }

    case 'GPIO_READ':
      if (operation.pins.length === 0) {
        rejections.push({ kind: 'MALFORMED_ARGUMENTS', detail: 'pins must not be empty.' });
      }
      for (const pin of operation.pins) usePin(pin, 'INPUT', 'GPIO read');
      break;

    case 'GPIO_WRITE':
      usePin(operation.pin, 'OUTPUT', 'GPIO drive');
      if (operation.level !== 0 && operation.level !== 1) {
        rejections.push({ kind: 'MALFORMED_ARGUMENTS', detail: 'level must be 0 or 1.' });
      }
      break;

    case 'GPIO_PULSE':
      usePin(operation.pin, 'OUTPUT', 'GPIO pulse');
      rejections.push(...rangeCheck(operation.durationUs, 1, 10_000_000, 'durationUs'));
      break;

    case 'GPIO_SAMPLE':
      if (operation.pins.length === 0) {
        rejections.push({ kind: 'MALFORMED_ARGUMENTS', detail: 'pins must not be empty.' });
      }
      for (const pin of operation.pins) usePin(pin, 'INPUT', 'GPIO sample');
      rejections.push(...rangeCheck(operation.samples, 1, MAX_SAMPLES, 'samples'));
      rejections.push(...rangeCheck(operation.intervalUs, 0, 1_000_000, 'intervalUs'));
      if (operation.pins.length * operation.samples > MAX_SAMPLES * 4) {
        rejections.push({
          kind: 'PARAMETER_OUT_OF_RANGE',
          detail: `pins x samples exceeds the agent capture buffer (${MAX_SAMPLES * 4} points).`,
        });
      }
      break;

    case 'GPIO_MEASURE_PULSE':
      usePin(operation.pin, 'INPUT', 'GPIO pulse measurement');
      rejections.push(...rangeCheck(operation.timeoutUs, 1, 10_000_000, 'timeoutUs'));
      break;

    case 'GPIO_MEASURE_FREQUENCY':
      usePin(operation.pin, 'INPUT', 'GPIO frequency measurement');
      rejections.push(...rangeCheck(operation.windowMs, 1, MAX_CAPTURE_MS, 'windowMs'));
      break;

    case 'GPIO_WAIT_EDGE':
      usePin(operation.pin, 'INPUT', 'GPIO edge wait');
      rejections.push(...rangeCheck(operation.timeoutMs, 1, MAX_CAPTURE_MS, 'timeoutMs'));
      break;

    case 'ADC_READ':
      usePin(operation.pin, 'ADC', 'ADC input');
      rejections.push(...rangeCheck(operation.samples, 1, MAX_SAMPLES, 'samples'));
      rejections.push(...rangeCheck(operation.intervalUs, 0, 1_000_000, 'intervalUs'));
      if (
        operation.attenuationDb !== undefined &&
        ![0, 2.5, 6, 11].includes(operation.attenuationDb)
      ) {
        rejections.push({
          kind: 'PARAMETER_OUT_OF_RANGE',
          detail: 'attenuationDb must be 0, 2.5, 6 or 11.',
        });
      }
      break;

    case 'PWM_START':
      usePin(operation.pin, 'PWM', 'PWM output');
      rejections.push(...rangeCheck(operation.frequencyHz, 1, MAX_PWM_FREQUENCY_HZ, 'frequencyHz'));
      rejections.push(...rangeCheck(operation.duty, 0, 1, 'duty'));
      rejections.push(...rangeCheck(operation.resolutionBits, 1, 20, 'resolutionBits'));
      rejections.push(...rangeCheck(operation.durationMs, 1, MAX_CAPTURE_MS, 'durationMs'));

      // The LEDC peripheral trades frequency against resolution: the product of
      // frequency and 2^bits cannot exceed the timer source clock.
      if (operation.resolutionBits !== undefined && operation.frequencyHz !== undefined) {
        const required = operation.frequencyHz * 2 ** operation.resolutionBits;
        if (required > 80_000_000) {
          rejections.push({
            kind: 'PARAMETER_OUT_OF_RANGE',
            detail:
              `${operation.frequencyHz} Hz at ${operation.resolutionBits}-bit resolution needs a ` +
              `${(required / 1e6).toFixed(1)} MHz LEDC clock; the source is 80 MHz.`,
            remedy: 'Lower the frequency or reduce the resolution.',
          });
        }
      }
      break;

    case 'PWM_STOP':
      usePin(operation.pin, 'PWM', 'PWM output');
      break;

    case 'STIMULUS_CAPTURE':
      usePin(operation.stimulus.pin, 'OUTPUT', 'stimulus');
      if (operation.capturePins.length === 0) {
        rejections.push({ kind: 'MALFORMED_ARGUMENTS', detail: 'capturePins must not be empty.' });
      }
      for (const pin of operation.capturePins) usePin(pin, 'INPUT', 'capture');
      rejections.push(...rangeCheck(operation.samples, 1, MAX_SAMPLES, 'samples'));
      rejections.push(...rangeCheck(operation.intervalUs, 0, 1_000_000, 'intervalUs'));
      rejections.push(...rangeCheck(operation.stimulus.durationUs, 1, 10_000_000, 'stimulus.durationUs'));
      rejections.push(...rangeCheck(operation.stimulus.cycles, 1, 1000, 'stimulus.cycles'));
      if (operation.capturePins.includes(operation.stimulus.pin)) {
        rejections.push({
          kind: 'PIN_CONFLICT',
          detail:
            `GPIO${operation.stimulus.pin} is both the stimulus and a capture pin. Sampling a ` +
            'pin the agent is driving reads back the drive level, not the device response.',
          remedy: 'Capture on a different pin, or use GPIO_SAMPLE without a stimulus.',
        });
      }
      break;

    case 'DELAY':
      rejections.push(...rangeCheck(operation.ms, 0, MAX_CAPTURE_MS, 'ms'));
      break;

    default: {
      const unknown = operation as { op?: string };
      rejections.push({
        kind: 'MALFORMED_ARGUMENTS',
        detail: `Unknown operation "${unknown.op}".`,
      });
    }
  }

  return { ok: rejections.length === 0, rejections, warnings, pinRoles };
}

// ---------------------------------------------------------------------------
// Agent request construction
// ---------------------------------------------------------------------------

function i2cParams(bus: I2CBusSpec | undefined, defaults: I2CBusSpec = {}): Record<string, unknown> {
  const merged = { ...defaults, ...bus };
  return {
    ...(merged.controller !== undefined ? { controller: merged.controller } : {}),
    ...(merged.sda !== undefined ? { sda: merged.sda } : {}),
    ...(merged.scl !== undefined ? { scl: merged.scl } : {}),
    ...(merged.frequencyHz !== undefined ? { frequencyHz: merged.frequencyHz } : {}),
  };
}

function spiParams(bus: SpiBusSpec | undefined, defaults: SpiBusSpec = {}): Record<string, unknown> {
  const merged = { ...defaults, ...bus };
  return {
    ...(merged.mosi !== undefined ? { mosi: merged.mosi } : {}),
    ...(merged.miso !== undefined ? { miso: merged.miso } : {}),
    ...(merged.sclk !== undefined ? { sclk: merged.sclk } : {}),
    ...(merged.cs !== undefined ? { cs: merged.cs } : {}),
    ...(merged.mode !== undefined ? { mode: merged.mode } : {}),
    ...(merged.clockHz !== undefined ? { clockHz: merged.clockHz } : {}),
    ...(merged.bitOrder !== undefined ? { lsbFirst: merged.bitOrder === 'LSB_FIRST' } : {}),
  };
}

function uartParams(
  bus: UartBusSpec | undefined,
  defaults: UartBusSpec = {}
): Record<string, unknown> {
  const merged = { ...defaults, ...bus };
  return {
    ...(merged.controller !== undefined ? { controller: merged.controller } : {}),
    ...(merged.tx !== undefined ? { tx: merged.tx } : {}),
    ...(merged.rx !== undefined ? { rx: merged.rx } : {}),
    ...(merged.baud !== undefined ? { baud: merged.baud } : {}),
    ...(merged.dataBits !== undefined ? { dataBits: merged.dataBits } : {}),
    ...(merged.parity !== undefined ? { parity: merged.parity } : {}),
    ...(merged.stopBits !== undefined ? { stopBits: merged.stopBits } : {}),
  };
}

/** Translate a raw operation into an agent request. */
export function buildAgentRequest(
  operation: RawOperation,
  defaults: OperationContext['defaults'] = {}
): { op: string; params: Record<string, unknown> } | null {
  switch (operation.op) {
    case 'I2C_SCAN':
      return {
        op: 'i2c.scan',
        params: {
          ...i2cParams(operation.bus, defaults.i2c),
          ...(operation.startAddress !== undefined ? { start: operation.startAddress } : {}),
          ...(operation.endAddress !== undefined ? { end: operation.endAddress } : {}),
          ...(operation.repeats !== undefined ? { repeats: operation.repeats } : {}),
        },
      };

    case 'I2C_READ':
      return {
        op: 'i2c.read',
        params: {
          ...i2cParams(operation.bus, defaults.i2c),
          address: operation.address,
          ...(operation.register !== undefined ? { register: operation.register } : {}),
          length: operation.length,
        },
      };

    case 'I2C_WRITE':
      return {
        op: 'i2c.write',
        params: {
          ...i2cParams(operation.bus, defaults.i2c),
          address: operation.address,
          write: operation.write,
        },
      };

    case 'I2C_WRITE_READ':
      return {
        op: 'i2c.writeRead',
        params: {
          ...i2cParams(operation.bus, defaults.i2c),
          address: operation.address,
          write: operation.write,
          readLength: operation.readLength,
          ...(operation.delayMs !== undefined ? { delayMs: operation.delayMs } : {}),
          ...(operation.repeatedStart !== undefined
            ? { repeatedStart: operation.repeatedStart }
            : {}),
        },
      };

    case 'SPI_TRANSFER':
      return {
        op: 'spi.transfer',
        params: {
          ...spiParams(operation.bus, defaults.spi),
          tx: operation.tx,
          ...(operation.readLength !== undefined ? { readLength: operation.readLength } : {}),
          ...(operation.padByte !== undefined ? { padByte: operation.padByte } : {}),
          ...(operation.keepCsAsserted !== undefined
            ? { keepCsAsserted: operation.keepCsAsserted }
            : {}),
        },
      };

    case 'UART_WRITE':
      return {
        op: 'uart.writeRead',
        params: { ...uartParams(operation.bus, defaults.uart), write: operation.write, readLength: 0, timeoutMs: 50 },
      };

    case 'UART_READ':
      return {
        op: 'uart.listen',
        params: {
          ...uartParams(operation.bus, defaults.uart),
          durationMs: operation.durationMs,
          ...(operation.maxBytes !== undefined ? { maxBytes: operation.maxBytes } : {}),
        },
      };

    case 'UART_WRITE_READ':
      return {
        op: 'uart.writeRead',
        params: {
          ...uartParams(operation.bus, defaults.uart),
          write: operation.write,
          readLength: operation.readLength,
          timeoutMs: operation.timeoutMs,
        },
      };

    case 'GPIO_CONFIGURE':
      return { op: 'gpio.configure', params: { pin: operation.pin, mode: operation.mode } };

    case 'GPIO_READ':
      return { op: 'gpio.read', params: { pins: operation.pins } };

    case 'GPIO_WRITE':
      return { op: 'gpio.write', params: { pin: operation.pin, level: operation.level } };

    case 'GPIO_PULSE':
      return {
        op: 'gpio.pulse',
        params: {
          pin: operation.pin,
          level: operation.level,
          durationUs: operation.durationUs,
          ...(operation.returnToLevel !== undefined
            ? { returnToLevel: operation.returnToLevel }
            : {}),
        },
      };

    case 'GPIO_SAMPLE':
      return {
        op: 'gpio.sample',
        params: {
          pins: operation.pins,
          samples: operation.samples,
          ...(operation.intervalUs !== undefined ? { intervalUs: operation.intervalUs } : {}),
        },
      };

    case 'GPIO_MEASURE_PULSE':
      return {
        op: 'gpio.measurePulse',
        params: {
          pin: operation.pin,
          level: operation.level,
          ...(operation.timeoutUs !== undefined ? { timeoutUs: operation.timeoutUs } : {}),
        },
      };

    case 'GPIO_MEASURE_FREQUENCY':
      return {
        op: 'gpio.measureFrequency',
        params: {
          pin: operation.pin,
          windowMs: operation.windowMs,
          ...(operation.edge !== undefined ? { edge: operation.edge } : {}),
        },
      };

    case 'GPIO_WAIT_EDGE':
      return {
        op: 'gpio.waitEdge',
        params: { pin: operation.pin, edge: operation.edge, timeoutMs: operation.timeoutMs },
      };

    case 'ADC_READ':
      return {
        op: 'adc.read',
        params: {
          pin: operation.pin,
          ...(operation.samples !== undefined ? { samples: operation.samples } : {}),
          ...(operation.intervalUs !== undefined ? { intervalUs: operation.intervalUs } : {}),
          ...(operation.attenuationDb !== undefined
            ? { attenuationDb: operation.attenuationDb }
            : {}),
        },
      };

    case 'PWM_START':
      return {
        op: 'pwm.start',
        params: {
          pin: operation.pin,
          frequencyHz: operation.frequencyHz,
          duty: operation.duty,
          ...(operation.resolutionBits !== undefined
            ? { resolutionBits: operation.resolutionBits }
            : {}),
          ...(operation.durationMs !== undefined ? { durationMs: operation.durationMs } : {}),
        },
      };

    case 'PWM_STOP':
      return { op: 'pwm.stop', params: { pin: operation.pin } };

    case 'STIMULUS_CAPTURE':
      return {
        op: 'gpio.stimulusCapture',
        params: {
          stimulus: operation.stimulus,
          capturePins: operation.capturePins,
          samples: operation.samples,
          ...(operation.intervalUs !== undefined ? { intervalUs: operation.intervalUs } : {}),
        },
      };

    case 'DELAY':
      return null; // Executed host-side.
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractBytes(data: unknown): number[] {
  if (!data || typeof data !== 'object') return [];
  const bytes = (data as { bytes?: unknown }).bytes;
  if (!Array.isArray(bytes)) return [];
  return bytes.filter((b): b is number => typeof b === 'number').map((b) => b & 0xff);
}

function extractSamples(data: unknown): number[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  for (const key of ['values', 'samples', 'levels', 'durationsUs', 'intervalsUs']) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((v): v is number => typeof v === 'number');
    }
  }
  // Single-value timing results still deserve to be exposed as a sample.
  for (const key of ['widthUs', 'frequencyHz', 'elapsedUs', 'edgeCount']) {
    const value = record[key];
    if (typeof value === 'number') return [value];
  }
  return [];
}

function summarise(samples: number[]): OperationOutcome['statistics'] {
  if (samples.length === 0) return null;
  return {
    count: samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: mean(samples),
    median: median(samples),
    stdDev: stdDev(samples),
  };
}

function emptyOutcome(
  index: number,
  operation: RawOperation,
  rejections: OperationRejection[],
  warnings: string[]
): OperationOutcome {
  const detail = rejections.map((r) => r.detail).join(' ');
  return {
    index,
    op: operation.op,
    request: operation,
    agentRequest: null,
    executed: false,
    ok: false,
    rejections,
    bytes: [],
    hex: '',
    ascii: null,
    samples: [],
    statistics: null,
    data: null,
    durationMs: 0,
    warnings,
    error: detail,
    raw: rawInterpretation<number[]>('', null, `Not executed: ${detail}`, 'NONE', 'UNKNOWN'),
    timestamp: timestamp(),
  };
}

/**
 * Execute one raw operation.
 *
 * Never throws. A rejection, a bus error and a device that does not answer are
 * all outcomes, each carrying its raw capture.
 */
export async function executeOperation(
  operation: RawOperation,
  ctx: OperationContext,
  index = 0
): Promise<OperationOutcome> {
  const validation = validateOperation(operation, ctx.family, ctx.defaults);
  if (!validation.ok) {
    return emptyOutcome(index, operation, validation.rejections, validation.warnings);
  }

  const started = Date.now();

  if (operation.op === 'DELAY') {
    await sleep(operation.ms);
    return {
      index,
      op: 'DELAY',
      request: operation,
      agentRequest: null,
      executed: true,
      ok: true,
      rejections: [],
      bytes: [],
      hex: '',
      ascii: null,
      samples: [],
      statistics: null,
      data: { ms: operation.ms },
      durationMs: Date.now() - started,
      warnings: validation.warnings,
      raw: rawInterpretation<number[]>('', [], `Host-side delay of ${operation.ms} ms`, 'NONE', 'UNKNOWN'),
      timestamp: timestamp(),
    };
  }

  const request = buildAgentRequest(operation, ctx.defaults);
  if (!request) {
    return emptyOutcome(
      index,
      operation,
      [{ kind: 'UNSUPPORTED_BY_AGENT', detail: `No agent mapping for ${operation.op}.` }],
      validation.warnings
    );
  }

  const result = await ctx.transport.request<Record<string, unknown>>(
    request.op,
    request.params,
    { ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}) }
  );

  const bytes = result.ok ? extractBytes(result.data) : [];
  const samples = result.ok ? extractSamples(result.data) : [];
  const hex = toHex(bytes);

  const warnings = [...validation.warnings];
  if (!result.ok && result.errorKind === 'UNSUPPORTED_OPERATION') {
    warnings.push(
      `The agent firmware does not implement "${request.op}". Flash the current ` +
        'firmware/interrogation-agent/ build to use this capability.'
    );
  }

  return {
    index,
    op: operation.op,
    request: operation,
    agentRequest: request,
    executed: true,
    ok: result.ok,
    rejections: [],
    bytes,
    hex,
    ascii: toPrintableAscii(bytes),
    samples,
    statistics: summarise(samples),
    data: (result.data as Record<string, unknown>) ?? null,
    durationMs: result.durationMs,
    warnings,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.errorKind !== undefined ? { errorKind: result.errorKind } : {}),
    raw: rawInterpretation(
      result.raw,
      bytes,
      result.ok
        ? describeOutcome(operation, bytes, samples)
        : `${operation.op} failed: ${result.error ?? 'unknown transport error'}`,
      result.ok ? 'DEVICE_RESPONSE' : 'NONE',
      result.ok ? 'HIGH' : 'UNKNOWN'
    ),
    timestamp: timestamp(),
  };
}

/**
 * Plain description of what came back.
 *
 * Deliberately factual: it says what was received, never what it means. Any
 * claim about significance is the caller's inference to make.
 */
function describeOutcome(operation: RawOperation, bytes: number[], samples: number[]): string {
  if (bytes.length > 0) {
    return `${operation.op}: received ${bytes.length} byte(s) [${toHex(bytes)}]`;
  }
  if (samples.length > 0) {
    const stats = summarise(samples)!;
    return (
      `${operation.op}: ${samples.length} sample(s), min ${stats.min}, max ${stats.max}, ` +
      `mean ${stats.mean?.toFixed(2)}`
    );
  }
  return `${operation.op}: completed with no data payload`;
}

/** Detect pins used in incompatible roles across a sequence. */
function analysePinUsage(
  operations: RawOperation[],
  family: Esp32Family,
  defaults: OperationContext['defaults']
): { usage: OperationSequenceResult['pinUsage']; warnings: string[] } {
  const roles = new Map<number, Set<string>>();

  for (const operation of operations) {
    const { pinRoles } = validateOperation(operation, family, defaults);
    for (const { gpio, role } of pinRoles) {
      const set = roles.get(gpio) ?? new Set<string>();
      set.add(role);
      roles.set(gpio, set);
    }
  }

  const warnings: string[] = [];
  const usage: OperationSequenceResult['pinUsage'] = [];

  for (const [gpio, roleSet] of roles) {
    const roleList = Array.from(roleSet);
    // A pin driven in one operation and sampled in another is a legitimate
    // technique, so this is reported rather than refused.
    const drives = roleList.some((r) => /drive|stimulus|pulse|PWM|SDA|SCL|MOSI|SCLK|CS|TX/i.test(r));
    const reads = roleList.some((r) => /read|sample|capture|measurement|edge|MISO|RX|ADC/i.test(r));
    const conflict = drives && reads;

    if (conflict) {
      warnings.push(
        `GPIO${gpio} is used both as an output (${roleList.filter((r) => /drive|stimulus|pulse|PWM|SDA|SCL|MOSI|SCLK|CS|TX/i.test(r)).join(', ')}) ` +
          `and as an input (${roleList.filter((r) => /read|sample|capture|measurement|edge|MISO|RX|ADC/i.test(r)).join(', ')}) ` +
          'in this sequence. That is valid for bidirectional or self-monitoring experiments, but ' +
          'reading a pin this agent is driving returns the drive level, not a device response.'
      );
    }
    if (roleList.length > 1) {
      const strapping = strappingPins(family).includes(gpio);
      if (strapping) {
        warnings.push(
          `GPIO${gpio} is a strapping pin used in ${roleList.length} roles; its level at reset ` +
            'selects boot mode.'
        );
      }
    }

    usage.push({ gpio, roles: roleList, conflict });
  }

  return { usage: usage.sort((a, b) => a.gpio - b.gpio), warnings };
}

/**
 * Execute a sequence of raw operations in order.
 *
 * Each operation is validated independently; a rejected operation does not stop
 * the sequence unless `stopOnError` is set, because a failed step is itself an
 * observation the caller may want alongside the rest.
 */
export async function executeOperationSequence(
  operations: RawOperation[],
  ctx: OperationContext,
  options: { stopOnError?: boolean; reproducibility?: ReproducibilityRecord } = {}
): Promise<OperationSequenceResult> {
  const started = Date.now();
  const outcomes: OperationOutcome[] = [];
  const errors: string[] = [];

  const { usage, warnings } = analysePinUsage(operations, ctx.family, ctx.defaults);

  if (operations.length === 0) {
    errors.push('No operations supplied.');
  } else if (operations.length > MAX_OPERATIONS_PER_SEQUENCE) {
    errors.push(
      `${operations.length} operations exceeds the per-sequence limit of ` +
        `${MAX_OPERATIONS_PER_SEQUENCE}. Split the sequence across several calls — results from ` +
        'one call can inform the next.'
    );
  }

  if (errors.length === 0) {
    for (let index = 0; index < operations.length; index++) {
      const outcome = await executeOperation(operations[index], ctx, index);
      outcomes.push(outcome);

      if (!outcome.ok) {
        const label = outcome.executed ? 'failed' : 'was rejected';
        errors.push(`Operation ${index} (${outcome.op}) ${label}: ${outcome.error}`);
        if (options.stopOnError) break;
      }
    }
  }

  const executed = outcomes.filter((o) => o.executed).length;
  const rejected = outcomes.filter((o) => !o.executed).length;
  const failed = outcomes.filter((o) => o.executed && !o.ok).length;
  const anySucceeded = outcomes.some((o) => o.ok);

  return {
    success: errors.length === 0 && outcomes.length > 0 && outcomes.every((o) => o.ok),
    operations: outcomes,
    executed,
    rejected,
    failed,
    pinUsage: usage,
    warnings: [...warnings, ...outcomes.flatMap((o) => o.warnings)],
    errors,
    durationMs: Date.now() - started,
    reproducibility:
      options.reproducibility ??
      ({
        mcpVersion: 'unknown',
        hardware: {
          port: { value: null, known: false, confidence: 'UNKNOWN', source: 'NONE' },
          chip: { value: ctx.family, known: ctx.family !== 'UNKNOWN', confidence: 'HIGH', source: 'FIRMWARE_REPORT' },
          chipRevision: { value: null, known: false, confidence: 'UNKNOWN', source: 'NONE' },
          mac: { value: null, known: false, confidence: 'UNKNOWN', source: 'NONE' },
        },
        firmware: {
          agentVersion: { value: null, known: false, confidence: 'UNKNOWN', source: 'NONE' },
          applicationName: { value: null, known: false, confidence: 'UNKNOWN', source: 'NONE' },
          applicationVersion: { value: null, known: false, confidence: 'UNKNOWN', source: 'NONE' },
        },
        configuration: { defaults: ctx.defaults ?? {} },
        timestamp: timestamp(),
      } as ReproducibilityRecord),
    // Executing a caller-constructed operation shows what the device did. It
    // does not establish what the device is, so the tier never rises above
    // OBSERVED here — promotion to TESTED/VERIFIED requires repetition against
    // a stated expectation, which is what the experiment tool does.
    evidenceTier: anySucceeded ? 'OBSERVED' : 'UNKNOWN',
    notes: [
      'Raw agent responses are retained verbatim on every operation, including failures.',
      'A successful operation is OBSERVED evidence: it records what the device did in ' +
        'response to exactly these bytes under exactly this configuration. It is not a ' +
        'verification of device identity or capability.',
      'Interpretation of the response is the caller\'s to make — this layer reports what ' +
        'happened, not what it means.',
    ],
    ...(errors.length > 0 ? { error: errors[0] } : {}),
  };
}
