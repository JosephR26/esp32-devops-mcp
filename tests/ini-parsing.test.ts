/**
 * platformio.ini parsing, against files written to disk.
 *
 * Two defects came out of this parser and neither was visible from reading it: only
 * the FIRST `board =` was matched, so a three-environment project reported one board
 * and read as misconfigured; and a trailing comment landed inside the value, so
 * `board = esp32dev ; devkit` produced a board named "esp32dev ; devkit" that matched
 * nothing. Both are shape problems in real config files rather than logic errors, so
 * they are tested against real files rather than mocked reads.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateProject } from '../src/tools/project.js';

const created: string[] = [];

/** A throwaway PlatformIO project containing the given ini. */
const projectWith = async (ini: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'esp32-ini-'));
  created.push(dir);
  await writeFile(join(dir, 'platformio.ini'), ini, 'utf8');
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'main.cpp'), `void setup() {}
void loop() {}
`, 'utf8');
  return dir;
};

after(async () => {
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('platformio.ini board parsing', () => {
  it('reports every environment board, not just the first', async () => {
    const result = await validateProject(await projectWith(`[env:devkit]
platform = espressif32
board = esp32dev
framework = arduino

[env:cyd]
platform = espressif32
board = esp32-2432S028R
framework = arduino

[env:wrover]
platform = espressif32
board = esp32-wrover-kit
framework = arduino
`));

    assert.deepEqual(result.config?.environments, ['devkit', 'cyd', 'wrover']);
    assert.deepEqual(result.config?.boards, ['esp32dev', 'esp32-2432S028R', 'esp32-wrover-kit']);
  });

  it('does not report a board count below the environment count for shared boards', async () => {
    // Two environments legitimately sharing one board is not three boards, and it is
    // not a warning either. Deduplication has to keep it at one.
    const result = await validateProject(await projectWith(`[env:debug]
board = esp32dev
framework = arduino

[env:release]
board = esp32dev
framework = arduino
`));

    assert.deepEqual(result.config?.boards, ['esp32dev']);
    assert.equal(result.config?.environments.length, 2);
  });

  it('strips a semicolon comment from the board name', async () => {
    const result = await validateProject(await projectWith(`[env:devkit]
board = esp32dev ; the plain devkit, MAC 34:5F:45
framework = arduino
`));

    assert.deepEqual(result.config?.boards, ['esp32dev']);
  });

  it('strips a hash comment from the board name', async () => {
    // PlatformIO accepts both introducers; only the semicolon was handled at first.
    const result = await validateProject(await projectWith(`[env:devkit]
board = esp32dev # same again
framework = arduino
`));

    assert.deepEqual(result.config?.boards, ['esp32dev']);
  });

  it('strips a comment from the framework too', async () => {
    // The framework read its own copy of the stripping logic. Sharing one helper is
    // what makes this pass rather than duplicating the fix and hoping.
    const result = await validateProject(await projectWith(`[env:devkit]
board = esp32dev
framework = arduino ; not espidf
`));

    assert.equal(result.config?.framework, 'arduino');
  });

  it('warns when a board line is nothing but a comment', async () => {
    // Stripping can empty a value. An empty string is not a board name.
    const result = await validateProject(await projectWith(`[env:devkit]
board = ; TODO decide
framework = arduino
`));

    assert.deepEqual(result.config?.boards, []);
    assert.ok(
      result.issues.some((i) => i.message.includes('No board configured')),
      JSON.stringify(result.issues)
    );
  });
});
