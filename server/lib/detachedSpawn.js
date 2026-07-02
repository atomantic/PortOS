// Spawn a long-running media-job child that SURVIVES a `pm2 restart
// portos-server`.
//
// pm2's TreeKill walks the parent→child process tree (`ps -e -o pid=,ppid=`)
// and SIGINTs every descendant of portos-server on restart/stop — and
// portos-server restarts routinely (memory ceiling). A multi-hour LoRA trainer
// or video render spawned as a normal child therefore dies mid-run, losing
// hours of GPU work to a process completely unrelated to training.
//
// `detached: true` does NOT help: it puts the child in a new session/process
// group (Node calls setsid), but TreeKill keys on PPID, not the process group,
// so the still-PPID-linked child is found and killed anyway. `treekill: false`
// on the app makes pm2 fail to reap the old node process (lingers on :5555 →
// EADDRINUSE crash-loop). So the fix has to happen spawn-side.
//
// The trick here is a pure-`sh` double-fork so the actual job process reparents
// to init (PPID=1) and leaves pm2's tree entirely, while the server keeps
// streaming its output by tailing on-disk log files:
//
//   server ──spawn(detached)──▶ outer `sh`   (exits within ~1ms)
//                                   │ `{ … } &`  backgrounded subshell
//                                   ▼
//                              supervisor sh   (reparents to init when outer
//                                   │           sh exits — PPID becomes 1)
//                                   ▼
//                                job process    (PPID = supervisor)
//
// Once the outer `sh` exits, TreeKill walking down from portos-server finds
// neither the supervisor nor the job. The supervisor `wait`s on the job and
// records its exit status to a file, so the server can still report success /
// failure for the lifetime it's up. (`setsid(1)` is unavailable on macOS, so
// we rely on Node's `detached` for the new session plus reparent-to-init from
// the double-fork — no external launcher binary needed.)
//
// The returned object is ChildProcess-LIKE — it exposes `pid`, `stdout`,
// `stderr` (EventEmitters emitting `data`/`end`), `on('close', (code,
// signal))`, `on('error', err)`, `kill(signal)`, `killed`, `exitCode`,
// `signalCode` — so existing spawn call sites adopt it with minimal change.
//
// A restarted server can RE-ATTACH to a survivor via reattachDetached(): the
// control dir's log/pid/exit files outlive the process, so a fresh tailer
// streams the (already-written + still-arriving) output and emits 'close' when
// the supervisor records the exit status — exactly as if the original handle
// had never gone away (#1332).

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { constants as osConstants } from 'os';
import { join } from 'path';
import { open, readFile, rm, stat, readdir } from 'fs/promises';
import { ensureDir, sleep } from './fileUtils.js';

// Default cadence for tailing the job's log files and polling for completion.
// 250ms matches the high-frequency-write batching cadence used elsewhere — far
// below human perception for progress, cheap enough to run for hours.
const DEFAULT_POLL_MS = 250;
// How long to wait for the supervisor to write the job's PID before declaring
// the launch a failure. The supervisor writes it the instant the job spawns;
// 10s is generous slack for a loaded machine.
const PID_TIMEOUT_MS = 10000;
// How long reapDetached lets a SIGTERM'd orphan checkpoint+exit before
// escalating to SIGKILL. Matches the in-session cancel escalation (8s) plus
// slack for a final checkpoint write.
const REAP_GRACE_MS = 12000;

// `wait` reports a signal-terminated child as 128+signum. Invert os signal
// constants once so we can decode that back into Node's ('code', 'signal')
// close convention (exactly one of the two is non-null).
const SIGNAL_BY_NUMBER = Object.fromEntries(
  Object.entries(osConstants.signals).map(([name, num]) => [num, name])
);

// Double-fork launcher. argv: <controlDir> <bin> <bin-args…> — passed as
// positional params (NOT interpolated into the script string) so paths/args
// with spaces or shell metacharacters can't break quoting or inject.
//   $1            → control dir (holds stdout.log/stderr.log/pid/exit)
//   "$@" (after shift) → the job command + its args
// The `{ … } &` group is a backgrounded subshell; when the outer `sh` hits EOF
// and exits, that subshell reparents to init, taking the job with it.
const LAUNCHER = `
d="$1"; shift
{
  "$@" > "$d/stdout.log" 2> "$d/stderr.log" &
  child=$!
  printf '%s' "$child" > "$d/pid"
  wait "$child"
  printf '%s' "$?" > "$d/exit"
} &
`;

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
 * @returns {{ tick: () => Promise<void>, finish: () => Promise<void> }}
 */
