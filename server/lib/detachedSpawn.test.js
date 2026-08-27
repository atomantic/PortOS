import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { ChildProcess, execFile } from './childProcess.js';
import { promisify } from 'util';
import { pinPlatform } from './testHelper.js';
import { killProcessTree } from './bufferedSpawn.js';
import { spawnDetached, reapDetached, reapAndCleanDetachedDirs, reattachDetached, isReattachable, isDetachedRunning, __detachedSpawnTesting } from './detachedSpawn.js';

// Only the win32 fallback's kill() reaches killProcessTree, so stubbing it is
// inert for every POSIX test here — and it lets the win32 test assert the
// delegation on a platform where `taskkill` doesn't exist.
vi.mock('./bufferedSpawn.js', async (importOriginal) => ({
  ...(await importOriginal()),
  killProcessTree: vi.fn(),
}));

const execFileAsync = promisify(execFile);

// spawnDetached's POSIX `sh` double-fork — and with it the whole control-dir
// contract (pid/exit sentinels, reap, re-attach, reparent-to-init survival) —
// does not exist on Windows: that platform takes an explicit plain-spawn
// fallback (see the win32 branch in detachedSpawn.js), where pm2 is
// taskkill-based and surviving a restart is not a guarantee PortOS makes.
// Tests that assert the double-fork mechanism are gated on IS_POSIX rather
// than rewritten, because there is no Windows behavior for them to assert.
// The win32 fallback itself is covered by its own test below.
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
    for (let i = 0; i < 40; i += 1) {
      ancestors = await ancestorsOf(handle.pid);
      if (!ancestors.includes(process.pid)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(ancestors).not.toContain(process.pid);
    handle.kill('SIGKILL');
    await onClose(handle);
  });

  it.runIf(IS_POSIX)('kill() signals the reparented job and surfaces the signal on close', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir, pollMs: 25 });
    expect(handle.pid).toBeGreaterThan(0);
    // Give the launcher a beat to write the PID file and start the sleeper.
    await new Promise((r) => setTimeout(r, 50));
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
    for (let i = 0; i < 80; i += 1) {
      runtimePid = Number.parseInt(getOut().trim(), 10);
      if (runtimePid > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runtimePid).toBeGreaterThan(0);
    expect(await aliveByPs(runtimePid)).toBe(true);
    const closed = onClose(handle);
    expect(handle.kill('SIGKILL')).toBe(true);
    await closed;
    let alive = true;
    for (let i = 0; i < 80; i += 1) {
      alive = await aliveByPs(runtimePid);
      if (!alive) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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
    // finish() schedules the rm after emitting close — give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const present = await stat(controlDir).then(() => true).catch(() => false);
    expect(present).toBe(false);
  });

  it('keeps the control dir by default (logs retained for post-mortem)', async () => {
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'printf "x\\n"; exit 0'], { controlDir, pollMs: 25 });
    await onClose(handle);
    await new Promise((r) => setTimeout(r, 50));
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

  it('falls back to a plain spawn on win32 (no POSIX sh double-fork)', async () => {
    const restorePlatform = pinPlatform('win32');
    try {
      const controlDir = await tmpControlDir();
      // Real `sh` exists on the test runner, so the plain-spawn fallback runs;
      // the point is that it returns a working ChildProcess, not the file-tailed
      // handle. (controlDir is unused on this path but still required.)
      const handle = await spawnDetached('sh', ['-c', 'printf "hi\\n"; exit 0'], { controlDir });
      expect(handle.pid).toBeGreaterThan(0);
      expect(typeof handle.kill).toBe('function');
      const getOut = collect(handle.stdout);
      const { code } = await onClose(handle);
      expect(code).toBe(0);
      expect(getOut()).toBe('hi\n');
    } finally {
      restorePlatform();
    }
  });

  // A child that runs until a marker file appears, then exits with a code and
  // NO signal — the shape `taskkill /T /F` produces on Windows, where the kill
  // happens out of band so libuv records no exit_signal. Driven by `node -e`
  // rather than `sh -c` because these tests are NOT gated on IS_POSIX: they
  // pin the platform and must run on a real Windows checkout, which has no
  // guaranteed POSIX shell.
  const spawnWin32Fallback = async (exitCode = 1) => {
    const controlDir = await tmpControlDir();
    const marker = join(controlDir, 'go');
    const handle = await spawnDetached(
      process.execPath,
      ['-e', `const {existsSync}=require('fs');const t=setInterval(()=>{if(existsSync(process.argv[1])){clearInterval(t);process.exit(${exitCode});}},25);`, marker],
      { controlDir }
    );
    return { handle, terminate: () => writeFile(marker, '1') };
  };

  it('win32 fallback kill() tree-kills so the runner\'s children die with it', async () => {
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const { handle, terminate } = await spawnWin32Fallback();
      const closed = onClose(handle);
      expect(handle.kill('SIGKILL')).toBe(true);
      expect(handle.killed).toBe(true);
      expect(killProcessTree).toHaveBeenCalledTimes(1);
      const [target, signal, opts] = killProcessTree.mock.calls[0];
      expect(signal).toBe('SIGKILL');
      expect(opts).toEqual({ processGroup: true });
      // The target must still be a real ChildProcess — killProcessTree's
      // `taskkill /T /F` branch is gated on `instanceof ChildProcess` — and must
      // carry Node's own kill, not the override, so its POSIX fall-through
      // can't recurse back into it.
      expect(target).toBeInstanceOf(ChildProcess);
      expect(target.pid).toBe(handle.pid);
      expect(target.kill).not.toBe(handle.kill);
      await terminate();
      await closed;
    } finally {
      restorePlatform();
    }
  });

  it('win32 fallback reports the requested signal on close (taskkill kills out of band)', async () => {
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const { handle, terminate } = await spawnWin32Fallback();
      const closed = onClose(handle);
      handle.kill('SIGKILL');
      // The stubbed tree-kill didn't terminate anything; let the child exit the
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

  it('win32 fallback leaves a clean exit alone when a cancel races completion', async () => {
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const { handle, terminate } = await spawnWin32Fallback(0);
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

  it('win32 fallback stamps a numeric signal as its NAME on close', async () => {
    const restorePlatform = pinPlatform('win32');
    try {
      const { handle, terminate } = await spawnWin32Fallback();
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

  it('win32 fallback refuses to tree-kill a child that already exited', async () => {
    const restorePlatform = pinPlatform('win32');
    try {
      const { handle, terminate } = await spawnWin32Fallback();
      const closed = onClose(handle);
      await terminate();
      await closed;
      // Windows recycles PIDs, so a late escalation must not taskkill whatever
      // inherited the number.
      killProcessTree.mockClear();
      expect(handle.kill('SIGKILL')).toBe(false);
      expect(killProcessTree).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('win32 fallback treats signal 0 as an existence probe, not a kill', async () => {
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const { handle, terminate } = await spawnWin32Fallback();
      const closed = onClose(handle);
      // Node's own kill(0) answers the probe (and sets `killed`, as it always
      // has); what matters is that no taskkill went out.
      expect(handle.kill(0)).toBe(true);
      expect(killProcessTree).not.toHaveBeenCalled();
      await terminate();
      await closed;
    } finally {
      restorePlatform();
    }
  });

  it('win32 fallback rejects an unknown signal instead of force-killing the tree', async () => {
    const restorePlatform = pinPlatform('win32');
    try {
      killProcessTree.mockClear();
      const { handle, terminate } = await spawnWin32Fallback();
      const closed = onClose(handle);
      // ChildProcess.kill() throws ERR_UNKNOWN_SIGNAL on a typo'd name; the
      // override must not turn that into a silent whole-tree force-kill.
      expect(() => handle.kill('SIGKLL')).toThrow();
      expect(killProcessTree).not.toHaveBeenCalled();
      await terminate();
      await closed;
    } finally {
      restorePlatform();
    }
  });

  it.runIf(IS_POSIX)('leaves the POSIX path on its own pid/group signalling (no tree-kill)', async () => {
    killProcessTree.mockClear();
    const controlDir = await tmpControlDir();
    const handle = await spawnDetached('sh', ['-c', 'sleep 30'], { controlDir, pollMs: 25 });
    // Attach the close listener BEFORE killing — the tail loop can fire 'close'
    // as soon as the signal lands.
    const closed = onClose(handle);
    await new Promise((r) => setTimeout(r, 50));
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
      await new Promise((r) => setTimeout(r, 50));
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
      await new Promise((r) => setTimeout(r, 50));
      const res = await reapAndCleanDetachedDirs(parent);
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
    // early output, then a beat, then late output + a non-zero exit.
    const original = await spawnDetached(
      'sh', ['-c', 'printf "early\\n"; sleep 1; printf "late\\n"; exit 5'],
      { controlDir, pollMs: 25 }
    );
    // Attach the original's close listener NOW (before it can fire) — 'close' is
    // one-shot, so a listener added after the child exits would never resolve.
    const originalClosed = onClose(original);
    // Let "early" land on disk, then re-attach as if the server had restarted.
    await new Promise((r) => setTimeout(r, 150));
    const reattached = await reattachDetached(controlDir, { pollMs: 25 });
    expect(reattached).not.toBeNull();
    expect(reattached.pid).toBe(original.pid);
    const getOut = collect(reattached.stdout);
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
    const original = await spawnDetached(
      'sh', ['-c', 'printf "h1\\nh2\\n"; sleep 1; printf "live\\n"; exit 0'],
      { controlDir, pollMs: 25 }
    );
    const originalClosed = onClose(original);
    await new Promise((r) => setTimeout(r, 200)); // let the backlog (h1/h2) land
    const reattached = await reattachDetached(controlDir, { pollMs: 25 });
    const getOut = collect(reattached.stdout);
    let replayedCount = 0;
    let outAtReplayed = null;
    reattached.on('replayed', () => { replayedCount += 1; outAtReplayed = getOut(); });
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
    await new Promise((r) => setTimeout(r, 100));
    const reattached = await reattachDetached(controlDir, { pollMs: 25 });
    const closed = onClose(reattached);
    expect(reattached.kill('SIGTERM')).toBe(true);
    const { signal } = await closed;
    expect(signal).toBe('SIGTERM');
    await originalClosed.catch(() => {});
  });
});
