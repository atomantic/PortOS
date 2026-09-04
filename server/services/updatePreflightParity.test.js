import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';

// Both POST /api/update/execute (server/routes/update.js) and the app:update
// socket handler for the PortOS app (server/sockets/apps.js) now route their
// refusal logic through the same checkPortosUpdatePreflight() (issue #5984).
// This suite proves that sharing: it drives BOTH entry points from identical
// mocked agent/persistent-mind/fork state and asserts they refuse with the
// same code and message, rather than re-covering every guard permutation
// already exercised per-route in update.test.js.
vi.mock('../services/updateChecker.js', () => ({
  getUpdateStatus: vi.fn(),
  setUpdateInProgress: vi.fn().mockResolvedValue(true),
}));
vi.mock('../services/updateExecutor.js', () => ({
  executeUpdate: vi.fn().mockResolvedValue({ success: true, version: '1.26.0' }),
}));
const { mockSpawningTasks } = vi.hoisted(() => ({ mockSpawningTasks: new Set() }));
vi.mock('../services/agentState.js', () => ({
  getActiveAgentIds: vi.fn().mockReturnValue([]),
  spawningTasks: mockSpawningTasks,
}));
vi.mock('../services/cosAgentLifecycle.js', () => ({
  filterLiveAgentIds: vi.fn(async (ids) => ids),
}));
const { mockCosState } = vi.hoisted(() => ({
  mockCosState: { persistentMind: { queuedMessages: [], activeTurn: null } },
}));
vi.mock('../services/cosState.js', () => ({
  readPersistentMindStateForSafetyCheck: vi.fn(async () => ({
    trusted: true,
    persistentMind: mockCosState.persistentMind,
  })),
  withStateLock: vi.fn(async (fn) => fn()),
}));

const portosApp = { id: PORTOS_APP_ID, name: 'PortOS', repoPath: '/repo' };
vi.mock('../services/apps.js', () => ({
  getAppById: vi.fn(async () => portosApp),
  notifyAppsChanged: vi.fn(),
}));
vi.mock('../services/history.js', () => ({ logAction: vi.fn() }));
vi.mock('../services/appUpdater.js', () => ({ updateApp: vi.fn() }));
vi.mock('../services/appDeployer.js', () => ({ runDeployFlow: vi.fn() }));
vi.mock('../services/pm2Standardizer.js', () => ({}));
vi.mock('../services/streamingDetect.js', () => ({ streamDetection: vi.fn() }));

import * as updateChecker from '../services/updateChecker.js';
import { executeUpdate } from '../services/updateExecutor.js';
import { getActiveAgentIds } from '../services/agentState.js';
import { readPersistentMindStateForSafetyCheck } from '../services/cosState.js';
import { updateApp as appUpdaterUpdateApp } from '../services/appUpdater.js';
import updateRoutes from '../routes/update.js';
import { registerAppHandlers } from '../sockets/apps.js';

const makeRouteApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/update', updateRoutes);
  app.use(errorMiddleware);
  return app;
};

// Minimal fake socket/io: records emit() calls and lets the test fire the
// registered 'app:update' handler directly.
const makeSocketHarness = () => {
  const handlers = new Map();
  const emitted = [];
  const socket = {
    on: (event, fn) => { handlers.set(event, fn); },
    emit: (event, payload) => { emitted.push({ event, payload }); },
  };
  const io = { emit: (event, payload) => { emitted.push({ event, payload }); } };
  registerAppHandlers(socket, io);
  return {
    fireUpdate: (payload) => handlers.get('app:update')(payload),
    emitted,
  };
};

// A baseline in-sync, non-fork status with a cached release — mirrors
// update.test.js's baseStatus so both suites describe the same "healthy"
// server state.
const baseStatus = (overrides = {}) => ({
  currentVersion: '1.26.0',
  latestRelease: { tag: 'v1.27.0', version: '1.27.0' },
  remoteInfo: { isFork: false, hasOrigin: true, fullName: 'atomantic/PortOS' },
  upstream: { fullName: 'atomantic/PortOS' },
  forkSyncFresh: false,
  installState: { outOfSync: false },
  ...overrides
});

