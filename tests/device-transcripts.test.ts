/**
 * Replay real device captures against the parsers.
 *
 * These bytes came off physical hardware, and the awkward ones are the point: captures
 * that begin mid-sentence, end truncated at the agent's payload cap, or carry residue
 * from a previous response. Hand-written test bytes are tidy in exactly the ways real
 * captures are not, which is how a decoder can look correct for months.
 *
 * No hardware is needed to run these, so a decoding regression fails `npm test` instead
 * of being noticed as an odd reading much later.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_TRANSCRIPTS,
  NMEA_GSV_MULTI_SENTENCE,
  NMEA_MID_SENTENCE_START,
  NMEA_NO_FIX,
  NMEA_TRUNCATED_TAIL,
  PN532_FIRMWARE_VERSION,
  PN532_ISO14443A_ACTIVATION_REDACTED,
  PN532_NO_TARGET,
  PN532_STALE_BUFFER_RESIDUE,
} from './fixtures/device-transcripts.js';
import {
  findBytePattern,
  isDegenerateResponse,
  toHex,
  toPrintableAscii,
} from '../src/hardware/patterns.js';

const ascii = (bytes: readonly number[]) => Buffer.from(bytes).toString('latin1');

/**
 * Named field accessors.
 *
 * NMEA is positional, so a raw index says nothing about what is being read and an
 * off-by-one is invisible. Naming them makes a wrong field a readable mistake.
 * The checksum suffix is stripped first so the last field parses like any other.
 */
const field = (sentence: string, index: number): string =>
  sentence.replace(/\*..\r\n$/, '').split(',')[index];

const rmc = {
  status: (s: string) => field(s, 2),
  date: (s: string) => field(s, 9),
};

const gga = {
  fixQuality: (s: string) => field(s, 6),
  satellitesUsed: (s: string) => field(s, 7),
};

const gsv = {
  totalInView: (s: string) => Number(field(s, 3)),
};

/** Complete NMEA sentences only: `$`…CRLF. A truncated tail must not match. */
const completeSentences = (bytes: readonly number[]): string[] =>
  ascii(bytes).match(/\$[^$\r\n]*\r\n/g) ?? [];

describe('NMEA transcripts', () => {
  it('ignores the noise before the first sentence in a mid-sentence capture', () => {
    // The capture opened mid-byte, so the leading bytes are not a sentence at all.
    const text = ascii(NMEA_MID_SENTENCE_START.bytes);
    assert.notEqual(text[0], '$', 'fixture should genuinely start mid-sentence');

    const sentences = completeSentences(NMEA_MID_SENTENCE_START.bytes);
    assert.equal(sentences.length, 1, 'only the one complete sentence should be extracted');
    assert.ok(sentences[0].startsWith('$GPVTG'), sentences[0]);
  });

  it('does not treat a truncated tail as a sentence', () => {
    // Every live capture hits the agent's 512-byte cap. The final fragment has no
    // terminator and no checksum, so it is not a reading.
    //
    // The previous version of this assertion COULD NOT FAIL. It checked that no
    // extracted sentence both lacked CRLF and ended with "$GPGS" — but every extracted
    // sentence ends with CRLF by construction, so the predicate was never true and the
    // assertion passed regardless of what the parser did. A check whose negative result
    // is structurally guaranteed reports success without testing anything.
    const text = ascii(NMEA_TRUNCATED_TAIL.bytes);
    assert.ok(text.endsWith('$GPGS'), 'fixture should genuinely end mid-sentence');

    const sentences = completeSentences(NMEA_TRUNCATED_TAIL.bytes);

    // The complete sentence IS extracted...
    assert.equal(sentences.length, 1, 'exactly one complete sentence in this capture');
    assert.ok(sentences[0].startsWith('$GPRMC'), sentences[0]);
    assert.ok(sentences[0].endsWith('\r\n'), 'a complete sentence is CRLF-terminated');

    // ...and the truncated fragment, present in the raw input, is NOT.
    assert.ok(text.includes('$GPGS'), 'the fragment is in the input');
    assert.ok(
      !sentences.some((s) => s.includes('$GPGS')),
      'the truncated fragment must not appear in any extracted sentence'
    );
  });

  it('keeps the date from a void fix rather than discarding the sentence', () => {
    // Time recovery needs one satellite; a position fix needs four. Discarding void
    // sentences throws away a valid clock.
    const sentence = completeSentences(NMEA_NO_FIX.bytes).find((s) => s.startsWith('$GPRMC'));
    assert.ok(sentence, 'expected an RMC sentence');

    assert.equal(rmc.status(sentence), 'V', 'status should be void');
    assert.equal(rmc.date(sentence), '170826', 'date should still be present despite no fix');
  });

  it('reports no satellites used while a fix is absent', () => {
    const sentence = completeSentences(NMEA_NO_FIX.bytes).find((s) => s.startsWith('$GPGGA'));
    assert.ok(sentence, 'expected a GGA sentence');

    assert.equal(gga.fixQuality(sentence), '0', 'fix quality 0');
    assert.equal(gga.satellitesUsed(sentence), '00', 'zero satellites used');
  });

  it('counts the whole constellation across a multi-sentence GSV set', () => {
    // Reading only the first GSV sentence undercounts satellites in view, which is the
    // number that matters when diagnosing why a fix has not arrived.
    const sentences = completeSentences(NMEA_GSV_MULTI_SENTENCE.bytes);
    assert.equal(sentences.length, 3, 'GSV set should span three sentences');

    const totals = sentences.map(gsv.totalInView);
    assert.deepEqual(totals, [11, 11, 11], 'every GSV sentence declares the same total');

    // Satellite records are 4 fields each, after the 4 header fields.
    const tracked = sentences.reduce((count, sentence) => {
      const fields = sentence.replace(/\*..\r\n$/, '').split(',');
      return count + Math.floor((fields.length - 4) / 4);
    }, 0);
    assert.equal(tracked, 11, 'all 11 satellites should be recoverable from the set');
  });

  it('reads as text, which is what identifies the baud rate as correct', () => {
    const text = toPrintableAscii(NMEA_NO_FIX.bytes);
    assert.ok(text !== null, 'a correct baud rate on a text protocol yields printable ASCII');
  });
});

