/** Follow detached control-directory logs through process exit and reconstruct handles for surviving jobs. */

import { EventEmitter } from 'events';
import { constants as osConstants } from 'os';
import { join } from 'path';
import { open, readFile, rm, stat } from 'fs/promises';
import { killProcessTree } from './bufferedSpawn.js';
import { isPidPossiblyAlive } from './processLiveness.js';

// Default cadence for tailing the job's log files and polling for completion.
// 250ms matches the high-frequency-write batching cadence used elsewhere — far
// below human perception for progress, cheap enough to run for hours.
export const DEFAULT_POLL_MS = 250;
export const GROUP_KILL_MARKER = 'kill-process-group';

export const isAlive = pid => isPidPossiblyAlive(pid, { ignoreLinuxZombies: true });

// Signal a detached job we hold no child handle for — the reparented POSIX
// double-fork job, the Windows supervisor's job, and the boot-time orphan
// reaper's pid-file target all reach their process only by number.
//
// Windows has neither process groups nor real signals, so `process.kill(pid,
// …)` there is a TerminateProcess of the job LEAF: whatever the runner spawned
// (the ffmpeg mux a CUDA video runtime shells out to, a model download) is
// orphaned still holding the output file and GPU memory. `taskkill /T /F` is
// the only tree there, so both the plain and the `killProcessGroup` form of a
// cancel collapse onto it — which is what gives a Windows job the same
// descendants-die-with-it guarantee POSIX gets from the negative pid (#4171,
// #6170). Note taskkill ignores the requested signal and force-kills, so a
// SIGTERM cancel is not graceful there; that is killProcessTree's documented
// Windows contract.
export const signalPid = (pid, signal, killProcessGroup = false) => {
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    // Signal 0 is an existence PROBE, not a kill — answer it instead of
    // force-killing the tree.
    if (signal === 0 || signal === '0') return isAlive(pid);
    // `taskkill /T /F` is destructive and Windows recycles PIDs freely, so it
    // must never fire at a job that already exited — a late escalation (the
    // reaper's grace-deadline SIGKILL) would tree-kill whatever inherited the
    // number. Node's own `kill` is safe there because a ChildProcess holds a
    // process HANDLE; taskkill only gets the pid.
    if (!isAlive(pid)) return false;
    killProcessTree({ pid }, signal, { processGroup: killProcessGroup }, isWindows);
    return true;
  }
  if (killProcessGroup) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // The child may not have established its own process group yet. Fall back
      // to its exact PID; at that early point it cannot have spawned descendants.
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

// The signal a win32 cancel ASKED for, remembered on the handle so the tailer
// can report the death the way Node would — see createDetachedHandle below.
const KILL_SIGNAL = Symbol('detachedKillSignal');

// `wait` reports a signal-terminated child as 128+signum. Invert os signal
// constants once so we can decode that back into Node's ('code', 'signal')
// close convention (exactly one of the two is non-null).
const SIGNAL_BY_NUMBER = Object.fromEntries(
  Object.entries(osConstants.signals).map(([name, num]) => [num, name])
);

/**
 * Build the ChildProcess-like handle shared by spawnDetached and
 * reattachDetached, with `kill` wired to the platform's cancel semantics.
 *
 * `kill()` accepts a NUMBER while `close` reports NAMES, and an unknown signal
 * must still throw `ERR_UNKNOWN_SIGNAL` rather than silently force-killing a
 * tree — so the signal is decoded and validated exactly as ChildProcess.kill()
 * does before anything is dispatched.
 *
 * On Windows the dispatch is `taskkill /T /F`, which terminates the job OUT OF
 * BAND: the supervisor then records whatever ordinary non-zero status Windows
 * left behind, and the tailer would report `close(1, null)` where Node's own
 * `kill()` reported `close(null, 'SIGKILL')`. Callers classify a cancel on
 * exactly that signal — videoGen's watchdog-success check keeps a finished
 * .mp4 only when `signal === 'SIGKILL'`, and `describeSignalDeath` reads it for
 * the failure reason — so remember the signal we ASKED for and let the tailer
 * stamp it. That records the request without waiting to confirm the tree died
 * from it, which is precisely what libuv does for a native kill (it stamps
 * exit_signal at request time). POSIX needs none of this: the supervisor's
 * `wait` status carries the real signal, decoded as 128+signum below.
 */
