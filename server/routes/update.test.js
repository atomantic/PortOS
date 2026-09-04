import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, errorEvents } from '../lib/errorHandler.js';

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
// The map ids are filtered through PortOS's durable records before they count.
// Default the filter to "every tracked id has a live record" so the existing
// cases keep asserting the counting arithmetic; the stale-entry case overrides it.
vi.mock('../services/cosAgentLifecycle.js', () => ({
  filterLiveAgentIds: vi.fn(async (ids) => ids)
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
import { filterLiveAgentIds } from '../services/cosAgentLifecycle.js';
import updateRoutes from './update.js';

// The execute route streams all progress over `req.app.get('io')`; without one
// attached, every socket emission in the route is a silent no-op and untestable.
const mockIo = { emit: vi.fn() };

// Attaching `io` also routes every error response through `errorEvents`, and a
// Node EventEmitter THROWS the payload when 'error' is emitted with no listener
// — which would break the error envelope for every non-200 case here. The real
// server always has a subscriber; this no-op stands in for it.
const noopErrorListener = () => {};
beforeAll(() => { errorEvents.on('error', noopErrorListener); });
afterAll(() => { errorEvents.off('error', noopErrorListener); });

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.set('io', mockIo);
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
    vi.mocked(filterLiveAgentIds).mockImplementation(async (ids) => ids);
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
    expect(executeUpdate).toHaveBeenCalledWith('v1.26.0', expect.any(Function), expect.objectContaining({ forceCleanWorkspaces: ['.', 'server'] }));
  });

  it('reconcile with no stale deps (build/migration staleness) forces no clean', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus({
      installState: { outOfSync: true, staleDeps: { stale: false, workspaces: [] }, staleBuild: true }
    }));
    const res = await request(makeApp()).post('/api/update/execute').send({ reconcile: true });
    expect(res.status).toBe(200);
    expect(executeUpdate).toHaveBeenCalledWith('v1.26.0', expect.any(Function), expect.objectContaining({ forceCleanWorkspaces: [] }));
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
    expect(executeUpdate).toHaveBeenCalledWith('v1.27.0', expect.any(Function), expect.objectContaining({ forceCleanWorkspaces: undefined }));
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
    vi.mocked(filterLiveAgentIds).mockImplementation(async (ids) => ids);
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

  // The phantom that pinned the Update page: the CoS Runner kept advertising
  // TUIs it had failed to kill, `syncRunnerAgents` adopted them, and the count
  // blocked the restart — the only thing that would have cleared them.
  it('lets the update run when every tracked id is an already-finalized ghost', async () => {
    getActiveAgentIds.mockReturnValue(['agent-ghost-1', 'agent-ghost-2']);
    vi.mocked(filterLiveAgentIds).mockResolvedValue([]);

    const res = await request(makeApp()).post('/api/update/execute').send({});

    expect(res.status).toBe(200);
    expect(executeUpdate).toHaveBeenCalled();
  });
});

