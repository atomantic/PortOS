import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _demucsRuntimePlan, ensureDemucsRuntime } from './demucsRuntime.js';

const dirs = [];
const freshDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demucs-lock-test-'));
  dirs.push(dir);
  return dir;
};
const pythonAt = (dir) => join(dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const nativePlan = () => _demucsRuntimePlan({ platform: 'darwin', arch: 'arm64', appleSilicon: true, darwinMajor: 23 });
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('Demucs locked provisioning boundary', () => {
  it.each([
    { platform: 'darwin', arch: 'x64', appleSilicon: false, darwinMajor: 23 },
    { platform: 'darwin', arch: 'arm64', appleSilicon: true, darwinMajor: 22 },
    { platform: 'linux', arch: 'arm64' },
  ])('refuses an unrepresented host before any subprocess: %j', async (host) => {
    const run = vi.fn();
    const resolveBasePython = vi.fn();
    await expect(ensureDemucsRuntime({ plan: _demucsRuntimePlan(host), run, resolveBasePython }))
      .rejects.toMatchObject({ code: 'DEMUCS_UNSUPPORTED_PROFILE' });
    expect(run).not.toHaveBeenCalled();
    expect(resolveBasePython).not.toHaveBeenCalled();
  });

  it('preserves an old runtime when no compatible interpreter is available', async () => {
    const dir = await freshDir();
    await mkdir(dirname(pythonAt(dir)), { recursive: true });
    await writeFile(pythonAt(dir), 'legacy');
    const run = vi.fn(async () => ({ success: false }));
    await expect(ensureDemucsRuntime({ dir, plan: nativePlan(), run, resolveBasePython: async () => '/python3.12' }))
      .rejects.toMatchObject({ code: 'DEMUCS_PYTHON_MISSING' });
    expect(run.mock.calls[0][1][1]).toContain("assert sys.implementation.name == 'cpython'");
    expect(await readFile(pythonAt(dir), 'utf8')).toBe('legacy');
    expect(run.mock.calls.some(([, args]) => args.includes('venv'))).toBe(false);
  });

  it('rebuilds an importable legacy venv, shares provisioning, and retries a failed hash install without stamping it', async () => {
    const dir = await freshDir();
    await mkdir(dirname(pythonAt(dir)), { recursive: true });
    await writeFile(pythonAt(dir), 'legacy');
    const plan = nativePlan();
    let rejectInstall = true;
    const run = vi.fn(async (_bin, args) => {
      if (args.includes('venv')) await writeFile(pythonAt(dir), 'rebuilt');
      return { success: !args.includes('pip') || !rejectInstall, error: 'hash mismatch' };
    });
    const options = { dir, plan, run, resolveBasePython: async () => '/python3.11' };
    const results = await Promise.allSettled([ensureDemucsRuntime(options), ensureDemucsRuntime(options)]);
    expect(results.every((result) => result.status === 'rejected' && result.reason.code === 'DEMUCS_INSTALL_FAILED')).toBe(true);
    expect(run.mock.calls.filter(([, args]) => args.includes('venv'))).toHaveLength(1);
    expect(existsSync(join(dir, 'portos-lock.sha256'))).toBe(false);
    rejectInstall = false;
    await ensureDemucsRuntime(options);
    expect(await readFile(join(dir, 'portos-lock.sha256'), 'utf8')).toBe(plan.lockId);
    run.mockClear();
    await ensureDemucsRuntime(options);
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0][1][0]).toBe('-c');
  });

  it('cancels one waiter while a second waiter receives progress and the finished runtime', async () => {
    const dir = await freshDir();
    const plan = nativePlan();
    const started = Promise.withResolvers();
    const finished = Promise.withResolvers();
    const run = vi.fn(async (_bin, args, onLine, { signal }) => {
      if (args.includes('pip')) {
        started.resolve({ signal, onLine });
        await finished.promise;
      }
      return { success: true };
    });
    const settings = { dir, plan, run, resolveBasePython: async () => 'python3.11' };
    const first = new AbortController();
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const leaving = ensureDemucsRuntime({ ...settings, signal: first.signal, onProgress: firstProgress });
    const staying = ensureDemucsRuntime({ ...settings, onProgress: secondProgress });
    const { signal, onLine } = await started.promise;

    try {
      first.abort();
      await expect(leaving).rejects.toMatchObject({ name: 'AbortError' });
      expect(signal.aborted).toBe(false);
      firstProgress.mockClear();
      onLine('Downloading fixture wheel');
      expect(firstProgress).not.toHaveBeenCalled();
      expect(secondProgress).toHaveBeenCalledWith({ stage: 'installing', detail: 'Downloading fixture wheel' });
    } finally {
      finished.resolve();
      await expect(staying).resolves.toBe(pythonAt(dir));
    }
    expect(run.mock.calls.filter(([, args]) => args.includes('pip'))).toHaveLength(1);
  });

  it('aborts after the final predicate waiter cancels and waits for child close before retrying', async () => {
    const dir = await freshDir();
    const plan = nativePlan();
    const started = Promise.withResolvers();
    const closed = Promise.withResolvers();
    let canceled = false;
    const run = vi.fn(async (_bin, args, _onLine, { signal }) => {
      if (args.includes('pip') && !canceled) {
        started.resolve(signal);
        await closed.promise;
      }
      return { success: true };
    });
    const settings = { dir, plan, run, resolveBasePython: async () => 'python3.11' };
    const first = new AbortController();
    vi.useFakeTimers();
    try {
      const leavingFirst = ensureDemucsRuntime({ ...settings, signal: first.signal });
      const leavingLast = ensureDemucsRuntime({ ...settings, isCancelled: () => canceled });
      const signal = await started.promise;
      first.abort();
      await expect(leavingFirst).rejects.toMatchObject({ name: 'AbortError' });
      expect(signal.aborted).toBe(false);

      canceled = true;
      const rejected = expect(leavingLast).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(existsSync(join(dir, 'portos-lock.sha256'))).toBe(false);

      const retry = ensureDemucsRuntime(settings);
      await vi.advanceTimersByTimeAsync(0);
      expect(run.mock.calls.filter(([, args]) => args.includes('venv'))).toHaveLength(1);
      closed.resolve();
      await expect(retry).resolves.toBe(pythonAt(dir));
      expect(run.mock.calls.filter(([, args]) => args.includes('venv'))).toHaveLength(2);
      expect(await readFile(join(dir, 'portos-lock.sha256'), 'utf8')).toBe(plan.lockId);
    } finally {
      closed.resolve();
      vi.useRealTimers();
    }
  });
});