describe('PN532 transcripts', () => {
  /** I2C reads are prefixed by a ready byte, so every frame offset shifts by one. */
  const afterReadyByte = (bytes: readonly number[]) => bytes.slice(1);

  it('locates the ACK frame after the I2C ready byte', () => {
    // Getting the ready-byte offset wrong makes the whole frame decode as garbage.
    assert.equal(PN532_FIRMWARE_VERSION.bytes[0], 0x01, 'ready byte should be present');

    const ackAt = findBytePattern(PN532_FIRMWARE_VERSION.bytes, '00 00 FF 00 FF 00');
    assert.equal(ackAt, 1, 'ACK frame should start immediately after the ready byte');
  });

  it('extracts IC, version and capability from GetFirmwareVersion', () => {
    const body = afterReadyByte(PN532_FIRMWARE_VERSION.bytes);
    const at = findBytePattern(body, 'D5 03');
    assert.ok(at >= 0, 'response TFI + command should be present');

    assert.equal(body[at + 2], 0x32, 'IC code 0x32 identifies a PN532');
    assert.equal(body[at + 3], 0x01, 'firmware major');
    assert.equal(body[at + 4], 0x06, 'firmware minor');
    assert.equal(body[at + 5] & 0x07, 0x07, 'supports ISO14443-A, ISO14443-B and ISO18092');
  });

  it('reads "no targets" as a result rather than a failure', () => {
    // NbTg = 0 means the field was energised and nothing answered. That is a finding.
    const body = afterReadyByte(PN532_NO_TARGET.bytes);
    const at = findBytePattern(body, 'D5 4B');
    assert.ok(at >= 0);
    assert.equal(body[at + 2], 0x00, 'NbTg should be zero');

    // Frame length governs how much of the buffer belongs to this response.
    assert.equal(body[3], 0x03, 'LEN=3 covers only D5 4B NbTg');
  });

  it('does not read stale buffer residue as part of a short frame', () => {
    // The buffer retains the previous reply. Residue decodes plausibly, so treating it
    // as current data invents readings that were never sent.
    const body = afterReadyByte(PN532_STALE_BUFFER_RESIDUE.bytes);
    const length = body[3];
    assert.equal(length, 0x03, 'declared frame length');

    // Frame = LEN + LCS + payload(LEN) + DCS + postamble, starting after 00 00 FF.
    const frameEnd = 3 + 1 + 1 + length + 1 + 1;
    const payload = body.slice(5, 5 + length);
    assert.deepEqual([...payload], [0xd5, 0x4b, 0x00], 'payload is the no-target response');

    const residue = body.slice(frameEnd);
    assert.ok(residue.length > 0, 'fixture should carry residue');
    assert.notEqual(residue[0], 0xd5, 'residue is not a new response frame');
  });

  it('decodes an ISO14443-4 activation without needing the card identifier', () => {
    const body = afterReadyByte(PN532_ISO14443A_ACTIVATION_REDACTED.bytes);
    const at = findBytePattern(body, 'D5 4B');
    assert.ok(at >= 0);

    assert.equal(body[at + 2], 0x01, 'one target');
    assert.equal(body[at + 3], 0x01, 'target number 1');

    const atqa = (body[at + 4] << 8) | body[at + 5];
    assert.equal(atqa, 0x0044, 'ATQA: double-size UID, ISO14443-4');
    assert.equal(body[at + 6], 0x20, 'SAK: ISO14443-4 compliant');

    const uidLength = body[at + 7];
    assert.equal(uidLength, 7, 'UID length is structural and is kept');

    // The identifier itself is zeroed in the fixture. Length parses; value carries
    // nothing about a real card.
    const uid = body.slice(at + 8, at + 8 + uidLength);
    assert.ok(uid.every((b) => b === 0), 'fixture UID must stay redacted');

    const ats = body.slice(at + 8 + uidLength);
    assert.equal(ats[0], 0x13, 'ATS declares 19 bytes');
    assert.equal(ats[1], 0x78, 'T0: TA/TB/TC present, FSCI=8');
    assert.equal(ats[4], 0x02, 'TC(1): CID supported, NAD not');
  });

  it('recognises the JCOP platform signature in the historical bytes', () => {
    // Platform, not cardholder — which is why these bytes are safe to keep.
    const at = findBytePattern(PN532_ISO14443A_ACTIVATION_REDACTED.bytes, '80 31 80 66 B1 84');
    assert.ok(at >= 0, 'JCOP historical bytes should be present');
  });
});

