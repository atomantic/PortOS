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
  SELF_IMPROVEMENT_TASK_TYPES: [],
  resetExecutionHistory: vi.fn().mockResolvedValue({ error: 'No execution history found' }),
}));

vi.mock('./pm2.js', () => ({
  // Strict variant: resolves an array on success (incl. []), or null on a
  // failed PM2 read. The status getters use this, not the forgiving listProcesses.
  listProcessesStrict: vi.fn().mockResolvedValue([]),
}));

import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { listProcessesStrict } from './pm2.js';
import { resetExecutionHistory } from './taskSchedule.js';
import { getAppStatuses, getAppStatusSummary, getReservedPorts, invalidateCache, PORTOS_APP_ID, updateAppTaskTypeOverride } from './apps.js';

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

describe('getAppStatusSummary', () => {
  beforeEach(() => {
    invalidateCache();
    vi.clearAllMocks();
  });

  it('counts only PM2-managed apps in total and tracks native projects separately', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: {
          name: 'PortOS',
          type: 'express',
          pm2ProcessNames: ['portos-server']
        },
        'svc-a': {
          name: 'svc-a',
          type: 'express',
          pm2ProcessNames: ['svc-a']
        },
        'svc-b': {
          name: 'svc-b',
          type: 'express',
          pm2ProcessNames: ['svc-b']
        },
        'ios-app': {
          name: 'iOS App',
          type: 'ios-native'
        },
        'xcode-app': {
          name: 'Xcode App',
          type: 'xcode'
        }
      }
    });
    listProcessesStrict.mockResolvedValue([
      { name: 'portos-server', status: 'online' },
      { name: 'svc-a', status: 'stopped' }
      // svc-b is missing → not_found → notStarted
    ]);

    const summary = await getAppStatusSummary();
    expect(summary).toEqual({
      total: 3,
      online: 1,
      stopped: 1,
      notStarted: 1,
      unknown: 0,
      degraded: false,
      unmanaged: 2
    });
  });

  it('returns zero counts when no apps are registered (native or otherwise)', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: {
          name: 'PortOS',
          type: 'express',
          pm2ProcessNames: ['portos-server']
        }
      }
    });
    listProcessesStrict.mockResolvedValue([{ name: 'portos-server', status: 'online' }]);

    const summary = await getAppStatusSummary();
    expect(summary).toEqual({
      total: 1,
      online: 1,
      stopped: 0,
      notStarted: 0,
      unknown: 0,
      degraded: false,
      unmanaged: 0
    });
  });

  it('queries each unique pm2Home only once', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: {
          name: 'PortOS',
          type: 'express',
          pm2ProcessNames: ['portos-server']
        },
        'shared-home-a': {
          name: 'a',
          type: 'express',
          pm2ProcessNames: ['a']
        },
        'shared-home-b': {
          name: 'b',
          type: 'express',
          pm2ProcessNames: ['b']
        },
        'custom-home': {
          name: 'c',
          type: 'express',
          pm2Home: '/tmp/other-pm2',
          pm2ProcessNames: ['c']
        }
      }
    });
    listProcessesStrict.mockImplementation(async (home) => {
      if (home === '/tmp/other-pm2') return [{ name: 'c', status: 'online' }];
      return [
        { name: 'portos-server', status: 'online' },
        { name: 'a', status: 'online' },
        { name: 'b', status: 'stopped' }
      ];
    });

    const summary = await getAppStatusSummary();
    expect(listProcessesStrict).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ total: 4, online: 3, stopped: 1, notStarted: 0, unmanaged: 0 });
  });

  it('skips archived apps', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: {
          name: 'PortOS',
          type: 'express',
          pm2ProcessNames: ['portos-server']
        },
        'old-app': {
          name: 'old',
          type: 'express',
          pm2ProcessNames: ['old'],
          archived: true
        }
      }
    });
    listProcessesStrict.mockResolvedValue([{ name: 'portos-server', status: 'online' }]);

    const summary = await getAppStatusSummary();
    expect(summary.total).toBe(1);
  });

  it('marks the summary degraded (not all not-started) when a PM2 read fails', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS', type: 'express', pm2ProcessNames: ['portos-server'] },
        'svc-a': { name: 'svc-a', type: 'express', pm2ProcessNames: ['svc-a'] }
      }
    });
    // Strict read returns null on a transient PM2 failure (NOT an empty list).
    listProcessesStrict.mockResolvedValue(null);

    const summary = await getAppStatusSummary();
    expect(summary).toEqual({
      total: 2,
      online: 0,
      stopped: 0,
      notStarted: 0,
      unknown: 2,
      degraded: true,
      unmanaged: 0
    });
  });

  it('keeps accurate counts for healthy homes when only one home fails', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS', type: 'express', pm2ProcessNames: ['portos-server'] },
        'custom-home': { name: 'c', type: 'express', pm2Home: '/tmp/other-pm2', pm2ProcessNames: ['c'] }
      }
    });
    listProcessesStrict.mockImplementation(async (home) => {
      if (home === '/tmp/other-pm2') return null; // this home's read failed
      return [{ name: 'portos-server', status: 'online' }];
    });

    const summary = await getAppStatusSummary();
    expect(summary).toMatchObject({ total: 2, online: 1, unknown: 1, degraded: true });
  });
});

describe('getAppStatuses', () => {
  beforeEach(() => {
    invalidateCache();
    vi.clearAllMocks();
  });

  it('reports unknown + degraded for apps whose PM2 home read failed', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS', type: 'express', pm2ProcessNames: ['portos-server'] }
      }
    });
    listProcessesStrict.mockResolvedValue(null);

    const statuses = await getAppStatuses();
    const portos = statuses.find(s => s.id === PORTOS_APP_ID);
    expect(portos.overallStatus).toBe('unknown');
    expect(portos.degraded).toBe(true);
  });

  it('does NOT mark apps unknown when the PM2 home reads an empty list', async () => {
    readJSONFile.mockResolvedValue({
      apps: {
        [PORTOS_APP_ID]: { name: 'PortOS', type: 'express', pm2ProcessNames: ['portos-server'] }
      }
    });
    // Successful read, genuinely no processes → not_started, NOT unknown.
    listProcessesStrict.mockResolvedValue([]);

    const statuses = await getAppStatuses();
    const portos = statuses.find(s => s.id === PORTOS_APP_ID);
    expect(portos.overallStatus).toBe('not_started');
    expect(portos.degraded).toBeUndefined();
  });
});
