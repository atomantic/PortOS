import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { execFile, spawn } from './childProcess.js';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import { pinPlatform } from './testHelper.js';
import { killProcessTree } from './bufferedSpawn.js';
import { spawnDetached, reapDetached, reapAndCleanDetachedDirs, reattachDetached, isReattachable, isDetachedRunning, __detachedSpawnTesting } from './detachedSpawn.js';

// Only a win32 cancel reaches killProcessTree, so stubbing it is inert for
// every POSIX test here — and it lets the win32 tests assert the delegation on
// a platform where `taskkill` doesn't exist. The one test that needs the real
// tree-kill (a Windows host, killing a job with a live grandchild) restores it
// for itself with `mockImplementationOnce`.
vi.mock('./bufferedSpawn.js', async (importOriginal) => ({
  ...(await importOriginal()),
  killProcessTree: vi.fn(),
}));

const execFileAsync = promisify(execFile);

// Both platforms produce the same control-dir contract (pid/exit sentinels,
// reap, re-attach, survive-the-restart) — but by different mechanisms: a POSIX
// `sh` double-fork, and a powershell launcher+supervisor on Windows. Tests that
// assert one MECHANISM are gated on the platform that has it (`sh -c` fixtures
// and PPID walks on IS_POSIX; the real powershell launcher on !IS_POSIX).
// Tests of the shared handle CONTRACT run everywhere, driving `node -e`
// fixtures rather than `sh -c` so they work on a Windows checkout too.
const IS_POSIX = process.platform !== 'win32';
const dirs = [];
const tmpControlDir = async () => {
  const d = await mkdtemp(join(tmpdir(), 'detached-spawn-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// Collect a stream's 'data' chunks into a single string.
const collect = (emitter) => {
  let out = '';
  emitter.on('data', (chunk) => { out += chunk.toString(); });
  return () => out;
};

// Resolve when the handle emits 'close' (code, signal) or 'error'.
const onClose = (handle) => new Promise((resolve, reject) => {
  handle.on('close', (code, signal) => resolve({ code, signal }));
  handle.on('error', reject);
});

// Wait for the OS-level state a test is actually about (the job is running, the
// cleanup rm landed, the log holds a line) instead of sleeping a fixed budget
// and hoping. These are real processes and real files, so there is no clock to
// fake — but a condition wait returns the moment the state arrives, which is
// typically ~1 tick rather than the 50–200ms the fixed sleeps it replaced cost
// unconditionally. Bounded so a genuine regression fails the assertion below
// rather than hanging the suite to the vitest timeout.
const WAIT_POLL_MS = 5;
const waitUntil = async (predicate, { timeoutMs = 5000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
};

// `process.kill(pid, 0)` is the portable liveness probe; the `ps`-based helpers
// below are POSIX-only and unusable in the win32 tests.
const isAliveForTest = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const ppidOf = async (pid) => {
  const { stdout } = await execFileAsync('ps', ['-o', 'ppid=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
};
const aliveByPs = async (pid) => {
  const { stdout } = await execFileAsync('ps', ['-o', 'pid=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
  return stdout.trim().length > 0;
};
// Walk a process's ancestor chain to the root (PPID 1 / 0).
const ancestorsOf = async (pid) => {
  const chain = [];
  let cur = await ppidOf(pid);
  while (cur > 1 && chain.length < 50) {
    chain.push(cur);
    cur = await ppidOf(cur);
  }
  return chain;
};

// The job's stdout as the tailer sees it on disk.
const readStdoutLog = (controlDir) => readFile(join(controlDir, 'stdout.log'), 'utf8').catch(() => '');

// A `sh` fragment that blocks until the test writes `marker`. Replaces a fixed
// `sleep N` in the fixtures below: the window a test needs open stays open for
// exactly as long as the test needs it, and not a second longer.
const blockUntil = (marker) => `while [ ! -f "${marker}" ]; do sleep 0.02; done`;

describe('spawnDetached', () => {
  it('streams stdout and stderr, then closes with the exit code', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached(
      'sh',
      ['-c', 'printf "out-a\\nout-b\\n"; printf "err-1\\n" 1>&2; exit 0'],
      { controlDir, pollMs: 25 }
    );
    const getOut = collect(handle.stdout);
    const getErr = collect(handle.stderr);
    const { code, signal } = await onClose(handle);
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(getOut()).toBe('out-a\nout-b\n');
    expect(getErr()).toBe('err-1\n');
    expect(handle.exitCode).toBe(0);
  });

  it('propagates a non-zero exit code', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'exit 3'], { controlDir, pollMs: 25 });
    const { code, signal } = await onClose(handle);
    expect(code).toBe(3);
    expect(signal).toBeNull();
  });

  it.runIf(IS_POSIX)('reparents the job out of the spawner tree (escapes pm2 TreeKill)', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir, pollMs: 25 });
    expect(handle.pid).toBeGreaterThan(0);
    // The double-fork reparents the supervisor (the job's parent) to init once
    // the outer sh exits. TreeKill walks DOWN from the spawner's PID, so the
    // job escapes iff this test process is NOT an ancestor of the job. Poll
    // briefly to let the outer sh exit, then assert the spawner is absent from
    // the job's full ancestor chain.
    let ancestors = [];
    await waitUntil(async () => {
      ancestors = await ancestorsOf(handle.pid);
      return !ancestors.includes(process.pid);
    });
    expect(ancestors).not.toContain(process.pid);
    handle.kill('SIGKILL');
    await onClose(handle);
  });

  it.runIf(IS_POSIX)('kill() signals the reparented job and surfaces the signal on close', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir, pollMs: 25 });
    expect(handle.pid).toBeGreaterThan(0);
    // Wait for the sleeper to actually be running under the recorded PID —
    // signalling before then would test nothing.
    await waitUntil(() => aliveByPs(handle.pid));
    const killed = handle.kill('SIGKILL');
    expect(killed).toBe(true);
    const { code, signal } = await onClose(handle);
    expect(signal).toBe('SIGKILL');
    expect(code).toBeNull();
    expect(handle.signalCode).toBe('SIGKILL');
  });

  it.runIf(IS_POSIX)('killProcessGroup terminates a wrapper and its runtime child', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('python3', ['-c', [
      'import os, subprocess, time',
      'os.setpgid(0, 0)',
      "child = subprocess.Popen(['sleep', '30'])",
      'print(child.pid, flush=True)',
      'time.sleep(30)',
    ].join('; ')], { controlDir, pollMs: 25, killProcessGroup: true });
    const getOut = collect(handle.stdout);
    let runtimePid = 0;
    await waitUntil(() => {
      runtimePid = Number.parseInt(getOut().trim(), 10);
      return runtimePid > 0;
    });
    expect(runtimePid).toBeGreaterThan(0);
    expect(await aliveByPs(runtimePid)).toBe(true);
    const closed = onClose(handle);
    expect(handle.kill('SIGKILL')).toBe(true);
    await closed;
    let alive = true;
    await waitUntil(async () => {
      alive = await aliveByPs(runtimePid);
      return !alive;
    });
    expect(alive).toBe(false);
  });

  it('rejects (via close=1) when the control dir is reused with stale files cleared', async () => {
    const controlDir = await tmpControlDir();
    // First run leaves pid/exit/logs behind.
    const first = await spawnDetached('sh', ['-c', 'printf "first\\n"; exit 0'], { controlDir, pollMs: 25 });
    await onClose(first);
    // Second run on the SAME dir must not latch onto the first run's exit/pid.
    const second = await spawnDetached('sh', ['-c', 'printf "second\\n"; exit 7'], { controlDir, pollMs: 25 });
    const getOut = collect(second.stdout);
    const { code } = await onClose(second);
    expect(code).toBe(7);
    expect(getOut()).toBe('second\n');
  });

  it.runIf(IS_POSIX)('removes the control dir after the job ends when cleanup is set', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'printf "x\\n"; exit 0'], { controlDir, pollMs: 25, cleanup: true });
    await onClose(handle);
    // finish() fires the rm off unawaited after emitting close — wait for the
    // dir to actually be gone rather than for a fixed budget.
    await waitUntil(async () => !(await stat(controlDir).then(() => true).catch(() => false)));
    const present = await stat(controlDir).then(() => true).catch(() => false);
    expect(present).toBe(false);
  });

  it('keeps the control dir by default (logs retained for post-mortem)', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'printf "x\\n"; exit 0'], { controlDir, pollMs: 25 });
    await onClose(handle);
    // No wait to burn: without `cleanup` nothing schedules a removal at all, so
    // asserting immediately after close is the stronger check — a regression
    // that starts removing the dir has no grace window to hide in.
    const present = await stat(controlDir).then(() => true).catch(() => false);
    expect(present).toBe(true);
  });

  it('requires a controlDir', async () => {
    await expect(spawnDetached('sh', ['-c', 'true'], {})).rejects.toThrow(/controlDir/);
  });

  it.runIf(IS_POSIX)('surfaces a setup failure as an error event, not a rejection', async () => {
    // controlDir under a regular FILE → ensureDir fails (ENOTDIR). spawnDetached
    // must still resolve a handle and emit 'error' so the caller's on('error')
    // finalization runs (rejecting would strand the run / leak temps).
    const base = await tmpControlDir();
    const filePath = join(base, 'not-a-dir');
    await writeFile(filePath, 'x');
    const handle = await spawnDetached('sh', ['-c', 'true'], { controlDir: join(filePath, 'sub') });
    const err = await new Promise((resolve) => handle.on('error', resolve));
    expect(err).toBeInstanceOf(Error);
    expect(handle.pid).toBeNull();
  });

  // The Windows launcher is real powershell, so it can only be exercised on a
  // Windows host — pinning the platform elsewhere would just
  // fail to find the binary. Regression for #6169: the plain
  // `spawn(..., { detached: true })` this replaced meant DETACHED_PROCESS,
  // which denies a console host any console, so the job exited 0 in ~100ms
  // having produced no output and run no part of the script. Asserting real
  // streamed output plus the job's own exit code is what catches that.
  it.runIf(!IS_POSIX)('runs the job and streams its output through the control dir', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached(
      process.execPath,
      // The spaced/quoted argv entry pins the Windows command-line quoting the
      // supervisor needs: .NET Framework's ProcessStartInfo takes one flat
      // argument STRING, so a mis-quoted path would silently split.
      ['-e', 'process.stdout.write(process.argv[1] + "\\n"); process.exit(3);', 'a b "c"'],
      { controlDir }
    );
    const getOut = collect(handle.stdout);
    expect(handle.pid).toBeGreaterThan(0);
    const { code, signal } = await onClose(handle);
    expect(code).toBe(3);
    expect(signal).toBeNull();
    expect(getOut()).toBe('a b "c"\n');
  });

  // The whole POINT of the Windows launcher: pm2 kills on Windows with
  // `taskkill /pid <app> /T /F`, which walks the parent tree, so a job spawned
  // as a plain child of portos-server dies at update.sh's own `pm2-stop` step
  // and leaves the install headless (#5976, and #6169 on Windows). Nothing in
  // the streaming tests above would fail if someone "simplified" the launcher
  // by dropping the launcher hop and starting the supervisor directly, so this
  // asserts the survival itself: tree-kill the spawning process, and the job
  // must still be running and still writing.
  it.runIf(!IS_POSIX)('survives a tree-kill of the process that spawned it', async () => {
    const controlDir = await tmpControlDir();
    const marker = join(controlDir, 'go');
    const heartbeat = join(controlDir, 'heartbeat');
    // A stand-in for portos-server: it spawns the job and then just stays alive.
    const spawnerPath = join(controlDir, 'spawner.mjs');
    await writeFile(spawnerPath, [
      `import { spawnDetached } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'detachedSpawn.js')).href)};`,
      'await spawnDetached(process.execPath, [',
      "  '-e',",
      "  'const {existsSync,appendFileSync}=require(\"fs\");const t=setInterval(()=>{appendFileSync(process.argv[2],\"x\");if(existsSync(process.argv[1])){clearInterval(t);process.exit(0);}},20);',",
      `  ${JSON.stringify(marker)},`,
      `  ${JSON.stringify(heartbeat)},`,
      `], { controlDir: ${JSON.stringify(controlDir)} });`,
      'setInterval(() => {}, 1000);',
    ].join('\n'));

    const spawner = spawn(process.execPath, [spawnerPath], { stdio: 'ignore' });
    const pidFile = join(controlDir, 'pid');
    const readPid = async () => Number.parseInt(await readFile(pidFile, 'utf8').catch(() => ''), 10);
    expect(await waitUntil(async () => Number.isFinite(await readPid()))).toBe(true);
    const jobPid = await readPid();

    // Tree-kill the spawner exactly as pm2 would. `taskkill /T` walks the
    // parent tree, so this is the real test: the job is only spared because the
    // launcher that started its supervisor has already exited.
    await execFileAsync('taskkill', ['/pid', String(spawner.pid), '/T', '/F']).catch(() => {});
    expect(await waitUntil(() => spawner.exitCode !== null || spawner.killed)).toBe(true);

    // Still alive, and still doing work — a job that survived the kill but was
    // wedged would satisfy a liveness check alone.
    const beats = async () => (await readFile(heartbeat, 'utf8').catch(() => '')).length;
    const before = await beats();
    expect(isAliveForTest(jobPid)).toBe(true);
    expect(await waitUntil(async () => (await beats()) > before)).toBe(true);

    await writeFile(marker, '1');
    expect(await waitUntil(async () => (await readFile(join(controlDir, 'exit'), 'utf8').catch(() => '')).length > 0)).toBe(true);
  });

  // PowerShell's ExitCode is a SIGNED int, so an NTSTATUS crash status reads
  // back negative — while Node's own ChildProcess, and the POSIX arm's raw wait
  // status, report it unsigned. Without the mask the two platforms disagree
  // about the same crash, and a caller classifying one by its code silently
  // stops recognizing it on Windows.
  it.runIf(!IS_POSIX)('reports a crash status unsigned, as Node does', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::Exit(-1073741819)'],
      { controlDir }
    );
    const { code, signal } = await onClose(handle);
    expect(code).toBe(3221225477); // 0xC0000005, not -1073741819
    expect(signal).toBeNull();
  });

  it.runIf(!IS_POSIX)('identifies a live job by its executable', async () => {
    const controlDir = await tmpControlDir();
    const marker = join(controlDir, 'go');
    const handle = await spawnDetached(
      process.execPath,
      ['-e', 'const {existsSync}=require("fs");const t=setInterval(()=>{if(existsSync(process.argv[1])){clearInterval(t);process.exit(0);}},5);', marker],
      { controlDir }
    );
    const closed = onClose(handle);
    expect(await isDetachedRunning(controlDir, { executable: process.execPath })).toBe(true);
    // A PID some unrelated process inherited must not keep the control dir
    // blocked — that would wedge every later update at "already running".
    expect(await isDetachedRunning(controlDir, { executable: 'notepad' })).toBe(false);
    await writeFile(marker, '1');
    await closed;
  });

  // A job that runs until a marker file appears, then exits with a code and NO
  // signal — the shape `taskkill /T /F` leaves behind on Windows, where the kill
  // happens out of band so nothing records an exit_signal. Driven by `node -e`
  // rather than `sh -c` because these tests are NOT gated on IS_POSIX: they run
  // against the control-dir handle both platforms now return, and must work on a
  // real Windows checkout, which has no guaranteed POSIX shell.
  //
  // The handle is built by whichever launcher the HOST has; only `kill`'s
  // dispatch is platform-dependent. So each test spawns FIRST — pinning before
  // the spawn would send a Linux runner at the supervisor's real powershell,
  // which it has none of — then pins win32 and holds the pin through 'close',
  // which decodes the exit status per-platform too. On a Windows host the pin
  // is a no-op and these run against the real supervisor handle end to end.
  const spawnMarkerJob = async (exitCode = 1, opts = {}) => {
    const controlDir = await tmpControlDir();
    const marker = join(controlDir, 'go');
    const handle = await spawnDetached(
      process.execPath,
      ['-e', `const {existsSync}=require('fs');const t=setInterval(()=>{if(existsSync(process.argv[1])){clearInterval(t);process.exit(${exitCode});}},5);`, marker],
      { controlDir, pollMs: 25, ...opts }
    );
    return { handle, controlDir, terminate: () => writeFile(marker, '1') };
  };

  it('win32 kill() tree-kills by pid so the runner\'s children die with it', async () => {
    const { handle, terminate } = await spawnMarkerJob();
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const closed = onClose(handle);
      expect(handle.kill('SIGKILL')).toBe(true);
      expect(handle.killed).toBe(true);
      expect(killProcessTree).toHaveBeenCalledTimes(1);
      const [target, signal, opts, isWin32] = killProcessTree.mock.calls[0];
      expect(signal).toBe('SIGKILL');
      expect(opts).toEqual({ processGroup: false });
      expect(isWin32).toBe(true);
      // The job reparented away from this process, so a bare `{ pid }` is the
      // only address there is — killProcessTree's taskkill branch has to accept
      // it, or the cancel silently degrades to a leaf kill that orphans the
      // ffmpeg/python the runner spawned (#4171).
      expect(target).toEqual({ pid: handle.pid });
      expect(target.kill).toBeUndefined();
      await terminate();
      await closed;
    } finally {
      restorePlatform();
    }
  });

  it('win32 maps killProcessGroup onto the same tree-kill (no process groups there)', async () => {
    const { handle, terminate } = await spawnMarkerJob(1, { killProcessGroup: true });
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const closed = onClose(handle);
      expect(handle.kill('SIGTERM')).toBe(true);
      const [target, , opts, isWin32] = killProcessTree.mock.calls[0];
      // Forwarded as-is: killProcessTree's win32 branch runs BEFORE its
      // process-group branch, so the flag can never reach a `process.kill(-pid)`
      // that Windows has no meaning for.
      expect(opts).toEqual({ processGroup: true });
      expect(isWin32).toBe(true);
      expect(target).toEqual({ pid: handle.pid });
      await terminate();
      await closed;
    } finally {
      restorePlatform();
    }
  });

  it('win32 reports the requested signal on close (taskkill kills out of band)', async () => {
    const { handle, terminate } = await spawnMarkerJob();
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const closed = onClose(handle);
      handle.kill('SIGKILL');
      // The stubbed tree-kill didn't terminate anything; let the job exit the
      // way a taskkill'd one does — a plain non-zero code, no signal.
      await terminate();
      const { code, signal } = await closed;
      // Without the re-stamp this is (1, null) and videoGen discards a finished
      // render as "Exit code 1" instead of honoring the watchdog kill.
      expect(code).toBeNull();
      expect(signal).toBe('SIGKILL');
      expect(handle.exitCode).toBeNull();
      expect(handle.signalCode).toBe('SIGKILL');
    } finally {
      restorePlatform();
    }
  });

  it('win32 leaves a clean exit alone when a cancel races completion', async () => {
    const { handle, terminate } = await spawnMarkerJob(0);
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const closed = onClose(handle);
      handle.kill('SIGTERM');
      await terminate();
      const { code, signal } = await closed;
      expect(code).toBe(0);
      expect(signal).toBeNull();
    } finally {
      restorePlatform();
    }
  });

  it('win32 stamps a numeric signal as its NAME on close', async () => {
    const { handle, terminate } = await spawnMarkerJob();
    const restorePlatform = pinPlatform('win32');
    try {
      const closed = onClose(handle);
      // kill() accepts a number; ChildProcess reports names, so a raw 9 would
      // break every `signal === 'SIGKILL'` comparison downstream.
      handle.kill(9);
      await terminate();
      const { code, signal } = await closed;
      expect(code).toBeNull();
      expect(signal).toBe('SIGKILL');
      expect(handle.signalCode).toBe('SIGKILL');
    } finally {
      restorePlatform();
    }
  });

  it('win32 refuses to tree-kill a job that already exited', async () => {
    const { handle, terminate } = await spawnMarkerJob();
    const restorePlatform = pinPlatform('win32');
    try {
      const closed = onClose(handle);
      await terminate();
      await closed;
      // Windows recycles PIDs, so a late escalation (reapDetached's grace
      // deadline) must not taskkill whatever inherited the number.
      killProcessTree.mockClear();
      expect(handle.kill('SIGKILL')).toBe(false);
      expect(killProcessTree).not.toHaveBeenCalled();
      // ...and the status the supervisor recorded survives the refused kill.
      expect(handle.exitCode).toBe(1);
      expect(handle.signalCode).toBeNull();
    } finally {
      restorePlatform();
    }
  });

  it('win32 treats signal 0 as an existence probe, not a kill', async () => {
    const { handle, terminate } = await spawnMarkerJob();
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const closed = onClose(handle);
      expect(handle.kill(0)).toBe(true);
      expect(killProcessTree).not.toHaveBeenCalled();
      await terminate();
      const { code, signal } = await closed;
      // A probe is not a death: it must not stamp a signal onto the close.
      expect(code).toBe(1);
      expect(signal).toBeNull();
    } finally {
      restorePlatform();
    }
  });

  it('win32 rejects an unknown signal instead of force-killing the tree', async () => {
    const { handle, terminate } = await spawnMarkerJob();
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const closed = onClose(handle);
      // ChildProcess.kill() throws ERR_UNKNOWN_SIGNAL on a typo'd name; the
      // handle must not turn that into a silent whole-tree force-kill.
      expect(() => handle.kill('SIGKLL')).toThrow(/Unknown signal/);
      expect(killProcessTree).not.toHaveBeenCalled();
      await terminate();
      await closed;
    } finally {
      restorePlatform();
    }
  });

  // The convergence itself (#6170): on a real Windows host, a cancel must take
  // the job's OWN descendants with it — the ffmpeg mux a video runtime shells
  // out to, the pip a trainer launches. `process.kill(pid)` there terminates the
  // job leaf and orphans them still holding the output file and GPU memory,
  // which is exactly why the supervisor path used to be opt-in. Needs the REAL
  // killProcessTree, so restore it for this one call.
  //
  // The runner is POWERSHELL, not node: libuv assigns a Node-spawned child to a
  // job object that closes (and kills the child) when its Node parent dies, so a
  // node-parent fixture passes even against a leaf-only kill and asserts
  // nothing. A real trainer/render runner — python, a shell — has no such tie,
  // and its ffmpeg keeps running. That is the orphan under test.
  it.runIf(!IS_POSIX)('cancels a Windows job together with the grandchild it spawned', async () => {
    const { killProcessTree: realKillProcessTree } = await vi.importActual('./bufferedSpawn.js');
    killProcessTree.mockImplementationOnce(realKillProcessTree);

    const controlDir = await tmpControlDir();
    const grandchildPidFile = join(controlDir, 'grandchild-pid');
    const heartbeat = join(controlDir, 'heartbeat');
    const grandchildPath = join(controlDir, 'grandchild.cjs');
    const runnerPath = join(controlDir, 'runner.ps1');
    // A heartbeat file rather than a pid probe: on Windows a terminated process
    // stays openable while any handle to it is alive, so `kill(pid, 0)` can
    // still answer for a process that is gone. Output that STOPS is unambiguous.
    await writeFile(grandchildPath, [
      "const { appendFileSync } = require('fs');",
      "setInterval(() => appendFileSync(process.env.PORTOS_TEST_HEARTBEAT, 'x'), 20);",
    ].join('\n'));
    // The paths reach the grandchild through the environment, not argv: Windows
    // PowerShell 5.1's `Start-Process -ArgumentList` joins its array on spaces
    // without quoting, so a temp path under a user name containing a space
    // would silently split.
    await writeFile(runnerPath, [
      'param([string]$NodeExe, [string]$ScriptPath, [string]$PidFile, [string]$Heartbeat)',
      '$env:PORTOS_TEST_HEARTBEAT = $Heartbeat',
      '$g = Start-Process -FilePath $NodeExe -ArgumentList @((\'"\' + $ScriptPath + \'"\')) -PassThru -NoNewWindow',
      'Set-Content -LiteralPath $PidFile -Value $g.Id',
      'while ($true) { Start-Sleep -Milliseconds 200 }',
    ].join('\n'));

    const handle = await spawnDetached(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runnerPath,
        process.execPath, grandchildPath, grandchildPidFile, heartbeat],
      { controlDir, pollMs: 25 }
    );
    const closed = onClose(handle);

    const beats = async () => (await readFile(heartbeat, 'utf8').catch(() => '')).length;
    // Two powershell hops plus a Start-Process, so this is slower than the
    // node-only fixtures above.
    expect(await waitUntil(async () => (await beats()) > 0, { timeoutMs: 30000 })).toBe(true);
    const grandchildPid = Number.parseInt(await readFile(grandchildPidFile, 'utf8'), 10);
    expect(grandchildPid).toBeGreaterThan(0);

    try {
      expect(handle.kill('SIGKILL')).toBe(true);
      await closed;
      // Stopped writing — a leaf-only kill leaves it beating forever.
      const settled = await waitUntil(async () => {
        const before = await beats();
        await new Promise((r) => setTimeout(r, 150));
        return (await beats()) === before;
      }, { timeoutMs: 10000 });
      expect(settled).toBe(true);
    } finally {
      // Never leave a real orphan behind when the assertion above is what failed.
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it.runIf(IS_POSIX)('leaves the POSIX path on its own pid/group signalling (no tree-kill)', async () => {
    killProcessTree.mockClear();
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir, pollMs: 25 });
    // Attach the close listener BEFORE killing — the tail loop can fire 'close'
    // as soon as the signal lands.
    const closed = onClose(handle);
    await waitUntil(() => aliveByPs(handle.pid));
    expect(handle.kill('SIGKILL')).toBe(true);
    expect(killProcessTree).not.toHaveBeenCalled();
    await closed;
  });

  describe('reapDetached', () => {
    it.runIf(IS_POSIX)('SIGTERMs a surviving orphan and reports it reaped', async () => {
      const controlDir = await tmpControlDir();
      const handle = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir, pollMs: 25 });
      const pid = handle.pid;
      expect(pid).toBeGreaterThan(0);
      // Attach the close listener BEFORE reaping — the killed sleeper writes
      // exit and the handle's own tail loop can fire 'close' before reap returns.
      const closed = onClose(handle);
      await waitUntil(() => aliveByPs(pid));
      const res = await reapDetached(controlDir, { graceMs: 3000, pollMs: 25 });
      expect(res.reaped).toBe(true);
      expect(res.pid).toBe(pid);
      expect(await aliveByPs(pid)).toBe(false);
      await closed;
    });

    it('is a no-op when the job already recorded an exit', async () => {
      const controlDir = await tmpControlDir();
      const handle = await spawnDetached('sh', ['-c', 'exit 0'], { controlDir, pollMs: 25 });
      await onClose(handle);
      const res = await reapDetached(controlDir, { graceMs: 200, pollMs: 25 });
      expect(res.reaped).toBe(false);
    });

    it('is a no-op when no pid was ever recorded', async () => {
      const controlDir = await tmpControlDir();
      const res = await reapDetached(controlDir, { graceMs: 200, pollMs: 25 });
      expect(res.reaped).toBe(false);
    });
  });

  describe('reapAndCleanDetachedDirs', () => {
    it.runIf(IS_POSIX)('reaps every surviving orphan under the parent and removes the dirs', async () => {
      const parent = await tmpControlDir();
      const a = join(parent, 'job-a');
      const b = join(parent, 'job-b');
      const hA = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir: a, pollMs: 25 });
      const hB = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir: b, pollMs: 25 });
      const closedA = onClose(hA);
      const closedB = onClose(hB);
      await waitUntil(async () => (await aliveByPs(hA.pid)) && (await aliveByPs(hB.pid)));
      // pollMs matches the per-job cadence the rest of this suite spawns with;
      // the default 250ms sentinel poll costs a quarter-second per dir here.
      const res = await reapAndCleanDetachedDirs(parent, { pollMs: 25 });
      expect(res.reaped).toBe(2);
      expect(res.scanned).toBe(2);
      expect(await stat(a).then(() => true).catch(() => false)).toBe(false);
      expect(await stat(b).then(() => true).catch(() => false)).toBe(false);
      await Promise.all([closedA, closedB]);
    });

    it('returns zero for a missing or empty parent', async () => {
      const parent = await tmpControlDir();
      const res = await reapAndCleanDetachedDirs(join(parent, 'does-not-exist'));
      expect(res).toEqual({ reaped: 0, scanned: 0 });
    });
  });
});

