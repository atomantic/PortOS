import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Mock the services the execute route depends on. executeUpdate is fire-and-
// forget in the route (not awaited), so a resolved stub is enough.
vi.mock('../services/updateChecker.js', () => ({
  getUpdateStatus: vi.fn(),
  checkForUpdate: vi.fn(),
  ignoreVersion: vi.fn(),
  clearIgnored: vi.fn(),
  clearStaleUpdateInProgress: vi.fn().mockResolvedValue(false),
  getRemoteInfo: vi.fn(),
  syncFork: vi.fn(),
  setUpdateInProgress: vi.fn().mockResolvedValue(true)
}));
vi.mock('../services/updateExecutor.js', () => ({
  executeUpdate: vi.fn().mockResolvedValue({ success: true, version: '1.26.0' })
}));
// getActiveAgentIds reads live-process maps and spawningTasks holds in-flight
// spawns; mock both so tests control the "are CoS agents running?" signal
// without spawning real processes. spawningTasks is a real Set the tests mutate
// (hoisted so the mock factory, which is hoisted above imports, can reference it).
const { mockSpawningTasks } = vi.hoisted(() => ({ mockSpawningTasks: new Set() }));
vi.mock('../services/agentState.js', () => ({
  getActiveAgentIds: vi.fn().mockReturnValue([]),
  spawningTasks: mockSpawningTasks
}));
const { mockCosState } = vi.hoisted(() => ({
  mockCosState: {
    persistentMind: { queuedMessages: [], activeTurn: null },
  },
}));
vi.mock('../services/cosState.js', () => ({
  readPersistentMindStateForSafetyCheck: vi.fn(async () => ({
    trusted: true,
    persistentMind: mockCosState.persistentMind,
  })),
  withStateLock: vi.fn(async (fn) => fn()),
}));

import * as updateChecker from '../services/updateChecker.js';
import { executeUpdate } from '../services/updateExecutor.js';
import { getActiveAgentIds } from '../services/agentState.js';
import { readPersistentMindStateForSafetyCheck } from '../services/cosState.js';
import updateRoutes from './update.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/update', updateRoutes);
  app.use(errorMiddleware);
  return app;
};

// A baseline in-sync, non-fork status with a cached release.
const baseStatus = (overrides = {}) => ({
  currentVersion: '1.26.0',
  latestRelease: { tag: 'v1.27.0', version: '1.27.0' },
  remoteInfo: { isFork: false, hasOrigin: true, fullName: 'atomantic/PortOS' },
  upstream: { fullName: 'atomantic/PortOS' },
  forkSyncFresh: false,
  installState: { outOfSync: false },
  ...overrides
});

describe('POST /api/update/execute — reconcile gating (issue #1779)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateChecker.setUpdateInProgress.mockResolvedValue(true);
    executeUpdate.mockResolvedValue({ success: true, version: '1.26.0' });
    getActiveAgentIds.mockReturnValue([]);
    mockCosState.persistentMind = { queuedMessages: [], activeTurn: null };
    readPersistentMindStateForSafetyCheck.mockImplementation(async () => ({
      trusted: true,
      persistentMind: mockCosState.persistentMind,
    }));
  });

  it('rejects reconcile when the install is already in sync (even with a cached release)', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus({ installState: { outOfSync: false } }));
    const res = await request(makeApp()).post('/api/update/execute').send({ reconcile: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ALREADY_IN_SYNC');
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('rejects reconcile when install state could not be determined (null)', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus({ installState: null }));
    const res = await request(makeApp()).post('/api/update/execute').send({ reconcile: true });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('INSTALL_STATE_UNAVAILABLE');
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('runs the reconcile when out of sync, targeting the current version and forcing clean of stale workspaces', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus({
      installState: {
        outOfSync: true,
        staleDeps: { stale: true, workspaces: [
          { name: 'root', stale: true },
          { name: 'client', stale: false },
          { name: 'server', stale: true }
        ] }
      }
    }));
    const res = await request(makeApp()).post('/api/update/execute').send({ reconcile: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ started: true, tag: 'v1.26.0' });
    // Only the stale workspaces, with 'root' mapped to update.sh's '.' token.
    expect(executeUpdate).toHaveBeenCalledWith('v1.26.0', expect.any(Function), { forceCleanWorkspaces: ['.', 'server'] });
  });

  it('reconcile with no stale deps (build/migration staleness) forces no clean', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus({
      installState: { outOfSync: true, staleDeps: { stale: false, workspaces: [] }, staleBuild: true }
    }));
    const res = await request(makeApp()).post('/api/update/execute').send({ reconcile: true });
    expect(res.status).toBe(200);
    expect(executeUpdate).toHaveBeenCalledWith('v1.26.0', expect.any(Function), { forceCleanWorkspaces: [] });
  });

  it('reconcile runs even with NO cached release (out of sync)', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(
      baseStatus({ latestRelease: null, installState: { outOfSync: true } })
    );
    const res = await request(makeApp()).post('/api/update/execute').send({ reconcile: true });
    expect(res.status).toBe(200);
    expect(res.body.tag).toBe('v1.26.0');
  });

  it('still applies the fork gate to a reconcile (unsynced fork → 412)', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus({
      installState: { outOfSync: true },
      remoteInfo: { isFork: true, hasOrigin: true, fullName: 'alice/PortOS' },
      forkSyncFresh: false
    }));
    const res = await request(makeApp()).post('/api/update/execute').send({ reconcile: true });
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('FORK_SYNC_REQUIRED');
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('a non-reconcile update still requires a cached release tag', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus({ latestRelease: null }));
    const res = await request(makeApp()).post('/api/update/execute').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_RELEASE');
  });

  it('a normal update uses the cached release tag and forces no clean', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus());
    const res = await request(makeApp()).post('/api/update/execute').send({});
    expect(res.status).toBe(200);
    expect(res.body.tag).toBe('v1.27.0');
    expect(executeUpdate).toHaveBeenCalledWith('v1.27.0', expect.any(Function), { forceCleanWorkspaces: undefined });
  });
});

