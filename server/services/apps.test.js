import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn(),
  PATHS: { data: '/mock/data', root: '/mock/root' },
}));

vi.mock('../../lib/tailscale-https.js', () => ({
  hasTailscaleCert: () => false,
}));

vi.mock('../lib/ports.js', () => ({
  PORTS: { API: 5555, API_LOCAL: 5553, UI: 5554 },
}));

vi.mock('./taskSchedule.js', () => ({
  resetExecutionHistory: vi.fn().mockResolvedValue({ error: 'No execution history found' }),
}));

vi.mock('./taskScheduleRegistry.js', () => ({
  SELF_IMPROVEMENT_TASK_TYPES: [],
}));

import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { resetExecutionHistory } from './taskSchedule.js';
import { createApp, deleteApp, getAllApps, getReservedPorts, invalidateCache, PORTOS_APP_ID, updateApp, updateAppTaskTypeOverride } from './apps.js';

describe('pr-watcher cooldown reset', () => {
  beforeEach(() => {
    invalidateCache();
    vi.clearAllMocks();
    readJSONFile.mockResolvedValue({
      apps: {
        'app-1': {
          name: 'App One',
          prWatcherState: { lastSeenPr: 42 },
          taskTypeOverrides: { 'pr-watcher': { enabled: true } },
        },
      },
    });
  });

  it('keeps the primary disable successful but logs a contextual storage failure', async () => {
    resetExecutionHistory.mockRejectedValueOnce(new Error('ENOSPC: schedule write failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const updated = await updateAppTaskTypeOverride('app-1', 'pr-watcher', { enabled: false });

    expect(updated.taskTypeOverrides['pr-watcher'].enabled).toBe(false);
    expect(updated.prWatcherState).toBeUndefined();
    expect(atomicWrite).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(
      'Failed to reset pr-watcher cooldown for app app-1: ENOSPC: schedule write failed'
    ));
    errorSpy.mockRestore();
  });

  it('treats missing execution history as a quiet no-op', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const updated = await updateAppTaskTypeOverride('app-1', 'pr-watcher', { enabled: false });

    expect(updated.taskTypeOverrides['pr-watcher'].enabled).toBe(false);
    expect(resetExecutionHistory).toHaveBeenCalledWith('pr-watcher', 'app-1');
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('issue-watcher cooldown reset', () => {
  beforeEach(() => {
    invalidateCache();
    vi.clearAllMocks();
    readJSONFile.mockResolvedValue({
      apps: {
        'app-1': {
          name: 'App One',
          issueWatcherState: { cursor: '2026-01-01T00:00:00.000Z' },
          taskTypeOverrides: { 'issue-watcher': { enabled: true } },
        },
      },
    });
  });

  it('clears its cursor and cooldown when disabled', async () => {
    const updated = await updateAppTaskTypeOverride('app-1', 'issue-watcher', { enabled: false });
    expect(updated.issueWatcherState).toBeUndefined();
    expect(resetExecutionHistory).toHaveBeenCalledWith('issue-watcher', 'app-1');
  });
});

describe('getReservedPorts', () => {
  beforeEach(() => {
    invalidateCache();
    vi.clearAllMocks();
  });

  it('reserves every per-process port (ports map values), not just uiPort/apiPort', async () => {
    // Mirror critical-mass: top-level apiPort/uiPort + engine processes that
    // expose IPC ports via the per-process `ports` map.
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS', uiPort: 5555, apiPort: 5555, devUiPort: 5554 },
        'critical-mass': {
          name: 'critical-mass',
          apiPort: 5563,
          uiPort: 5563,
          devUiPort: 5564,
          processes: [
            { name: 'critical-mass', ports: { api: 5563, coinbaseIpc: 5565, geminiIpc: 5566, cryptocomIpc: 5567 } },
            { name: 'critical-mass-coinbase', ports: { exchangeIpc: 5565 } },
            { name: 'critical-mass-gemini', ports: { geminiIpc: 5566 } },
            { name: 'critical-mass-cryptocom', ports: { cryptocomIpc: 5567 } },
            { name: 'critical-mass-ui', ports: { devUi: 5564 } },
          ],
        },
      },
    });

    const reserved = await getReservedPorts();

    // Includes engine IPC ports surfaced only through processes[].ports
    expect(reserved).toContain(5565);
    expect(reserved).toContain(5566);
    expect(reserved).toContain(5567);
    // Top-level port fields still reserved
    expect(reserved).toContain(5563);
    expect(reserved).toContain(5564);
    // PortOS baseline ports always reserved
    expect(reserved).toContain(5555);
    expect(reserved).toContain(5554);
    // De-duplicated and sorted ascending
    expect([...reserved]).toEqual([...new Set(reserved)].sort((a, b) => a - b));
  });

  it('ignores invalid port values in processes[].ports', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS' },
        'weird-app': {
          name: 'weird',
          processes: [
            { name: 'a', ports: { api: 5570, broken: null, alsoBroken: 'not-a-port', zero: 0 } },
          ],
        },
      },
    });

    const reserved = await getReservedPorts();
    expect(reserved).toContain(5570);
    expect(reserved).not.toContain(0);
    expect(reserved.every(p => Number.isInteger(p) && p > 0)).toBe(true);
  });

  it('rejects garbage strings (e.g. "5565abc") and out-of-range integers', async () => {
    // parseInt-style coercion would silently accept `'5565abc'` as 5565.
    // Strict /^\\d+$/ + range check is what keeps a hand-edited apps.json from
    // smuggling a bogus reservation.
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS' },
        'sketchy': {
          name: 'sketchy',
          apiPort: '5565abc',     // partially-numeric string
          uiPort: 99999,          // above 65535
          processes: [
            { name: 'a', ports: { api: 5571, weird: '12.5', neg: -1, big: 70000 } },
          ],
        },
      },
    });

    const reserved = await getReservedPorts();
    expect(reserved).toContain(5571);
    expect(reserved).not.toContain(5565);
    expect(reserved).not.toContain(99999);
    expect(reserved).not.toContain(70000);
    expect(reserved).not.toContain(-1);
    expect(reserved.every(p => Number.isInteger(p) && p >= 1 && p <= 65535)).toBe(true);
  });
});