describe('isReattachable', () => {
  it.runIf(IS_POSIX)('is true while the recorded child is still alive', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir, pollMs: 25 });
    expect(await isReattachable(controlDir)).toBe(true);
    handle.kill('SIGKILL');
    await onClose(handle);
  });

  it.runIf(IS_POSIX)('is true after the child exited (RESULT line still unprocessed on disk)', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'printf "x\\n"; exit 0'], { controlDir, pollMs: 25 });
    await onClose(handle);
    expect(await isReattachable(controlDir)).toBe(true);
  });

  it('is false when no pid was ever recorded', async () => {
    const controlDir = await tmpControlDir();
    expect(await isReattachable(controlDir)).toBe(false);
  });

  it('is false for a dead pid with no exit sentinel (killed mid-run)', async () => {
    const controlDir = await tmpControlDir();
    // A reparented-then-tree-killed orphan: pid recorded, never alive again,
    // and the supervisor never got to write `exit`. PID 2^31-1 is never live.
    await writeFile(join(controlDir, 'pid'), '2147483647');
    expect(await isReattachable(controlDir)).toBe(false);
  });
});

describe('isDetachedRunning', () => {
  it.each(['<defunct>', 'bash <defunct>', '[bash] <defunct>', 'bash <exiting>'])(
    'keeps a zombie PID blocked until its supervisor writes the exit sentinel: %s',
    (command) => {
      expect(__detachedSpawnTesting.processCommandMatches(command, {
        executable: 'bash',
        args: ['/example/update.sh']
      })).toBe(true);
    }
  );

  it.runIf(IS_POSIX)('is true while the recorded child is still alive with no exit sentinel', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir, pollMs: 25 });
    expect(await isDetachedRunning(controlDir)).toBe(true);
    handle.kill('SIGKILL');
    await onClose(handle);
  });

  it.runIf(IS_POSIX)('is true when the live process matches the expected executable', async () => {
    const controlDir = await tmpControlDir();
    await writeFile(join(controlDir, 'pid'), String(process.pid));
    expect(await isDetachedRunning(controlDir, { executable: basename(process.execPath) })).toBe(true);
  });

  it.runIf(IS_POSIX)('is false when a recycled live PID belongs to another process', async () => {
    const controlDir = await tmpControlDir();
    await writeFile(join(controlDir, 'pid'), String(process.pid));
    expect(await isDetachedRunning(controlDir, {
      executable: 'bash',
      args: ['/example/update.sh']
    })).toBe(false);
  });

  it('is false once the job recorded its exit', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'exit 0'], { controlDir, pollMs: 25 });
    await onClose(handle);
    expect(await isDetachedRunning(controlDir)).toBe(false);
  });

  it('is false when no pid was ever recorded', async () => {
    const controlDir = await tmpControlDir();
    expect(await isDetachedRunning(controlDir)).toBe(false);
  });

  it('is false for a dead pid with no exit sentinel', async () => {
    const controlDir = await tmpControlDir();
    await writeFile(join(controlDir, 'pid'), '2147483647');
    expect(await isDetachedRunning(controlDir)).toBe(false);
  });

  // Callers treat `false` as permission to act (spawn a second update, purge the
  // job's directory), so an unreadable control file must surface rather than
  // masquerade as "never launched" (#3342).
  it('rejects when a control file exists but cannot be read', async () => {
    const controlDir = await tmpControlDir();
    // A directory where the file belongs reads back EISDIR, not ENOENT — and
    // unlike chmod it behaves the same when the suite runs as root.
    await mkdir(join(controlDir, 'pid'), { recursive: true });
    await expect(isDetachedRunning(controlDir)).rejects.toThrow();
  });
});

