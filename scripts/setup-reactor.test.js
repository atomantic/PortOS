import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), fetch: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), readFile: vi.fn(async () => Buffer.from('archive')), writeFile: vi.fn() }));
vi.mock('node:crypto', () => ({ createHash: () => ({ update: () => ({ digest: () => 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645' }) }) }));

let previousExitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.spawn.mockReturnValue({ status: 0 });
});
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  [1, 22, 'archive extraction'],
  [2, 23, 'Python environment preparation'],
  [3, 24, 'SDK installation'],
  [4, 25, 'SDK verification'],
])('reports failing setup command %i without exposing subprocess diagnostics', async (step, code, message) => {
  for (let i = 1; i < step; i++) mocks.spawn.mockReturnValueOnce({ status: 0 });
  mocks.spawn.mockReturnValueOnce({ status: 2, stderr: 'private proxy credentials', error: new Error('private local path') });
  await import('./setup-reactor.js');
  await vi.waitFor(() => expect(process.exitCode).toBe(code));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining(message));
  expect(console.error.mock.calls.flat().join(' ')).not.toContain('private');
  expect(mocks.spawn).toHaveBeenCalledTimes(step);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it('finishes all setup steps when the runtime is installed successfully', async () => {
  await import('./setup-reactor.js');
  await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith('✅ Reactor runtime ready'));
  expect(mocks.spawn).toHaveBeenCalledTimes(4);
  expect(process.exitCode).toBeUndefined();
});

it('reports a runtime-manager connection failure without its private URL', async () => {
  readFile.mockResolvedValueOnce(null);
  mocks.fetch.mockRejectedValueOnce(new Error('private proxy URL'));
  await import('./setup-reactor.js');
  await vi.waitFor(() => expect(process.exitCode).toBe(20));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('runtime manager download failed'));
  expect(console.error.mock.calls.flat().join(' ')).not.toContain('private');
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('redacts unexpected filesystem errors from command-line setup', async () => {
  mkdir.mockRejectedValueOnce(Object.assign(new Error('private local path'), { code: 'EACCES' }));
  await import('./setup-reactor.js');
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(console.error.mock.calls.flat().join(' ')).not.toContain('private');
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('installs only from the hash-pinned lock, never by resolving the direct pin', async () => {
  await import('./setup-reactor.js');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(4));
  const install = mocks.spawn.mock.calls[2][1];
  expect(install).toEqual(expect.arrayContaining(['--require-hashes', '--no-deps', '--only-binary', ':all:']));
  expect(install.at(-1)).toMatch(/requirements-reactor\.lock\.txt$/);
  expect(install).not.toContain(expect.stringMatching(/requirements-reactor\.txt$/));
});

it('locks the direct reactor-sdk pin with a hash and bootstraps a patched uv', () => {
  const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
  const pin = read('./requirements-reactor.txt').match(/^reactor-sdk==([0-9.]+)/m)[1];
  const lock = read('./requirements-reactor.lock.txt');
  expect(lock).toContain(`reactor-sdk==${pin} ;`);
  expect(lock).toMatch(/--hash=sha256:[0-9a-f]{64}/);
  // GHSA-hq85-5cpj-mr62 (compromised CA, wheel extraction) is fixed in uv 0.13.4.
  const [major, minor, patch] = read('./setup-reactor.js').match(/const version = '(\d+\.\d+\.\d+)'/)[1].split('.').map(Number);
  expect(major > 0 || minor > 13 || (minor === 13 && patch >= 4)).toBe(true);
});
