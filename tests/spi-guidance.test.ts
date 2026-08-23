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

/**
 * Resolve a phrase to the ONE entry that carries it.
 *
 * These assertions used to run against `limitations.join(' ')`, which is weaker than
 * it looks: a joined string cannot tell a finding stated in one coherent entry from
 * the same words scattered across three, and it never notices a duplicate. Requiring
 * exactly one matching entry checks the structure as well as the content — and fails
 * if an entry is split without the test being updated to follow.
 */
const entryContaining = (entries: readonly string[], phrase: string): string => {
  const matches = entries.filter((entry) => entry.includes(phrase));
  assert.equal(
    matches.length,
    1,
    `expected exactly one entry containing "${phrase}", found ${matches.length}`
  );
  return matches[0];
};

const limitation = (phrase: string) => entryContaining(PN532_PROFILE.limitations, phrase);

describe('PN532 profile records what was learned on hardware', () => {
  it('warns that SPI is unreliable on clones, and names I2C in the same entry', () => {
    // The verdict after eliminating every other cause by measurement. A limitation
    // that only says "this may not work" leaves the reader exactly where they were,
    // so the recommendation has to travel with the warning rather than sit elsewhere
    // in the array where a reader may not reach it.
    const verdict = limitation('SPI mode is UNRELIABLE on breakout clones');
    assert.ok(verdict.includes('prefer I2C'), verdict);
    assert.ok(verdict.includes('worked over I2C first time'), verdict);
  });

  it('separates the SPI verdict from the evidence behind it', () => {
    // Two different jobs: one tells you what to do, the other tells you why it is
    // trustworthy. Crammed into one entry, the instruction gets lost in the recital.
    const evidence = limitation('reached by elimination');
    assert.ok(evidence.includes('continuity probed pin-to-pad'), evidence);
    assert.ok(evidence.includes('all four positions tried'), evidence);
    assert.ok(evidence.includes('RSTO measured driven high'), evidence);
  });

  it('records the loopback as the positive control that made the negatives mean anything', () => {
    const control = limitation('proven independently by a loopback');
    assert.ok(control.includes('BEFORE concluding anything from silence'), control);
  });

  it('records the LSB-first quirk, which fails silently when missed', () => {
    const bitOrder = limitation('LSB-FIRST');
    assert.ok(bitOrder.includes('plausible-looking garbage'), bitOrder);
  });

  it('records the infinite-retry trap that looks like a broken device', () => {
    const trap = limitation('MxRtyPassiveActivation');
    assert.ok(trap.includes('retry forever'), trap);
    assert.ok(trap.includes('indistinguishable from a broken device'), trap);
  });

  it('gives the retry cap as its own instruction rather than a clause', () => {
    const remedy = limitation('RFConfiguration item 0x05');
    assert.ok(remedy.includes('NbTg=0'), remedy);
  });

  it('states the 13.56 MHz limit that explains why LF fobs never appear', () => {
    const band = limitation('13.56 MHz ONLY');
    assert.ok(band.includes('125 kHz'), band);
  });

  it('says outright that an empty poll with an LF fob is correct behaviour', () => {
    // Without this, a correct result reads as a fault and gets chased.
    const expected = limitation('correct behaviour, not a failure');
    assert.ok(expected.includes('No amount of repositioning will change it'), expected);
  });

  it('states each limitation once', () => {
    const seen = new Set(PN532_PROFILE.limitations);
    assert.equal(
      seen.size,
      PN532_PROFILE.limitations.length,
      'a duplicated limitation is invisible in a joined string'
    );
  });
});

describe('SPI discovery guidance on a degenerate result', () => {
  const guidance = (phrase: string) => entryContaining(DEGENERATE_SPI_GUIDANCE, phrase);

  it('leads with what a uniform response actually means', () => {
    assert.ok(DEGENERATE_SPI_GUIDANCE[0].includes('not evidence of a device'));
  });

  it('tells the caller to prove the host path with a loopback FIRST', () => {
    // Ordering matters: investigating the device before establishing a positive
    // control is what turns ten seconds into an evening.
    const loopback = guidance('jumper MOSI directly to MISO');
    assert.ok(loopback.includes('loopback MUST echo the bytes sent'), loopback);
  });

  it('says plainly that a uniform response proves nothing without that control', () => {
    guidance('equally consistent with a host that cannot read');
  });

  it('directs suspicion at the device only after the loopback passes', () => {
    const after = guidance('If the loopback echoes and the device still returns a uniform pattern');
    assert.ok(after.includes('some breakout clones do not implement SPI usefully'), after);
  });
});
