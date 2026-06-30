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

import * as updateChecker from '../services/updateChecker.js';
import { executeUpdate } from '../services/updateExecutor.js';
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
