import { describe, expect, it, vi } from 'vitest';
import { __testing, getSoftwareInventory } from './softwareInventory.js';

const { browserRow, condaRows, nodeRows, readBlenderVersion, ytDlpRow } = __testing;

const runtime = (overrides = {}) => ({
  node: { version: 'v26.12.1', inSupportedRange: true, securityBaseline: { compliant: true }, pinned: '/x/node' },
  nvm: { dir: '/x/.nvm', defaultVersion: 'v26.12.1', installed: ['v26.12.1'] },
  pm2: { shipped: '7.1.0', latest: '7.1.0', daemon: { pm2Version: '7.1.0' }, cli: '7.1.0', cliBehind: false, daemonStale: false },
  releases: { latestInLine: { version: 'v26.12.1' }, securityUpdate: false, offers: [] },
  canUpdate: true,
  ...overrides,
});

describe('getSoftwareInventory', () => {
  it('keeps healthy rows when one probe throws and another hangs', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const collectors = [
      { id: 'ok', name: 'Ok', group: 'Runtime', read: async () => [{ id: 'ok', state: 'current' }] },
      { id: 'boom', name: 'Boom', group: 'Media tools', home: { path: '/x' }, read: async () => { throw new Error('nope'); } },
      { id: 'slow', name: 'Slow', group: 'Local AI', read: () => new Promise(() => {}) },
    ];
    const { components } = await getSoftwareInventory({ collectors, timeoutMs: 20 });
    expect(components.map((c) => [c.id, c.state])).toEqual([['ok', 'current'], ['boom', 'unknown'], ['slow', 'unknown']]);
    expect(components[1]).toMatchObject({ home: { path: '/x' }, summary: 'Status could not be read: nope' });
    expect(components[2].summary).toMatch(/timed out/);
  });
});

describe('runtime rows', () => {
  it('offers the Node update only when a newer release exists, flagging security first', () => {
    expect(nodeRows(runtime())[0]).toMatchObject({ state: 'current', action: null });
    const [node] = nodeRows(runtime({
      releases: { latestInLine: { version: 'v26.13.0' }, securityUpdate: true, offers: [{ version: 'v26.13.0' }] },
    }));
    expect(node).toMatchObject({ state: 'security', latest: 'v26.13.0', action: { kind: 'node-update', version: 'v26.13.0', restarts: true } });
  });

  it('withholds the Node action when nvm cannot run it, and reports a missing release index as unknown', () => {
    const blocked = nodeRows(runtime({ canUpdate: false, nvm: null, blockedReason: 'nvm is not installed.',
      releases: { latestInLine: { version: 'v26.13.0' }, offers: [{ version: 'v26.13.0' }] } }));
    expect(blocked[0]).toMatchObject({ state: 'update', action: null });
    expect(blocked[1]).toMatchObject({ id: 'nvm', state: 'missing', summary: 'nvm is not installed.' });
    expect(nodeRows(runtime({ releases: null, releasesError: 'offline' }))[0]).toMatchObject({ state: 'unknown', summary: 'offline' });
  });

  it('offers a pm2 sync that says whether it restarts PortOS', () => {
    const [, , pm2] = nodeRows(runtime({ pm2: { ...runtime().pm2, daemon: { pm2Version: '7.0.0' }, daemonStale: true } }));
    expect(pm2).toMatchObject({ state: 'attention', version: '7.0.0', latest: '7.1.0', action: { kind: 'pm2-sync', restarts: true } });
  });
});

describe('component rows', () => {
  it('maps the browser restart state to an update and picks the published build for this arch', () => {
    const row = browserRow({ state: 'restart-required', runningVersion: '140.0.1', installedVersion: '140.0.2',
      publishedVersions: { mac_arm64: '140.0.3', mac: '140.0.4' } }, 'arm64');
    expect(row).toMatchObject({ state: 'update', version: '140.0.1', latest: '140.0.3' });
    expect(browserRow(null).state).toBe('unknown');
  });

  it('offers yt-dlp updates only when its updater can run', () => {
    const status = { installed: true, version: '2026.01.01', latestVersion: '2026.02.01', updateAvailable: true, canUpdate: true };
    expect(ytDlpRow(status).action).toMatchObject({ kind: 'ytdlp-update' });
    expect(ytDlpRow({ ...status, canUpdate: false, blockedReason: 'pinned' })).toMatchObject({ action: null, summary: 'pinned' });
  });

  it('lists CUDA conda envs only on Linux unless they exist', () => {
    const mac = condaRows({ platform: 'darwin', resolve: () => null }).map((row) => row.id);
    expect(mac).toEqual(['conda:rigging']);
    const present = condaRows({ platform: 'darwin', resolve: (env) => (env === 'pixal3d' ? '/c/envs/pixal3d/bin/python' : null) });
    expect(present.map((row) => [row.id, row.state])).toEqual([['conda:rigging', 'missing'], ['conda:pixal3d', 'current']]);
  });

  it('reads the Blender version from the app bundle or the install directory without running it', async () => {
    const read = async (path) => (path === '/Applications/Blender.app/Contents/Info.plist'
      ? '<key>CFBundleShortVersionString</key>\n\t<string>5.2.4</string>' : '');
    expect(await readBlenderVersion('/Applications/Blender.app/Contents/MacOS/Blender', { read })).toBe('5.2.4');
    expect(await readBlenderVersion('/opt/blender-4.2.0-linux-x64/blender', { read })).toBe('4.2.0');
    expect(await readBlenderVersion(null, { read })).toBeNull();
  });
});
