/** Launch, reattach and reap detached jobs through their persisted control directories. */

import { readFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { sleep } from './fileUtils.js';
import { DEFAULT_POLL_MS, GROUP_KILL_MARKER, createLogTailer, isAlive, signalPid } from './detachedReattach.js';
import { processCommandMatches, processMatches } from './processSnapshot.js';
import { readBootstrapDiagnostic, WINDOWS_SUPERVISOR } from './detachedLauncher.js';

export { reattachDetached } from './detachedReattach.js';
export { spawnDetached, spawnDatabaseMaintenanceWorker, sweepQuiescentWriters } from './detachedLauncher.js';
export { snapshotProcesses, snapshotMaintenanceProcesses, signalProcessGroup } from './processSnapshot.js';
export { isDetachedSupervisorCommand } from '../../scripts/lib/posixDetachedLauncher.mjs';

// How long reapDetached lets a SIGTERM'd orphan checkpoint+exit before
// escalating to SIGKILL. Matches the in-session cancel escalation (8s) plus
// slack for a final checkpoint write.
const REAP_GRACE_MS = 12000;

const readControlFile = (path) => readFile(path, 'utf8').catch((err) => {
  if (err?.code === 'ENOENT') return '';
  throw err;
});

// Windows NT loader initialization exit codes (STATUS_DLL_INIT_FAILED and
// STATUS_ACCESS_VIOLATION). Under heavy parallel spawn load on Windows CI runners,
// the NT loader can terminate a newly created child process before user code runs
// or any output is written (#10081).
const WINDOWS_LOADER_EXIT_CODES = Object.freeze(new Set([
  3221225794, // 0xC0000142 STATUS_DLL_INIT_FAILED
  3221225477, // 0xC0000005 STATUS_ACCESS_VIOLATION
]));

const isLoaderInitFailure = ({
  code,
  outBytes = 0,
  errBytes = 0,
  isWindows = process.platform === 'win32',
} = {}) => {
  return Boolean(
    isWindows
    && WINDOWS_LOADER_EXIT_CODES.has(code)
    && outBytes === 0
    && errBytes === 0
  );
};

export const __detachedSpawnTesting = {
  createLogTailer,
  WINDOWS_SUPERVISOR,
  processCommandMatches,
  readBootstrapDiagnostic,
  WINDOWS_LOADER_EXIT_CODES,
  isLoaderInitFailure,
};

/**
 * Is the control dir's job still running (live PID, no exit sentinel)? Lets a
 * caller that REUSES a fixed control dir (e.g. the update executor) refuse to
 * spawn while a prior detached job is alive — spawnDetached's setup truncates
 * the pid/exit files, so the old supervisor's late `exit` write would satisfy
 * the NEW tailer's sentinel check and prematurely close the new handle with
 * the old job's status (the stale-late-write race reapDetached guards against).
 *
 * Both callers read a `false` as permission to act — start a second update
 * (updateExecutor), or purge the directory the job is writing into
 * (dataManagerBusy, #3342). So an ABSENT control file reads as "never launched",
 * but any other read failure is rethrown rather than silently synthesized into
 * "not running": "we could not look" must not answer as "nothing is there".
 * Callers that reuse one control dir for one fixed command may also provide
 * its expected executable and arguments. That identity check prevents a stale
 * PID file from treating an unrelated process that inherited the PID as the
 * detached job.
 *
 * @param {string} controlDir - the job's spawnDetached control dir
 * @param {{executable: string, args?: string[]}|null} expectedProcess
 * @returns {Promise<boolean>}
 */
export async function isDetachedRunning(controlDir, expectedProcess = null) {
  const pidRaw = await readControlFile(join(controlDir, 'pid'));
  const pid = Number.parseInt(pidRaw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const exitWritten = (await readControlFile(join(controlDir, 'exit'))).length > 0;
  if (exitWritten || !isAlive(pid)) return false;
  return expectedProcess ? processMatches(pid, expectedProcess) : true;
}

/**
 * Reap a detached job that outlived the server (boot recovery). Because
 * spawnDetached children reparent to init, a `pm2 restart` leaves them running
 * with no in-process handle — and the boot reconcile then marks their run/job
 * failed. If such an orphan is still alive it must be stopped before that run
 * is marked resumable (else a resume spawns a SECOND trainer into the same
 * checkpoint dir) and before the GPU lane is freed (else a new job contends
 * with it). SIGTERM first so the trainer/render checkpoints, then escalate to
 * SIGKILL after the grace window — turning a restart from a mid-op SIGINT
 * crash into a clean checkpointed stop the existing resume path recovers from.
 * On Windows both rungs are the same `taskkill /T /F` (no real signals there,
 * and `process.kill` was already an unconditional TerminateProcess of the job
 * LEAF), so the reap is not graceful — but it now takes the job's descendants
 * with it instead of orphaning them (#6170).
 * This is the fallback when reattachDetached can't (or shouldn't) re-attach —
 * e.g. a render lane with no re-attach path, or a probe that came back
 * non-reattachable. A caller that can reattach should
 * prefer reattachDetached so a still-healthy run keeps going rather than being
 * checkpoint-killed.
 *
 * @param {string} controlDir - the job's spawnDetached control dir
 * @returns {Promise<{reaped: boolean, pid?: number}>}
 */
export async function reapDetached(controlDir, { graceMs = REAP_GRACE_MS, pollMs = DEFAULT_POLL_MS } = {}) {
  const exitFile = join(controlDir, 'exit');
  const pidRaw = await readFile(join(controlDir, 'pid'), 'utf8').catch(() => '');
  const pid = Number.parseInt(pidRaw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return { reaped: false };
  const killProcessGroup = (await readFile(join(controlDir, GROUP_KILL_MARKER), 'utf8').catch(() => '')).trim() === '1';
  const exitWritten = async () => (await readFile(exitFile, 'utf8').catch(() => '')).length > 0;
  // Supervisor already recorded an exit → the job finished; nothing to reap.
  if (await exitWritten()) return { reaped: false };
  // Note: trusts the persisted PID. A reused PID (the job exited without the
  // supervisor recording it AND the OS recycled the number within the few
  // seconds before boot) is vanishingly unlikely on a single-user box; the same
  // trust the in-session cancel path places in the child PID.
  const wasAlive = isAlive(pid);
  if (wasAlive) signalPid(pid, 'SIGTERM', killProcessGroup);
  // Wait for the supervisor's `exit` sentinel — its FINAL act after the child
  // dies — not just child death. That sentinel means the supervisor is fully
  // done writing into controlDir, so a resume that reuses the dir can't race a
  // stale late write (which would prematurely close the new handle). Escalate
  // to SIGKILL at the grace deadline; hard-cap so a wedged supervisor can't
  // hang boot.
  // Both deadlines are WALL-CLOCK, read from the monotonic-enough Date.now()
  // rather than accumulated as `waited += pollMs` (#7951). Each pass through
  // this loop costs `sleep(pollMs)` PLUS a file read, and a `setTimeout(25)` on
  // a loaded box does not return in 25ms — so counting ticks made both the
  // grace and the hard cap stretch by whatever factor the machine was
  // oversubscribed by. That matters beyond the suite: this runs at boot, and
  // the hard cap exists precisely "so a wedged supervisor can't hang boot",
  // which a tick count does not actually guarantee. It also made
  // reapAndCleanDetachedDirs — which sweeps dirs sequentially — blow a 30s test
  // timeout on a 3s grace.
  const startedAt = Date.now();
  const graceDeadline = startedAt + graceMs;
  const hardDeadline = startedAt + graceMs + 5000;
  while (Date.now() < hardDeadline) {
    await sleep(pollMs);
    if (await exitWritten()) return { reaped: wasAlive, pid };
    if (Date.now() >= graceDeadline && isAlive(pid)) signalPid(pid, 'SIGKILL', killProcessGroup);
  }
  return { reaped: wasAlive, pid };
}

/**
 * Boot-time sweep of a parent dir holding per-job control dirs (e.g.
 * `data/videos/.detached/<jobId>`). Reaps any surviving orphan in each and then
 * removes the dir. Used where job ids aren't enumerable from persisted state —
 * notably chained video renders, whose live child lives under a random INNER
 * chunk id, not the outer queue job id. Safe to call only at boot, before any
 * new job starts (every dir present then is an orphan from the prior process).
 *
 * @param {string} parentDir - the `.detached` parent (e.g. PATHS.videos/.detached)
 * @param {object} [opts] - forwarded to reapDetached (graceMs, pollMs)
 * @returns {Promise<{reaped: number, scanned: number}>}
 */
export async function reapAndCleanDetachedDirs(parentDir, opts = {}) {
  const entries = await readdir(parentDir).catch(() => []);
  let reaped = 0;
  for (const name of entries) {
    const dir = join(parentDir, name);
    const res = await reapDetached(dir, opts).catch(() => ({ reaped: false }));
    if (res.reaped) reaped += 1;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { reaped, scanned: entries.length };
}