describe.runIf(IS_POSIX)('reattachDetached', () => {
  it('replays a still-running survivor from the start and closes with its exit code', async () => {
    const controlDir = await tmpControlDir();
    const release = join(controlDir, 'go');
    // early output, then a pause the TEST releases, then late output + a
    // non-zero exit.
    const original = await spawnDetached(
      'sh', ['-c', `printf "early\\n"; ${blockUntil(release)}; printf "late\\n"; exit 5`],
      { controlDir, pollMs: 25 }
    );
    // Attach the original's close listener NOW (before it can fire) — 'close' is
    // one-shot, so a listener added after the child exits would never resolve.
    const originalClosed = onClose(original);
    // Let "early" land on disk, then re-attach as if the server had restarted.
    await waitUntil(async () => (await readStdoutLog(controlDir)).includes('early'));
    const reattached = await reattachDetached(controlDir, { pollMs: 25 });
    expect(reattached).not.toBeNull();
    expect(reattached.pid).toBe(original.pid);
    const getOut = collect(reattached.stdout);
    await writeFile(release, '1');
    const { code, signal } = await onClose(reattached);
    // The re-attached tailer reads from offset 0, so it sees the FULL output —
    // including bytes written before it attached — and the terminal exit code.
    expect(getOut()).toBe('early\nlate\n');
    expect(code).toBe(5);
    expect(signal).toBeNull();
    await originalClosed.catch(() => {});
  });

  it('recovers a job that FINISHED during the downtime (replays its result + close)', async () => {
    const controlDir = await tmpControlDir();
    const original = await spawnDetached('sh', ['-c', 'printf "RESULT:ok\\n"; exit 0'], { controlDir, pollMs: 25 });
    await onClose(original); // job already exited before we re-attach
    const reattached = await reattachDetached(controlDir, { pollMs: 25 });
    expect(reattached).not.toBeNull();
    const getOut = collect(reattached.stdout);
    const { code } = await onClose(reattached);
    expect(getOut()).toBe('RESULT:ok\n');
    expect(code).toBe(0);
  });

  it('emits a one-time "replayed" signal once the initial backlog is drained', async () => {
    const controlDir = await tmpControlDir();
    const release = join(controlDir, 'go');
    const original = await spawnDetached(
      'sh', ['-c', `printf "h1\\nh2\\n"; ${blockUntil(release)}; printf "live\\n"; exit 0`],
      { controlDir, pollMs: 25 }
    );
    const originalClosed = onClose(original);
    // let the backlog (h1/h2) land
    await waitUntil(async () => (await readStdoutLog(controlDir)).includes('h2'));
    const reattached = await reattachDetached(controlDir, { pollMs: 25 });
    const getOut = collect(reattached.stdout);
    let replayedCount = 0;
    let outAtReplayed = null;
    const replayed = new Promise((resolve) => {
      reattached.on('replayed', () => { replayedCount += 1; outAtReplayed = getOut(); resolve(); });
    });
    // Release "live" only once the replay boundary has been observed. The old
    // `sleep 1` made that ordering a race the test happened to win; gating on
    // the event makes it the thing the fixture guarantees.
    await replayed;
    await writeFile(release, '1');
    const { code } = await onClose(reattached);
    // 'replayed' fires exactly once, AFTER the pre-existing backlog was emitted
    // but BEFORE the post-restart "live" line — that's the boundary the stall
    // detector uses to avoid arming on instantly-replayed step history.
    expect(replayedCount).toBe(1);
    expect(outAtReplayed).toBe('h1\nh2\n');
    expect(getOut()).toBe('h1\nh2\nlive\n');
    expect(code).toBe(0);
    await originalClosed.catch(() => {});
  });

  it('returns null when there is no pid to attach to', async () => {
    const controlDir = await tmpControlDir();
    expect(await reattachDetached(controlDir, { pollMs: 25 })).toBeNull();
  });

  it('returns null for a dead pid with no exit sentinel', async () => {
    const controlDir = await tmpControlDir();
    await writeFile(join(controlDir, 'pid'), '2147483647');
    expect(await reattachDetached(controlDir, { pollMs: 25 })).toBeNull();
  });

  it('can SIGTERM the survivor through the re-attached handle', async () => {
    const controlDir = await tmpControlDir();
    const original = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir, pollMs: 25 });
    // Attach before the kill — the shared child's death closes BOTH handles, and
    // 'close' is one-shot, so the original's listener has to be wired up front.
    const originalClosed = onClose(original);
    await waitUntil(() => aliveByPs(original.pid));
    const reattached = await reattachDetached(controlDir, { pollMs: 25 });
    const closed = onClose(reattached);
    expect(reattached.kill('SIGTERM')).toBe(true);
    const { signal } = await closed;
    expect(signal).toBe('SIGTERM');
    await originalClosed.catch(() => {});
  });
});