describe('PortOS update preflight parity — route vs. socket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawningTasks.clear();
    updateChecker.setUpdateInProgress.mockResolvedValue(true);
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus());
    executeUpdate.mockResolvedValue({ success: true, version: '1.26.0' });
    getActiveAgentIds.mockReturnValue([]);
    mockCosState.persistentMind = { queuedMessages: [], activeTurn: null };
    readPersistentMindStateForSafetyCheck.mockImplementation(async () => ({
      trusted: true,
      persistentMind: mockCosState.persistentMind,
    }));
  });

  it('refuses identically when a CoS agent is live', async () => {
    getActiveAgentIds.mockReturnValue(['agent-1']);

    const routeRes = await request(makeRouteApp()).post('/api/update/execute').send({});
    expect(routeRes.status).toBe(409);
    expect(routeRes.body.code).toBe('AGENTS_ACTIVE');

    const { fireUpdate, emitted } = makeSocketHarness();
    await fireUpdate({ appId: PORTOS_APP_ID });
    const errorEvent = emitted.find((e) => e.event === 'app:update:error');
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.payload.code).toBe('AGENTS_ACTIVE');
    expect(errorEvent.payload.message).toBe(routeRes.body.error);
    expect(appUpdaterUpdateApp).not.toHaveBeenCalled();
  });

  it('refuses identically when Persistent Mind has unacknowledged queued image work', async () => {
    mockCosState.persistentMind = {
      queuedMessages: [{ id: 'message-example', images: [{ attachmentId: 'attachment-example' }] }],
      activeTurn: null,
    };

    const routeRes = await request(makeRouteApp()).post('/api/update/execute').send({});
    expect(routeRes.status).toBe(409);
    expect(routeRes.body.code).toBe('PERSISTENT_MIND_IMAGES_IN_FLIGHT');

    const { fireUpdate, emitted } = makeSocketHarness();
    await fireUpdate({ appId: PORTOS_APP_ID });
    const errorEvent = emitted.find((e) => e.event === 'app:update:error');
    expect(errorEvent.payload.code).toBe('PERSISTENT_MIND_IMAGES_IN_FLIGHT');
    expect(errorEvent.payload.message).toBe(routeRes.body.error);
    expect(appUpdaterUpdateApp).not.toHaveBeenCalled();
  });

  it('refuses identically when running from an unsynced fork, and both honor acknowledgeFork', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus({
      remoteInfo: { isFork: true, hasOrigin: true, fullName: 'alice/PortOS' },
      forkSyncFresh: false,
    }));

    const routeRes = await request(makeRouteApp()).post('/api/update/execute').send({});
    expect(routeRes.status).toBe(412);
    expect(routeRes.body.code).toBe('FORK_SYNC_REQUIRED');

    const { fireUpdate, emitted } = makeSocketHarness();
    await fireUpdate({ appId: PORTOS_APP_ID });
    const errorEvent = emitted.find((e) => e.event === 'app:update:error');
    expect(errorEvent.payload.code).toBe('FORK_SYNC_REQUIRED');
    expect(errorEvent.payload.message).toBe(routeRes.body.error);
    expect(appUpdaterUpdateApp).not.toHaveBeenCalled();

    // Both honor the acknowledgement and proceed.
    const ackRouteRes = await request(makeRouteApp()).post('/api/update/execute').send({ acknowledgeFork: true });
    expect(ackRouteRes.status).toBe(200);

    appUpdaterUpdateApp.mockResolvedValue({ success: true, steps: [] });
    const { fireUpdate: fireAckUpdate } = makeSocketHarness();
    await fireAckUpdate({ appId: PORTOS_APP_ID, acknowledgeFork: true });
    expect(appUpdaterUpdateApp).toHaveBeenCalledWith(portosApp, expect.any(Function), {
      syncFork: false, acknowledgeFork: true, acknowledgePersistentMindImageBackup: false,
    });
  });

  it('a non-PortOS app is never subject to the PortOS preflight', async () => {
    const { getAppById } = await import('../services/apps.js');
    getAppById.mockResolvedValueOnce({ id: 'some-other-app', name: 'Other App', repoPath: '/other' });
    getActiveAgentIds.mockReturnValue(['agent-1']); // would refuse a PortOS update
    appUpdaterUpdateApp.mockResolvedValue({ success: true, steps: [] });

    const { fireUpdate, emitted } = makeSocketHarness();
    await fireUpdate({ appId: 'some-other-app' });

    expect(emitted.find((e) => e.event === 'app:update:error')).toBeUndefined();
    expect(appUpdaterUpdateApp).toHaveBeenCalled();
  });
});
