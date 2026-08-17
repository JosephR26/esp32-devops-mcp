/**
 * Which build of this server is actually running.
 *
 * A compiled server keeps serving the `dist/` it loaded at startup. Merge a fix,
 * rebuild, and the running process is still executing the old code — so a bug you
 * have already fixed keeps reproducing, and the obvious conclusion ("the fix didn't
 * work") is wrong. That cost real time three separate times during development, each
 * time looking like a fresh defect.
 *
 * The cure is to make the running build visible rather than assumed. Every field here
 * describes the code that is EXECUTING, not the code on disk in `src/`.
 */

import { statSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface BuildInfo {
  /** Declared package version. Changes only when someone bumps it. */
  version: string;
  /** When the running JavaScript was compiled. This is what catches a stale process. */
  builtAt: string | null;
  /** Age of the running build, in whole minutes, at the moment it was read. */
  builtMinutesAgo: number | null;
  /** Short git SHA of the working tree, when discoverable. */
  gitSha: string | null;
  /** Absolute path of the module actually loaded. */
  loadedFrom: string;
}

/**
 * Walk upward for a directory containing `marker`.
 *
 * Deliberately not a fixed `../..` from the module: that assumes one compiled layout
 * (`dist/utils/`) and silently reports "unknown" under any other — the test build
 * compiles to `.test-build/src/utils/`, which is exactly where the first version of
 * this file went wrong. A diagnostic that degrades quietly is worse than none, since
 * the whole point is to be trusted when something looks stale.
 */
function findUpward(start: string, marker: string, maxDepth = 8): string | null {
  let dir = start;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // Reached the filesystem root.
    dir = parent;
  }
  return null;
}

/** Best-effort git HEAD read. Never throws; a missing .git is normal for an install. */
function readGitSha(startDir: string): string | null {
  try {
    const repoRoot = findUpward(startDir, '.git');
    if (!repoRoot) return null;
    const gitDir = join(repoRoot, '.git');

    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();

    // Detached HEAD stores the SHA directly; otherwise it points at a ref.
    if (!head.startsWith('ref:')) return head.slice(0, 7) || null;

    const refPath = join(gitDir, head.slice(4).trim());
    if (existsSync(refPath)) {
      return readFileSync(refPath, 'utf8').trim().slice(0, 7) || null;
    }

    // Packed refs: the loose ref file does not exist for every branch.
    const packed = join(gitDir, 'packed-refs');
    if (existsSync(packed)) {
      const refName = head.slice(4).trim();
      for (const line of readFileSync(packed, 'utf8').split('\n')) {
        const [sha, name] = line.trim().split(/\s+/);
        if (name === refName && sha) return sha.slice(0, 7);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function buildInfo(): BuildInfo {
  const version = (() => {
    try {
      const root = findUpward(MODULE_DIR, 'package.json');
      if (!root) return 'unknown';
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
    } catch {
      return 'unknown';
    }
  })();

  const loadedFrom = fileURLToPath(import.meta.url);

  let builtAt: string | null = null;
  let builtMinutesAgo: number | null = null;
  try {
    const mtime = statSync(loadedFrom).mtime;
    builtAt = mtime.toISOString();
    builtMinutesAgo = Math.floor((Date.now() - mtime.getTime()) / 60_000);
  } catch {
    /* unreadable — leave null rather than invent a timestamp */
  }

  return {
    version,
    builtAt,
    builtMinutesAgo,
    gitSha: readGitSha(MODULE_DIR),
    loadedFrom,
  };
}

/** One-line summary for a startup banner. */
export function buildSummary(info: BuildInfo = buildInfo()): string {
  const parts = [`v${info.version}`];
  if (info.gitSha) parts.push(`git ${info.gitSha}`);
  if (info.builtAt) {
    const age = info.builtMinutesAgo;
    const when =
      age === null ? info.builtAt
      : age < 1 ? 'just now'
      : age < 60 ? `${age} min ago`
      : age < 1440 ? `${Math.floor(age / 60)} h ago`
      : `${Math.floor(age / 1440)} days ago`;
    parts.push(`built ${when}`);
  }
  return parts.join(' · ');
}
