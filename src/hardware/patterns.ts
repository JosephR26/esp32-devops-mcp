/**
 * Byte-pattern utilities shared by identification, probing and testing.
 *
 * A BytePattern is a whitespace-separated sequence of hex byte tokens where
 * `??` (or `*`) matches any single byte:
 *
 *   "?? 32 01 06 07"   matches 0x00 0x32 0x01 0x06 0x07 and 0xD5 0x32 ...
 *
 * Patterns are matched as a *subsequence anchored at any offset* so that framing
 * bytes preceding the payload do not defeat a match.
 */

/** Format a byte array as space-separated uppercase hex. */
export function toHex(bytes: number[] | Uint8Array, separator = ' '): string {
  return Array.from(bytes)
    .map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0'))
    .join(separator);
}

/** Format a single value as 0x-prefixed hex with a minimum width. */
export function hexValue(value: number, byteWidth = 1): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(byteWidth * 2, '0')}`;
}

/** Render a value as a binary string of the given bit width. */
export function toBinary(value: number, bits: number): string {
  return (value >>> 0).toString(2).padStart(bits, '0');
}

/** Parse a byte pattern into tokens; `null` entries are wildcards. */
export function parseBytePattern(pattern: string): (number | null)[] {
  const tokens = pattern.trim().split(/[\s,]+/).filter(Boolean);
  return tokens.map((token) => {
    if (token === '??' || token === '*' || token === 'xx' || token === 'XX') return null;
    const normalised = token.replace(/^0x/i, '');
    const value = parseInt(normalised, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xff) {
      throw new Error(`Invalid byte pattern token: "${token}"`);
    }
    return value;
  });
}

/** Whether `bytes` contains `pattern` at any offset. */
export function matchBytePattern(bytes: number[], pattern: string): boolean {
  return findBytePattern(bytes, pattern) >= 0;
}

/** Offset at which `pattern` first occurs in `bytes`, or -1. */
export function findBytePattern(bytes: number[], pattern: string): number {
  let tokens: (number | null)[];
  try {
    tokens = parseBytePattern(pattern);
  } catch {
    return -1;
  }
  if (tokens.length === 0 || bytes.length < tokens.length) return -1;

  for (let offset = 0; offset <= bytes.length - tokens.length; offset++) {
    let matched = true;
    for (let i = 0; i < tokens.length; i++) {
      const expected = tokens[i];
      if (expected !== null && (bytes[offset + i] & 0xff) !== expected) {
        matched = false;
        break;
      }
    }
    if (matched) return offset;
  }
  return -1;
}

/** Decode bytes to ASCII, or null when the run is not predominantly printable. */
export function toPrintableAscii(bytes: number[], threshold = 0.8): string | null {
  if (bytes.length === 0) return null;
  let printable = 0;
  for (const byte of bytes) {
    const b = byte & 0xff;
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
  }
  if (printable / bytes.length < threshold) return null;
  return bytes
    .map((b) => {
      const v = b & 0xff;
      return (v >= 0x20 && v <= 0x7e) || v === 0x09 || v === 0x0a || v === 0x0d
        ? String.fromCharCode(v)
        : '.';
    })
    .join('');
}

/** True when every byte is 0x00 or every byte is 0xFF — the classic "no device" reads. */
export function isDegenerateResponse(bytes: number[]): boolean {
  if (bytes.length === 0) return true;
  const first = bytes[0] & 0xff;
  if (first !== 0x00 && first !== 0xff) return false;
  return bytes.every((b) => (b & 0xff) === first);
}

/**
 * Find byte sequences that repeat within a capture.
 * Used to spot framing/preamble structure in unknown UART and SPI streams.
 */
export function findRepeatedPatterns(
  bytes: number[],
  minLength = 2,
  maxLength = 8,
  minOccurrences = 2
): { pattern: string; count: number }[] {
  const counts = new Map<string, number>();

  for (let length = minLength; length <= maxLength; length++) {
    if (bytes.length < length * minOccurrences) break;
    for (let i = 0; i + length <= bytes.length; i++) {
      const key = toHex(bytes.slice(i, i + length));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const results = Array.from(counts.entries())
    .filter(([, count]) => count >= minOccurrences)
    .map(([pattern, count]) => ({ pattern, count }));

  // Longest and most frequent first — those carry the most structural signal.
  results.sort((a, b) => {
    const lengthDiff = b.pattern.length - a.pattern.length;
    return lengthDiff !== 0 ? lengthDiff : b.count - a.count;
  });
  return results.slice(0, 20);
}

/** Mean of a sample set, or null when empty. */
export function mean(samples: number[]): number | null {
  if (samples.length === 0) return null;
  return samples.reduce((sum, v) => sum + v, 0) / samples.length;
}

/** Median of a sample set, or null when empty. */
export function median(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Population standard deviation, or null when fewer than two samples. */
export function stdDev(samples: number[]): number | null {
  if (samples.length < 2) return null;
  const m = mean(samples)!;
  const variance = samples.reduce((sum, v) => sum + (v - m) ** 2, 0) / samples.length;
  return Math.sqrt(variance);
}
