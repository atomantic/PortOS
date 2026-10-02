/**
 * Owner-aware sweep of `pvt-*` run-scoped temp roots (#9113).
 *
 * `vitest.config.js` mints one root per run and stamps `.owner.pid` in it. A
 * killed run never reaches `teardown()` in `runTempRoot.js`, so its root is
 * left behind; the next config load calls `sweepStaleRunRoots()` to reclaim
 * it. A recorded owner that is provably gone frees the root immediately, an
 * owner that is alive keeps it however old it is (a >6h run must not be swept
 * from under itself), and a root whose owner cannot be determined falls back
 * to the conservative 6h age rule.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OWNER_FILE = '.owner.pid';
export const STALE_ROOT_AGE_MS = 6 * 60 * 60 * 1000;
// `ps -o lstart=` has 1s resolution and the recorded start is derived from
// process.uptime(), so allow slack before calling a pid "reused".
const START_TOLERANCE_MS = 5000;

/** Record this process as the root's owner: `<pid> <start-ms>`. */
export function writeOwnerFile(root) {
  const startMs = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(root, OWNER_FILE), `${process.pid} ${startMs}\n`);
}

/** Start time of a live pid in ms, or null when it cannot be read (always null on win32). */
function readProcessStartMs(pid) {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    const ms = Date.parse(out);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * true = owner alive, false = owner gone (or pid reused), null = unknown.
 * `process.kill(pid, 0)` throws ESRCH for a missing pid and EPERM for a live
 * pid owned by someone else (alive).
 */
export function isOwnerAlive({ pid, startMs }) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code !== 'EPERM') return null;
  }
  const liveStart = readProcessStartMs(pid);
  if (liveStart === null || !Number.isFinite(startMs)) return true;
  return Math.abs(liveStart - startMs) <= START_TOLERANCE_MS;
}

function readOwner(path) {
  try {
    const [pid, startMs] = readFileSync(join(path, OWNER_FILE), 'utf8').trim().split(/\s+/).map(Number);
    return Number.isInteger(pid) && pid > 0 ? { pid, startMs } : null;
  } catch {
    return null;
  }
}

export function sweepStaleRunRoots(tmpRoot, { now = Date.now(), probe = isOwnerAlive } = {}) {
  let names;
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return; // unreadable tmp dir — skip rather than fail config load
  }
  for (const name of names) {
    if (!name.startsWith('pvt-')) continue;
    const path = join(tmpRoot, name);
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) continue;
      const owner = readOwner(path);
      const alive = owner ? probe(owner) : null;
      if (alive === true) continue;
      if (alive === false || now - stat.mtimeMs > STALE_ROOT_AGE_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Already gone, or a permissions/race hiccup — best-effort sweep only.
    }
  }
}
