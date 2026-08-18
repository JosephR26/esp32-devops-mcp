/**
 * What the tools say when SPI returns nothing useful.
 *
 * A uniform 0x00/0xFF response is UNINTERPRETABLE on its own: "no device answered"
 * and "the host cannot read at all" look identical. An evening was spent chasing a
 * silent PN532 through wiring, switch positions, CS timing and bit order before a
 * loopback finally proved the host side worked — at which point every earlier
 * negative became meaningful at once.
 *
 * These tests pin the guidance that makes that a ten-second check instead.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PN532_PROFILE } from '../src/hardware/profiles/pn532.js';
import { DEGENERATE_SPI_GUIDANCE } from '../src/tools/hardware.js';

const limitations = PN532_PROFILE.limitations.join(' ');

describe('PN532 profile records what was learned on hardware', () => {
  it('warns that SPI is unreliable on clones', () => {
    // The verdict after eliminating every other cause by measurement.
    assert.match(limitations, /SPI mode is UNRELIABLE on breakout clones/i);
  });

  it('names I2C as the fallback rather than leaving the reader stuck', () => {
    // A limitation that only says "this may not work" wastes the reader's time.
    assert.match(limitations, /prefer I2C/i);
  });

  it('records the LSB-first quirk, which fails silently when missed', () => {
    assert.match(limitations, /LSB-FIRST/i);
    assert.match(limitations, /plausible-looking garbage/i);
  });

  it('records the infinite-retry trap that looks like a broken device', () => {
    assert.match(limitations, /retry forever|MxRtyPassiveActivation/i);
  });

  it('states the 13.56 MHz limit that explains why LF fobs never appear', () => {
    assert.match(limitations, /13\.56 MHz ONLY/);
    assert.match(limitations, /125 kHz/);
  });
});

describe('SPI discovery guidance on a degenerate result', () => {
  const source = DEGENERATE_SPI_GUIDANCE.join(' ');

  it('leads with what a uniform response actually means', () => {
    assert.match(DEGENERATE_SPI_GUIDANCE[0], /not evidence of a device/);
  });

  it('tells the caller to prove the host path with a loopback FIRST', () => {
    // Ordering matters: investigating the device before establishing a positive
    // control is what turns ten seconds into an evening.
    assert.match(source, /jumper MOSI directly to MISO/);
    assert.match(source, /loopback MUST echo the bytes sent/);
  });

  it('says plainly that a uniform response proves nothing without that control', () => {
    assert.match(source, /equally consistent with a host that cannot read/);
  });

  it('directs suspicion at the device only after the loopback passes', () => {
    assert.match(source, /If the loopback echoes and the device still returns a uniform pattern/);
    assert.match(source, /some breakout clones do not implement SPI usefully/);
  });
});