function createLogTailer(handle, { controlDir, pollMs, cleanup }) {
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
      fds[logPath] = await open(logPath, 'r').catch(() => null);
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
  const finish = async () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    // Final drain so the job's last bytes (e.g. the RESULT:/result-JSON line a
    // hard os._exit can emit just before teardown) are delivered before 'end'.
    await drainBoth();
    await closeFds();
    handle.stdout.emit('end');
    handle.stderr.emit('end');
    const raw = await readFile(exitFile, 'utf8').catch(() => '');
    const status = Number.parseInt(raw, 10);
    let code = null;
    let signal = null;
    if (Number.isFinite(status)) {
      if (status > 128 && SIGNAL_BY_NUMBER[status - 128]) signal = SIGNAL_BY_NUMBER[status - 128];
      else code = status;
    } else {
      code = 1; // exit file missing/garbled — treat as generic failure
    }
    handle.exitCode = code;
    handle.signalCode = signal;
    handle.emit('close', code, signal);
    if (cleanup) rm(controlDir, { recursive: true, force: true }).catch(() => {});
  };

  // Single poll tick: stream new output, then check for the exit sentinel. The
  // supervisor writes `exit` only AFTER `wait` returns, by which point the job
  // has closed its redirected fds — so seeing `exit` guarantees the logs are
  // complete and the final drain in finish() captures everything. A `stat`
  // (size>0) tests for the sentinel without allocating/reading the whole file.
  let replayedEmitted = false;
  const tick = async () => {
    if (closed) return;
    await drainBoth();
    // After the first drain, the entire pre-existing backlog has been emitted —
    // for a fresh spawn that's ~nothing, but for a reattach (#1332) it's the
    // whole replayed-from-offset-0 history. Fire a one-time 'replayed' so a
    // consumer can tell replayed history from live output (e.g. to keep a
    // wall-clock stall detector from arming on instantly-replayed step lines).
    if (!replayedEmitted) { replayedEmitted = true; handle.emit('replayed'); }
    const exited = await stat(exitFile).then((s) => s.size > 0).catch(() => false);
    if (exited) {
      await finish();
      return;
    }
    timer = setTimeout(() => { tick().catch((err) => handle.emit('error', err)); }, pollMs);
  };

  return { tick, finish };
}

/**
 * Spawn a detached, pm2-restart-surviving child process.
 *
 * @param {string} bin - executable to run
 * @param {string[]} args - arguments
 * @param {object} opts
 * @param {object} [opts.env] - child environment
 * @param {string} [opts.cwd] - working directory for the job
 * @param {string} opts.controlDir - job-private dir for log/pid/exit files
 * @param {number} [opts.pollMs] - tail/poll cadence (default 250ms)
 * @param {boolean} [opts.cleanup] - remove controlDir after the job terminates
 *   (default false — keep the logs, e.g. inside a run dir for post-mortem)
 * @returns {Promise<object>} ChildProcess-like handle (resolves once the PID is known)
 */
