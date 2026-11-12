import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), fetch: vi.fn(), digest: '' }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), readFile: vi.fn(async () => Buffer.from('archive')), writeFile: vi.fn() }));
vi.mock('node:crypto', () => ({ createHash: () => ({ update: () => ({ digest: () => mocks.digest }) }) }));

let previousExitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
  mocks.digest = 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83';
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

// Independently downloaded 0.13.7 archives match both the release's SHA-256
// sidecars and GitHub asset digests: https://github.com/astral-sh/uv/releases/tag/0.13.7
// Exercise the fresh-download boundary: cached-archive mocks missed stale hashes.
it.each([
  ['darwin', 'arm64', 'aarch64-apple-darwin.tar.gz', '81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731'],
  ['darwin', 'x64', 'x86_64-apple-darwin.tar.gz', '20c47e4c1f630b8abaff8c291fa9b9aa300fef92c4fbff95adf198b55287cda7'],
  ['linux', 'arm64', 'aarch64-unknown-linux-gnu.tar.gz', '71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc'],
  ['linux', 'x64', 'x86_64-unknown-linux-gnu.tar.gz', 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83'],
  ['win32', 'x64', 'x86_64-pc-windows-msvc.zip', '0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021'],
])('bootstraps the current release from a verified download on %s/%s', async (platform, arch, artifact, digest) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(process, 'arch', 'get').mockReturnValue(arch);
  mocks.digest = digest;
  readFile.mockResolvedValueOnce(null);
  mocks.fetch.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => Buffer.from('release archive') });

  await import('./setup-reactor.js');

  await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith('✅ Reactor runtime ready'));
  expect(mocks.fetch).toHaveBeenCalledWith(
    `https://github.com/astral-sh/uv/releases/download/0.13.7/uv-${artifact}`,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(mocks.spawn).toHaveBeenCalledTimes(4);
  expect(process.exitCode).toBeUndefined();
});

it('rejects a downloaded archive with the wrong checksum before executing it', async () => {
  mocks.digest = '0'.repeat(64);
  readFile.mockResolvedValueOnce(null);
  mocks.fetch.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => Buffer.from('altered archive') });

  await import('./setup-reactor.js');

  await vi.waitFor(() => expect(process.exitCode).toBe(21));
  expect(mocks.spawn).not.toHaveBeenCalled();
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