describe('transcript fixture integrity', () => {
  it('holds only whole bytes', () => {
    for (const transcript of ALL_TRANSCRIPTS) {
      for (const byte of transcript.bytes) {
        assert.ok(
          Number.isInteger(byte) && byte >= 0 && byte <= 0xff,
          `${transcript.id} contains a non-byte: ${byte}`
        );
      }
    }
  });

  it('records provenance and a reason for every transcript', () => {
    for (const transcript of ALL_TRANSCRIPTS) {
      assert.ok(['observed', 'representative'].includes(transcript.provenance), transcript.id);
      assert.ok(transcript.note.length > 10, `${transcript.id} should say why it is kept`);
    }
  });

  it('keeps the awkward captures, not just the clean ones', () => {
    // A fixture of only well-formed frames would defeat the purpose.
    const notes = ALL_TRANSCRIPTS.map((t) => t.note.toLowerCase()).join(' ');
    assert.match(notes, /mid-byte|mid-sentence/, 'keep a capture that starts mid-sentence');
    assert.match(notes, /cap|truncat/, 'keep a capture truncated by the payload cap');
    assert.match(notes, /residue/, 'keep a capture carrying stale buffer residue');
  });

  it('contains no card identifier', () => {
    // The activation transcript is the only one that ever had one.
    const uidBytes = [0x05, 0x8d, 0x78, 0x8f, 0x8e, 0xf3];
    for (const transcript of ALL_TRANSCRIPTS) {
      const found = findBytePattern(transcript.bytes, toHex(uidBytes));
      assert.equal(found, -1, `${transcript.id} must not contain the captured card UID`);
    }
  });

  it('does not mistake a real capture for a degenerate one', () => {
    // All-0x00 or all-0xFF means a floating line, not data. Real captures must not
    // trip that check, or genuine readings get discarded as noise.
    for (const transcript of ALL_TRANSCRIPTS) {
      assert.equal(
        isDegenerateResponse(transcript.bytes),
        false,
        `${transcript.id} should not read as a floating line`
      );
    }
  });
});
