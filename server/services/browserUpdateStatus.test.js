import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareChromeVersions, __testing } from './browserUpdateStatus.js';

const { createBrowserUpdateReader } = __testing;

const BUNDLE = '/Applications/Google Chrome.app';
const BINARY = `${BUNDLE}/Contents/MacOS/Google Chrome`;
const plist = (overrides = {}) => ({
  CFBundleIdentifier: 'com.google.Chrome', CFBundleShortVersionString: '156.0.8078.74', CFBundleExecutable: 'Google Chrome', ...overrides,
});

function fixture({ config = {}, metadata = plist(), running = 'Chrome/156.0.8078.4' } = {}) {
  const readVersion = vi.fn().mockResolvedValue({ Browser: running });
  const readConfig = vi.fn().mockResolvedValue({ cdpHost: '127.0.0.1', cdpPort: 5556, healthPort: 5557, headless: false, ...config });
  const readProcess = vi.fn().mockResolvedValue({ exists: true, status: 'online', pid: 42 });
  const readHealth = vi.fn().mockResolvedValue({ connected: true, cdpHost: '127.0.0.1', cdpPort: 5556, headless: false });
  const execute = vi.fn(async (file, args) => {
    if (file === '/usr/sbin/lsof') return { stdout: args.includes('-iTCP:5557') ? 'p42\nn127.0.0.1:5557\n' : 'p123\nn127.0.0.1:5556\n' };
    if (file === '/bin/ps') return { stdout: args.includes('ppid=') ? '42\n' : `${BINARY}\n` };
    if (file === '/usr/bin/plutil') return { stdout: JSON.stringify(metadata) };
    throw new Error('unexpected command');
  });
  const canonical = vi.fn(async path => path);
  const fileStat = vi.fn(async () => ({ dev: 1, ino: 2, size: 3, mtimeMs: 4 }));
  const readRelease = vi.fn().mockResolvedValue('156.0.8078.74');
  const deps = { platform: 'darwin', readVersion, readConfig, readProcess, readHealth, execute, canonical, fileStat, readRelease };
  return { deps, read: () => createBrowserUpdateReader(deps)() };
}

afterEach(() => vi.restoreAllMocks());