export function createDetachedHandle({ pid = null, killProcessGroup = false } = {}) {
  const handle = new EventEmitter();
  handle.stdout = new EventEmitter();
  handle.stderr = new EventEmitter();
  handle.pid = pid;
  handle.killed = false;
  handle.exitCode = null;
  handle.signalCode = null;
  handle[KILL_SIGNAL] = null;
  handle.kill = (signal = 'SIGTERM') => {
    const isProbe = signal === 0 || signal === '0';
    const signalName = typeof signal === 'number' ? SIGNAL_BY_NUMBER[signal] : signal;
    // Validate BEFORE anything is dispatched or recorded, so a typo throws with
    // the handle untouched — as ChildProcess.kill() leaves a child untouched.
    if (!isProbe && (!signalName || !(signalName in osConstants.signals))) {
      const err = new TypeError(`Unknown signal: ${signal}`);
      err.code = 'ERR_UNKNOWN_SIGNAL';
      throw err;
    }
    handle.killed = true;
    if (!handle.pid) return false;
    const dispatched = signalPid(handle.pid, signal, killProcessGroup);
    // Only a kill that actually went out gets stamped: a probe is not a death,
    // and a refused dispatch (the job already exited) must leave the status the
    // supervisor recorded alone.
    if (dispatched && !isProbe && process.platform === 'win32') handle[KILL_SIGNAL] = signalName;
    return dispatched;
  };
  return handle;
}

/**
 * Build the log-tailer for a spawnDetached control dir. Holds a persistent fd
 * per log (opened lazily once the supervisor creates the file) plus the byte
 * offset read so far, streams new bytes as stdout/stderr 'data', and emits the
 * handle's 'close' once the supervisor's `exit` sentinel appears. Shared by the
 * initial spawn and by reattachDetached so both stream identically.
 *
 * @param {object} handle - ChildProcess-like handle with `stdout`/`stderr` EventEmitters
 * @param {object} opts
 * @param {string} opts.controlDir - dir holding stdout.log/stderr.log/exit
 * @param {number} opts.pollMs - tail/poll cadence
 * @param {boolean} opts.cleanup - rm the controlDir once the job terminates
 * @returns {{ tick: () => Promise<void>, finish: () => Promise<void>, stop: () => Promise<void> }}
 */