describe('POST /api/update/execute — lock handling and socket progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawningTasks.clear();
    updateChecker.setUpdateInProgress.mockResolvedValue(true);
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus());
    executeUpdate.mockResolvedValue({ success: true, version: '1.27.0' });
    getActiveAgentIds.mockReturnValue([]);
    vi.mocked(filterLiveAgentIds).mockImplementation(async (ids) => ids);
    mockCosState.persistentMind = { queuedMessages: [], activeTurn: null };
    readPersistentMindStateForSafetyCheck.mockImplementation(async () => ({
      trusted: true,
      persistentMind: mockCosState.persistentMind,
    }));
  });

  // The atomic check-and-set is the only thing standing between two callers and
  // two concurrent `update.sh` runs; ignoring its `false` return would let the
  // second one through.
  it('409s UPDATE_IN_PROGRESS when the lock is already held', async () => {
    updateChecker.setUpdateInProgress.mockResolvedValue(false);
    const res = await request(makeApp()).post('/api/update/execute').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UPDATE_IN_PROGRESS');
    expect(executeUpdate).not.toHaveBeenCalled();
    // A lost race must not release the lock the winner holds.
    expect(updateChecker.setUpdateInProgress).not.toHaveBeenCalledWith(false);
  });

  // The tag is handed to update.sh; anything that isn't a plain semver release
  // is an option/argument-injection vector and must never reach the lock.
  it('400s INVALID_TAG for a non-semver release tag, without acquiring the lock', async () => {
    updateChecker.getUpdateStatus.mockResolvedValue(
      baseStatus({ latestRelease: { tag: 'v1.27.0; rm -rf /', version: '1.27.0' } })
    );
    const res = await request(makeApp()).post('/api/update/execute').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TAG');
    expect(updateChecker.setUpdateInProgress).not.toHaveBeenCalled();
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  // Regression for issue #6036: executeUpdate rejecting (e.g. spawnDetached
  // throwing before any child listener is attached) skips recordUpdateResult,
  // so the launcher is the only place left that can release the lock. Leaving
  // it set wedges every later update at 409 and blocks all CoS agent spawns.
  it('releases the update lock and emits an error when executeUpdate rejects', async () => {
    executeUpdate.mockRejectedValue(new Error('spawn EACCES'));
    const res = await request(makeApp()).post('/api/update/execute').send({});
    // NOT 200: the rejection happens during the LAUNCH, before any script is
    // running, so the caller is told the update never started rather than being
    // handed `started: true` for a restart that is not coming.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.started).toBeUndefined();
    await vi.waitFor(() => {
      expect(updateChecker.setUpdateInProgress).toHaveBeenCalledWith(false);
    });
    expect(mockIo.emit).toHaveBeenCalledWith('portos:update:error', {
      message: 'spawn EACCES',
      step: 'unknown',
    });
  });

  // The response is already sent by then, so the socket is the client's only
  // channel for the outcome and the version it should now expect.
  it('emits portos:update:complete with the version the script actually landed on', async () => {
    executeUpdate.mockResolvedValue({ success: true, version: '1.28.3' });
    await request(makeApp()).post('/api/update/execute').send({});
    await vi.waitFor(() => {
      expect(mockIo.emit).toHaveBeenCalledWith('portos:update:complete', {
        success: true,
        newVersion: '1.28.3',
        versionKnown: true,
      });
    });
  });

  // No marker version: fall back to the triggering tag, but flag it as a guess
  // so the UI doesn't present it as the confirmed installed version.
  it('falls back to the triggering tag with versionKnown=false when no version is resolved', async () => {
    executeUpdate.mockResolvedValue({ success: true });
    await request(makeApp()).post('/api/update/execute').send({});
    await vi.waitFor(() => {
      expect(mockIo.emit).toHaveBeenCalledWith('portos:update:complete', {
        success: true,
        newVersion: '1.27.0',
        versionKnown: false,
      });
    });
  });

  // A resolved failure is a different code path from a rejection and must still
  // surface the failing step rather than the generic 'unknown'.
  it('emits portos:update:error with the failed step when executeUpdate resolves unsuccessfully', async () => {
    executeUpdate.mockResolvedValue({
      success: false,
      failedStep: 'install',
      errorMessage: 'Update failed at step "install" (exit code 1)',
    });
    await request(makeApp()).post('/api/update/execute').send({});
    await vi.waitFor(() => {
      expect(mockIo.emit).toHaveBeenCalledWith('portos:update:error', {
        message: 'Update failed at step "install" (exit code 1)',
        step: 'install',
      });
    });
  });

  // The `emit` callback the route hands executeUpdate is what turns update.sh's
  // STEP: lines into the client's progress bar.
  it('forwards executeUpdate progress callbacks as portos:update:step events', async () => {
    executeUpdate.mockImplementation(async (_tag, emit) => {
      emit('pull', 'running', 'Pulling latest code...');
      return { success: true, version: '1.27.0' };
    });
    await request(makeApp()).post('/api/update/execute').send({});
    expect(mockIo.emit).toHaveBeenCalledWith('portos:update:step', {
      step: 'pull',
      status: 'running',
      message: 'Pulling latest code...',
      timestamp: expect.any(Number),
    });
  });
});