describe('POST /api/update/execute — active CoS agent gating', () => {
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

  it('rejects a normal update with 409 AGENTS_ACTIVE while an agent is live (no restart)', async () => {
    getActiveAgentIds.mockReturnValue(['agent-1']);
    const res = await request(makeApp()).post('/api/update/execute').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AGENTS_ACTIVE');
    expect(executeUpdate).not.toHaveBeenCalled();
    // Guard runs before the in-progress lock is acquired.
    expect(updateChecker.setUpdateInProgress).not.toHaveBeenCalled();
  });

  it('rejects when a task is mid-spawn (in spawningTasks) even before it registers a process', async () => {
    // No live process yet — the agent has launched but not yet populated the
    // process maps; a restart would still sever it. spawningTasks closes that gap.
    getActiveAgentIds.mockReturnValue([]);
    mockSpawningTasks.add('task-42');
    const res = await request(makeApp()).post('/api/update/execute').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AGENTS_ACTIVE');
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('re-checks after acquiring the lock and releases it if an agent started during the git/fork awaits', async () => {
    // Pre-check sees no agents (call 1), but one goes live during getUpdateStatus/
    // fork-gate (call 2 at the post-lock re-check) — the update must abort and
    // release the in-progress lock instead of restarting out from under it.
    getActiveAgentIds.mockReturnValueOnce([]).mockReturnValueOnce(['agent-late']);
    const res = await request(makeApp()).post('/api/update/execute').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AGENTS_ACTIVE');
    expect(executeUpdate).not.toHaveBeenCalled();
    // Lock was acquired then released (true, then false), leaving no stuck lock.
    expect(updateChecker.setUpdateInProgress).toHaveBeenNthCalledWith(1, true);
    expect(updateChecker.setUpdateInProgress).toHaveBeenCalledWith(false);
  });

  it('rejects a reconcile with 409 AGENTS_ACTIVE while agents are live', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus({ installState: { outOfSync: true } }));
    getActiveAgentIds.mockReturnValue(['agent-1', 'agent-2']);
    const res = await request(makeApp()).post('/api/update/execute').send({ reconcile: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AGENTS_ACTIVE');
    // Pluralized message names both agents.
    expect(res.body.error).toMatch(/2 CoS agents are running/);
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('proceeds normally when no agents are running', async () => {
    getActiveAgentIds.mockReturnValue([]);
    const res = await request(makeApp()).post('/api/update/execute').send({});
    expect(res.status).toBe(200);
    expect(executeUpdate).toHaveBeenCalled();
  });

  it('rejects before locking when queued image work cannot survive an older reader', async () => {
    mockCosState.persistentMind = {
      queuedMessages: [{ id: 'message-example', images: [{ attachmentId: 'attachment-example' }] }],
      activeTurn: null,
    };

    const res = await request(makeApp()).post('/api/update/execute').send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERSISTENT_MIND_IMAGES_IN_FLIGHT');
    expect(res.body.error).toMatch(/Drain the image-bearing work, or create a backup/);
    expect(updateChecker.setUpdateInProgress).not.toHaveBeenCalled();
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('re-checks image work after locking and releases the update lock on a race', async () => {
    let reads = 0;
    readPersistentMindStateForSafetyCheck.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? { trusted: true, persistentMind: { queuedMessages: [], activeTurn: null } }
        : {
            trusted: true,
            persistentMind: {
              queuedMessages: [],
              activeTurn: {
                wake: {
                  kind: 'message',
                  message: { id: 'message-example', images: [{ attachmentId: 'attachment-example' }] },
                },
              },
            },
          };
    });

    const res = await request(makeApp()).post('/api/update/execute').send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERSISTENT_MIND_IMAGES_IN_FLIGHT');
    expect(updateChecker.setUpdateInProgress).toHaveBeenNthCalledWith(1, true);
    expect(updateChecker.setUpdateInProgress).toHaveBeenCalledWith(false);
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('releases the update lock when the post-lock safety read fails', async () => {
    readPersistentMindStateForSafetyCheck
      .mockResolvedValueOnce({ trusted: true, persistentMind: { queuedMessages: [], activeTurn: null } })
      .mockRejectedValueOnce(new Error('state read failed'));

    const res = await request(makeApp()).post('/api/update/execute').send({});

    expect(res.status).toBe(500);
    expect(updateChecker.setUpdateInProgress).toHaveBeenNthCalledWith(1, true);
    expect(updateChecker.setUpdateInProgress).toHaveBeenCalledWith(false);
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('fails closed when persisted Persistent Mind state is untrusted', async () => {
    readPersistentMindStateForSafetyCheck.mockResolvedValue({ trusted: false, persistentMind: null });

    const res = await request(makeApp()).post('/api/update/execute').send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERSISTENT_MIND_STATE_UNTRUSTED');
    expect(updateChecker.setUpdateInProgress).not.toHaveBeenCalled();
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('allows an explicit backup acknowledgement when queued image work cannot drain', async () => {
    mockCosState.persistentMind = {
      queuedMessages: [{ id: 'message-example', images: [{ attachmentId: 'attachment-example' }] }],
      activeTurn: null,
    };

    const res = await request(makeApp()).post('/api/update/execute').send({
      acknowledgePersistentMindImageBackup: true,
    });

    expect(res.status).toBe(200);
    expect(executeUpdate).toHaveBeenCalled();
  });
});

describe('GET /api/update/status — activeCosAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawningTasks.clear();
    updateChecker.clearStaleUpdateInProgress.mockResolvedValue(false);
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus());
    getActiveAgentIds.mockReturnValue([]);
    mockCosState.persistentMind = { queuedMessages: [], activeTurn: null };
    readPersistentMindStateForSafetyCheck.mockImplementation(async () => ({
      trusted: true,
      persistentMind: mockCosState.persistentMind,
    }));
  });

  it('reports the live agent count so the UI can suppress update actions', async () => {
    getActiveAgentIds.mockReturnValue(['agent-1', 'agent-2', 'agent-3']);
    const res = await request(makeApp()).get('/api/update/status');
    expect(res.status).toBe(200);
    expect(res.body.activeCosAgents).toBe(3);
  });

  it('counts an in-flight spawn when no process is registered yet', async () => {
    getActiveAgentIds.mockReturnValue([]);
    mockSpawningTasks.add('task-1');
    const res = await request(makeApp()).get('/api/update/status');
    expect(res.status).toBe(200);
    expect(res.body.activeCosAgents).toBe(1);
  });

  it('sums distinct live and spawning agents (a live agent plus two spawns → 3)', async () => {
    getActiveAgentIds.mockReturnValue(['agent-1']);
    mockSpawningTasks.add('task-1');
    mockSpawningTasks.add('task-2');
    const res = await request(makeApp()).get('/api/update/status');
    expect(res.status).toBe(200);
    expect(res.body.activeCosAgents).toBe(3);
  });

  it('reports 0 when no agents are running', async () => {
    const res = await request(makeApp()).get('/api/update/status');
    expect(res.status).toBe(200);
    expect(res.body.activeCosAgents).toBe(0);
    expect(res.body.persistentMindImages).toEqual({
      safe: true,
      trusted: true,
      queuedImageMessages: 0,
      activeImageMessage: false,
    });
  });
});