describe('portless / desktop apps (#2991)', () => {
  beforeEach(() => {
    invalidateCache();
    vi.clearAllMocks();
  });

  it('never lets a portless desktop app contribute a port to the reserved set', async () => {
    // A desktop/GUI app (a game binary) has no HTTP port at all: all top-level
    // port fields are null and its supervised process carries no ports map.
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS', uiPort: 5555, apiPort: 5555, devUiPort: 5554 },
        'the-game': {
          name: 'The Game',
          type: 'desktop',
          uiPort: null,
          apiPort: null,
          devUiPort: null,
          tlsPort: null,
          pm2ProcessNames: ['the-game'],
          processes: [{ name: 'the-game' }], // no `port` / `ports` — portless
        },
      },
    });

    const reserved = await getReservedPorts();
    // Only PortOS baseline ports — the desktop app added nothing.
    expect(reserved).toContain(5555);
    expect(reserved).toContain(5554);
    expect(reserved).not.toContain(null);
    expect(reserved.every(p => Number.isInteger(p) && p >= 1 && p <= 65535)).toBe(true);
    expect(reserved).toEqual([5554, 5555]);
  });

  it('createApp stores a desktop app with null ports (no port ever synthesized)', async () => {
    readJSONFile.mockResolvedValue({ apps: { [PORTOS_APP_ID]: { name: 'PortOS' } } });

    const created = await createApp({
      name: 'The Game',
      repoPath: '/tmp/the-game',
      type: 'desktop',
      startCommands: ['./scripts/game run'],
    });

    expect(created.type).toBe('desktop');
    expect(created.uiPort).toBeNull();
    expect(created.apiPort).toBeNull();
    expect(created.devUiPort).toBeNull();
    expect(created.startCommands).toEqual(['./scripts/game run']);

    // The persisted record carries no numeric port anywhere.
    const persisted = atomicWrite.mock.calls.at(-1)?.[1];
    const stored = persisted.apps[created.id];
    expect(stored.uiPort).toBeNull();
    expect(stored.apiPort).toBeNull();
    expect(stored.devUiPort).toBeNull();
  });

  it('createApp persists an explicit repo-state-audit opt-out, and leaves it absent otherwise', async () => {
    // Absent means ON (repoStateVerificationEnabled), so createApp must NOT stamp a
    // default — that would freeze the app against a later change of that default.
    // But an explicit `false` has to survive, or a new app cannot opt out via POST
    // at all: createApp builds the record field-by-field and drops anything it
    // doesn't name.
    readJSONFile.mockResolvedValue({ apps: { [PORTOS_APP_ID]: { name: 'PortOS' } } });

    const optedOut = await createApp({
      name: 'Quiet App',
      repoPath: '/tmp/quiet-app',
      verifyRepoStateOnCompletion: false,
    });
    expect(optedOut.verifyRepoStateOnCompletion).toBe(false);
    expect(atomicWrite.mock.calls.at(-1)[1].apps[optedOut.id].verifyRepoStateOnCompletion).toBe(false);

    const unset = await createApp({ name: 'Default App', repoPath: '/tmp/default-app' });
    expect(unset).not.toHaveProperty('verifyRepoStateOnCompletion');
    expect(atomicWrite.mock.calls.at(-1)[1].apps[unset.id]).not.toHaveProperty('verifyRepoStateOnCompletion');
  });

  it('createApp preserves managed-app feature overrides', async () => {
    readJSONFile.mockResolvedValue({ apps: { [PORTOS_APP_ID]: { name: 'PortOS' } } });
    const featureOverrides = { datadog: true, jira: null, gsd: false };

    const created = await createApp({
      name: 'Feature App',
      repoPath: '/tmp/feature-app',
      featureOverrides,
    });

    expect(created.featureOverrides).toEqual(featureOverrides);
    expect(atomicWrite.mock.calls.at(-1)[1].apps[created.id].featureOverrides).toEqual(featureOverrides);
  });

  it('createApp preserves web ports when a separate native target is present', async () => {
    readJSONFile.mockResolvedValue({ apps: { [PORTOS_APP_ID]: { name: 'PortOS' } } });
    const nativeLaunch = {
      label: 'Godot',
      command: './scripts/game run',
      processName: 'mixed-game',
    };

    const created = await createApp({
      name: 'Mixed App',
      repoPath: '/tmp/mixed-app',
      type: 'express',
      uiPort: 3000,
      pm2ProcessNames: ['mixed-web'],
      nativeLaunch,
    });

    expect(created).toMatchObject({
      type: 'express',
      uiPort: 3000,
      pm2ProcessNames: ['mixed-web'],
      nativeLaunch,
    });
    expect(atomicWrite.mock.calls.at(-1)?.[1].apps[created.id].nativeLaunch).toEqual(nativeLaunch);
  });

});

