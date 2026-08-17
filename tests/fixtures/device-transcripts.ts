/**
 * Real bytes from real devices.
 *
 * Companion to host-strings.ts. That file exists because every host-side bug was an
 * input-shape bug; these transcripts exist for the same reason one layer down. Protocol
 * decoding has been exercised almost entirely against bytes someone wrote by hand to
 * demonstrate the happy path, and hand-written bytes are tidy in ways real captures are
 * not: they start on a frame boundary, they are never truncated mid-sentence, and they
 * never contain the tail of a previous response.
 *
 * Every transcript here was captured from physical hardware over the interrogation
 * agent, and the awkward ones are the point. Replaying them needs no hardware, so a
 * parser regression is caught by `npm test` rather than by someone noticing an odd
 * reading months later.
 *
 * PROVENANCE, as in host-strings.ts:
 *
 *   'observed'       - captured verbatim from a device this project ran against.
 *   'representative' - documented form for a device not run against here.
 *
 * NOTHING PERSONAL IS RECORDED. The GPS transcripts have position fields replaced with
 * REDACTED (their checksums therefore do not validate — deliberate, see below), and the
 * NFC transcript carries no card UID. Both were captured from the operator's own
 * hardware and stripped before being written here.
 */

export type Provenance = 'observed' | 'representative';

export interface DeviceTranscript {
  /** Short id used in test names. */
  id: string;
  /** What produced these bytes. */
  device: string;
  /** Bytes as captured, most significant property being that they are NOT tidy. */
  bytes: number[];
  provenance: Provenance;
  /** Why this particular capture is worth keeping. */
  note: string;
}

const hex = (text: string): number[] =>
  text.trim().split(/\s+/).map((byte) => parseInt(byte, 16));

// ── NEO-6M GPS, NMEA 0183 over UART at 9600 baud ───────────────────────────────

/**
 * A capture that begins MID-SENTENCE.
 *
 * The UART started listening partway through a byte, so the first characters are
 * garbage before the first `$`. A parser that assumes a capture begins on a frame
 * boundary will mis-frame everything after it.
 */
export const NMEA_MID_SENTENCE_START: DeviceTranscript = {
  id: 'nmea-mid-sentence-start',
  device: 'u-blox NEO-6M',
  provenance: 'observed',
  note: 'Capture opened mid-byte; leading bytes are noise before the first "$".',
  bytes: hex(`
    28 29 C2 9A AA A2 8A 72 82 82 62 B2 B1 2C 2C 2C 2C 2C 2C 31 37 30 38 32 36 2C
    2C 2C 4E 2A 37 44 0D 0A
    24 47 50 56 54 47 2C 2C 2C 2C 2C 2C 2C 2C 2C 4E 2A 33 30 0D 0A
  `),
};

/**
 * A capture TRUNCATED by the agent's 512-byte payload cap, mid-sentence.
 *
 * Every live capture hits this. The final sentence has no terminator and no checksum,
 * and must not be treated as a complete reading.
 */
export const NMEA_TRUNCATED_TAIL: DeviceTranscript = {
  id: 'nmea-truncated-tail',
  device: 'u-blox NEO-6M',
  provenance: 'observed',
  note: 'Ends mid-sentence at the agent 512-byte cap: "$GPGS" with no terminator.',
  bytes: hex(`
    24 47 50 52 4D 43 2C 31 38 33 35 31 36 2E 30 30 2C 56 2C 2C 2C 2C 2C 2C 2C 2C
    2C 2C 4E 2A 37 35 0D 0A
    24 47 50 47 53
  `),
};

/**
 * No-fix state. Valid framing, empty position fields, status 'V' (void).
 *
 * The interesting property: the receiver already knows the DATE (170826) while
 * reporting no position at all. Time recovery needs one satellite; a fix needs four.
 * "No fix" is not the same as "no useful output", and a parser that discards void
 * sentences throws away a valid clock.
 */
export const NMEA_NO_FIX: DeviceTranscript = {
  id: 'nmea-no-fix',
  device: 'u-blox NEO-6M',
  provenance: 'observed',
  note: 'Void status with a valid date — time is known before position is.',
  bytes: hex(`
    24 47 50 52 4D 43 2C 31 38 33 35 34 32 2E 30 30 2C 56 2C 2C 2C 2C 2C 2C 2C 31
    37 30 38 32 36 2C 2C 2C 4E 2A 37 45 0D 0A
    24 47 50 47 47 41 2C 31 38 33 35 34 32 2E 30 30 2C 2C 2C 2C 2C 30 2C 30 30 2C
    39 39 2E 39 39 2C 2C 2C 2C 2C 2C 2A 36 46 0D 0A
    24 47 50 47 53 41 2C 41 2C 31 2C 2C 2C 2C 2C 2C 2C 2C 2C 2C 2C 2C 2C 39 39 2E
    39 39 2C 39 39 2E 39 39 2C 39 39 2E 39 39 2A 33 30 0D 0A
  `),
};

/**
 * Satellites in view while still holding no fix: 11 tracked, 0 used.
 *
 * GSV is a multi-sentence set (1 of 3, 2 of 3, …). A parser that reads only the first
 * sentence undercounts the constellation, and the count is the useful part when
 * diagnosing why a fix has not arrived.
 */
