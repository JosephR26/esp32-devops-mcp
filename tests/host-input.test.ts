/**
 * Host-side input handling: project path validation and USB-serial bridge
 * identification.
 *
 * The cases come from tests/fixtures/host-strings.ts — strings real machines
 * actually emit. Both bugs covered here passed every synthetic test and failed
 * on first contact with a real host, so the fixture is the test data rather than
 * something tidier invented alongside it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateProjectPath } from '../src/utils/validation.js';
import {
  identifyUsbSerialBridge,
  looksLikeEsp32Port,
  parseSerialPorts,
} from '../src/utils/parser.js';
import {
  PORT_DESCRIPTIONS,
  PROJECT_PATHS,
  STORE_ALIAS_PYTHON3,
} from './fixtures/host-strings.js';

describe('project path validation against real host paths', () => {
  for (const { path, valid, provenance, note } of PROJECT_PATHS) {
    const label = path === '' ? '(empty string)' : JSON.stringify(path);
    it(`${valid ? 'accepts' : 'rejects'} ${label} [${provenance}]${note ? ` — ${note}` : ''}`, () => {
      assert.equal(validateProjectPath(path), valid);
    });
  }

  it('accepts every observed path', () => {
    // Narrower than the sweep above and deliberately so: a path this project has
    // actually used must never be rejected, whatever else changes.
    const observed = PROJECT_PATHS.filter((p) => p.provenance === 'observed');
    assert.ok(observed.length > 0, 'fixture should carry observed paths');

    for (const { path } of observed) {
      assert.equal(validateProjectPath(path), true, `observed path rejected: ${path}`);
    }
  });
});

describe('USB-serial bridge identification against real port descriptions', () => {
  for (const { description, isEsp32, bridge, provenance, note } of PORT_DESCRIPTIONS) {
    it(`${isEsp32 ? 'identifies' : 'declines'} ${JSON.stringify(description)} [${provenance}]${note ? ` — ${note}` : ''}`, () => {
      assert.equal(identifyUsbSerialBridge(description), bridge);
      assert.equal(looksLikeEsp32Port(description), isEsp32);
    });
  }

  it('never claims a host-internal or virtual port is an ESP32', () => {
    // The failure that mattered: a platform UART reported as a board. Any
    // regression here can send a flash at the wrong device.
    for (const { description, isEsp32 } of PORT_DESCRIPTIONS.filter((p) => !p.isEsp32)) {
      assert.equal(
        looksLikeEsp32Port(description),
        false,
        `wrongly identified as an ESP32: ${description}`
      );
      assert.equal(isEsp32, false);
    }
  });

  it('identifies a bridge for every port expected to carry one', () => {
    for (const { description, bridge } of PORT_DESCRIPTIONS.filter((p) => p.isEsp32)) {
      assert.equal(
        identifyUsbSerialBridge(description),
        bridge,
        `bridge mismatch for: ${description}`
      );
    }
  });

  it('does not identify a bridge in an empty description', () => {
    assert.equal(identifyUsbSerialBridge(''), null);
  });
});

describe('serial port list parsing', () => {
  it('marks only real bridges when parsing a mixed port list', () => {
    // The exact three ports this development machine enumerates.
    const output = [
      '1. COM1 - Qualcomm(R) UART Bus Device (COM1)',
      '2. COM2 - Qualcomm(R) UART Bus Device (COM2)',
      '3. COM3 - USB-SERIAL CH340 (COM3)',
    ].join('\n');

    const { ports } = parseSerialPorts(output);

    assert.equal(ports.length, 3);
    assert.deepEqual(
      ports.map((p: any) => [p.port, p.isESP32]),
      [['COM1', false], ['COM2', false], ['COM3', true]]
    );
    assert.equal(ports[2].bridge, 'WCH CH34x');
    assert.equal(ports[0].bridge, undefined, 'no bridge field when none was identified');
  });
});

describe('fixture integrity', () => {
  it('records provenance for every entry', () => {
    // The fixture is only worth having if 'observed' means observed. Guard the
    // shape so an entry cannot be added without saying where it came from.
    for (const entry of [...PORT_DESCRIPTIONS, ...PROJECT_PATHS]) {
      assert.ok(
        entry.provenance === 'observed' || entry.provenance === 'representative',
        `missing or invalid provenance: ${JSON.stringify(entry)}`
      );
    }
  });

  it('keeps the Store alias case on record even though nothing asserts on it yet', () => {
    // executePython hardcodes its candidate list, so this cannot be reproduced
    // without injecting one. Keep the shape that broke fallback: present on PATH,
    // so never ENOENT, but exits non-zero having run nothing.
    assert.equal(STORE_ALIAS_PYTHON3.exitCode, 9009);
    assert.notEqual(STORE_ALIAS_PYTHON3.exitCode, 0);
    assert.match(STORE_ALIAS_PYTHON3.stdout, /Python was not found/);
    assert.equal(STORE_ALIAS_PYTHON3.provenance, 'observed');
  });
});
