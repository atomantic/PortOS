import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_PROFILES } from './pythonLockProfiles.js';

const mock = vi.hoisted(() => ({ spawn: vi.fn(), ensureUv: vi.fn(), ambientUv: vi.fn(() => '/ambient/bin/uv') }));
vi.mock('./childProcess.js', async (original) => ({ ...await original(), spawn: mock.spawn }));
vi.mock('./processEnv.js', async (original) => ({ ...await original(), whichFirstSync: mock.ambientUv }));
vi.mock('./privateUv.js', async (original) => ({ ...await original(), ensurePrivateUv: mock.ensureUv }));
const { installLockedRuntime, installPackages } = await import('./pythonSetup.js');

const forced = [];
const spawned = () => mock.spawn.mock.calls.map(([bin, args]) => [bin, ...args].join(' '));

beforeEach(() => {
  mock.ambientUv.mockClear();
  mock.ensureUv.mockReset().mockResolvedValue({ ok: true, uv: '/private/tools/uv' });
  forced.length = 0;
  mock.spawn.mockReset().mockImplementation((_bin, args) => {
    // The one-entry requirements file is removed once the install ends; capture it live.
    if (args.includes('--force-reinstall')) forced.push(readFileSync(args.at(-1), 'utf8'));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => child.emit('close', null));
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
});

describe('installLockedRuntime', () => {
  it('installs the profile closure with --require-hashes --no-deps through the private uv, never a PATH uv', async () => {
    const onLog = vi.fn();
    await expect(installLockedRuntime('/guard/python', 'guard-runtime', onLog, { preferUv: true, platform: 'linux', arch: 'x64' }).promise)
      .resolves.toEqual({ ok: true, code: 0 });
    expect(spawned()).toEqual([`/private/tools/uv pip install --python /guard/python --require-hashes --no-deps -r ${LOCK_PROFILES['guard-runtime'].lockFile}`]);
    expect(mock.ambientUv).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'complete' }));
  });

  it('falls back to hash-checked pip, still without resolution, when no patched private uv can be had', async () => {
    mock.ensureUv.mockResolvedValue({ ok: false, reason: 'No Python found to bootstrap uv 0.13.6.' });
    const onLog = vi.fn();
    await installLockedRuntime('/guard/python', 'guard-runtime', onLog, { preferUv: true, platform: 'darwin', arch: 'arm64' }).promise;
    expect(spawned()).toEqual([`/guard/python -m pip install --require-hashes --no-deps -r ${LOCK_PROFILES['guard-runtime'].lockFile}`]);
    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Using pip instead') }));
  });

  it('reports an unsupported host before running anything', async () => {
    const onLog = vi.fn();
    const result = await installLockedRuntime('/guard/python', 'guard-runtime', onLog, { preferUv: true, platform: 'darwin', arch: 'x64' }).promise;
    expect(result).toMatchObject({ ok: false, unsupported: true });
    expect(onLog).toHaveBeenCalledWith({ type: 'error', message: expect.stringMatching(/no hash-pinned lock for darwin\/x64.*does not resolve unlocked packages/) });
    expect(mock.spawn).not.toHaveBeenCalled();
    expect(mock.ensureUv).not.toHaveBeenCalled();
  });

  it('surfaces an installer failure code and stops on kill', async () => {
    mock.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('close', 2));
      return child;
    });
    const onLog = vi.fn();
    await expect(installLockedRuntime('/guard/python', 'guard-runtime', onLog, { platform: 'linux', arch: 'arm64' }).promise).resolves.toEqual({ ok: false, code: 2 });
    expect(onLog).toHaveBeenLastCalledWith({ type: 'error', message: 'pip exited with code 2' });
  });
});

describe('installPackages generic repair', () => {
  it('on Apple Silicon repairs mflux-owned packages from the hash-pinned lock, never by bare name', async () => {
    await installPackages('/image/python', ['mflux', 'transformers', 'opencv-python'], vi.fn(), { appleSilicon: true }).promise;
    const calls = spawned();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(new RegExp(`^/image/python -m pip install (--user )?--require-hashes --no-deps -r .*requirements-mflux-mlx\\.lock\\.txt$`));
    expect(calls[0]).not.toContain('--upgrade');
  });

  it('dispatches mlx_vlm / mlx_video repair to the video lock, restoring the real package after removing the wrong namesake', async () => {
    await installPackages('/image/python', ['mlx-video-with-audio>=0.1.35', 'mlx_vlm', 'mflux'], vi.fn(), { appleSilicon: true }).promise;
    const calls = spawned();
    expect(calls[0]).toBe('/image/python -m pip uninstall --yes mlx_video');
    // Uninstalling the namesake can delete files the real package shares; only that entry is force-reinstalled.
    expect(calls[1]).toMatch(/^\/image\/python -m pip install (--user )?--force-reinstall --require-hashes --no-deps -r .*requirements\.txt$/);
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatch(/^mlx-video-with-audio==[\d.]+ ;/);
    expect(forced[0]).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    expect(forced[0].match(/^[A-Za-z0-9][\w.-]*==/gm)).toHaveLength(1);
    expect(calls[2]).toMatch(/--require-hashes --no-deps -r .*requirements-mflux-video-mlx\.lock\.txt$/);
    expect(calls).toHaveLength(3);
  });

  it('does not start any package subprocess when cancelled while the private uv is still bootstrapping', async () => {
    let finishUv;
    mock.ensureUv.mockReturnValue(new Promise((resolve) => { finishUv = resolve; }));
    const install = installPackages('/image/python', ['mflux'], vi.fn(), { appleSilicon: true, preferUv: true });
    install.kill();
    finishUv({ ok: true, uv: '/private/tools/uv' });
    await expect(install.promise).resolves.toEqual({ ok: false, code: -1 });
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it('uses the private uv for preferUv repairs', async () => {
    await installPackages('/image/python', ['mflux'], vi.fn(), { appleSilicon: true, preferUv: true }).promise;
    expect(spawned()).toEqual([`/private/tools/uv pip install --python /image/python --require-hashes --no-deps -r ${LOCK_PROFILES.mflux.lockFile}`]);
    expect(mock.ambientUv).not.toHaveBeenCalled();
  });

  it.each([
    ['an unlocked package next to locked ones on Apple Silicon', ['mflux', 'diffusers'], true, /diffusers/],
    ['any package on a host without a repair lock', ['numpy', 'torch'], false, /numpy.*torch/],
  ])('rejects unconstrained fallback resolution for %s before running anything', async (_label, names, appleSilicon, detail) => {
    const onLog = vi.fn();
    const result = await installPackages('/image/python', names, onLog, { appleSilicon, preferUv: true }).promise;
    expect(result).toMatchObject({ ok: false, unresolved: expect.any(Array) });
    expect(onLog).toHaveBeenCalledWith({ type: 'error', message: expect.stringMatching(new RegExp(`^Unsupported repair profile: .*${detail.source}`)) });
    expect(mock.spawn).not.toHaveBeenCalled();
    expect(mock.ensureUv).not.toHaveBeenCalled();
  });
});