export const NMEA_GSV_MULTI_SENTENCE: DeviceTranscript = {
  id: 'nmea-gsv-multi-sentence',
  device: 'u-blox NEO-6M',
  provenance: 'observed',
  note: 'GSV split across 3 sentences: 11 satellites in view, none yet used for a fix.',
  bytes: hex(`
    24 47 50 47 53 56 2C 33 2C 31 2C 31 31 2C 30 34 2C 2C 2C 32 32 2C 30 36 2C 2C
    2C 32 33 2C 30 37 2C 2C 2C 32 31 2C 30 38 2C 2C 2C 32 32 2A 37 34 0D 0A
    24 47 50 47 53 56 2C 33 2C 32 2C 31 31 2C 31 31 2C 2C 2C 32 31 2C 31 33 2C 2C
    2C 33 37 2C 31 37 2C 2C 2C 32 33 2C 32 33 2C 2C 2C 32 32 2A 37 42 0D 0A
    24 47 50 47 53 56 2C 33 2C 33 2C 31 31 2C 33 30 2C 2C 2C 32 33 2C 33 31 2C 2C
    2C 32 33 2C 33 32 2C 2C 2C 32 39 2A 37 32 0D 0A
  `),
};

// ── PN532 NFC controller, command protocol over I2C ────────────────────────────

/**
 * `GetFirmwareVersion` — ACK frame followed by the response, in one read.
 *
 * Note the leading `01`: I2C reads are prefixed by a ready-status byte, so every frame
 * offset shifts by one relative to the datasheet's diagrams. Getting this wrong makes
 * the whole frame decode as garbage.
 */
export const PN532_FIRMWARE_VERSION: DeviceTranscript = {
  id: 'pn532-firmware-version',
  device: 'NXP PN532',
  provenance: 'observed',
  note: 'Ready byte + ACK + response. IC 0x32, firmware 1.6, support 0x07.',
  bytes: hex(`
    01 00 00 FF 00 FF 00 02
    01 00 00 FF 06 FA D5 03 32 01 06 07 E8 00 00 00
  `),
};

/**
 * A poll that found nothing: `D5 4B 00`.
 *
 * NbTg = 0 is a RESULT, not a failure. Distinguishing it from a hang matters: with the
 * default retry setting the command never returns at all, so "no targets" and "no
 * answer" look identical unless retries were capped first.
 */
export const PN532_NO_TARGET: DeviceTranscript = {
  id: 'pn532-no-target',
  device: 'NXP PN532',
  provenance: 'observed',
  note: 'InListPassiveTarget with zero targets found — a result, not an error.',
  bytes: hex('01 00 00 FF 03 FD D5 4B 00 E0 00'),
};

/**
 * A short frame followed by STALE BYTES from the previous response.
 *
 * The buffer retains the earlier reply, so anything after a short frame is residue.
 * Treating it as part of the current frame invents data that was never sent — and it is
 * genuinely easy to do, because the residue decodes plausibly.
 */
export const PN532_STALE_BUFFER_RESIDUE: DeviceTranscript = {
  id: 'pn532-stale-buffer-residue',
  device: 'NXP PN532',
  provenance: 'observed',
  note:
    'D5 4B 00 (no targets) followed by residue from an earlier activation frame. ' +
    'The residue contained a card UID, which is zeroed here — the residue is kept ' +
    'for its SHAPE, and the identifier contributes nothing to that.',
  bytes: hex(`
    01 00 00 FF 03 FD D5 4B 00 E0 00
    44 20 07 00 00 00 00 00 00 00 13 78 80 72 02 80 31 80 66 B1 84 0C 01 6E 01 83
  `),
};

/**
 * ISO14443-4 activation, with the card identifier removed.
 *
 * UID bytes are replaced with `00`; the length field is left intact because the LENGTH
 * is structural and the VALUE is the identifier. ATQA, SAK and the ATS describe the
 * card class and platform, not the instance, so they are kept.
 */
export const PN532_ISO14443A_ACTIVATION_REDACTED: DeviceTranscript = {
  id: 'pn532-iso14443a-activation-redacted',
  device: 'NXP PN532 + ISO14443-4 card',
  provenance: 'observed',
  note: 'One target: ATQA 0x0044, SAK 0x20, 7-byte UID (zeroed), 19-byte JCOP ATS.',
  bytes: hex(`
    01 00 00 FF 22 DE D5 4B 01 01 00 44 20 07
    00 00 00 00 00 00 00
    13 78 80 72 02 80 31 80 66 B1 84 0C 01 6E 01 83 00 90 00
  `),
};

export const NMEA_TRANSCRIPTS = [
  NMEA_MID_SENTENCE_START,
  NMEA_TRUNCATED_TAIL,
  NMEA_NO_FIX,
  NMEA_GSV_MULTI_SENTENCE,
] as const;

export const PN532_TRANSCRIPTS = [
  PN532_FIRMWARE_VERSION,
  PN532_NO_TARGET,
  PN532_STALE_BUFFER_RESIDUE,
  PN532_ISO14443A_ACTIVATION_REDACTED,
] as const;

export const ALL_TRANSCRIPTS = [...NMEA_TRANSCRIPTS, ...PN532_TRANSCRIPTS] as const;
