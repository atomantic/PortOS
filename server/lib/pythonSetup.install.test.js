import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ spawn: vi.fn(), uv: null }));
vi.mock('./childProcess.js', async (original) => ({ ...await original(), spawn: mock.spawn }));
vi.mock('./processEnv.js', async (original) => ({ ...await original(), whichFirstSync: () => mock.uv }));
const { installPackages } = await import('./pythonSetup.js');

beforeEach(() => {
  mock.uv = null;
  mock.spawn.mockReset().mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => child.emit('close', null));
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
});

it('uses uv only when requested and present, keeping the dedicated interpreter and pins', async () => {
  mock.uv = '/tools/uv';
  await expect(installPackages('/guard/python', ['torch==2.14.0'], vi.fn(), { preferUv: true }).promise).resolves.toEqual({ ok: true, code: 0 });
  expect(mock.spawn).toHaveBeenLastCalledWith('/tools/uv', ['pip', 'install', '--python', '/guard/python', '--upgrade', 'torch==2.14.0'], expect.any(Object));
  await installPackages('/image/python', ['torch'], vi.fn()).promise;
  expect(mock.spawn.mock.calls.at(-1)[0]).toBe('/image/python');
  mock.uv = null;
  await installPackages('/guard/python', ['torch==2.14.0'], vi.fn(), { preferUv: true }).promise;
  expect(mock.spawn).toHaveBeenLastCalledWith('/guard/python', ['-m', 'pip', 'install', '--upgrade', '--progress-bar', 'on', 'torch==2.14.0'], expect.any(Object));
});

it('on Apple Silicon repairs mflux-owned packages from the hash-pinned lock, never by bare name', async () => {
  await installPackages('/image/python', ['mflux', 'transformers', 'mlx_vlm'], vi.fn(), { appleSilicon: true }).promise;
  const calls = mock.spawn.mock.calls.map(([, args]) => args.join(' '));
  const lock = calls.find((c) => c.includes('--require-hashes'));
  expect(lock).toMatch(/--no-deps -r .*requirements-mflux-mlx\.lock\.txt$/);
  const named = calls.find((c) => c.includes('--upgrade'));
  expect(named).toContain('mlx_vlm');
  expect(named).not.toMatch(/mflux|transformers/);
});

it('off Apple Silicon keeps the by-name install', async () => {
  await installPackages('/image/python', ['numpy'], vi.fn(), { appleSilicon: false }).promise;
  expect(mock.spawn.mock.calls.at(-1)[1]).toEqual(['-m', 'pip', 'install', '--upgrade', '--progress-bar', 'on', 'numpy']);
});
