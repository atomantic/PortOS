/**
 * Is any process running with its working directory inside a directory?
 *
 * Used to tell an abandoned foreign worktree (its terminal session exited) from
 * one a person or tool is still sitting in. The answer is tri-state collapsed
 * to a boolean that fails CLOSED: anything the probe cannot establish (no
 * `lsof`, a platform without it, an unreadable or implausible listing) reads as
 * "occupied", never as "nobody is there".
 */

import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from './childProcess.js';

const LSOF_TIMEOUT_MS = 10_000;
const LSOF_MAX_BUFFER = 16 * 1024 * 1024;

// lsof only runs on darwin/linux and prints POSIX paths, so compare with posix semantics on every host.
const realOrResolved = (p) => { try { return realpathSync(p); } catch { return posix.resolve(p); } };

/** Working directories from `lsof -Fn` field output (`p<pid>` then `n<path>` per process). */
function parseLsofCwds(stdout) {
  return String(stdout || '').split('\n').filter(l => l.startsWith('n')).map(l => l.slice(1));
}

/**
 * @param {string} dir
 * @param {{ platform?: string, run?: (file: string, args: string[], opts: object) => Promise<{ stdout: string }> }} [options] test seams
 * @returns {Promise<boolean>} true when a process has its cwd in `dir`, or when that cannot be ruled out
 */
export async function hasProcessCwdInside(dir, { platform = process.platform, run = promisify(execFile) } = {}) {
  if (!dir) return true;
  if (platform !== 'darwin' && platform !== 'linux') return true;
  // lsof exits non-zero when it merely could not read some other user's process,
  // while still printing what it saw; the listing is judged on content below.
  const out = await run('lsof', ['-a', '-d', 'cwd', '-Fn'], { timeout: LSOF_TIMEOUT_MS, maxBuffer: LSOF_MAX_BUFFER })
    .then(r => r.stdout, err => err?.stdout ?? null);
  const cwds = out == null ? [] : parseLsofCwds(out);
  // This very process always has a cwd, so an empty listing means lsof failed.
  if (cwds.length === 0) return true;
  const targets = new Set([posix.resolve(dir), realOrResolved(dir)]);
  return cwds.some(cwd => [...targets].some(t => cwd === t || cwd.startsWith(t.endsWith(posix.sep) ? t : t + posix.sep)));
}
