import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apps: [],
  appsError: null,
  processes: [],
}));

vi.mock('./apps.js', () => ({
  getAllApps: vi.fn(),
}));

vi.mock('./pm2.js', () => ({
  listProcessesStrict: vi.fn(),
}));

import { getAllApps } from './apps.js';
import { listProcessesStrict } from './pm2.js';
import {
  annotateExpectedExit,
  getAppStatuses,
  getAppStatusSummary,
  getDesktopProcessNames,
  resolvePm2HomeForProcess,
} from './appProcessStatus.js';

const setApps = (...apps) => {
  mocks.apps = apps;
  mocks.appsError = null;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apps = [];
  mocks.appsError = null;
  mocks.processes = [];
  getAllApps.mockImplementation(async ({ includeArchived = true } = {}) => {
    if (mocks.appsError) throw mocks.appsError;
    return includeArchived ? mocks.apps : mocks.apps.filter(app => !app.archived);
  });
  listProcessesStrict.mockImplementation(async () => mocks.processes);
});

describe('getDesktopProcessNames', () => {
  it('collects desktop process names and native launch targets, including archived apps', async () => {
    setApps(
      { id: 'web', type: 'express', pm2ProcessNames: ['web'] },
      { id: 'game', type: 'desktop', archived: true, pm2ProcessNames: ['game', 'game-alt'] },
      { id: 'mixed', type: 'express', nativeLaunch: { processName: 'mixed-game' } },
    );

    await expect(getDesktopProcessNames()).resolves.toEqual(new Set(['game', 'game-alt', 'mixed-game']));
  });

  it('returns an empty set when no matching app exists', async () => {
    setApps({ id: 'web', type: 'express', pm2ProcessNames: ['web'] });

    await expect(getDesktopProcessNames()).resolves.toEqual(new Set());
  });
});

describe('resolvePm2HomeForProcess', () => {
  it('resolves a custom home for a PM2 process', async () => {
    setApps({ id: 'custom', type: 'express', pm2Home: '/tmp/example-pm2', pm2ProcessNames: ['example-api'] });

    await expect(resolvePm2HomeForProcess('example-api')).resolves.toBe('/tmp/example-pm2');
  });

  it('resolves a custom home for a native launch process', async () => {
    setApps({
      id: 'mixed',
      type: 'express',
      pm2Home: '/tmp/example-pm2',
      nativeLaunch: { processName: 'mixed-game' },
    });

    await expect(resolvePm2HomeForProcess('mixed-game')).resolves.toBe('/tmp/example-pm2');
  });

  it('returns null for an app using the default home or an unknown process', async () => {
    setApps({ id: 'default', type: 'express', pm2ProcessNames: ['example-api'] });

    await expect(resolvePm2HomeForProcess('example-api')).resolves.toBeNull();
    await expect(resolvePm2HomeForProcess('missing')).resolves.toBeNull();
  });
});

describe('annotateExpectedExit', () => {
  it('marks desktop and native processes while preserving their input shape', async () => {
    setApps(
      { id: 'web', type: 'express', pm2ProcessNames: ['web'] },
      { id: 'game', type: 'desktop', pm2ProcessNames: ['game'] },
    );

    await expect(annotateExpectedExit([
      { name: 'web', status: 'errored' },
      { name: 'game', pm2_env: { status: 'errored' } },
    ])).resolves.toEqual([
      { name: 'web', status: 'errored', expectedExit: false },
      { name: 'game', pm2_env: { status: 'errored' }, expectedExit: true },
    ]);
  });

  it('fails open when the registry read fails', async () => {
    mocks.appsError = new Error('registry unreadable');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(annotateExpectedExit([{ name: 'game', status: 'errored' }])).resolves.toEqual([
      { name: 'game', status: 'errored', expectedExit: false },
    ]);
    errorSpy.mockRestore();
  });
});

describe('getAppStatuses', () => {
  it('reports desktop lifecycle state from PM2 and excludes archived apps', async () => {
    setApps(
      { id: 'web', name: 'Web', type: 'express', repoPath: '/tmp/web', pm2ProcessNames: ['web'] },
      { id: 'game', name: 'Game', type: 'desktop', repoPath: '/tmp/game', pm2ProcessNames: ['game'] },
      { id: 'old', name: 'Old', type: 'express', archived: true, pm2ProcessNames: ['old'] },
    );
    mocks.processes = [
      { name: 'web', status: 'online' },
      { name: 'game', status: 'stopped' },
    ];

    const statuses = await getAppStatuses();

    expect(statuses).toEqual([
      { id: 'web', name: 'Web', type: 'express', repoPath: '/tmp/web', overallStatus: 'online', managed: true },
      { id: 'game', name: 'Game', type: 'desktop', repoPath: '/tmp/game', overallStatus: 'stopped', managed: true },
    ]);
  });

  it('distinguishes a failed PM2 read from a successful empty read', async () => {
    setApps({ id: 'web', name: 'Web', type: 'express', repoPath: '/tmp/web', pm2ProcessNames: ['web'] });

    mocks.processes = null;
    const failed = await getAppStatuses();
    expect(failed[0]).toMatchObject({ overallStatus: 'unknown', managed: true, degraded: true });

    mocks.processes = [];
    const empty = await getAppStatuses();
    expect(empty[0]).toMatchObject({ overallStatus: 'not_started', managed: true });
    expect(empty[0].degraded).toBeUndefined();
  });

  it('reports native projects as unmanaged and queries each PM2 home once', async () => {
    setApps(
      { id: 'a', name: 'A', type: 'express', pm2ProcessNames: ['a'] },
      { id: 'b', name: 'B', type: 'express', pm2Home: '/tmp/example-pm2', pm2ProcessNames: ['b'] },
      { id: 'native', name: 'Native', type: 'ios-native' },
    );
    listProcessesStrict.mockImplementation(async (home) => home === '/tmp/example-pm2'
      ? [{ name: 'b', status: 'online' }]
      : [{ name: 'a', status: 'stopped' }]);

    const statuses = await getAppStatuses();

    expect(listProcessesStrict).toHaveBeenCalledTimes(2);
    expect(statuses.find(status => status.id === 'native')).toMatchObject({ overallStatus: 'n/a', managed: false });
    expect(statuses.find(status => status.id === 'a')).toMatchObject({ overallStatus: 'stopped', managed: true });
    expect(statuses.find(status => status.id === 'b')).toMatchObject({ overallStatus: 'online', managed: true });
  });
});

describe('getAppStatusSummary', () => {
  it('counts managed, unmanaged, and unknown states without collapsing failures to not-started', async () => {
    setApps(
      { id: 'online', type: 'express', pm2ProcessNames: ['online'] },
      { id: 'stopped', type: 'express', pm2ProcessNames: ['stopped'] },
      { id: 'missing', type: 'express', pm2ProcessNames: ['missing'] },
      { id: 'native', type: 'xcode' },
    );
    mocks.processes = [
      { name: 'online', status: 'online' },
      { name: 'stopped', status: 'stopped' },
    ];

    await expect(getAppStatusSummary()).resolves.toEqual({
      total: 3,
      online: 1,
      stopped: 1,
      notStarted: 1,
      unknown: 0,
      degraded: false,
      unmanaged: 1,
    });

    mocks.processes = null;
    await expect(getAppStatusSummary()).resolves.toMatchObject({
      total: 3,
      online: 0,
      stopped: 0,
      notStarted: 0,
      unknown: 3,
      degraded: true,
      unmanaged: 1,
    });
  });
});
