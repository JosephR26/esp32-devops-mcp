/**
 * Register decoding.
 *
 * Read-only by construction: nothing in this module emits a write. Register
 * definitions come from component profiles, and a definition marked
 * `safeToRead: false` (or `readHasSideEffects: true`) is skipped by automated
 * inspection rather than read "just to see".
 */

import {
  type ConfidenceLevel,
  type DecodedField,
  type RegisterDefinition,
  type RegisterInspectionResult,
} from '../types/hardware.js';
import { knownValue, unknownValue } from './evidence.js';
import { hexValue, toBinary, toHex } from './patterns.js';

/** Render a register address as hex, tolerating symbolic addresses. */
export function formatRegisterAddress(address: number | string): string {
  return typeof address === 'number' ? hexValue(address) : address;
}

/** Extract a bitfield from a register value. */
export function extractField(value: number, bitOffset: number, bitWidth: number): number {
  if (bitWidth <= 0 || bitWidth > 32) {
    throw new Error(`Invalid bit width: ${bitWidth}`);
  }
  const mask = bitWidth === 32 ? 0xffffffff : (1 << bitWidth) - 1;
  return (value >>> bitOffset) & mask;
}

/** Decode every field of a register definition against a raw value. */
export function decodeRegisterFields(
  definition: RegisterDefinition,
  value: number
): DecodedField[] {
  return definition.fields.map((field) => {
    const fieldValue = extractField(value, field.bitOffset, field.bitWidth);
    const meaning = field.enumerations?.[String(fieldValue)];
    return {
      name: field.name,
      bitOffset: field.bitOffset,
      bitWidth: field.bitWidth,
      value: fieldValue,
      binary: toBinary(fieldValue, field.bitWidth),
      ...(meaning !== undefined ? { meaning } : {}),
      ...(field.description !== undefined ? { description: field.description } : {}),
    };
  });
}

/** Assemble a big-endian integer from register bytes. */
export function bytesToValue(bytes: number[]): number {
  return bytes.reduce((acc, byte) => (acc << 8) | (byte & 0xff), 0) >>> 0;
}

/**
 * Whether automated inspection is permitted to read this register.
 * Reads with side effects are excluded: observing must not mutate the subject.
 */
export function isSafeToInspect(definition: RegisterDefinition): boolean {
  if (!definition.safeToRead) return false;
  if (definition.readHasSideEffects) return false;
  return definition.access === 'R' || definition.access === 'RW';
}

/** Explain why a register was skipped. */
export function skipReason(definition: RegisterDefinition): string {
  if (definition.access === 'W') {
    return 'Write-only register — reading it is not meaningful and this tool never writes.';
  }
  if (definition.readHasSideEffects) {
    return 'Reading this register mutates device state (e.g. clear-on-read); skipped by default.';
  }
  if (!definition.safeToRead) {
    return 'Profile marks this register as unsafe to read without a controlled procedure.';
  }
  return 'Skipped.';
}

/** Build a result for a register that was deliberately not read. */
export function skippedRegisterResult(
  definition: RegisterDefinition,
  reason?: string
): RegisterInspectionResult {
  return {
    address: definition.address,
    addressHex: formatRegisterAddress(definition.address),
    name: definition.name,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    read: false,
    rawValue: unknownValue<number>('Register not read'),
    rawBytes: null,
    hex: null,
    binary: null,
    fields: [],
    resetValue:
      definition.resetValue !== undefined
        ? knownValue(definition.resetValue, 'DATASHEET', 'Documented reset value')
        : unknownValue<number>('No documented reset value in profile'),
    changedFromReset: null,
    ...(definition.reference !== undefined ? { reference: definition.reference } : {}),
    confidence: 'UNKNOWN',
    skipped: reason ?? skipReason(definition),
  };
}

/** Build a result for a register read that failed. */
export function failedRegisterResult(
  definition: RegisterDefinition,
  error: string,
  raw = ''
): RegisterInspectionResult {
  const result = skippedRegisterResult(definition, undefined);
  delete result.skipped;
  return {
    ...result,
    rawValue: unknownValue<number>(error),
    rawBytes: raw || null,
    error,
  };
}

/**
 * Decode a successful register read.
 *
 * Confidence is HIGH rather than CONFIRMED for a single read: one sample proves
 * the value was that at the moment of reading, not that it is stable.
 */
export function decodeRegister(
  definition: RegisterDefinition,
  bytes: number[],
  raw: string,
  confidence: ConfidenceLevel = 'HIGH'
): RegisterInspectionResult {
  const value = bytesToValue(bytes);
  const changedFromReset =
    definition.resetValue !== undefined ? value !== definition.resetValue : null;

  return {
    address: definition.address,
    addressHex: formatRegisterAddress(definition.address),
    name: definition.name,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    read: true,
    rawValue: knownValue(value, 'REGISTER_READ', 'Read from device', confidence, raw),
    rawBytes: toHex(bytes),
    hex: hexValue(value, Math.max(1, Math.ceil(definition.width / 8))),
    binary: toBinary(value, definition.width),
    fields: decodeRegisterFields(definition, value),
    resetValue:
      definition.resetValue !== undefined
        ? knownValue(definition.resetValue, 'DATASHEET', 'Documented reset value')
        : unknownValue<number>('No documented reset value in profile'),
    changedFromReset,
    ...(definition.reference !== undefined ? { reference: definition.reference } : {}),
    confidence,
  };
}

/** How many bytes a register definition occupies. */
export function registerByteWidth(definition: RegisterDefinition): number {
  return Math.max(1, Math.ceil(definition.width / 8));
}