describe('managed app feature overrides', () => {
  beforeEach(() => {
    invalidateCache();
    vi.clearAllMocks();
  });

  it('merges partial updates without deleting sibling overrides', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS' },
        'app-1': {
          name: 'Feature App',
          featureOverrides: { datadog: true, gsd: false },
        },
      },
    });

    const updated = await updateApp('app-1', { featureOverrides: { jira: false } });

    expect(updated.featureOverrides).toEqual({ datadog: true, jira: false, gsd: false });
    expect(atomicWrite.mock.calls.at(-1)[1].apps['app-1'].featureOverrides).toEqual({
      datadog: true,
      jira: false,
      gsd: false,
    });
  });
});

describe('deleteApp', () => {
  beforeEach(() => {
    invalidateCache();
    vi.clearAllMocks();
  });

  it('removes only the PortOS registry record and preserves the app path data', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS' },
        'app-1': { name: 'Example App', repoPath: '/mock/example-app' },
      },
    });

    await expect(deleteApp('app-1')).resolves.toBe(true);

    const persisted = atomicWrite.mock.calls.at(-1)[1];
    expect(persisted.apps['app-1']).toBeUndefined();
    expect(persisted.apps[PORTOS_APP_ID]).toMatchObject({ name: 'PortOS' });
  });

  it('protects the PortOS baseline record', async () => {
    await expect(deleteApp(PORTOS_APP_ID)).resolves.toBe(false);
    expect(readJSONFile).not.toHaveBeenCalled();
    expect(atomicWrite).not.toHaveBeenCalled();
  });
});

describe('__PORTOS_ROOT__ placeholder expansion on load', () => {
  beforeEach(() => {
    invalidateCache();
    vi.clearAllMocks();
  });

  it('expands and persists placeholder repoPath and appIconPath', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: {
          name: 'PortOS',
          repoPath: '__PORTOS_ROOT__',
          appIconPath: '__PORTOS_ROOT__/client/public/portos-logo.png',
          type: 'express',
          pm2ProcessNames: ['portos-server'],
        },
      },
    });

    const apps = await getAllApps();
    const portos = apps.find((app) => app.id === PORTOS_APP_ID);
    expect(portos.repoPath).toBe('/mock/root');
    expect(portos.appIconPath).toBe('/mock/root/client/public/portos-logo.png');

    expect(atomicWrite).toHaveBeenCalled();
    const persisted = atomicWrite.mock.calls.at(-1)[1];
    expect(persisted.apps[PORTOS_APP_ID].repoPath).toBe('/mock/root');
    expect(persisted.apps[PORTOS_APP_ID].appIconPath).toBe('/mock/root/client/public/portos-logo.png');
    expect(JSON.stringify(persisted)).not.toContain('__PORTOS_ROOT__');
  });

  it('preserves a concrete user-overridden repoPath', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: {
          name: 'PortOS',
          repoPath: '/custom/portos/checkout',
          type: 'express',
          pm2ProcessNames: ['portos-server'],
        },
      },
    });

    const apps = await getAllApps();
    const portos = apps.find((app) => app.id === PORTOS_APP_ID);
    expect(portos.repoPath).toBe('/custom/portos/checkout');
  });

  it('expands placeholders on non-PortOS app records too', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: {
          name: 'PortOS',
          repoPath: '/mock/root',
          type: 'express',
          pm2ProcessNames: ['portos-server'],
        },
        'other-app': {
          name: 'Other',
          repoPath: '__PORTOS_ROOT__/../sibling',
          appIconPath: '__PORTOS_ROOT__/icon.png',
          type: 'node',
        },
      },
    });

    const apps = await getAllApps();
    const other = apps.find((app) => app.id === 'other-app');
    expect(other.repoPath).toBe('/mock/root/../sibling');
    expect(other.appIconPath).toBe('/mock/root/icon.png');

    const persisted = atomicWrite.mock.calls.at(-1)[1];
    expect(persisted.apps['other-app'].repoPath).toBe('/mock/root/../sibling');
    expect(persisted.apps['other-app'].appIconPath).toBe('/mock/root/icon.png');
  });
});
