import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EIDOVERSE_LOOPBACK_PRELOAD, eidoverseStartCommand } from '../lib/eidoverseStartCommand.js';

const mock = vi.hoisted(() => ({ apps: [], bun: { command: '/example/bun' }, status: null }));
vi.mock('./apps.js', () => ({
  getAllApps: async () => structuredClone(mock.apps),
  updateApp: vi.fn(async (id, fields) => Object.assign(mock.apps.find((app) => app.id === id), fields)),
  notifyAppsChanged: vi.fn(),
}));
vi.mock('./eidoverse.js', () => ({
  EIDOVERSE_MAX_MEMORY_RESTART: '2G',
  EIDOVERSE_PORT: 8940,
  EIDOVERSE_PROCESS_NAME: 'eidoverse-worlds',
  findManagedApp: (apps) => apps.find((app) => app.pm2ProcessNames.includes('eidoverse-worlds')) || null,
  resolveBunRuntime: async () => mock.bun,
}));
vi.mock('./pm2.js', () => ({
  getAppStatusStrict: vi.fn(async () => mock.status),
  deleteApp: vi.fn(async () => ({ success: true })),
  restartApp: vi.fn(async () => ({ success: true })),
  startWithCommand: vi.fn(async () => ({ success: true })),
}));

import { updateApp } from './apps.js';
import { deleteApp, restartApp, startWithCommand } from './pm2.js';
import { ensureEidoverseLoopback, launchEidoverseProcess, restartEidoverseProcess } from './eidoverseLaunch.js';

const LEGACY = 'bun --env-file=.env.portos server/server.ts';
const SAFE = eidoverseStartCommand('bun');
const SAFE_ARGS = ['--preload', EIDOVERSE_LOOPBACK_PRELOAD, '--env-file=.env.portos', 'server/server.ts'];
const LEGACY_ARGS = ['--env-file=.env.portos', 'server/server.ts'];
const LAUNCH = ['eidoverse-worlds', '/example/worlds', SAFE, { pm2Home: '/example/pm2', port: 8940, maxMemoryRestart: '2G' }];

beforeEach(() => {
  vi.clearAllMocks();
  mock.bun = { command: '/example/bun' };
  mock.status = { status: 'not_found' };
  mock.apps = [{
    id: 'example-world', repoPath: '/example/worlds', pm2Home: '/example/pm2',
    pm2ProcessNames: ['eidoverse-worlds'], startCommands: [LEGACY],
  }];
});

describe('upgrade of an existing managed app', () => {
  it.each(['online', 'launching', 'waiting restart'])('rewrites the stored command and replaces a(n) %s process', async (status) => {
    mock.status = { status, args: LEGACY_ARGS };
    await expect(ensureEidoverseLoopback()).resolves.toEqual({ replaced: true });
    expect(mock.apps[0].startCommands).toEqual([SAFE]);
    expect(deleteApp).toHaveBeenCalledWith('eidoverse-worlds', '/example/pm2');
    expect(startWithCommand).toHaveBeenCalledExactlyOnceWith(...LAUNCH);
    expect(deleteApp.mock.invocationCallOrder[0]).toBeLessThan(startWithCommand.mock.invocationCallOrder[0]);
  });

  it('replaces a process restored with old arguments even when the stored command is current', async () => {
    mock.apps[0].startCommands = [SAFE];
    mock.status = { status: 'online', args: LEGACY_ARGS };
    await expect(ensureEidoverseLoopback()).resolves.toEqual({ replaced: true });
    expect(updateApp).not.toHaveBeenCalled();
    expect(startWithCommand).toHaveBeenCalledWith(...LAUNCH);
  });

  it('drops a stopped unprotected entry without starting it', async () => {
    mock.status = { status: 'stopped', args: LEGACY_ARGS };
    await expect(ensureEidoverseLoopback()).resolves.toEqual({ replaced: false });
    expect(deleteApp).toHaveBeenCalledOnce();
    expect(startWithCommand).not.toHaveBeenCalled();
  });

  it('leaves a protected process and an uninstalled feature alone', async () => {
    mock.apps[0].startCommands = [SAFE];
    mock.status = { status: 'online', args: SAFE_ARGS };
    await expect(ensureEidoverseLoopback()).resolves.toEqual({ replaced: false });
    mock.apps = [];
    await expect(ensureEidoverseLoopback()).resolves.toEqual({ replaced: false });
    expect(updateApp).not.toHaveBeenCalled();
    expect(deleteApp).not.toHaveBeenCalled();
  });

  it('never treats unreadable PM2 state as protected, or replaces a process on it', async () => {
    mock.status = null;
    await expect(ensureEidoverseLoopback()).rejects.toMatchObject({ code: 'EIDOVERSE_RUNTIME_UNKNOWN' });
    expect(mock.apps[0].startCommands).toEqual([SAFE]);
    expect(deleteApp).not.toHaveBeenCalled();
  });

  it('reports a failed replacement', async () => {
    mock.status = { status: 'online', args: LEGACY_ARGS };
    startWithCommand.mockResolvedValueOnce({ success: false });
    await expect(ensureEidoverseLoopback()).rejects.toMatchObject({ code: 'EIDOVERSE_START_FAILED' });
  });
});

describe('start and restart', () => {
  it('falls back to the managed command when the stored one does not run Bun', async () => {
    mock.apps[0].startCommands = ['./start.sh'];
    await launchEidoverseProcess(mock.apps[0]);
    expect(startWithCommand.mock.calls[0][2]).toBe(eidoverseStartCommand('/example/bun'));
    mock.bun = null;
    mock.apps[0].startCommands = [];
    await launchEidoverseProcess(mock.apps[0]);
    expect(startWithCommand.mock.calls[1][2]).toBe(SAFE);
  });

  it('keeps the running process when there is no checkout to relaunch from', async () => {
    mock.status = { status: 'online', args: LEGACY_ARGS };
    await expect(launchEidoverseProcess({ ...mock.apps[0], repoPath: '' }))
      .rejects.toMatchObject({ code: 'EIDOVERSE_LAUNCH_UNAVAILABLE' });
    expect(deleteApp).not.toHaveBeenCalled();
  });

  it('restarts a protected process in place and recreates an unprotected one', async () => {
    mock.status = { status: 'online', args: SAFE_ARGS };
    await restartEidoverseProcess(mock.apps[0]);
    expect(restartApp).toHaveBeenCalledWith('eidoverse-worlds', '/example/pm2');
    expect(startWithCommand).not.toHaveBeenCalled();
    mock.status = { status: 'online', args: LEGACY_ARGS };
    await restartEidoverseProcess(mock.apps[0]);
    expect(restartApp).toHaveBeenCalledOnce();
    expect(startWithCommand).toHaveBeenCalledWith(...LAUNCH);
  });
});
