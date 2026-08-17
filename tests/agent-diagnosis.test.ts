/**
 * The remedy offered when the interrogation agent cannot be reached.
 *
 * Getting this wrong is expensive in the physical world: telling someone to reflash
 * when a serial monitor was holding the port sends them to rewrite a working board.
 * These tests pin the advice to the actual failure.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentUnavailableHelp } from '../src/hardware/session.js';

const joined = (kind?: string) => agentUnavailableHelp('detail line', kind).join(' ');

describe('agent-unavailable diagnosis', () => {
  it('always leads with the caller-supplied detail', () => {
    for (const kind of [undefined, 'PORT_UNAVAILABLE', 'NO_TRANSPORT', 'AGENT_NOT_PRESENT', 'TIMEOUT']) {
      assert.equal(agentUnavailableHelp('detail line', kind)[0], 'detail line');
    }
  });

  it('does NOT advise reflashing when the port could not be opened', () => {
    // The bug this guards: a busy port produced "flash the agent firmware", which
    // blames a board that was never contacted.
    const text = joined('PORT_UNAVAILABLE');
    assert.doesNotMatch(text, /flash/i);
    assert.doesNotMatch(text, /pio run/);
    assert.match(text, /could not be opened/i);
    assert.match(text, /not implicated/i);
  });

  it('names the likely holders of a busy port', () => {
    assert.match(joined('PORT_UNAVAILABLE'), /serial monitor|in flight|stale process/i);
  });

  it('does NOT advise reflashing when pyserial is missing', () => {
    const text = joined('NO_TRANSPORT');
    assert.doesNotMatch(text, /pio run/);
    assert.match(text, /pyserial/i);
    assert.match(text, /not implicated/i);
  });

  it('does advise flashing when the agent genuinely did not answer', () => {
    for (const kind of ['AGENT_NOT_PRESENT', 'TIMEOUT']) {
      const text = joined(kind);
      assert.match(text, /interrogation agent firmware/i, kind);
      assert.match(text, /pio run -e esp32dev -t upload/, kind);
    }
  });

  it('falls back to the firmware advice for an unknown or absent kind', () => {
    // Safest default: an unrecognised failure is more likely a missing agent than a
    // held port, and the advice is at least harmless.
    for (const kind of [undefined, 'INTERNAL', 'SOMETHING_NEW']) {
      assert.match(joined(kind), /interrogation agent firmware/i, String(kind));
    }
  });
});
