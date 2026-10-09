/**
 * Owner-aware sweep of run-scoped temp roots (#9113, #9804).
 *
 * Workspace configs and the CI launcher stamp `.owner.pid` in each root. A
 * killed run never reaches `teardown()` in `runTempRoot.js`, so its root is
 * left behind; the next config load calls `sweepStaleRunRoots()` to reclaim
 * it for the caller's exact prefix (default `pvt-`). A recorded owner that is provably gone frees the root immediately, an
 * owner that is alive keeps it however old it is (a >6h run must not be swept
 * from under itself), and a root whose owner cannot be determined falls back
 * to the conservative 6h age rule.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { killWithEscalation } from '../../server/lib/killWithEscalation.js';

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

/**
 * `[{ pid, profile }]` for every running process started with a
 * `--user-data-dir` (a test Chrome and its helpers). Empty on win32 or when
 * `ps` is unavailable: the sweep is best-effort and never fails a run.
 */
export function listProfileProcesses() {
  if (process.platform === 'win32') return [];
  let out;
  try {
    out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,args='], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    });
  } catch {
    return [];
  }
  const found = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    const profile = match && /(?:^|\s)--user-data-dir=(\S+)/.exec(match[2])?.[1];
    if (profile && Number(match[1]) !== process.pid) found.push({ pid: Number(match[1]), profile });
  }
  return found;
}

const isPidAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

// SIGTERM now, SIGKILL after a grace window if the pid is still there.
export function terminatePid(pid) {
  killWithEscalation({ exitCode: null, signalCode: null, kill: signal => { try { return process.kill(pid, signal); } catch { return false; } } },
    { label: 'Orphaned test browser', stillRunning: () => isPidAlive(pid), delayMs: 2000 });
}

// First path segment of `path` below `root`, or null when it is not inside.
function segmentUnder(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep)[0];
}

/**
 * Kill every process whose browser profile lives under `root` (a run's own
 * temp root, at run exit). Synchronous SIGKILL by default, so it is safe in
 * an `exit` handler. Returns the number of processes signalled.
 */
export function killTestBrowsersUnder(root, { listProcesses = listProfileProcesses, kill = pid => process.kill(pid, 'SIGKILL') } = {}) {
  let killed = 0;
  for (const { pid, profile } of listProcesses()) {
    if (segmentUnder(root, profile) === null) continue;
    try { kill(pid); killed++; } catch { /* already gone */ }
  }
  return killed;
}

/**
 * A test Chrome outlives an interrupted run (#10840): its profile sits in a
 * run root whose owner is gone (or was removed with it), and the browser keeps
 * burning a core. Kill every process whose `--user-data-dir` is under such a
 * `<prefix>` root in `tmpRoot`. A live owner keeps its browsers; an unknown
 * owner keeps them until the root is old enough to sweep.
 */
export function sweepOrphanedTestBrowsers(tmpRoot, { prefix = 'pvt-', now = Date.now(), probe = isOwnerAlive, listProcesses = listProfileProcesses, terminate = terminatePid } = {}) {
  const verdicts = new Map();
  const orphaned = name => {
    if (verdicts.has(name)) return verdicts.get(name);
    const path = join(tmpRoot, name);
    let verdict;
    try {
      const stat = lstatSync(path);
      const owner = readOwner(path);
      const alive = owner ? probe(owner) : null;
      verdict = alive === false || (alive === null && now - stat.mtimeMs > STALE_ROOT_AGE_MS);
    } catch (err) {
      // The root was removed while its browser kept running.
      verdict = err?.code === 'ENOENT';
    }
    verdicts.set(name, verdict);
    return verdict;
  };
  let killed = 0;
  for (const { pid, profile } of listProcesses()) {
    const name = segmentUnder(tmpRoot, profile);
    if (!name?.startsWith(prefix) || !orphaned(name)) continue;
    try { terminate(pid); killed++; } catch { /* already gone */ }
  }
  if (killed) console.warn(`🧹 Stopped ${killed} test browser process${killed === 1 ? '' : 'es'} left running by an interrupted test run`);
  return killed;
}

export function sweepStaleRunRoots(tmpRoot, { prefix = 'pvt-', now = Date.now(), probe = isOwnerAlive, listProcesses = listProfileProcesses, terminate = terminatePid } = {}) {
  // Require an exact directory-name prefix, never a path or an empty match.
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9-]+-$/.test(prefix)) {
    throw new Error('Owned temp prefix must be a nonempty name ending in a hyphen');
  }
  // Browsers first: a root swept below no longer names its owner.
  sweepOrphanedTestBrowsers(tmpRoot, { prefix, now, probe, listProcesses, terminate });
  let names;
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return; // unreadable tmp dir — skip rather than fail config load
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(tmpRoot, name);
    try {
      const stat = lstatSync(path);
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
