/**
 * Byte-pattern matching, register decoding, and the read-only guarantees around
 * register inspection.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findBytePattern,
  findRepeatedPatterns,
  hexValue,
  isDegenerateResponse,
  matchBytePattern,
  mean,
  median,
  parseBytePattern,
  stdDev,
  toBinary,
  toHex,
  toPrintableAscii,
} from '../src/hardware/patterns.js';
import {
  bytesToValue,
  decodeRegister,
  decodeRegisterFields,
  extractField,
  failedRegisterResult,
  formatRegisterAddress,
  isSafeToInspect,
  registerByteWidth,
  skipReason,
  skippedRegisterResult,
} from '../src/hardware/registers.js';
import type { RegisterDefinition } from '../src/types/hardware.js';

describe('byte pattern matching', () => {
  it('matches an exact sequence at any offset', () => {
    const bytes = [0x01, 0x00, 0x00, 0xff, 0xd5, 0x03, 0x32, 0x01];
    assert.ok(matchBytePattern(bytes, 'D5 03 32'));
    assert.equal(findBytePattern(bytes, 'D5 03 32'), 4);
  });

  it('treats ?? as a wildcard byte', () => {
    assert.ok(matchBytePattern([0xd5, 0x03, 0x32], '?? 03 32'));
    assert.ok(matchBytePattern([0x00, 0x03], '?? 03'));
  });

  it('accepts * and xx as wildcards too', () => {
    assert.ok(matchBytePattern([0xaa, 0xbb], '* BB'));
    assert.ok(matchBytePattern([0xaa, 0xbb], 'xx BB'));
  });

  it('rejects a non-matching sequence', () => {
    assert.equal(matchBytePattern([0xd5, 0x03, 0x33], 'D5 03 32'), false);
    assert.equal(findBytePattern([0x01], 'D5 03'), -1);
  });

  it('handles an empty byte array and an over-long pattern', () => {
    assert.equal(matchBytePattern([], 'D5'), false);
    assert.equal(matchBytePattern([0xd5], 'D5 03 32'), false);
  });

  it('returns -1 for a malformed pattern rather than throwing', () => {
    assert.equal(findBytePattern([0x01, 0x02], 'ZZ 03'), -1);
    assert.throws(() => parseBytePattern('ZZ'), /Invalid byte pattern token/);
  });

  it('parses 0x-prefixed tokens and comma separators', () => {
    assert.deepEqual(parseBytePattern('0xD5, 0x03'), [0xd5, 0x03]);
  });
});

describe('byte formatting', () => {
  it('formats bytes as uppercase hex', () => {
    assert.equal(toHex([0x00, 0x0f, 0xff]), '00 0F FF');
    assert.equal(hexValue(0x24), '0x24');
    assert.equal(hexValue(0x1234, 2), '0x1234');
    assert.equal(toBinary(0x05, 8), '00000101');
  });

  it('decodes printable ASCII and rejects binary noise', () => {
    assert.equal(toPrintableAscii([0x41, 0x42, 0x43]), 'ABC');
    assert.equal(toPrintableAscii([0x00, 0x01, 0x02, 0x03]), null);
    assert.equal(toPrintableAscii([]), null);
  });

  it('flags all-0x00 and all-0xFF responses as degenerate', () => {
    assert.equal(isDegenerateResponse([0x00, 0x00, 0x00]), true);
    assert.equal(isDegenerateResponse([0xff, 0xff]), true);
    assert.equal(isDegenerateResponse([0xff, 0x00]), false);
    assert.equal(isDegenerateResponse([0x12, 0x34]), false);
    assert.equal(isDegenerateResponse([]), true, 'no data is not data');
  });

  it('finds repeated sequences in a capture', () => {
    const patterns = findRepeatedPatterns([0xb5, 0x62, 0x01, 0xb5, 0x62, 0x02, 0xb5, 0x62, 0x03]);
    assert.ok(patterns.some((p) => p.pattern === 'B5 62' && p.count === 3));
  });

  it('returns no repeated patterns for a short or unique capture', () => {
    assert.deepEqual(findRepeatedPatterns([0x01]), []);
    assert.deepEqual(findRepeatedPatterns([0x01, 0x02, 0x03, 0x04], 2, 2, 2), []);
  });
});

describe('statistics helpers', () => {
  it('computes mean, median and standard deviation', () => {
    assert.equal(mean([2, 4, 6]), 4);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.ok(Math.abs(stdDev([2, 4, 4, 4, 5, 5, 7, 9])! - 2) < 1e-9);
  });

  it('returns null rather than a fabricated statistic for empty input', () => {
    assert.equal(mean([]), null);
    assert.equal(median([]), null);
    assert.equal(stdDev([]), null);
    assert.equal(stdDev([5]), null, 'one sample has no spread');
  });
});

describe('register decoding', () => {
  const CONFIG: RegisterDefinition = {
    address: 0x6b,
    name: 'PWR_MGMT_1',
    width: 8,
    access: 'RW',
    resetValue: 0x40,
    safeToRead: true,
    reference: 'RM-MPU-6000A §4.28',
    fields: [
      {
        name: 'CLKSEL',
        bitOffset: 0,
        bitWidth: 3,
        enumerations: { '0': 'Internal 8 MHz oscillator', '1': 'PLL with X-axis gyro reference' },
      },
      { name: 'TEMP_DIS', bitOffset: 3, bitWidth: 1 },
      { name: 'SLEEP', bitOffset: 6, bitWidth: 1, enumerations: { '0': 'Awake', '1': 'Asleep' } },
    ],
  };

  it('extracts bitfields correctly', () => {
    assert.equal(extractField(0b1010_1101, 0, 3), 0b101);
    assert.equal(extractField(0b1010_1101, 6, 1), 0b10 & 1);
    assert.equal(extractField(0xffff, 0, 16), 0xffff);
  });

  it('rejects an invalid bit width', () => {
    assert.throws(() => extractField(0xff, 0, 0), /Invalid bit width/);
    assert.throws(() => extractField(0xff, 0, 33), /Invalid bit width/);
  });

  it('decodes fields with their documented meanings', () => {
    const fields = decodeRegisterFields(CONFIG, 0x41);
    const clksel = fields.find((f) => f.name === 'CLKSEL')!;
    const sleep = fields.find((f) => f.name === 'SLEEP')!;

    assert.equal(clksel.value, 1);
    assert.equal(clksel.meaning, 'PLL with X-axis gyro reference');
    assert.equal(sleep.value, 1);
    assert.equal(sleep.meaning, 'Asleep');
    assert.equal(clksel.binary, '001');
  });

  it('reports whether the value differs from the documented reset value', () => {
    const changed = decodeRegister(CONFIG, [0x01], 'raw');
    assert.equal(changed.changedFromReset, true);
    assert.equal(changed.rawValue.value, 0x01);
    assert.equal(changed.resetValue.value, 0x40);

    const unchanged = decodeRegister(CONFIG, [0x40], 'raw');
    assert.equal(unchanged.changedFromReset, false);
  });

  it('returns null for changedFromReset when no reset value is documented', () => {
    const noReset: RegisterDefinition = { ...CONFIG, resetValue: undefined as unknown as number };
    delete (noReset as Partial<RegisterDefinition>).resetValue;
    const result = decodeRegister(noReset, [0x12], 'raw');
    assert.equal(result.changedFromReset, null);
    assert.equal(result.resetValue.known, false);
  });

  it('caps single-read confidence at HIGH, never CONFIRMED', () => {
    const result = decodeRegister(CONFIG, [0x40], 'raw');
    assert.equal(result.confidence, 'HIGH');
    assert.notEqual(result.confidence, 'CONFIRMED');
  });

  it('assembles multi-byte registers big-endian', () => {
    assert.equal(bytesToValue([0x85, 0x83]), 0x8583);
    assert.equal(bytesToValue([0xff]), 0xff);
    assert.equal(registerByteWidth({ ...CONFIG, width: 16 }), 2);
    assert.equal(registerByteWidth({ ...CONFIG, width: 8 }), 1);
  });

  it('formats numeric and symbolic addresses', () => {
    assert.equal(formatRegisterAddress(0x6b), '0x6B');
    assert.equal(formatRegisterAddress('STATUS'), 'STATUS');
  });
});

describe('register read safety', () => {
  const base: RegisterDefinition = {
    address: 0x01,
    name: 'R',
    width: 8,
    access: 'R',
    safeToRead: true,
    fields: [],
  };

  it('permits reads of safe, readable registers', () => {
    assert.equal(isSafeToInspect(base), true);
    assert.equal(isSafeToInspect({ ...base, access: 'RW' }), true);
  });

  it('refuses to read a write-only register', () => {
    assert.equal(isSafeToInspect({ ...base, access: 'W' }), false);
    assert.match(skipReason({ ...base, access: 'W' }), /never writes/);
  });

  it('refuses to read a clear-on-read register', () => {
    const volatileReg = { ...base, readHasSideEffects: true };
    assert.equal(isSafeToInspect(volatileReg), false);
    assert.match(skipReason(volatileReg), /mutates device state/);
  });

  it('refuses to read a register the profile marks unsafe', () => {
    assert.equal(isSafeToInspect({ ...base, safeToRead: false }), false);
  });

  it('builds a skipped result carrying the reason and no fabricated value', () => {
    const result = skippedRegisterResult({ ...base, access: 'W' });
    assert.equal(result.read, false);
    assert.equal(result.rawValue.known, false);
    assert.equal(result.hex, null);
    assert.equal(result.fields.length, 0);
    assert.ok(result.skipped);
  });

  it('builds a failed result that keeps the raw capture', () => {
    const result = failedRegisterResult(base, 'device did not answer', 'RAW-BYTES');
    assert.equal(result.read, false);
    assert.equal(result.error, 'device did not answer');
    assert.equal(result.rawBytes, 'RAW-BYTES');
    assert.equal(result.skipped, undefined);
  });
});
