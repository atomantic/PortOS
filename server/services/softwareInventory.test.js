import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { __testing, getInstalledBlenderCandidates, getSoftwareInventory } from './softwareInventory.js';

const { blenderRow, browserRow, condaRows, nodeRows, readBlenderVersion, ytDlpRow } = __testing;

const runtime = (overrides = {}) => ({
  node: { version: 'v26.12.1', inSupportedRange: true, securityBaseline: { compliant: true }, pinned: '/x/node' },
  nvm: { dir: '/x/.nvm', defaultVersion: 'v26.12.1', installed: ['v26.12.1'] },
  pm2: { shipped: '7.1.0', latest: '7.1.0', daemon: { pm2Version: '7.1.0' }, cli: '7.1.0', cliBehind: false, daemonStale: false },
  releases: { latestInLine: { version: 'v26.12.1' }, securityUpdate: false, offers: [] },
  canUpdate: true,
  ...overrides,
});

describe('getSoftwareInventory', () => {
  it('finds installed macOS Blender apps from bundle metadata without launching them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blender-discovery-'));
    try {
      const contents = join(root, 'Blender.app', 'Contents');
      await mkdir(join(contents, 'MacOS'), { recursive: true });
      await writeFile(join(contents, 'Info.plist'), '<key>CFBundleShortVersionString</key><string>5.2.3</string>');
      await writeFile(join(contents, 'MacOS', 'Blender'), 'not an executable');
      expect(await getInstalledBlenderCandidates({ platform: 'darwin', roots: [root] })).toEqual([
        { executable: join(contents, 'MacOS', 'Blender'), version: '5.2.3' },
      ]);
      expect(await getInstalledBlenderCandidates({ platform: 'linux', roots: [root] })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it('withholds Node and pm2 actions while one of their jobs is running', () => {
    const rows = nodeRows(runtime({ job: { kind: 'pm2-update' }, pm2: { ...runtime().pm2, cliBehind: true },
      releases: { latestInLine: { version: 'v26.13.0' }, offers: [{ version: 'v26.13.0' }] } }));
    expect(rows[0]).toMatchObject({ busy: 'pm2 update running', action: null });
    expect(rows[2]).toMatchObject({ state: 'attention', busy: 'pm2 update running', action: null });
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

  describe('Blender row', () => {
    const offer = { version: '5.2.3', series: '5.2', newestSeries: '5.2' };
    const configured = (executable, ready = true) => ({ tools: { blender: { executable, executionMode: 'contained', problem: executable ? null : 'Not configured.' } },
      lanes: { blender: ready ? { ready: true } : { ready: false, reason: 'check not run' } } });
    const read = async () => '';

    it('flags an installed but unselected Blender and offers the managed install', async () => {
      const row = await blenderRow(configured(null), { offer, platform: 'darwin', read,
        candidates: [{ executable: '/Applications/Blender.app/Contents/MacOS/Blender', version: '4.3.2' }] });
      expect(row).toMatchObject({ state: 'attention', version: '4.3.2', latest: '5.2.3',
        action: { kind: 'blender-install', label: 'Install Blender 5.2.3' } });
      expect(row.summary).toMatch(/4\.3\.2 is installed at .* no Blender selected/);
    });

    it('offers an update for an older patch, and none while installing or off macOS', async () => {
      const older = configured('/x/blender-5.2.1-macos/Blender');
      expect(await blenderRow(older, { offer, platform: 'darwin', read })).toMatchObject({ state: 'update', version: '5.2.1', action: { label: 'Update to 5.2.3' } });
      expect(await blenderRow(older, { offer, platform: 'darwin', read, job: { version: '5.2.3' } })).toMatchObject({ busy: 'Installing Blender 5.2.3', action: null });
      expect((await blenderRow(older, { offer, platform: 'linux', read })).action).toBeNull();
      expect(await blenderRow(configured('/x/blender-5.2.3-macos/Blender'), { offer, platform: 'darwin', read })).toMatchObject({ state: 'current', action: null });
    });

    it('marks a Blender older than the supported series as needing attention', async () => {
      const row = await blenderRow(configured('/x/blender-4.1.0/blender'), { offer, platform: 'darwin', read });
      expect(row).toMatchObject({ state: 'attention', action: { kind: 'blender-install' } });
      expect(row.summary).toMatch(/older than the 4\.2 series/);
    });
  });
});