describe('GET /api/update/status — activeCosAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawningTasks.clear();
    updateChecker.clearStaleUpdateInProgress.mockResolvedValue(false);
    updateChecker.getUpdateStatus.mockResolvedValue(baseStatus());
    getActiveAgentIds.mockReturnValue([]);
    vi.mocked(filterLiveAgentIds).mockImplementation(async (ids) => ids);
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

  // The maps are not self-cleaning: the CoS Runner keeps advertising a TUI it
  // failed to kill, and `syncRunnerAgents` adopts it. Counting those pinned the
  // Update page on "4 CoS agents are currently running" above an empty agent
  // list — and only a restart, the very thing being blocked, could clear it.
  it('ignores tracked ids PortOS has already finalized', async () => {
    getActiveAgentIds.mockReturnValue(['agent-ghost-1', 'agent-ghost-2', 'agent-live']);
    vi.mocked(filterLiveAgentIds).mockResolvedValue(['agent-live']);
    const res = await request(makeApp()).get('/api/update/status');
    expect(res.status).toBe(200);
    expect(res.body.activeCosAgents).toBe(1);
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

describe('POST /api/update/sync-fork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const forkInfo = (overrides = {}) => ({
    hasOrigin: true, isGithub: true, isUpstream: false, isFork: true, fullName: 'alice/PortOS',
    ...overrides,
  });

  it('200s with the sync result on a valid fork (default branch)', async () => {
    updateChecker.getRemoteInfo.mockResolvedValue(forkInfo());
    updateChecker.syncFork.mockResolvedValue({
      synced: true, alreadyUpToDate: false, fullName: 'alice/PortOS', source: 'atomantic/PortOS', mergedBranch: 'main',
    });
    const res = await request(makeApp()).post('/api/update/sync-fork').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ synced: true, mergedBranch: 'main' });
    expect(updateChecker.syncFork).toHaveBeenCalledWith({ branch: undefined, remoteInfo: forkInfo() });
  });

  it('200s with a custom branch', async () => {
    updateChecker.getRemoteInfo.mockResolvedValue(forkInfo());
    updateChecker.syncFork.mockResolvedValue({
      synced: true, alreadyUpToDate: true, fullName: 'alice/PortOS', source: 'atomantic/PortOS', mergedBranch: 'develop',
    });
    const res = await request(makeApp()).post('/api/update/sync-fork').send({ branch: 'develop' });
    expect(res.status).toBe(200);
    expect(res.body.mergedBranch).toBe('develop');
    expect(updateChecker.syncFork).toHaveBeenCalledWith({ branch: 'develop', remoteInfo: forkInfo() });
  });

  it('400 NO_ORIGIN when there is no git origin remote', async () => {
    updateChecker.getRemoteInfo.mockResolvedValue({ hasOrigin: false });
    const res = await request(makeApp()).post('/api/update/sync-fork').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_ORIGIN');
    expect(updateChecker.syncFork).not.toHaveBeenCalled();
  });

  it('400 NOT_GITHUB when the origin is not on GitHub', async () => {
    updateChecker.getRemoteInfo.mockResolvedValue({ hasOrigin: true, isGithub: false });
    const res = await request(makeApp()).post('/api/update/sync-fork').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_GITHUB');
  });

  it('400 ALREADY_UPSTREAM when origin already is the upstream repo', async () => {
    updateChecker.getRemoteInfo.mockResolvedValue({ hasOrigin: true, isGithub: true, isUpstream: true });
    const res = await request(makeApp()).post('/api/update/sync-fork').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ALREADY_UPSTREAM');
  });

  it('400 NOT_A_FORK when origin is a same-named repo that is not actually a fork', async () => {
    updateChecker.getRemoteInfo.mockResolvedValue({
      hasOrigin: true, isGithub: true, isUpstream: false, isFork: false, fullName: 'alice/some-other-repo',
    });
    const res = await request(makeApp()).post('/api/update/sync-fork').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_FORK');
  });

  it('502 GIT_UNAVAILABLE when getRemoteInfo rejects', async () => {
    updateChecker.getRemoteInfo.mockRejectedValue(new Error('git not found'));
    const res = await request(makeApp()).post('/api/update/sync-fork').send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('GIT_UNAVAILABLE');
  });

  it('409 FORK_DIVERGED when syncFork reports a non-fast-forward, with recovery guidance in the message', async () => {
    updateChecker.getRemoteInfo.mockResolvedValue(forkInfo());
    updateChecker.syncFork.mockRejectedValue(new Error('would not be a fast forward, diverged'));
    const res = await request(makeApp()).post('/api/update/sync-fork').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FORK_DIVERGED');
    expect(res.body.error).toMatch(/--force/);
  });

  it('502 FORK_SYNC_FAILED when syncFork throws an unrelated error', async () => {
    updateChecker.getRemoteInfo.mockResolvedValue(forkInfo());
    updateChecker.syncFork.mockRejectedValue(new Error('gh: command not found'));
    const res = await request(makeApp()).post('/api/update/sync-fork').send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('FORK_SYNC_FAILED');
  });

  it('400s a schema violation on a branch name with disallowed characters', async () => {
    const res = await request(makeApp()).post('/api/update/sync-fork').send({ branch: 'main; rm -rf /' });
    expect(res.status).toBe(400);
    expect(updateChecker.getRemoteInfo).not.toHaveBeenCalled();
  });
});
