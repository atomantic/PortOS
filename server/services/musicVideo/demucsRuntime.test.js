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
});
