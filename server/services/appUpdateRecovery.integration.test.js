import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';

vi.mock('../lib/detachedSpawn.js', () => ({ spawnDetached: vi.fn(), isDetachedRunning: vi.fn(async () => false) }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn(async () => ({ id: 'portos-default', name: 'PortOS', repoPath: '/example/portos' })),
  notifyAppsChanged: vi.fn() }));
vi.mock('./appUpdater.js', () => ({ updateApp: vi.fn() }));
vi.mock('./updatePreflight.js', () => ({ checkPortosUpdatePreflight: vi.fn(async () => {}) }));
vi.mock('./history.js', () => ({ logAction: vi.fn(async () => {}) }));
vi.mock('./updateChecker.js', () => ({ recordUpdateResult: vi.fn(async () => {}), getCurrentVersion: vi.fn(async () => '1.0.0') }));

import { spawnDetached } from '../lib/detachedSpawn.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { createMaintenanceJournal } from '../lib/maintenanceJournal.js';
import * as appUpdater from './appUpdater.js';
import { runAppUpdate } from './appUpdateRunner.js';
import { __resetAppOperations, listActiveAppOperations } from './appOperations.js';
import { launchUpdate } from './updateExecutor.js';

afterEach(() => { __resetAppOperations(); vi.clearAllMocks(); });

describe('App Management update recovery', () => {
  it.each(['unclaimed', 'claimed', 'reused', 'reused-short'])('removes a stale %s supervisor row and permits retry', async scenario => {
    const pid = 2147483647;
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stopTailing = vi.fn(async () => {});
    spawnDetached.mockImplementationOnce(async (_cmd, _args, options) => {
      if (scenario === 'claimed') {
        const id = options.env.PORTOS_DEFERRED_UPDATE_LAUNCH_ID;
        maintenance.deferredUpdate.claimLaunch(id);
        createMaintenanceJournal(dirname(maintenance.directory)).transaction(state => {
          state.operations.find(op => op.id === id).pid = pid;
        });
      }
      return child;
    });
    appUpdater.updateApp.mockImplementationOnce(async (_app, emit) => {
      const launched = await launchUpdate('v1.0.0', emit, { admission: maintenance,
        supervisorAbsent: value => !scenario.startsWith('reused') && value === pid, monitorIntervalMs: 10,
        supervisorSnapshot: async () => [{ pid, startedAt: Math.floor(Date.now() / 1000) * 1000,
          command: scenario === 'reused-short' ? '/usr/bin/cat' : 'node /other/scripts/deferred-update.mjs' }] });
      return { success: true, selfUpdateStarted: true, supervisorPid: launched.supervisorPid, completion: launched.completion, steps: [] };
    });
    const io = { emit: vi.fn() };
    await expect(runAppUpdate({ io, appId: 'portos-default' })).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(listActiveAppOperations()).toEqual([]));
    expect(maintenance.deferredUpdate.launch()).toBeNull();
    expect(child.stopTailing).toHaveBeenCalledOnce();
    appUpdater.updateApp.mockResolvedValueOnce({ success: true, steps: [] });
    await expect(runAppUpdate({ io, appId: 'portos-default' })).resolves.toEqual({ ok: true });
  });
});