export async function spawnDetached(bin, args = [], { env, cwd, controlDir, pollMs = DEFAULT_POLL_MS, cleanup = false } = {}) {
  if (!controlDir) throw new Error('spawnDetached requires a controlDir');

  // Windows has no POSIX `sh` for the double-fork, and pm2's process management
  // there is taskkill-based rather than the PPID-walk this works around. Fall
  // back to a normal child process: a real ChildProcess already satisfies the
  // handle contract (pid / stdout / stderr / on('close',code,signal) / kill /
  // exitCode / signalCode), so callers are unaffected. Surviving a pm2 restart
  // is a POSIX-only guarantee; Windows keeps its prior spawn semantics.
  if (process.platform === 'win32') {
    return spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  const handle = new EventEmitter();
  handle.stdout = new EventEmitter();
  handle.stderr = new EventEmitter();
  handle.pid = null;
  handle.killed = false;
  handle.exitCode = null;
  handle.signalCode = null;
  // Default no-op so a setup failure (below) returns a usable handle.
  handle.kill = () => false;

  const pidFile = join(controlDir, 'pid');
  const exitFile = join(controlDir, 'exit');
  const stdoutLog = join(controlDir, 'stdout.log');
  const stderrLog = join(controlDir, 'stderr.log');

  // Setup is filesystem I/O that can fail (permissions, a stale non-dir path,
  // disk full). Surface those as the handle's 'error' event — like a real
  // ChildProcess spawn failure — rather than rejecting: callers attach
  // `on('error')` AFTER the await for their finalization/cleanup, and a reject
  // would bypass that and strand a `running` run or leak temp files. Deferred
  // so the listener is attached before it fires.
  const ensureControlDir = await ensureDir(controlDir).then(
    () => Promise.all([pidFile, exitFile, stdoutLog, stderrLog].map((f) => rm(f, { force: true }))),
  ).then(() => null, (err) => err);
  if (ensureControlDir) {
    setImmediate(() => {
      if (cleanup) rm(controlDir, { recursive: true, force: true }).catch(() => {});
      handle.emit('error', ensureControlDir);
    });
    return handle;
  }

  // Launch the double-fork. `detached` gives the outer sh its own session;
  // `stdio: 'ignore'` because all job output is redirected to files by the
  // launcher; `.unref()` so the server never waits on the (instantly-exiting)
  // outer sh.
  const launcher = spawn('sh', ['-c', LAUNCHER, 'sh', controlDir, bin, ...args], {
    env,
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  // The outer sh exits in ~1ms; a spawn error (e.g. no `sh`) is the only real
  // launcher failure. Capture it so the deferred kickoff below surfaces it as
  // the handle's 'error' AFTER the caller has attached listeners — emitting it
  // synchronously here could throw as an unhandled 'error'.
  let launcherSpawnError = null;
  launcher.on('error', (err) => { launcherSpawnError = err; });
  launcher.unref();

  // Tail the on-disk log files and watch for the supervisor's exit sentinel,
  // streaming new bytes as stdout/stderr 'data' and emitting 'close' on exit.
  // Factored out so reattachDetached (boot re-attach to a survivor — #1332) can
  // drive the exact same streaming machinery against an existing control dir.
  const { tick, finish } = createLogTailer(handle, { controlDir, pollMs, cleanup });

  // Block until the supervisor records the job PID (the instant the job
  // spawns), so callers can rely on `handle.pid` right after `await
  // spawnDetached`. A PID that never appears means the launch itself failed.
  // We only RESOLVE the pid here; the tailing/error emission is deferred to a
  // setImmediate after the handle is returned (below) so the caller's
  // synchronous `.on('data'|'close'|'error')` listeners are attached before
  // any event can fire — otherwise an immediate emission would be lost (data /
  // close) or throw as unhandled (error), matching ChildProcess async timing.
  let launchError = null;
  const awaitPid = async () => {
    for (let waited = 0; waited < PID_TIMEOUT_MS; waited += pollMs) {
      if (launcherSpawnError) { launchError = launcherSpawnError; return; }
      const raw = await readFile(pidFile, 'utf8').catch(() => '');
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0) {
        handle.pid = pid;
        return;
      }
      await sleep(pollMs);
    }
    // No PID. If the supervisor still recorded an exit status, the job ran and
    // exited (e.g. a non-existent bin → 127); route that through 'close'.
    // Otherwise it's a hard launch failure.
    const exitRaw = await readFile(exitFile, 'utf8').catch(() => '');
    if (exitRaw.length === 0) {
      launchError = new Error(`detached spawn produced no PID within ${PID_TIMEOUT_MS}ms`);
    }
  };

  // Signal the job directly by PID (it has reparented away from our tree, but a
  // direct PID signal still reaches it). Mirrors the original `proc.kill()`
  // which also signalled the PID, not the group.
  handle.kill = (signal = 'SIGTERM') => {
    handle.killed = true;
    if (!handle.pid) return false;
    try {
      process.kill(handle.pid, signal);
      return true;
    } catch {
      return false; // ESRCH — already gone
    }
  };

  await awaitPid();

  // Kick off tailing (or the launch-failure path) AFTER returning, so the
  // caller's synchronous event listeners are wired first.
  setImmediate(() => {
    if (launchError) {
      if (cleanup) rm(controlDir, { recursive: true, force: true }).catch(() => {});
      handle.emit('error', launchError);
      return;
    }
    if (handle.pid === null) { finish().catch((err) => handle.emit('error', err)); return; }
    tick().catch((err) => handle.emit('error', err));
  });

  return handle;
}

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * Cheap boot-time probe: is there a detached child worth re-attaching to under
 * this control dir? True when the recorded PID is still alive (job still
 * running) OR the supervisor wrote an `exit` status the previous process never
 * got to consume (job finished during the downtime — its RESULT line is still
 * sitting in the logs unprocessed). False when no PID was recorded, or the PID
 * is dead with no exit sentinel (killed mid-run — nothing clean to resume from,
 * the caller should fall back to reap+fail). Lets a caller decide reattach-vs-
 * fail without constructing a full handle.
 *
 * @param {string} controlDir - the job's spawnDetached control dir
 * @returns {Promise<boolean>}
 */
export async function isReattachable(controlDir) {
  const pidRaw = await readFile(join(controlDir, 'pid'), 'utf8').catch(() => '');
  const pid = Number.parseInt(pidRaw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const exitWritten = (await readFile(join(controlDir, 'exit'), 'utf8').catch(() => '')).length > 0;
  return exitWritten || isAlive(pid);
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
export async function reattachDetached(controlDir, { pollMs = DEFAULT_POLL_MS, cleanup = false } = {}) {
  // Detached survival is a POSIX-only guarantee (see spawnDetached's win32
  // fallback) — there is never a reparented orphan to re-attach to on Windows.
  if (process.platform === 'win32') return null;
  const pidRaw = await readFile(join(controlDir, 'pid'), 'utf8').catch(() => '');
  const pid = Number.parseInt(pidRaw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const exitWritten = (await readFile(join(controlDir, 'exit'), 'utf8').catch(() => '')).length > 0;
  // Dead PID with no exit sentinel → killed mid-run; nothing clean to stream
  // (the RESULT line was never written). Let the caller reap+fail.
  if (!exitWritten && !isAlive(pid)) return null;

  const handle = new EventEmitter();
  handle.stdout = new EventEmitter();
  handle.stderr = new EventEmitter();
  handle.pid = pid;
  handle.killed = false;
  handle.exitCode = null;
  handle.signalCode = null;
  // Signal the survivor directly by PID (it reparented away from our tree, but
  // a direct PID signal still reaches it) — mirrors spawnDetached's handle.kill
  // so cancel/stall paths work identically on a re-attached run.
  handle.kill = (signal = 'SIGTERM') => {
    handle.killed = true;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false; // ESRCH — already gone
    }
  };

  const { tick } = createLogTailer(handle, { controlDir, pollMs, cleanup });
  // Defer the first tick so the caller's synchronous .on('data'|'close'|'error')
  // listeners are wired before any event fires (matches spawnDetached timing).
  setImmediate(() => { tick().catch((err) => handle.emit('error', err)); });
  return handle;
}

/**
 * Is the control dir's job still running (live PID, no exit sentinel)? Lets a
 * caller that REUSES a fixed control dir (e.g. the update executor) refuse to
 * spawn while a prior detached job is alive — spawnDetached's setup truncates
 * the pid/exit files, so the old supervisor's late `exit` write would satisfy
 * the NEW tailer's sentinel check and prematurely close the new handle with
 * the old job's status (the stale-late-write race reapDetached guards against).
 *
 * @param {string} controlDir - the job's spawnDetached control dir
 * @returns {Promise<boolean>}
 */
export async function isDetachedRunning(controlDir) {
  const pidRaw = await readFile(join(controlDir, 'pid'), 'utf8').catch(() => '');
  const pid = Number.parseInt(pidRaw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const exitWritten = (await readFile(join(controlDir, 'exit'), 'utf8').catch(() => '')).length > 0;
  return !exitWritten && isAlive(pid);
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
 * This is the fallback when reattachDetached can't (or shouldn't) re-attach —
 * e.g. a render lane with no re-attach path, or a probe that came back
 * non-reattachable. A caller that CAN re-attach (LoRA training, #1332) should
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
  const exitWritten = async () => (await readFile(exitFile, 'utf8').catch(() => '')).length > 0;
  // Supervisor already recorded an exit → the job finished; nothing to reap.
  if (await exitWritten()) return { reaped: false };
  // Note: trusts the persisted PID. A reused PID (the job exited without the
  // supervisor recording it AND the OS recycled the number within the few
  // seconds before boot) is vanishingly unlikely on a single-user box; the same
  // trust the in-session cancel path places in the child PID.
  const wasAlive = isAlive(pid);
  if (wasAlive) { try { process.kill(pid, 'SIGTERM'); } catch { /* raced its own exit */ } }
  // Wait for the supervisor's `exit` sentinel — its FINAL act after the child
  // dies — not just child death. That sentinel means the supervisor is fully
  // done writing into controlDir, so a resume that reuses the dir can't race a
  // stale late write (which would prematurely close the new handle). Escalate
  // to SIGKILL at the grace deadline; hard-cap so a wedged supervisor can't
  // hang boot.
  const hardCapMs = graceMs + 5000;
  for (let waited = 0; waited < hardCapMs; waited += pollMs) {
    await sleep(pollMs);
    if (await exitWritten()) return { reaped: wasAlive, pid };
    if (waited >= graceMs && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
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
 * @returns {Promise<{reaped: number, scanned: number}>}
 */
export async function reapAndCleanDetachedDirs(parentDir) {
  const entries = await readdir(parentDir).catch(() => []);
  let reaped = 0;
  for (const name of entries) {
    const dir = join(parentDir, name);
    // eslint-disable-next-line no-await-in-loop
    const res = await reapDetached(dir).catch(() => ({ reaped: false }));
    if (res.reaped) reaped += 1;
    // eslint-disable-next-line no-await-in-loop
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { reaped, scanned: entries.length };
}
