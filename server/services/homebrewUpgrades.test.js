import { recordingOperatorIo } from '../test/recordingOperatorIo.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listActiveRenders } from './renderActivity.js';
import { __testing, getHomebrewStatus, setHomebrewHold, startHomebrewJob } from './homebrewUpgrades.js';

const BREW = '/opt/homebrew/bin/brew';
const nativePostgres = async () => ({ mode: 'native', major: 17, build: 'Homebrew' });
const okStream = vi.fn(async () => ({ success: true }));
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function makeIo() {
  const frames = [];
  return { frames, io: recordingOperatorIo((event, payload) => frames.push([event, payload])) };
}

/** Resolves once the job's `software:changed` lands. */
async function settled(frames) {
  for (let i = 0; i < 100 && !frames.some(([event]) => event === 'software:changed'); i += 1) await flush();
}

const outdated = {
  formulae: [
    { name: 'pgvector', installed_versions: ['0.8.1'], current_version: '0.8.7_1', pinned: false },
    { name: 'wget', installed_versions: ['1.24'], current_version: '1.25', pinned: false },
  ],
  casks: [],
};
const infos = { formulae: [
  { name: 'pgvector', dependencies: ['postgresql@18'], installed: [{ runtime_dependencies: [{ full_name: 'postgresql@17', declared_directly: true }] }] },
  { name: 'wget', dependencies: [], installed: [{ runtime_dependencies: [] }] },
] };
const read = async (_brew, args) => (args[0] === 'outdated' ? outdated : infos);

afterEach(() => { __testing.reset(); vi.clearAllMocks(); });

describe('getHomebrewStatus', () => {
  it('degrades to unsupported off macOS and without Homebrew', async () => {
    expect(await getHomebrewStatus({ deps: { platform: 'win32' } })).toMatchObject({ supported: false });
    expect(await getHomebrewStatus({ deps: { platform: 'darwin', brew: null } })).toMatchObject({ supported: false, reason: 'Homebrew is not installed.' });
  });

  it('lists outdated packages with their risk and reports an extension that no longer loads', async () => {
    const query = vi.fn(async () => { throw Object.assign(new Error('could not access file "$libdir/vector": No such file or directory'), { code: '58P01' }); });
    const status = await getHomebrewStatus({ fresh: true, deps: {
      platform: 'darwin', brew: BREW, read, stream: okStream, query, readPostgres: nativePostgres, listPythons: async () => [],
    } });
    expect(okStream).toHaveBeenCalledWith(BREW, ['update', '--quiet'], null, expect.any(Object));
    expect(status.packages.map((pkg) => [pkg.name, pkg.risk])).toEqual([['pgvector', 'breaking'], ['wget', 'safe']]);
    expect(status.problems).toEqual([expect.objectContaining({ id: 'postgres-extensions', detail: expect.stringContaining('$libdir/vector') })]);
  });
});

