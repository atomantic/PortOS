/**
 * Is any process running with its working directory inside a directory?
 *
 * `hasProcessCwdInside(dir)` (via `lsof -d cwd`) backs the ownerless-foreign-worktree release in `worktreeManager.js`, telling an abandoned worktree (terminal session exited) from one a person or tool is sitting in. Fails CLOSED: anything the probe can't establish (no `lsof`, an unsupported platform, an empty/unreadable/implausible listing) reads as "occupied", never "nobody is there". `probeProcessCwdInside(dir)` keeps that unknown answer distinct (null) for a caller that can substitute other evidence.
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
 * @returns {Promise<boolean|null>} true when a process has its cwd in `dir`, false when none does, null when the probe cannot tell
 */
export async function probeProcessCwdInside(dir, { platform = process.platform, run = promisify(execFile) } = {}) {
  if (!dir) return null;
  if (platform !== 'darwin' && platform !== 'linux') return null;
  // lsof exits non-zero when it merely couldn't read another user's process while still printing what it saw; the listing is judged on content below.
  const out = await run('lsof', ['-a', '-d', 'cwd', '-Fn'], { timeout: LSOF_TIMEOUT_MS, maxBuffer: LSOF_MAX_BUFFER })
    .then(r => r.stdout, err => err?.stdout ?? null);
  const cwds = out == null ? [] : parseLsofCwds(out);
  // This very process always has a cwd, so an empty listing means lsof failed.
  if (cwds.length === 0) return null;
  const targets = new Set([posix.resolve(dir), realOrResolved(dir)]);
  return cwds.some(cwd => [...targets].some(t => cwd === t || cwd.startsWith(t.endsWith(posix.sep) ? t : t + posix.sep)));
}

/**
 * @param {string} dir
 * @param {object} [options] - as `probeProcessCwdInside`
 * @returns {Promise<boolean>} true when a process has its cwd in `dir`, or when that cannot be ruled out
 */
export async function hasProcessCwdInside(dir, options) {
  return await probeProcessCwdInside(dir, options) !== false;
}
