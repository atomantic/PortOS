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
// NOTE: this does NOT re-attach to a job that outlived the server (the poller
// dies with the process); a restarted server simply stops streaming while the
// job keeps running, and checkpoint-resume recovers anything in flight.
// Re-attach is tracked separately (#1332).

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { constants as osConstants } from 'os';
import { join } from 'path';
import { open, readFile, rm, stat } from 'fs/promises';
import { ensureDir, sleep } from './fileUtils.js';

// Default cadence for tailing the job's log files and polling for completion.
// 250ms matches the high-frequency-write batching cadence used elsewhere — far
// below human perception for progress, cheap enough to run for hours.
const DEFAULT_POLL_MS = 250;
// How long to wait for the supervisor to write the job's PID before declaring
// the launch a failure. The supervisor writes it the instant the job spawns;
// 10s is generous slack for a loaded machine.
const PID_TIMEOUT_MS = 10000;

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

  await ensureDir(controlDir);
  // Clear any stale control files from a prior run reusing this dir, so the
  // PID/exit pollers can't latch onto a previous job's results.
  const pidFile = join(controlDir, 'pid');
  const exitFile = join(controlDir, 'exit');
  const stdoutLog = join(controlDir, 'stdout.log');
  const stderrLog = join(controlDir, 'stderr.log');
  await Promise.all([pidFile, exitFile, stdoutLog, stderrLog].map((f) => rm(f, { force: true })));

  const handle = new EventEmitter();
  handle.stdout = new EventEmitter();
  handle.stderr = new EventEmitter();
  handle.pid = null;
  handle.killed = false;
  handle.exitCode = null;
  handle.signalCode = null;

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

  // Tail state: a persistent fd per log (opened lazily once the supervisor
  // creates the file) plus the byte offset read so far. Holding the fd open for
  // the job's lifetime avoids an open+close per poll tick (~4/s for hours).
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
  const tick = async () => {
    if (closed) return;
    await drainBoth();
    const exited = await stat(exitFile).then((s) => s.size > 0).catch(() => false);
    if (exited) {
      await finish();
      return;
    }
    timer = setTimeout(() => { tick().catch((err) => handle.emit('error', err)); }, pollMs);
  };

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