describe('startHomebrewJob', () => {
  const baseDeps = (overrides = {}) => ({
    platform: 'darwin', brew: BREW, read, stream: okStream, readPostgres: nativePostgres, listPythons: async () => [],
    assertIdle: vi.fn(async () => {}), query: vi.fn(async () => ({ rows: [] })),
    checkHealth: async () => ({ connected: true, hasSchema: true }), probe: vi.fn(async () => ({})),
    ...overrides,
  });
  const readStatus = (deps) => () => getHomebrewStatus({ deps });

  it('warns before a breaking upgrade and goes ahead when the owner acknowledges it', async () => {
    const deps = baseDeps();
    deps.readStatus = readStatus(deps);
    await expect(startHomebrewJob({ kind: 'upgrade', names: ['pgvector'], deps })).rejects.toMatchObject({ code: 'HOMEBREW_UPGRADE_RISK', status: 409 });
    const { io, frames } = makeIo();
    const started = await startHomebrewJob({ kind: 'upgrade', names: ['pgvector', 'wget'], acknowledgeRisk: true, io, deps });
    expect(started).toMatchObject({ started: true, names: ['pgvector', 'wget'] });
    await settled(frames);
    const upgrades = okStream.mock.calls.filter(([, args]) => args[0] === 'upgrade').map(([, args]) => args);
    expect(upgrades).toEqual([['upgrade', '--formula', 'pgvector'], ['upgrade', '--formula', 'wget']]);
    expect(frames.find(([, frame]) => frame?.step === 'complete')?.[1].message).toMatch(/Upgraded 2; all checks pass/);
    expect(__testing.getJob()).toBeNull();
  });

  it('refuses names that are not outdated and a second job while one runs', async () => {
    const deps = baseDeps();
    deps.readStatus = readStatus(deps);
    await expect(startHomebrewJob({ kind: 'upgrade', names: ['curl'], deps })).rejects.toMatchObject({ code: 'HOMEBREW_NOT_OUTDATED' });
    let release;
    const slow = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { io, frames } = makeIo();
    await startHomebrewJob({ kind: 'repair', io, deps: { ...deps, query: slow } });
    await expect(startHomebrewJob({ kind: 'repair', deps })).rejects.toMatchObject({ code: 'HOMEBREW_BUSY' });
    expect(listActiveRenders()).toEqual([expect.objectContaining({ kind: 'homebrew' })]);
    release({ rows: [] });
    await settled(frames);
    expect(listActiveRenders()).toEqual([]);
  });

  it('repairs a pgvector library an upgrade removed by running the database setup', async () => {
    let loads = false;
    const query = vi.fn(async (sql) => {
      if (sql.includes('::vector') && !loads) throw new Error('could not access file "$libdir/vector": No such file or directory');
      return { rows: [] };
    });
    const stream = vi.fn(async (cmd, args) => {
      if (String(args[0]).endsWith('setup-db.js')) loads = true;
      return { success: true };
    });
    const { io, frames } = makeIo();
    await startHomebrewJob({ kind: 'repair', io, deps: baseDeps({ query, stream }) });
    await settled(frames);
    expect(stream.mock.calls.some(([, args]) => String(args[0]).endsWith('scripts/setup-db.js'))).toBe(true);
    const { results } = (await getHomebrewStatus({ deps: baseDeps({ query, stream }) })).lastRun;
    expect(results.find((result) => result.id === 'postgres-extensions')).toMatchObject({ ok: true, repaired: true });
  });

  it('rebuilds a pyenv Python that stopped starting', async () => {
    const python = { path: '/home/u/.pyenv/versions/3.8.9/bin/python3', real: '/home/u/.pyenv/versions/3.8.9/bin/python3.8', pyenvVersion: '3.8.9', label: 'pyenv Python 3.8.9' };
    let rebuilt = false;
    const probe = vi.fn(async () => { if (!rebuilt) throw Object.assign(new Error('exit 134'), { stderr: 'dyld: Library not loaded: libintl.8.dylib' }); return {}; });
    const stream = vi.fn(async (_cmd, args) => { if (args[0] === 'install') rebuilt = true; return { success: true }; });
    const listPythons = async () => [python];
    const first = makeIo();
    await startHomebrewJob({ kind: 'repair', io: first.io, deps: baseDeps({ stream, probe, listPythons, pyenv: null }) });
    await settled(first.frames);
    // Without pyenv the failure names the rebuild command.
    expect(first.frames.some(([, frame]) => frame?.message?.includes('pyenv install --force 3.8.9'))).toBe(true);
    expect(rebuilt).toBe(false);

    const second = makeIo();
    await startHomebrewJob({ kind: 'repair', io: second.io, deps: baseDeps({ stream, probe, listPythons, pyenv: '/usr/local/bin/pyenv' }) });
    await settled(second.frames);
    expect(stream).toHaveBeenCalledWith('/usr/local/bin/pyenv', ['install', '--force', '3.8.9'], expect.any(Function), expect.any(Object));
    expect(second.frames.find(([, frame]) => frame?.step === 'complete')?.[1].message).toMatch(/all checks pass/);
  });

  it('is unsupported off macOS', async () => {
    await expect(startHomebrewJob({ kind: 'repair', deps: { platform: 'linux' } })).rejects.toMatchObject({ code: 'HOMEBREW_UNSUPPORTED' });
  });
});

describe('setHomebrewHold', () => {
  it('pins and unpins through brew and announces the change', async () => {
    const run = vi.fn(async () => ({ stdout: '' }));
    const { io, frames } = makeIo();
    expect(await setHomebrewHold({ names: ['pgvector'], hold: true, io, deps: { platform: 'darwin', brew: BREW, run } })).toEqual({ names: ['pgvector'], held: true });
    expect(run).toHaveBeenCalledWith(BREW, ['pin', 'pgvector'], expect.any(Object));
    expect(frames).toContainEqual(['software:changed', { reason: 'homebrew' }]);
  });
});

describe('linkedFormulae', () => {
  it('names the formulae a Python built outside Homebrew links, on Apple Silicon and Intel prefixes', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'brew-linked-'));
    try {
      mkdirSync(join(prefix, 'bin'));
      mkdirSync(join(prefix, 'lib', 'python3.8', 'lib-dynload'), { recursive: true });
      writeFileSync(join(prefix, 'bin', 'python3.8'), '');
      writeFileSync(join(prefix, 'lib', 'python3.8', 'lib-dynload', '_ssl.so'), '');
      const run = vi.fn(async () => ({ stdout: [
        `${prefix}/bin/python3.8:`,
        '\t/opt/homebrew/opt/gettext/lib/libintl.8.dylib (compatibility version 12.0.0)',
        '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)',
        `${prefix}/lib/python3.8/lib-dynload/_ssl.so:`,
        '\t/opt/homebrew/Cellar/openssl@3/3.4.0/lib/libssl.3.dylib (compatibility version 3.0.0)',
        '\t/usr/local/opt/xz/lib/liblzma.5.dylib (compatibility version 6.0.0)',
      ].join('\n') }));
      const python = { real: join(prefix, 'bin', 'python3.8') };
      expect(await __testing.linkedFormulae(python, { run })).toEqual(['gettext', 'openssl@3', 'xz']);
      expect(run.mock.calls[0][1]).toEqual(['-L', python.real, join(prefix, 'lib', 'python3.8', 'lib-dynload', '_ssl.so')]);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});
