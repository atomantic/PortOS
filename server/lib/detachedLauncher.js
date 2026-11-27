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
// Windows has no `sh` and no reparent-to-init, so it reaches the same place by
// a different route — a launcher that exits and leaves a supervisor behind (see
// the block above `WINDOWS_SUPERVISOR`). Both arms write the same control dir
// and hand back the same handle, so this module has exactly ONE code path per
// caller; the platforms differ only in how a cancel reaches the job's
// descendants — a process-group signal on POSIX, `taskkill /T /F` on Windows
// (#6170).
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

import { open, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { spawn } from './childProcess.js';
import { DEFAULT_POLL_MS, GROUP_KILL_MARKER, createDetachedHandle, createLogTailer } from './detachedReattach.js';
import { quoteWindowsArg, snapshotProcesses } from './processSnapshot.js';
import { POSIX_DETACHED_LAUNCHER } from '../../scripts/lib/posixDetachedLauncher.mjs';
import { ensureDir, sleep } from './fileUtils.js';
import { quoteForShell } from './shellCd.js';
import { withSpawnCwdEnv } from './spawnCwd.js';
import { classifyWriterQuiescence, reserveDatabaseWriter, retireQuiescentWriters } from './databaseWriterRegistry.js';
import { createDatabaseMaintenanceJournal } from './databaseMaintenanceJournal.js';
import { PATHS } from './paths.js';

// How long to wait for the supervisor to write the job's PID before declaring
// the launch a failure. The supervisor writes it the instant the job spawns;
// 10s is generous slack for a loaded machine.
const PID_TIMEOUT_MS = 10000;

// ─── Windows equivalent of the double-fork ───────────────────────────────────
//
// Windows has no `sh` and no reparent-to-init, but pm2 kills an app there with
// `taskkill /pid <app> /T /F`, which walks the SAME parent→child tree the POSIX
// launcher escapes — so a plain child of portos-server dies with it exactly as
// it does on POSIX. The escape is a launcher that exits immediately, leaving
// the supervisor with a dead parent and therefore outside the server's tree:
//
//   server ──spawn──▶ launcher powershell   (exits in ~200ms)
//                          │ Process.Start
//                          ▼
//                     supervisor powershell  (parent already gone, so
//                          │                  `taskkill /T` from the server
//                          ▼                  never reaches it)
//                       job process
//
// The supervisor redirects the job's stdout/stderr into the control dir and
// records its pid and exit status there, so the shared tailer below streams a
// Windows job exactly as it streams a POSIX one.
//
// Reading the job spec from `job.json` (rather than interpolating it into the
// script) keeps paths with spaces, quotes, or `$` out of PowerShell's parser.
// `$null = $p.Handle` caches the process handle BEFORE the wait: without it
// `Start-Process -PassThru` hands back an object whose `ExitCode` reads back
// empty once the process is gone, and the tailer would never see a status.
//
// `-NoNewWindow` (NOT `-WindowStyle Hidden`) is what keeps this off Windows'
// default-terminal handoff: only `-NoNewWindow` sets `CreateNoWindow`, while
// `-WindowStyle Hidden` merely passes SW_HIDE and still allocates a console
// host — condition 3 of docs/WINDOWS_CONSOLE.md. The job inherits the
// supervisor's own (window-less) console, so it still HAS one and a console
// host like powershell runs normally.
//
// The catch must write the `exit` sentinel and must NOT touch stdout/stderr.log:
// `Start-Process`'s redirect holds both under an exclusive lock for as long as
// the job lives, so a throw AFTER a successful launch (a faulting
// `WaitForExit`, a sharing violation on the pid write) would fail on its own
// error write and never reach the sentinel — leaving the tailer polling
// forever. Bootstrap diagnostics use their own file, independent of those
// locks, and never include raw exception text.
// Only fixed stage names, numeric HRESULTs and elapsed milliseconds reach
// diagnostics. The launcher and supervisor share a wall-clock origin so a late
// supervisor can be distinguished from time spent inside Start-Process. Keep
// the short history on success too; a last-stage label alone loses that timing.
// PowerShell exception text can embed commands, credentials and private paths.
const WINDOWS_BOOTSTRAP_DIAGNOSTIC = `
function Write-BootstrapStage($stage, $errorCode = 0, $elapsedMs = $null) {
  if ($null -eq $elapsedMs) { $elapsedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $bootstrapStartedAt }
  [System.IO.File]::AppendAllText($diagnosticFile, "$stage hresult=$errorCode elapsed-ms=$elapsedMs\`n")
}
`;

export const WINDOWS_SUPERVISOR = `param([long]$bootstrapStartedAt)
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$diagnosticFile = Join-Path $dir 'supervisor-bootstrap.log'
${WINDOWS_BOOTSTRAP_DIAGNOSTIC}
$started = $false
$preserveStarted = $false
function Test-LaunchCancelled {
  return (!(Test-Path -LiteralPath $dir) -or (Test-Path -LiteralPath (Join-Path $dir 'launch-cancelled')))
}
try {
  $ErrorActionPreference = 'Stop'
  Write-BootstrapStage 'reading-job'
  $job = Get-Content -LiteralPath (Join-Path $dir 'job.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $preserveStarted = $job.preserveStartedOnBootstrapError -eq $true
  $params = @{
    FilePath               = $job.bin
    RedirectStandardOutput = (Join-Path $dir 'stdout.log')
    RedirectStandardError  = (Join-Path $dir 'stderr.log')
    NoNewWindow            = $true
    PassThru               = $true
  }
  if ($job.arguments) { $params.ArgumentList = $job.arguments }
  if ($job.cwd) { $params.WorkingDirectory = $job.cwd }
  if (Test-LaunchCancelled) {
    Write-BootstrapStage 'cancelled'
    [System.IO.File]::WriteAllText((Join-Path $dir 'exit'), '1')
    exit 1
  }
  Write-BootstrapStage 'starting-job'
  $p = Start-Process @params
  $started = $true
  $jobStartedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $bootstrapStartedAt
  # Cache the process handle before any diagnostic file I/O: a short job can
  # exit while that I/O runs, but we must retain its exit-code contract.
  $null = $p.Handle
  $handleAcquiredMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $bootstrapStartedAt
  Write-BootstrapStage 'job-started' 0 $jobStartedMs
  Write-BootstrapStage 'handle-acquired' 0 $handleAcquiredMs
  [System.IO.File]::WriteAllText((Join-Path $dir 'pid'), "$($p.Id)")
  Write-BootstrapStage 'pid-written'
  # A timed-out caller can remove its control directory before this cold
  # supervisor starts. Check throughout the handoff so late children are reaped.
  while (!$p.WaitForExit(250)) {
    if (Test-LaunchCancelled) {
      & taskkill /pid $p.Id /T /F 2>$null | Out-Null
    }
  }
  $p.WaitForExit()
  # ExitCode is a SIGNED int, so a status at or above 0x80000000 (0xC0000005 and
  # the rest of the NTSTATUS crash codes) reads back negative. Node's own
  # ChildProcess reports those UNSIGNED, and the POSIX arm passes the shell wait
  # status straight through; mask back to that so a caller classifying a crash
  # by its code sees the same number on either platform.
  # The L suffix is required: PowerShell types a bare 0xFFFFFFFF as Int32 -1,
  # and masking against -1 is the identity, silently leaving the value negative.
  $code = [int64]$p.ExitCode -band 0xFFFFFFFFL
  [System.IO.File]::WriteAllText((Join-Path $dir 'exit'), "$code")
} catch {
  $failureCode = $_.Exception.HResult
  try { Write-BootstrapStage 'failed' $failureCode } catch { }
  try {
    if ($started -and !$preserveStarted -and !$p.HasExited) { & taskkill /pid $p.Id /T /F 2>$null | Out-Null }
  } catch { }
  if (!$started -or !$preserveStarted) {
    try { [System.IO.File]::WriteAllText((Join-Path $dir 'exit'), '1') } catch { }
  }
}
`;

/**
 * Write the control dir's job spec + supervisor script and launch the
 * short-lived launcher that starts the supervisor outside our process tree.
 * The supervisor is started with an explicit `CreateNoWindow`, not through
 * `Start-Process`, so this hop out of the console-less PM2 fork can never
 * trigger Windows' default-terminal handoff — see docs/WINDOWS_CONSOLE.md.
 * (The supervisor's own launch of the job passes `-NoNewWindow` for the same
 * reason; `-WindowStyle Hidden` would NOT set `CreateNoWindow`.)
 */
async function launchWindowsSupervisor({ controlDir, bin, args, env, cwd, observeLauncher, preserveStartedOnBootstrapError }) {
  const supervisorPath = join(controlDir, 'supervisor.ps1');
  // Independent files — write them together rather than serializing two
  // round-trips in front of every launch.
  await Promise.all([
    writeFile(join(controlDir, 'job.json'), JSON.stringify({
      bin,
      arguments: args.map(quoteWindowsArg).join(' '),
      cwd: cwd || null,
      preserveStartedOnBootstrapError,
    }), 'utf8'),
    writeFile(supervisorPath, WINDOWS_SUPERVISOR, 'utf8'),
  ]);
  const bootstrapStartedAt = Date.now();
  const supervisorArgs = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quoteWindowsArg(supervisorPath)} -bootstrapStartedAt ${bootstrapStartedAt}`;
  const startSupervisor = [
    '$ErrorActionPreference = "Stop";',
    `$bootstrapStartedAt = ${bootstrapStartedAt};`,
    `$diagnosticFile = ${quoteForShell(join(controlDir, 'launcher-bootstrap.log'), 'powershell')};`,
    WINDOWS_BOOTSTRAP_DIAGNOSTIC,
    'try {',
    `if (!(Test-Path -LiteralPath ${quoteForShell(controlDir, 'powershell')}) -or (Test-Path -LiteralPath ${quoteForShell(join(controlDir, 'launch-cancelled'), 'powershell')})) { Write-BootstrapStage 'cancelled'; exit 1 };`,
    "Write-BootstrapStage 'starting-supervisor';",
    '$psi = New-Object System.Diagnostics.ProcessStartInfo;',
    "$psi.FileName = 'powershell';",
    `$psi.Arguments = ${quoteForShell(supervisorArgs, 'powershell')};`,
    '$psi.UseShellExecute = $false;',
    '$psi.CreateNoWindow = $true;',
    '[void][System.Diagnostics.Process]::Start($psi);',
    "Write-BootstrapStage 'supervisor-started';",
    "} catch { try { Write-BootstrapStage 'failed' $_.Exception.HResult } catch { }; exit 1 }",
  ].join(' ');
  const launcher = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', startSupervisor,
  ], {
    // Pin PWD to the spawn cwd — see withSpawnCwdEnv (#3193). The supervisor
    // and the job both inherit this environment.
    env: withSpawnCwdEnv(env ?? process.env, cwd),
    cwd,
    stdio: 'ignore',
  });
  // Install terminal observers before returning across this async boundary.
  observeLauncher(launcher);
  return launcher;
}

// Read a bounded projection even if a corrupt control file contains arbitrary
// text. Never include raw PowerShell output or exception messages in an error.
export async function readBootstrapDiagnostic(controlDir, name) {
  const file = await open(join(controlDir, name), 'r').catch(() => null);
  if (!file) return 'unavailable';
  try {
    // One launcher writes at most three rows; one supervisor at most six.
    // Read an extra byte so a valid prefix cannot conceal an oversized tail.
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) return 'invalid';
    const value = buffer.subarray(0, bytesRead).toString('utf8');
    const rows = value.replace(/\r?\n$/, '').split(/\r?\n/);
    const pattern = /^(starting-supervisor|supervisor-started|reading-job|starting-job|job-started|handle-acquired|pid-written|failed|cancelled) hresult=-?\d{1,11}(?: elapsed-ms=(-?\d{1,13}))?$/;
    if (rows.length > 6 || !rows.every((row) => pattern.test(row))) return 'invalid';
    // A single legacy stage/HRESULT row remains readable. Only allowlisted
    // stage names and relative times are projected from the earlier rows.
    const timeline = rows.map((row) => {
      const [, stage, elapsed] = pattern.exec(row);
      return elapsed === undefined ? stage : `${stage}@${elapsed}ms`;
    });
    return rows.at(-1) + (rows.length > 1 ? `; timeline=${timeline.join('>')}` : '');
  } catch {
    return 'unreadable';
  } finally {
    await file.close().catch(() => {});
  }
}

const markAbandoned = (writer) => {
  try { writer.abandoned?.(); } catch {
    console.error('❌ Could not persist abandoned detached launch evidence');
  }
};

// On completion, retire a POSIX record only after two consecutive snapshots
// prove the job gone and its recorded groups empty. Survivors (or a slow
// supervisor) leave the identity retained for maintenance reconciliation.
const RETIRE_ATTEMPTS = 3;
const RETIRE_INTERVAL_MS = 200;
async function retireQuiescentWriter(writer) {
  if (process.platform === 'win32' || !writer.inspect || !writer.retire) return;
  let consecutive = 0;
  for (let attempt = 0; attempt < RETIRE_ATTEMPTS + 1 && consecutive < 2; attempt += 1) {
    if (attempt > 0) await sleep(RETIRE_INTERVAL_MS);
    const verdict = classifyWriterQuiescence(writer.inspect(), await snapshotProcesses()).verdict;
    consecutive = verdict === 'quiescent' ? consecutive + 1 : 0;
  }
  if (consecutive >= 2) writer.retire();
}

/** Boot sweep: retire every record the launching process never got to (see `retireQuiescentWriters`). */
export const sweepQuiescentWriters = (options = {}) => retireQuiescentWriters({ snapshot: snapshotProcesses, ...options });

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
 * @param {number} [opts.pidTimeoutMs] - how long to wait for the supervisor to
 *   record a PID before treating the launch as failed (default 10000ms).
 *   Overridable so a test driving the real double-fork/supervisor launch can
 *   give a slow CI host more headroom without weakening the production default.
 * @param {boolean} [opts.cleanup] - remove controlDir after the job terminates
 *   (default false — keep the logs, e.g. inside a run dir for post-mortem)
 * @param {boolean} [opts.killProcessGroup] - signal `-pid` on cancel/reap so a
 *   group-leader wrapper and every runtime child terminate together. The job is
 *   responsible for establishing its own process group before spawning children.
 *   POSIX-only in mechanism: Windows has no process group, and its cancel is
 *   always the `taskkill /T /F` tree, group flag or not.
 * @returns {Promise<object>} ChildProcess-like handle (resolves once the PID is known)
 */
export async function spawnDetached(bin, args = [], options = {}) {
  return spawnDetachedWithReservation(bin, args, options, reserveDatabaseWriter);
}

/**
 * Internal, one-use launch of the fixed offline-transfer worker. There is no
 * bin/argv/env/controlDir override and no ordinary-writer bypass option. It
 * retains the supervisor receipt even when the caller exits; a successor needs
 * that receipt before recovery (see databaseMaintenanceTransfer.js).
 */
export async function spawnDatabaseMaintenanceWorker(id, token) {
  const journal = createDatabaseMaintenanceJournal();
  const controlDir = journal.reserveCoordinatorWorker(id, token);
  return spawnDetachedWithReservation(process.execPath,
    [join(PATHS.root, 'scripts', 'database-maintenance-worker.mjs'), id, token],
    { controlDir, cleanup: false, cwd: PATHS.root,
      env: { ...process.env, PORTOS_DATA_ROOT: PATHS.installRoot } },
    () => {
      journal.assertCoordinatorWorker(id, token);
      return { assertLaunchAllowed: () => journal.assertCoordinatorWorker(id, token) };
    });
}

async function spawnDetachedWithReservation(bin, args, {
  env, cwd, controlDir, pollMs = DEFAULT_POLL_MS, pidTimeoutMs = PID_TIMEOUT_MS,
  cleanup = false, killProcessGroup = false, onLaunchTimeout,
}, reserveWriter) {
  if (!controlDir) throw new Error('spawnDetached requires a controlDir');

  const isWindows = process.platform === 'win32';

  // `kill` reports false until the supervisor records a PID, so a setup failure
  // (below) still returns a usable handle.
  const handle = createDetachedHandle({ killProcessGroup });
  // Publish before any await: a launch admitted immediately before maintenance
  // is visible even while async setup or the detached supervisor is pending.
  let writer;
  try { writer = reserveWriter(controlDir, killProcessGroup); } catch (err) {
    setImmediate(() => handle.emit('error', err));
    return handle;
  }
  const recordCompletion = (code, signal) => {
    try { writer.completed?.(code, signal); } catch {
      // Missing evidence is unresolved, never synthesized into quiescence.
      console.error('❌ Could not persist detached writer completion evidence');
    }
  };
  handle.once('close', (code, signal) => {
    recordCompletion(code, signal);
    retireQuiescentWriter(writer).catch(() => {
      // Retained evidence is reconciled later; it is never treated as absence.
    });
  });

  const pidFile = join(controlDir, 'pid');
  const exitFile = join(controlDir, 'exit');
  const stdoutLog = join(controlDir, 'stdout.log');
  const stderrLog = join(controlDir, 'stderr.log');
  const groupKillFile = join(controlDir, GROUP_KILL_MARKER);

  // Setup is filesystem I/O that can fail (permissions, a stale non-dir path,
  // disk full). Surface those as the handle's 'error' event — like a real
  // ChildProcess spawn failure — rather than rejecting: callers attach
  // `on('error')` AFTER the await for their finalization/cleanup, and a reject
  // would bypass that and strand a `running` run or leak temp files. Deferred
  // so the listener is attached before it fires.
  const ensureControlDir = await ensureDir(controlDir).then(
    () => Promise.all([pidFile, exitFile, stdoutLog, stderrLog, groupKillFile,
      ...(isWindows ? ['launcher-bootstrap.log', 'supervisor-bootstrap.log', 'launcher-result.log', 'launch-cancelled'].map((name) => join(controlDir, name)) : [])].map((f) => rm(f, { force: true }))),
  ).then(
    () => (killProcessGroup ? writeFile(groupKillFile, '1') : null),
  ).then(() => null, (err) => err);
  if (ensureControlDir) {
    markAbandoned(writer);
    setImmediate(() => {
      if (cleanup) rm(controlDir, { recursive: true, force: true }).catch(() => {});
      handle.emit('error', ensureControlDir);
    });
    return handle;
  }

  // Launch the double-fork. `detached` gives the outer sh its own session;
  // `stdio: 'ignore'` because all job output is redirected to files by the
  // launcher; `.unref()` so the server never waits on the (instantly-exiting)
  // outer sh. Windows takes the supervisor launcher instead — see its header
  // block above for why `detached` cannot appear on that arm.
  // The outer sh exits in ~1ms; a spawn error (e.g. no `sh`) is the only real
  // launcher failure. Capture it so the deferred kickoff below surfaces it as
  // the handle's 'error' AFTER the caller has attached listeners — emitting it
  // synchronously here could throw as an unhandled 'error'. The Windows path
  // writes two control files before it spawns, so it can fail with a rejection
  // too; route that into the same slot rather than letting it reject
  // spawnDetached, for the reason ensureControlDir above spells out.
  try { writer.assertLaunchAllowed(); } catch (err) {
    // Nothing was launched, so the reservation can say so durably. Without
    // this, an admitted launch refused by the fence would stay unresolved.
    markAbandoned(writer);
    setImmediate(() => handle.emit('error', err));
    return handle;
  }
  let launcherSpawnError = null;
  let launcherExit = null;
  let launcherClosed = false;
  let launcherSpawned = false;
  let launcherStartedAt;
  const launcherTimeline = [];
  const recordLauncherStage = (stage) => {
    launcherTimeline.push(`${stage}@${Math.max(0, Date.now() - launcherStartedAt)}ms`);
  };
  const observeLauncher = (child) => {
    launcherStartedAt = Date.now();
    recordLauncherStage('spawn-returned');
    child.once('spawn', () => { launcherSpawned = true; recordLauncherStage('spawned'); });
    child.on('error', (err) => {
      if (launcherSpawnError) return;
      launcherSpawnError = err;
      recordLauncherStage('spawn-error');
    });
    child.once('exit', (code) => {
      launcherExit = Number.isInteger(code) ? code : 'signal';
      recordLauncherStage('exited');
    });
    child.once('close', () => { launcherClosed = true; recordLauncherStage('closed'); });
  };
  const launcher = isWindows
    ? await launchWindowsSupervisor({ controlDir, bin, args, env, cwd, observeLauncher,
      preserveStartedOnBootstrapError: Boolean(onLaunchTimeout) })
      .catch((err) => { launcherSpawnError = err; return null; })
    : spawn('sh', ['-c', POSIX_DETACHED_LAUNCHER, 'sh', controlDir, bin, ...args], {
      // Pin PWD to the spawn cwd — see withSpawnCwdEnv (#3193).
      env: withSpawnCwdEnv(env ?? process.env, cwd),
      cwd,
      detached: true,
      stdio: 'ignore',
    });
  if (!isWindows && launcher?.pid) {
    try { writer.launcher?.(launcher.pid); } catch {
      console.error('❌ Could not persist detached launcher group evidence');
    }
  }
  if (!isWindows && launcher) observeLauncher(launcher);
  launcher?.unref();

  // Tail the on-disk log files and watch for the supervisor's exit sentinel,
  // streaming new bytes as stdout/stderr 'data' and emitting 'close' on exit.
  // Factored out so reattachDetached (boot re-attach to a survivor — #1332) can
  // drive the exact same streaming machinery against an existing control dir.
  const { tick, finish, stop } = createLogTailer(handle, { controlDir, pollMs, cleanup });
  handle.stopTailing = stop;

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
    // Wall-clock deadline, not `waited += pollMs` — same reason as the reap
    // loop below (#7951): the loop body reads a file each pass, so a tick count
    // under-measures real elapsed time on a loaded machine and stretches this
    // timeout well past pidTimeoutMs.
    const pidDeadline = Date.now() + pidTimeoutMs;
    while (Date.now() < pidDeadline) {
      if (launcherSpawnError) { launchError = launcherSpawnError; return; }
      const raw = await readFile(pidFile, 'utf8').catch(() => '');
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0) {
        handle.pid = pid;
        return;
      }
      if (isWindows && (await readFile(exitFile, 'utf8').catch(() => '')).length > 0) {
        // A fast job can publish both files between these reads.
        const completedPid = Number.parseInt(await readFile(pidFile, 'utf8').catch(() => ''), 10);
        if (Number.isFinite(completedPid) && completedPid > 0) {
          handle.pid = completedPid;
          return;
        }
        launchError = new Error('Windows supervisor exited before recording a PID');
        return;
      }
      if (isWindows && launcherClosed && launcherExit !== 0) {
        launchError = new Error('Windows launcher closed before recording a PID');
        return;
      }
      await sleep(pollMs);
    }
    if (isWindows) recordLauncherStage('pid-timeout');
    // No PID. If the supervisor still recorded an exit status, the job ran and
    // exited (e.g. a non-existent bin → 127); route that through 'close'.
    // Otherwise it's a hard launch failure.
    const exitRaw = await readFile(exitFile, 'utf8').catch(() => '');
    if (exitRaw.length === 0 || isWindows) {
      launchError = new Error(`detached spawn produced no PID within ${pidTimeoutMs}ms`);
    }
  };

  await awaitPid();
  if (handle.pid !== null) {
    try { writer.launched?.(handle.pid); } catch {
      // The child may already exist. Preserve the reservation and control
      // files; inventory cannot mistake this for a completed or absent writer.
      console.error('❌ Could not persist detached writer launch evidence');
    }
  }

  // No POSIX launcher PID means no process was started. A PID-bearing
  // launcher remains evidence even if it later errors or its publication fails.
  if (!isWindows && launchError && !launcher?.pid) markAbandoned(writer);

  let failureCleanupAllowed = true;
  if (isWindows && launchError) {
    if (onLaunchTimeout) {
      try { handle.launchTimeoutResult = await onLaunchTimeout(); }
      catch (error) { handle.launchTimeoutError = error; }
    }
    // Persist cancellation before returning or scheduling cleanup. A supervisor
    // still cold-starting must not launch an orphan after this failed handoff.
    const mayCancel = !onLaunchTimeout || ['canceled', 'unknown'].includes(handle.launchTimeoutResult?.state);
    const cancellationWritten = mayCancel && await writeFile(join(controlDir, 'launch-cancelled'), '1').then(() => true, () => false);
    // A launcher exit does not prove its detached supervisor/job stopped. Keep
    // the cancellation marker and evidence until reconciliation can confirm it.
    // Only a failed native spawn with no process identity proves no child exists.
    failureCleanupAllowed = Boolean(launcherSpawnError && !launcher?.pid && !launcherSpawned);
    const cleanupState = failureCleanupAllowed ? 'not-started' : 'unconfirmed';
    const launcherResult = launcherSpawnError
      ? (['ENOENT', 'EACCES', 'EPERM', 'EAGAIN', 'ENOMEM'].includes(launcherSpawnError.code)
        ? launcherSpawnError.code : 'spawn-error')
      : (launcherExit === null ? 'pending' : String(launcherExit));
    await writeFile(join(controlDir, 'launcher-result.log'), launcherResult).catch(() => {});
    const [launcherStage, supervisorStage] = await Promise.all([
      readBootstrapDiagnostic(controlDir, 'launcher-bootstrap.log'),
      readBootstrapDiagnostic(controlDir, 'supervisor-bootstrap.log'),
    ]);
    launchError = new Error(`detached spawn failed to acquire PID within ${pidTimeoutMs}ms; launcher=${launcherResult}; launcher-lifecycle=${launcherTimeline.join('>') || 'not-spawned'}; launcher-stage=${launcherStage}; supervisor-stage=${supervisorStage}; cancellation=${!mayCancel ? 'not-requested' : cancellationWritten ? 'written' : 'unconfirmed'}; cleanup=${cleanupState}`);
  }

  // Kick off tailing (or the launch-failure path) AFTER returning, so the
  // caller's synchronous event listeners are wired first.
  setImmediate(() => {
    if (launchError) {
      if (cleanup && failureCleanupAllowed) rm(controlDir, { recursive: true, force: true }).catch(() => {});
      handle.emit('error', launchError);
      return;
    }
    if (handle.pid === null) { finish().catch((err) => handle.emit('error', err)); return; }
    tick().catch((err) => handle.emit('error', err));
  });

  return handle;
}