describe('managed Chrome update observation', () => {
  it('compares all four version fields and rejects malformed values', () => {
    expect(compareChromeVersions('156.0.8078.4', '156.0.8078.74')).toBe(-1);
    expect(compareChromeVersions('156.0.8078.74', '156.0.8078.4')).toBe(1);
    expect(compareChromeVersions('156.0.8078.74', '156.0.8078.74')).toBe(0);
    expect(compareChromeVersions('156.0.8078', '156.0.8078.74')).toBeNull();
    expect(compareChromeVersions('Chrome/156.0.8078.4', '156.0.8078.74')).toBeNull();
  });

  it('reports an installed update only after matching the listener and configured app', async () => {
    const { deps, read } = fixture();
    expect(await read()).toEqual({ state: 'restart-required', runningVersion: '156.0.8078.4', installedVersion: '156.0.8078.74',
      publishedVersions: { mac_arm64: '156.0.8078.74', mac: '156.0.8078.74' }, channel: 'stable', autoUpdate: 'unverified' });
    expect(new Set(deps.execute.mock.calls.map(([file]) => file))).toEqual(new Set(['/usr/sbin/lsof', '/bin/ps', '/usr/bin/plutil']));
    expect(deps.readVersion).toHaveBeenCalledTimes(2);
  });

  it('treats a published release as information, not an installed update or failed updater', async () => {
    const { deps, read } = fixture({ running: 'Chrome/156.0.8078.74' });
    deps.readRelease.mockResolvedValue('157.0.9000.1');
    expect(await read()).toMatchObject({ state: 'current', publishedVersions: { mac_arm64: '157.0.9000.1', mac: '157.0.9000.1' }, autoUpdate: 'unverified' });
    deps.readRelease.mockRejectedValue(new Error('offline'));
    expect(await read()).toMatchObject({ state: 'current', publishedVersions: { mac_arm64: null, mac: null } });
  });

  it('uses Google VersionHistory for the selected platform and channel', async () => {
    const { deps } = fixture({ running: 'Chrome/156.0.8078.74' });
    delete deps.readRelease;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      versions: [{ version: '157.0.9000.1' }],
    }), { status: 200 }));
    const result = await createBrowserUpdateReader(deps)();
    expect(result).toMatchObject({ state: 'current', publishedVersions: { mac_arm64: '157.0.9000.1', mac: '157.0.9000.1' } });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      'https://versionhistory.googleapis.com/v1/chrome/platforms/mac_arm64/channels/stable/versions?order_by=version%20desc&pageSize=1',
      'https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/stable/versions?order_by=version%20desc&pageSize=1',
    ]));
  });

  it('keeps an installed restart actionable when the release index is unavailable', async () => {
    const { deps, read } = fixture();
    deps.readRelease.mockRejectedValue(new Error('offline'));
    expect(await read()).toMatchObject({ state: 'restart-required', publishedVersions: { mac_arm64: null, mac: null } });
  });

  it('honors the configured app bundle in headed mode and executable in headless mode', async () => {
    const config = { chromePath: BINARY, macAppBundle: '/Applications/Google Chrome Canary.app' };
    expect(await fixture({ config }).read()).toMatchObject({ state: 'configuration-mismatch' });
    expect(await fixture({ config: { ...config, headless: true } }).read()).toMatchObject({ state: 'restart-required' });
  });

  it('recognizes a listener executable reached through an app-external symlink', async () => {
    const { deps, read } = fixture();
    const original = deps.execute.getMockImplementation();
    deps.execute.mockImplementation((file, args) => file === '/bin/ps' && args.includes('comm=')
      ? Promise.resolve({ stdout: '/usr/local/bin/chrome\n' }) : original(file, args));
    deps.canonical.mockImplementation(async path => path === '/usr/local/bin/chrome' ? BINARY : path);
    expect(await read()).toMatchObject({ state: 'restart-required' });
  });

  it('does not apply Google release comparisons to unknown browsers', async () => {
    const { deps, read } = fixture({ metadata: plist({ CFBundleIdentifier: 'org.chromium.Chromium' }) });
    expect(await read()).toEqual({ state: 'unsupported', reason: 'browser' });
    expect(deps.readRelease).not.toHaveBeenCalled();
    expect(await createBrowserUpdateReader({ platform: 'win32' })()).toEqual({ state: 'unsupported', reason: 'platform' });
  });

  it('checks the matching Canary channel when the configured executable is Canary', async () => {
    const { deps } = fixture({ metadata: plist({ CFBundleIdentifier: 'com.google.Chrome.canary' }) });
    const read = createBrowserUpdateReader(deps);
    expect(await read()).toMatchObject({ state: 'restart-required', channel: 'canary' });
    expect(deps.readRelease).toHaveBeenCalledWith('canary', 'mac_arm64');
    expect(deps.readRelease).toHaveBeenCalledWith('canary', 'mac');
  });

  it('does not treat a reused, remote, changing, or unreadable listener as verified', async () => {
    const multiple = fixture();
    multiple.deps.execute.mockResolvedValueOnce({ stdout: 'p123\np456\n' });
    expect(await multiple.read()).toEqual({ state: 'unverified' });
    const changing = fixture();
    changing.deps.readVersion.mockResolvedValueOnce({ Browser: 'Chrome/156.0.8078.4' }).mockResolvedValueOnce({ Browser: 'Chrome/156.0.8078.74' });
    expect(await changing.read()).toEqual({ state: 'unverified' });
    const remote = fixture({ config: { cdpHost: 'example.com' } });
    expect(await remote.read()).toEqual({ state: 'unverified' });
    expect(remote.deps.execute).not.toHaveBeenCalled();
    const unreadable = fixture();
    unreadable.deps.execute.mockRejectedValue(new Error('denied'));
    expect(await unreadable.read()).toEqual({ state: 'unverified' });
    const badConfig = fixture();
    badConfig.deps.readConfig.mockRejectedValue(new Error('unreadable'));
    expect(await badConfig.read()).toEqual({ state: 'unverified' });
  });

  it('uses the supervisor-reported CDP endpoint instead of a changed configured port', async () => {
    const { deps, read } = fixture({ config: { cdpPort: 6666 } });
    expect(await read()).toMatchObject({ state: 'restart-required' });
    expect(deps.readVersion).toHaveBeenCalledWith(expect.objectContaining({ cdpPort: 5556 }));
    expect(deps.execute.mock.calls.some(([, args]) => args.includes('-iTCP:6666'))).toBe(false);
  });

  it('requires the health listener to belong to the online supervisor and headless Chrome to be its child', async () => {
    const wrongSupervisor = fixture();
    wrongSupervisor.deps.readProcess.mockResolvedValue({ exists: true, status: 'online', pid: 99 });
    expect(await wrongSupervisor.read()).toEqual({ state: 'unverified' });
    const reused = fixture();
    reused.deps.readHealth.mockResolvedValue({ connected: true, cdpHost: '127.0.0.1', cdpPort: 5556, headless: true });
    const original = reused.deps.execute.getMockImplementation();
    reused.deps.execute.mockImplementation((file, args) => file === '/bin/ps' && args.includes('ppid=')
      ? Promise.resolve({ stdout: '1\n' }) : original(file, args));
    expect(await reused.read()).toEqual({ state: 'unverified' });
  });

  it('warns when restarting would select an older installed build', async () => {
    expect(await fixture({ running: 'Chrome/156.0.8078.74', metadata: plist({ CFBundleShortVersionString: '156.0.8078.4' }) }).read())
      .toMatchObject({ state: 'downgrade-risk', installedVersion: '156.0.8078.4' });
  });

  it('drops an observation if the installed app changes during a release lookup', async () => {
    const metadata = plist();
    const { deps, read } = fixture({ metadata });
    let finish;
    const lookup = new Promise(resolve => { finish = resolve; });
    deps.readRelease.mockReturnValue(lookup);
    const pending = read();
    await vi.waitFor(() => expect(deps.readRelease).toHaveBeenCalledTimes(2));
    metadata.CFBundleShortVersionString = '156.0.8078.80';
    finish('156.0.8078.80');
    expect(await pending).toEqual({ state: 'unverified' });
  });

  it('binds restart proof to configuration and rejects a configuration change during observation', async () => {
    const { deps } = fixture();
    const read = createBrowserUpdateReader(deps);
    const first = await read({ includePublished: false, includeProof: true });
    deps.readConfig.mockResolvedValue({ cdpHost: '127.0.0.1', cdpPort: 5556, healthPort: 5557, headless: false, userDataDir: '/different-profile' });
    const second = await read({ includePublished: false, includeProof: true });
    expect(first.proof).not.toBe(second.proof);
    deps.readConfig.mockResolvedValueOnce({ cdpHost: '127.0.0.1', cdpPort: 5556, healthPort: 5557, headless: false })
      .mockResolvedValueOnce({ cdpHost: '127.0.0.1', cdpPort: 6666, healthPort: 5557, headless: false });
    expect(await read({ includePublished: false, includeProof: true })).toEqual({ state: 'unverified' });
  });

  it('reports a stopped supervisor separately from an unavailable CDP observation', async () => {
    const { deps, read } = fixture();
    deps.readProcess.mockResolvedValue({ exists: false, status: 'not_found' });
    expect(await read()).toEqual({ state: 'stopped' });
    deps.readProcess.mockResolvedValue({ exists: null, status: 'unavailable' });
    expect(await read()).toEqual({ state: 'unverified' });
  });
});
