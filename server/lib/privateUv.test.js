import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ execFile: vi.fn(), exists: true }));
vi.mock('./childProcess.js', () => ({ execFile: (...args) => mock.execFile(...args) }));
vi.mock('node:fs', async (original) => ({ ...await original(), existsSync: () => mock.exists }));
vi.mock('node:os', async (original) => ({ ...await original(), homedir: () => '/home/example', platform: () => 'linux' }));
const { MIN_PATCHED_UV, PRIVATE_UV_VERSION, ensurePrivateUv, privateUvPath } = await import('./privateUv.js');

const answer = (stdout = '') => (...args) => args.at(-1)(null, { stdout, stderr: '' });
const calls = () => mock.execFile.mock.calls.map(([bin, args]) => [bin, ...args].join(' '));

beforeEach(() => {
  mock.exists = true;
  mock.execFile.mockReset();
});

describe('private patched uv', () => {
  it('pins a release at or above the CA / wheel-extraction fix floor', () => {
    const [major, minor, patch] = PRIVATE_UV_VERSION.split('.').map(Number);
    expect(major > 0 || minor > MIN_PATCHED_UV[1] || (minor === MIN_PATCHED_UV[1] && patch >= MIN_PATCHED_UV[2])).toBe(true);
  });

  it('reuses a current private uv without touching Python or the network', async () => {
    mock.execFile.mockImplementation(answer(`uv ${PRIVATE_UV_VERSION} (abc)\n`));
    await expect(ensurePrivateUv({ basePython: '/py/python3' })).resolves.toEqual({ ok: true, uv: privateUvPath() });
    expect(calls()).toEqual([`${privateUvPath()} --version`]);
  });

  it('bootstraps a fresh venv with the exact version when absent, sharing one run between concurrent callers', async () => {
    mock.exists = false;
    mock.execFile.mockImplementation((bin, args, _opts, done) => {
      if (args[0] === '-m' && args[1] === 'pip') mock.exists = true;
      done(null, { stdout: args[0] === '--version' ? `uv ${PRIVATE_UV_VERSION}` : '', stderr: '' });
    });
    const [a, b] = await Promise.all([ensurePrivateUv({ basePython: '/py/python3' }), ensurePrivateUv({ basePython: '/py/python3' })]);
    expect(a).toEqual({ ok: true, uv: privateUvPath() });
    expect(b).toEqual(a);
    expect(calls().filter((c) => c.includes('-m venv'))).toEqual(['/py/python3 -m venv --clear /home/example/.portos/tools/uv-0.13.6']);
    expect(calls().some((c) => /-m pip install --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r .*requirements-uv-bootstrap\.lock\.txt$/.test(c))).toBe(true);
  });

  it('replaces an outdated private uv and reports failure instead of falling back to PATH', async () => {
    mock.execFile.mockImplementation((bin, args, _opts, done) => done(null, { stdout: args[0] === '--version' ? 'uv 0.8.14' : '', stderr: '' }));
    const stale = await ensurePrivateUv({ basePython: '/py/python3' });
    mock.execFile.mockImplementation((bin, args, _opts, done) => done(null, { stdout: args[0] === '--version' ? 'uv 0.13.3 (abc)' : '', stderr: '' }));
    await expect(ensurePrivateUv({ basePython: '/py/python3' })).resolves.toMatchObject({ ok: false });
    expect(stale).toMatchObject({ ok: false, reason: expect.stringContaining(`did not report version ${PRIVATE_UV_VERSION}`) });
    mock.execFile.mockReset().mockImplementation(answer('uv 0.8.14'));
    await expect(ensurePrivateUv({})).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('No Python found') });
    mock.execFile.mockReset().mockImplementation((bin, args, _opts, done) => done(Object.assign(new Error('boom'), { stderr: 'pip: no network\n' })));
    const failed = await ensurePrivateUv({ basePython: '/py/python3' });
    expect(failed.reason).not.toContain('no network');
    expect(failed).toMatchObject({ ok: false, reason: expect.stringMatching(/^Could not bootstrap uv 0\.13\.6: the virtualenv creation step failed\.$/) });
  });
});