export function createLogTailer(handle, { controlDir, pollMs, cleanup, openLog = open }) {
  const exitFile = join(controlDir, 'exit');
  const stdoutLog = join(controlDir, 'stdout.log');
  const stderrLog = join(controlDir, 'stderr.log');

  // Persistent fd per log + the byte offset read so far. Holding the fd open
  // for the job's lifetime avoids an open+close per poll tick (~4/s for hours).
  const fds = { [stdoutLog]: null, [stderrLog]: null };
  const offsets = { [stdoutLog]: 0, [stderrLog]: 0 };
  const emitterFor = { [stdoutLog]: handle.stdout, [stderrLog]: handle.stderr };
  const CHUNK = 64 * 1024;

  // Read everything appended to a log since the last poll and emit it as 'data'
  // chunks (Buffers, matching ChildProcess stream semantics). `read` returns
  // bytesRead, so no per-tick stat is needed to find EOF.
  const drainLog = async (logPath) => {
    if (!fds[logPath]) {
      fds[logPath] = await openLog(logPath, 'r').catch(() => null);
      if (!fds[logPath]) return; // file not created yet (job hasn't started writing)
    }
    const fh = fds[logPath];
    for (;;) {
      const buf = Buffer.alloc(CHUNK);
      const { bytesRead } = await fh.read(buf, 0, CHUNK, offsets[logPath]);
      if (bytesRead <= 0) break;
      offsets[logPath] += bytesRead;
      emitterFor[logPath].emit('data', buf.subarray(0, bytesRead));
      if (bytesRead < CHUNK) break;
    }
  };
  // Drain both logs concurrently (independent files/offsets/emitters), never
  // rejecting so a transient read error can't break the poll loop.
  const drainBoth = () => Promise.all(
    [stdoutLog, stderrLog].map((p) => drainLog(p).catch(() => {}))
  );
  const closeFds = () => Promise.all(
    [stdoutLog, stderrLog].map((p) => (fds[p] ? fds[p].close().catch(() => {}) : null))
  );

  let closed = false;
  let timer = null;
  let draining = null;
  let terminal = null;
  const stop = () => {
    if (terminal) return terminal;
    if (closed) return Promise.resolve();
    closed = true;
    if (timer) clearTimeout(timer);
    terminal = (async () => {
      if (draining) await draining;
      await closeFds();
      handle.stdout.emit('end');
      handle.stderr.emit('end');
    })();
    return terminal;
  };
  const finish = () => {
    if (terminal) return terminal;
    if (closed) return Promise.resolve();
    closed = true;
    if (timer) clearTimeout(timer);
    terminal = (async () => {
    // Final drain so the job's last bytes (e.g. the RESULT:/result-JSON line a
    // hard os._exit can emit just before teardown) are delivered before 'end'.
    draining = drainBoth();
    await draining;
    draining = null;
    await closeFds();
    handle.stdout.emit('end');
    handle.stderr.emit('end');
    const raw = await readFile(exitFile, 'utf8').catch(() => '');
    const status = Number.parseInt(raw, 10);
    let code = null;
    let signal = null;
    if (Number.isFinite(status)) {
      // 128+signum is a POSIX `wait` convention. On Windows 129-255 are
      // ordinary exit statuses a program may return for its own reasons, so
      // decoding one of them as a signal would invent a death that never
      // happened. (Crash codes like 0xC0000005 land far above this range.)
      if (process.platform !== 'win32' && status > 128 && SIGNAL_BY_NUMBER[status - 128]) signal = SIGNAL_BY_NUMBER[status - 128];
      else code = status;
    } else {
      code = 1; // exit file missing/garbled — treat as generic failure
    }
    // A Windows cancel went out through `taskkill /T /F`, out of band of the
    // job's own exit, so re-stamp the signal it asked for (set only on win32 —
    // see createDetachedHandle). A CLEAN exit is left alone: a cancel that
    // raced completion by microseconds means the job really did finish.
    if (handle[KILL_SIGNAL] && signal === null && code !== 0) {
      code = null;
      signal = handle[KILL_SIGNAL];
    }
    handle.exitCode = code;
    handle.signalCode = signal;
    handle.emit('close', code, signal);
    if (cleanup) rm(controlDir, { recursive: true, force: true }).catch(() => {});
    })();
    return terminal;
  };

  // Single poll tick: stream new output, then check for the exit sentinel. The
  // supervisor writes `exit` only AFTER `wait` returns, by which point the job
  // has closed its redirected fds — so seeing `exit` guarantees the logs are
  // complete and the final drain in finish() captures everything. A `stat`
  // (size>0) tests for the sentinel without allocating/reading the whole file.
  let replayedEmitted = false;
  const tick = async () => {
    if (closed) return;
    draining = drainBoth();
    await draining;
    draining = null;
    if (closed) return;
    // After the first drain, the entire pre-existing backlog has been emitted —
    // for a fresh spawn that's ~nothing, but for a reattach (#1332) it's the
    // whole replayed-from-offset-0 history. Fire a one-time 'replayed' so a
    // consumer can tell replayed history from live output (e.g. to keep a
    // wall-clock stall detector from arming on instantly-replayed step lines).
    if (!replayedEmitted) { replayedEmitted = true; handle.emit('replayed'); }
    const exited = await stat(exitFile).then((s) => s.size > 0).catch(() => false);
    if (closed) return;
    if (exited) {
      await finish();
      return;
    }
    timer = setTimeout(() => { tick().catch((err) => handle.emit('error', err)); }, pollMs);
  };

  return { tick, finish, stop };
}

