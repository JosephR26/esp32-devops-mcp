/**
 * Host-side input handling: project path validation, USB-serial bridge
 * identification, and Python interpreter discovery.
 *
 * The cases come from tests/fixtures/host-strings.ts — strings real machines
 * actually emit. Every bug covered here passed the synthetic tests and failed on
 * first contact with a real host, so the fixture is the test data rather than
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
  DEFAULT_PYTHON_COMMANDS,
  executePython,
  resolvePythonCommand,
} from '../src/utils/exec.js';
import {
  PORT_DESCRIPTIONS,
  PROJECT_PATHS,
  STORE_ALIAS_PYTHON3,
} from './fixtures/host-strings.js';

describe('project path validation against real host paths', () => {
  for (const { path, valid, provenance, note } of PROJECT_PATHS) {
    const label = path.trim() === '' ? JSON.stringify(path) : JSON.stringify(path);
    it(`${valid ? 'accepts' : 'rejects'} ${label} [${provenance}]${note ? ` — ${note}` : ''}`, () => {
      assert.equal(validateProjectPath(path), valid);
    });
  }
});

describe('USB-serial bridge identification against real port descriptions', () => {
  for (const { description, isEsp32, bridge, provenance, note } of PORT_DESCRIPTIONS) {
    it(`${isEsp32 ? 'identifies' : 'declines'} ${JSON.stringify(description)} [${provenance}]${note ? ` — ${note}` : ''}`, () => {
      assert.equal(identifyUsbSerialBridge(description), bridge);
      assert.equal(looksLikeEsp32Port(description), isEsp32);
    });
  }

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

/**
 * These assert on the FIXTURE, not on the code under test.
 *
 * The sweeps above already check each entry's expected result, so re-checking
 * those expectations would be pure duplication. What a sweep cannot notice is a
 * fixture that has quietly stopped encoding the intent — if every non-ESP32 port
 * were deleted, the bridge sweep would still pass while covering nothing.
 *
 * Nor can the type system: `Provenance` already makes an invalid value a compile
 * error and `provenance` is a required field, so a runtime check that it is one
 * of two strings adds nothing. Presence of both KINDS is the part types cannot
 * express, so that is what is checked here.
 */
describe('fixture coverage', () => {
  it('carries ports that must NOT be identified as ESP32s', () => {
    // The failure that mattered: a host platform UART reported as a board, which
    // can send a flash at the wrong device.
    const negatives = PORT_DESCRIPTIONS.filter((p) => !p.isEsp32);
    assert.ok(negatives.length > 0, 'fixture should carry non-ESP32 ports');
    assert.ok(
      negatives.some((p) => /uart/i.test(p.description)),
      'fixture should keep a non-ESP32 port whose description contains "UART"'
    );
  });

  it('carries ports that must be identified as ESP32s', () => {
    assert.ok(
      PORT_DESCRIPTIONS.some((p) => p.isEsp32),
      'fixture should carry ESP32-bearing ports'
    );
  });

  it('carries both valid and invalid paths, including absolute Windows ones', () => {
    assert.ok(PROJECT_PATHS.some((p) => p.valid), 'fixture should carry valid paths');
    assert.ok(PROJECT_PATHS.some((p) => !p.valid), 'fixture should carry invalid paths');
    assert.ok(
      PROJECT_PATHS.some((p) => p.valid && /^[a-zA-Z]:\\/.test(p.path)),
      'fixture should carry an absolute Windows path with backslashes'
    );
    assert.ok(
      PROJECT_PATHS.some((p) => p.valid && /^[a-zA-Z]:\//.test(p.path)),
      'fixture should carry an absolute Windows path with forward slashes'
    );
  });

  it('stays grounded in strings from real machines', () => {
    // 'representative' entries are realistic but unwitnessed. If the fixture ever
    // becomes entirely representative it has stopped being evidence.
    assert.ok(
      PORT_DESCRIPTIONS.some((p) => p.provenance === 'observed'),
      'fixture should keep observed port descriptions'
    );
    assert.ok(
      PROJECT_PATHS.some((p) => p.provenance === 'observed'),
      'fixture should keep observed paths'
    );
  });

  it('marks every observed path as valid', () => {
    // A path this project has really used must not be recorded as one the
    // validator should reject.
    for (const entry of PROJECT_PATHS.filter((p) => p.provenance === 'observed')) {
      assert.equal(entry.valid, true, `observed path marked invalid: ${entry.path}`);
    }
  });
});

describe('python interpreter discovery', () => {
  /** A probe standing in for a set of interpreters that exist on a host. */
  const probeFor = (usable: readonly string[]) => async (command: string) =>
    usable.includes(command);

  it('skips a candidate that exists but exits non-zero', async () => {
    // The Microsoft Store alias: present on PATH, so never ENOENT, but it runs
    // nothing and exits 9009. The original loop treated any non-ENOENT failure as
    // "the script ran and failed" and gave up, reporting Python as missing while a
    // working `python` sat next in the list.
    assert.notEqual(STORE_ALIAS_PYTHON3.exitCode, 0);

    const probe = async (command: string) => command !== 'python3';
    const resolved = await resolvePythonCommand(DEFAULT_PYTHON_COMMANDS, probe);

    assert.equal(resolved, 'python');
  });

  it('returns the first usable candidate in order', async () => {
    assert.equal(
      await resolvePythonCommand(['python3', 'python', 'py'], probeFor(['python3', 'python'])),
      'python3'
    );
    assert.equal(
      await resolvePythonCommand(['python3', 'python', 'py'], probeFor(['py'])),
      'py'
    );
  });

  it('returns null when no candidate is usable', async () => {
    assert.equal(await resolvePythonCommand(DEFAULT_PYTHON_COMMANDS, probeFor([])), null);
  });

  it('propagates a throwing probe rather than treating it as unusable', async () => {
    // PythonProbe's contract is to return false, never to throw — which is why
    // the default probe converts every failure mode into false itself. A probe
    // that throws is a bug in the caller, so it surfaces instead of being
    // silently reinterpreted as "this interpreter is missing".
    const throwing = async (command: string) => {
      if (command === 'python3') throw new Error('spawn failed');
      return true;
    };

    await assert.rejects(
      resolvePythonCommand(DEFAULT_PYTHON_COMMANDS, throwing),
      /spawn failed/
    );
  });

  it('reports Python as missing only when every candidate failed', async () => {
    const result = await executePython('script.py', [], { pythonProbe: async () => false });

    assert.equal(result.success, false);
    assert.match(result.stderr, /Python not found/);
  });

  it('tries python3, python, then py by default', () => {
    assert.deepEqual([...DEFAULT_PYTHON_COMMANDS], ['python3', 'python', 'py']);
  });
});
