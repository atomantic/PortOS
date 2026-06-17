import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { spawnDetached } from './detachedSpawn.js';

const execFileAsync = promisify(execFile);
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

  it('reparents the job out of the spawner tree (escapes pm2 TreeKill)', async () => {
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

  it('kill() signals the reparented job and surfaces the signal on close', async () => {
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

  it('removes the control dir after the job ends when cleanup is set', async () => {
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

  it('falls back to a plain spawn on win32 (no POSIX sh double-fork)', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
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
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});