/**
 * Re-attach to a detached job that outlived the server (#1332). Returns a fresh
 * ChildProcess-like handle that tails the existing control-dir logs FROM THE
 * START — replaying everything written before the restart and then streaming
 * anything still arriving — and emits 'close' once the supervisor's exit
 * sentinel appears. This is the streaming half of spawnDetached without the
 * spawn: the survivor reparented to init, so we never had (and don't need) a
 * child handle to it; the on-disk logs are the channel.
 *
 * Replaying from offset 0 means the consumer's line handler sees the FULL
 * output — including the terminal `RESULT:{…}` line that registers the trained
 * artifact — so a run that completes during the downtime still finalizes
 * instead of being silently discarded. (Consumers that persist per-line
 * artifacts must therefore be idempotent against a replay.)
 *
 * Returns null when there's nothing safe to attach to (no recorded PID, or a
 * dead PID with no exit sentinel) — the caller should reap+fail instead. The
 * `cleanup` default is false: a re-attached run's logs are its only post-mortem
 * record, same as the original spawn.
 *
 * PID trust: like reapDetached/cancel, this trusts the persisted PID. In the
 * vanishingly-unlikely case the OS recycled it onto an unrelated live process
 * before boot, isAlive() reports true and we'd tail for an exit that never
 * comes — but the caller (the training queue) wraps the re-attached run in its
 * flat idle watchdog (WATCHDOG_TRAINING_MS), which fails the run and frees the
 * GPU lane once no trainer output arrives, so a stale PID can't wedge the lane
 * indefinitely. Matches the single-user trust model documented on reapDetached.
 *
 * @param {string} controlDir - the job's spawnDetached control dir
 * @param {object} [opts]
 * @param {number} [opts.pollMs] - tail/poll cadence (default 250ms)
 * @param {boolean} [opts.cleanup] - rm the controlDir once the job terminates
 * @returns {Promise<object|null>} ChildProcess-like handle, or null if not reattachable
 */
export async function reattachDetached(controlDir, { pollMs = DEFAULT_POLL_MS, cleanup = false, deferTail = false } = {}) {
  // No platform gate: whether there is a survivor to re-attach to is a fact
  // about the CONTROL DIR, and the pid/exit probe below already answers it.
  // Every platform now writes those files (#6169, #6170), so a Windows job is
  // re-attachable on exactly the same evidence a POSIX one is.
  const pidRaw = await readFile(join(controlDir, 'pid'), 'utf8').catch(() => '');
  const pid = Number.parseInt(pidRaw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const exitWritten = (await readFile(join(controlDir, 'exit'), 'utf8').catch(() => '')).length > 0;
  const killProcessGroup = (await readFile(join(controlDir, GROUP_KILL_MARKER), 'utf8').catch(() => '')).trim() === '1';
  // Dead PID with no exit sentinel → killed mid-run; nothing clean to stream
  // (the RESULT line was never written). Let the caller reap+fail.
  if (!exitWritten && !isAlive(pid)) return null;

  // Mirrors spawnDetached's exact PID/group/tree-kill behavior, so cancel and
  // stall paths work identically on a re-attached run.
  const handle = createDetachedHandle({ pid, killProcessGroup });

  const { tick } = createLogTailer(handle, { controlDir, pollMs, cleanup });
  // Defer the first tick so the caller's synchronous .on('data'|'close'|'error')
  // listeners are wired before any event fires (matches spawnDetached timing).
  let started = false;
  const startTail = () => {
    if (started) return;
    started = true;
    setImmediate(() => { tick().catch((err) => handle.emit('error', err)); });
  };
  if (deferTail) handle.startTail = startTail;
  else startTail();
  return handle;
}
