/**
 * Cross-process exclusion for a serial port.
 *
 * A serial port is exclusive at the OS level: whoever opens it first wins, and the
 * loser gets EACCES/PermissionError. That is fine when one process talks to the
 * board, which is how the MCP server was always used — Claude issues tool calls
 * sequentially.
 *
 * It stops being fine the moment a second process appears. The control panel and the
 * MCP server are separate processes; both legitimately want the same board. An
 * in-process promise queue cannot help, because the contention is between processes.
 *
 * Worse, the failure is quiet rather than loud: the interrogation tools degrade to
 * datasheet-only answers, so a collision looks like a board that needs reflashing
 * rather than a port that was busy for 400 ms.
 *
 * This is a cooperative lock — an advisory file both processes honour. It cannot stop
 * an unrelated program (a serial monitor, say) from taking the port, and it does not
 * try to. It removes collisions between the parts of this project.
 */

import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_DIR = join(tmpdir(), 'esp32-devops-mcp-locks');

/**
 * A lock older than this is treated as abandoned even if its owning pid still exists.
 * Generous: the slowest single bridge exchange observed is a few seconds, and a UART
 * capture can legitimately hold the port for the length of its capture window.
 */
const STALE_AFTER_MS = 60_000;

/** How long to wait for another holder before giving up. */
const DEFAULT_WAIT_MS = 30_000;

const POLL_INTERVAL_MS = 40;

/**
 * How long an unparseable lock must persist before it is treated as junk rather than
 * as a lock caught mid-write. Far longer than any legitimate write takes.
 */
const CORRUPT_GRACE_MS = 5_000;

/** Age of a file in ms, or null if it is gone. */
async function ageOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs;
  } catch {
    return null;
  }
}

interface LockRecord {
  pid: number;
  acquiredAt: number;
  port: string;
  /** Free-text owner label, purely so a stuck lock can be traced to a program. */
  owner: string;
}

function lockPathFor(port: string): string {
  // COM3, /dev/ttyUSB0 and friends are not filenames. Flatten to something that is.
  const safe = port.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'default';
  return join(LOCK_DIR, `port-${safe}.lock`);
}

/**
 * Whether a pid is still running.
 *
 * `process.kill(pid, 0)` sends no signal; it only checks. EPERM means the process
 * exists but belongs to another user — still alive, so still a valid lock holder.
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attempt an atomic create. Returns false when another holder already exists.
 *
 * The record is written to a private temporary file FIRST and only then linked into
 * place. An earlier version opened the lock path with 'wx' and wrote the record as a
 * second step, which left a window where the lock file existed but was still empty —
 * long enough for a competitor to read it, fail to parse it, conclude it was corrupt
 * and therefore abandoned, delete it, and take the lock. Three processes entered the
 * critical section together that way.
 *
 * `link()` fails with EEXIST when the destination exists, so the lock becomes visible
 * only once it is already complete and parseable.
 */
async function tryCreate(path: string, record: LockRecord): Promise<boolean> {
  const staging = `${path}.${process.pid}.${lockSequence++}.tmp`;

  await writeFile(staging, JSON.stringify(record), 'utf8');
  try {
    await link(staging, path);
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(staging).catch(() => {});
  }
}

/** Distinguishes staging files within one process; never used for identity. */
let lockSequence = 0;

/**
 * Remove a lock whose owner is gone or which has simply been held too long.
 *
 * Deliberately conservative: an unreadable or malformed lock is removed (nothing can
 * be learned from it and it would otherwise block forever), but a healthy lock owned
 * by a live process is left alone however inconvenient.
 */
async function clearIfAbandoned(path: string): Promise<void> {
  let record: LockRecord | null = null;

  try {
    record = JSON.parse(await readFile(path, 'utf8')) as LockRecord;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return; // Released while we looked. Nothing to do.

    // Unparseable. Reclaim it, but only after a grace period.
    //
    // Deleting an unreadable lock immediately is what let three processes into the
    // critical section at once: a lock caught mid-write parsed as corrupt, so a
    // competitor deleted a perfectly valid lock. tryCreate now publishes the record
    // atomically so that window is gone, and this grace period means a future
    // regression there degrades into a delay rather than a lost lock.
    const age = await ageOf(path);
    if (age !== null && age > CORRUPT_GRACE_MS) {
      await unlink(path).catch(() => {});
    }
    return;
  }

  const tooOld = Date.now() - record.acquiredAt > STALE_AFTER_MS;
  const ownerGone = !processAlive(record.pid);
  if (tooOld || ownerGone) {
    await unlink(path).catch(() => {});
  }
}

export interface PortLockOptions {
  /** How long to wait for the port before failing. */
  waitMs?: number;
  /** Label recorded in the lock file, to make a stuck lock traceable. */
  owner?: string;
}

/**
 * Run `task` while holding the cross-process lock for `port`.
 *
 * A missing port name is not locked at all: there is nothing to serialise against,
 * and inventing a shared "default" lock would make unrelated callers block each other.
 */
export async function withPortLock<T>(
  port: string | undefined,
  task: () => Promise<T>,
  options: PortLockOptions = {}
): Promise<T> {
  if (!port) return task();

  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const path = lockPathFor(port);
  const deadline = Date.now() + waitMs;

  await mkdir(LOCK_DIR, { recursive: true });

  let acquired = false;
  while (!acquired) {
    acquired = await tryCreate(path, {
      pid: process.pid,
      acquiredAt: Date.now(),
      port,
      owner: options.owner ?? process.argv[1] ?? 'unknown',
    });

    if (acquired) break;

    await clearIfAbandoned(path);

    if (Date.now() >= deadline) {
      // Report who holds it — a stuck lock is otherwise very hard to trace.
      let holder = 'unknown';
      try {
        const record = JSON.parse(await readFile(path, 'utf8')) as LockRecord;
        holder = `pid ${record.pid} (${record.owner})`;
      } catch {
        /* the holder vanished between the timeout and this read */
      }
      throw new Error(
        `Timed out after ${waitMs} ms waiting for ${port}: held by ${holder}. ` +
          'Another part of this project is using the port — the control panel and the ' +
          'MCP server share it.'
      );
    }

    await delay(POLL_INTERVAL_MS);
  }

  try {
    return await task();
  } finally {
    await unlink(path).catch(() => {});
  }
}

/** Exposed for tests and diagnostics. */
export const __portLockInternals = { lockPathFor, LOCK_DIR, STALE_AFTER_MS };
