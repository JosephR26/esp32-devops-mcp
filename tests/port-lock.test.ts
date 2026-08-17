/**
 * Cross-process serial port exclusion.
 *
 * The bug this exists to prevent: the control panel and the MCP server are separate
 * processes, both legitimately wanting the same board. The loser of that race got a
 * PermissionError which the tools reported as a datasheet-only answer — so a 400 ms
 * collision looked like a board needing reflashing.
 *
 * These tests run in one process, so they prove the lock's *mechanism* (atomic file
 * creation, abandonment recovery, timeout reporting) rather than true multi-process
 * exclusion. The mechanism is the part that can regress silently.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, readFile, unlink, utimes, writeFile } from 'node:fs/promises';

import { withPortLock, __portLockInternals } from '../src/utils/port-lock.js';

const { lockPathFor, LOCK_DIR } = __portLockInternals;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = async (port: string) => { await unlink(lockPathFor(port)).catch(() => {}); };

describe('port lock', () => {
  it('serialises overlapping work on the same port', async () => {
    const port = 'COM_TEST_SERIAL';
    await clean(port);

    // Records entry and exit so overlap is detectable, not merely ordering.
    const events: string[] = [];
    const work = (id: string) => withPortLock(port, async () => {
      events.push(`enter:${id}`);
      await delay(30);
      events.push(`exit:${id}`);
    });

    await Promise.all([work('a'), work('b'), work('c')]);

    // Whatever the order, no task may enter before the previous one exited.
    for (let i = 0; i < events.length; i += 2) {
      assert.match(events[i], /^enter:/, `expected an enter at ${i}: ${events.join(',')}`);
      assert.match(events[i + 1], /^exit:/, `expected an exit at ${i + 1}: ${events.join(',')}`);
      assert.equal(events[i].split(':')[1], events[i + 1].split(':')[1], 'interleaved');
    }
    assert.equal(events.length, 6);
    await clean(port);
  });

  it('does not serialise different ports against each other', async () => {
    // A shared lock across unrelated ports would be a performance bug that looks
    // like correctness.
    await clean('COM_TEST_A');
    await clean('COM_TEST_B');

    let bStarted = false;
    const a = withPortLock('COM_TEST_A', async () => {
      await delay(60);
      // If B were blocked behind A, it could not have started yet.
      assert.equal(bStarted, true, 'different ports should not block each other');
    });
    const b = withPortLock('COM_TEST_B', async () => { bStarted = true; await delay(10); });

    await Promise.all([a, b]);
    await clean('COM_TEST_A');
    await clean('COM_TEST_B');
  });

  it('releases the lock when the task throws', async () => {
    const port = 'COM_TEST_THROW';
    await clean(port);

    await assert.rejects(withPortLock(port, async () => { throw new Error('boom'); }), /boom/);

    // If the lock leaked, this would block until the timeout.
    let ran = false;
    await withPortLock(port, async () => { ran = true; }, { waitMs: 2000 });
    assert.equal(ran, true, 'lock leaked after a failing task');
    await clean(port);
  });

  it('reclaims a lock whose owning process is gone', async () => {
    const port = 'COM_TEST_DEAD';
    const path = lockPathFor(port);
    await mkdir(LOCK_DIR, { recursive: true });

    // pid 0x7FFFFFFF is not a running process on any sane system.
    await writeFile(path, JSON.stringify({
      pid: 2147483647, acquiredAt: Date.now(), port, owner: 'a process that died',
    }), 'utf8');

    let ran = false;
    await withPortLock(port, async () => { ran = true; }, { waitMs: 3000 });
    assert.equal(ran, true, 'a lock owned by a dead process should be reclaimed');
    await clean(port);
  });

  it('does NOT immediately steal a lock that merely looks corrupt', async () => {
    // This is the bug that let three processes into the critical section at once: a
    // lock caught mid-write parsed as corrupt, so a competitor deleted a valid lock.
    // A freshly unparseable lock must be given the benefit of the doubt.
    const port = 'COM_TEST_FRESH_CORRUPT';
    const path = lockPathFor(port);
    await mkdir(LOCK_DIR, { recursive: true });
    await writeFile(path, 'not json at all', 'utf8');

    await assert.rejects(
      withPortLock(port, async () => 'stolen', { waitMs: 300 }),
      /Timed out/,
      'a fresh unparseable lock must not be stolen'
    );

    await clean(port);
  });

  it('reclaims an unparseable lock once it is clearly junk', async () => {
    // Recovery still has to happen, or a corrupt file blocks the port forever.
    const port = 'COM_TEST_OLD_CORRUPT';
    const path = lockPathFor(port);
    await mkdir(LOCK_DIR, { recursive: true });
    await writeFile(path, 'not json at all', 'utf8');

    // Backdate well past the grace period.
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);

    let ran = false;
    await withPortLock(port, async () => { ran = true; }, { waitMs: 3000 });
    assert.equal(ran, true, 'an old unreadable lock teaches nothing and must not block forever');
    await clean(port);
  });

  it('names the holder when it times out', async () => {
    const port = 'COM_TEST_TIMEOUT';
    await clean(port);

    // Hold it with a live owner (this process), so it is NOT reclaimable.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withPortLock(port, () => held);
    await delay(30);

    // A stuck lock is very hard to trace without knowing who holds it.
    await assert.rejects(
      withPortLock(port, async () => 'never', { waitMs: 200 }),
      (error: Error) => /Timed out/.test(error.message) && /pid \d+/.test(error.message)
    );

    release();
    await holder;
    await clean(port);
  });

  it('does not lock when no port is named', async () => {
    // Nothing to serialise against, and a shared "default" lock would make unrelated
    // callers block each other for no reason.
    const order: string[] = [];
    await Promise.all([
      withPortLock(undefined, async () => { order.push('a-in'); await delay(30); order.push('a-out'); }),
      withPortLock(undefined, async () => { order.push('b-in'); await delay(5); order.push('b-out'); }),
    ]);
    assert.deepEqual(order, ['a-in', 'b-in', 'b-out', 'a-out'], 'unnamed ports should run concurrently');
  });

  it('writes a traceable record while held', async () => {
    const port = 'COM_TEST_RECORD';
    await clean(port);

    await withPortLock(port, async () => {
      const record = JSON.parse(await readFile(lockPathFor(port), 'utf8'));
      assert.equal(record.pid, process.pid);
      assert.equal(record.port, port);
      assert.equal(typeof record.owner, 'string');
      assert.ok(record.acquiredAt <= Date.now());
    }, { owner: 'test-owner' });

    await clean(port);
  });
});
