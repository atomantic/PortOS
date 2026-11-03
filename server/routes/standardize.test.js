import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, realpath: vi.fn(async (path) => path) };
});

vi.mock('../lib/workspaceRoots.js', () => ({
  isWithinAllowedRoots: vi.fn(() => true),
  outsideAllowedRootsMessage: vi.fn(() => 'standardization target is outside allowed directories')
}));

// Standardizing REWRITES the target repo (writes ecosystem.config.cjs, comments
// ports out of .env/vite config), so these tests assert the precondition gate
// runs before any of that — and that a refused request does zero work.
vi.mock('../services/pm2Standardizer.js', () => ({
  standardizeRefusalFor: vi.fn(() => null),
  analyzeApp: vi.fn().mockResolvedValue({ success: true, proposedChanges: { processes: [{ name: 'p' }] } }),
  applyStandardization: vi.fn().mockResolvedValue({ success: true, filesModified: [], backupBranch: null }),
  createGitBackup: vi.fn().mockResolvedValue({ success: true, branch: 'backup-1' })
}));

vi.mock('../services/apps.js', () => ({
  getAppById: vi.fn(),
  updateApp: vi.fn().mockResolvedValue({})
}));

import standardizeRoutes from './standardize.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { standardizeRefusalFor, analyzeApp, applyStandardization, createGitBackup } from '../services/pm2Standardizer.js';
import { getAppById, updateApp } from '../services/apps.js';
import { isWithinAllowedRoots } from '../lib/workspaceRoots.js';
import { realpath } from 'fs/promises';
import { maintenance } from '../lib/maintenanceAdmission.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/standardize', standardizeRoutes);
  app.use(errorMiddleware);
  return app;
}

/** Nothing that touches the repo may have run. */
function expectNoStandardizerWork() {
  expect(analyzeApp).not.toHaveBeenCalled();
  expect(applyStandardization).not.toHaveBeenCalled();
  expect(createGitBackup).not.toHaveBeenCalled();
}

const validPlan = () => ({
  currentState: { hasGit: true },
  proposedChanges: {
    createEcosystem: true,
    ecosystemContent: 'module.exports = { apps: [] };',
    processes: [{ name: 'example-api' }],
    strayPorts: [{ file: '.env', variable: 'PORT', value: 3000, line: 1, action: 'remove' }]
  }
});

describe('standardize routes — target resolution and the refusal gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(standardizeRefusalFor).mockReturnValue(null);
    vi.mocked(isWithinAllowedRoots).mockReturnValue(true);
    vi.mocked(realpath).mockImplementation(async (path) => path);
    vi.mocked(applyStandardization).mockResolvedValue({ success: true, filesModified: [], backupBranch: null });
  });

  it('refuses standardizer work while an update holds maintenance', async () => {
    const update = maintenance.deferredUpdate.request();
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
    try {
      for (const [route, body] of [
        ['analyze', { repoPath: '/srv/example-app' }],
        ['apply', { repoPath: '/srv/example-app', plan: validPlan() }],
        ['backup', { repoPath: '/srv/example-app' }],
      ]) {
        const res = await request(makeApp()).post(`/api/standardize/${route}`).send(body);
        expect(res.status).toBe(503);
      }
      expectNoStandardizerWork();
    } finally { maintenance.deferredUpdate.finish(update.id, false); }
  });

  it('resolves an allowed app to its repoPath and proceeds', async () => {
    vi.mocked(getAppById).mockResolvedValue({ id: 'app-1', type: 'vite+express', repoPath: '/srv/example-app' });

    const res = await request(makeApp()).post('/api/standardize/analyze').send({ appId: 'app-1' });

    expect(res.status).toBe(200);
    expect(analyzeApp).toHaveBeenCalledWith('/srv/example-app', undefined);
  });

  it('refuses an app the standardizer rejects, before touching the repo', async () => {
    vi.mocked(getAppById).mockResolvedValue({ id: 'app-ios', type: 'ios-native', repoPath: '/srv/ios-app' });
    vi.mocked(standardizeRefusalFor).mockReturnValue('ios-native apps are not run under PM2');

    const res = await request(makeApp()).post('/api/standardize/analyze').send({ appId: 'app-ios' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('NOT_STANDARDIZABLE');
    expectNoStandardizerWork();
  });

  it('still refuses when an explicit repoPath is supplied alongside the appId', async () => {
    // Taking repoPath early would let the pair smuggle a refused app past the gate.
    vi.mocked(getAppById).mockResolvedValue({ id: 'app-ios', type: 'ios-native', repoPath: '/srv/ios-app' });
    vi.mocked(standardizeRefusalFor).mockReturnValue('ios-native apps are not run under PM2');

    const res = await request(makeApp())
      .post('/api/standardize/apply')
      .send({ appId: 'app-ios', repoPath: '/srv/somewhere-else', plan: validPlan() });

    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('NOT_STANDARDIZABLE');
    expectNoStandardizerWork();
  });

  it('standardizes the checked app\'s own repo, ignoring a companion repoPath', async () => {
    // Typing one record and then rewriting a different directory would make the
    // gate decorative — a permitted Node appId could carry a Python or Docker
    // repo straight past the refusal.
    vi.mocked(getAppById).mockResolvedValue({ id: 'app-1', type: 'vite+express', repoPath: '/srv/example-app' });

    const res = await request(makeApp())
      .post('/api/standardize/analyze')
      .send({ appId: 'app-1', repoPath: '/srv/some-python-service' });

    expect(res.status).toBe(200);
    expect(analyzeApp).toHaveBeenCalledWith('/srv/example-app', undefined);
  });

  it('preserves a symlinked app path after checking its canonical target', async () => {
    vi.mocked(getAppById).mockResolvedValue({ id: 'app-1', type: 'vite+express', repoPath: '/tmp/example-app' });
    vi.mocked(realpath).mockResolvedValue('/private/tmp/example-app');

    const res = await request(makeApp()).post('/api/standardize/analyze').send({ appId: 'app-1' });

    expect(res.status).toBe(200);
    expect(isWithinAllowedRoots).toHaveBeenCalledWith('/private/tmp/example-app');
    expect(analyzeApp).toHaveBeenCalledWith('/tmp/example-app', undefined);
  });

  it('404s an appId with no app record', async () => {
    vi.mocked(getAppById).mockResolvedValue(null);

    const res = await request(makeApp()).post('/api/standardize/backup').send({ appId: 'app-gone' });

    expect(res.status).toBe(404);
    expectNoStandardizerWork();
  });

  it('resolves a bare repoPath without an app record to type-check', async () => {
    const res = await request(makeApp()).post('/api/standardize/backup').send({ repoPath: '/srv/loose-repo' });

    expect(res.status).toBe(200);
    expect(getAppById).not.toHaveBeenCalled();
    expect(standardizeRefusalFor).not.toHaveBeenCalled();
    expect(createGitBackup).toHaveBeenCalledWith('/srv/loose-repo');
  });

  it('validates and applies a standardization plan successfully', async () => {
    vi.mocked(getAppById).mockResolvedValue({ id: 'app-1', type: 'vite+express', repoPath: '/srv/example-app' });

    const plan = validPlan();
    const res = await request(makeApp())
      .post('/api/standardize/apply')
      .send({ appId: 'app-1', plan });

    expect(res.status).toBe(200);
    expect(applyStandardization).toHaveBeenCalledWith('/srv/example-app', plan, { overwriteEcosystem: false });
    expect(updateApp).toHaveBeenCalledWith('app-1', { pm2ProcessNames: ['example-api'] });
  });

  it('returns the standard error envelope when apply reports failure', async () => {
    vi.mocked(applyStandardization).mockResolvedValue({
      success: false,
      error: 'Working tree has uncommitted changes',
      filesModified: [],
      errors: ['Working tree has uncommitted changes']
    });

    const res = await request(makeApp())
      .post('/api/standardize/apply')
      .send({ repoPath: '/srv/example-app', plan: validPlan() });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: 'Working tree has uncommitted changes',
      code: 'APPLY_FAILED',
      timestamp: expect.any(Number)
    }));
    expect(res.body.success).toBeUndefined();
    expect(updateApp).not.toHaveBeenCalled();
  });

  it('rejects a hostile plan that traverses outside the target repo', async () => {
    const plan = validPlan();
    plan.proposedChanges.strayPorts[0].file = '../../outside.env';

    const res = await request(makeApp())
      .post('/api/standardize/apply')
      .send({ repoPath: '/srv/example-app', plan });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(applyStandardization).not.toHaveBeenCalled();
  });

  it('validates malformed target types before resolving filesystem paths', async () => {
    const res = await request(makeApp())
      .post('/api/standardize/apply')
      .send({ repoPath: [], plan: validPlan() });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(realpath).not.toHaveBeenCalled();
    expect(applyStandardization).not.toHaveBeenCalled();
  });

  it('rejects a target outside the allowed workspace roots before applying', async () => {
    vi.mocked(isWithinAllowedRoots).mockReturnValue(false);

    const res = await request(makeApp())
      .post('/api/standardize/apply')
      .send({ repoPath: '/private/example-app', plan: validPlan() });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(applyStandardization).not.toHaveBeenCalled();
  });

  it('400s when neither repoPath nor appId is supplied', async () => {
    const res = await request(makeApp()).post('/api/standardize/analyze').send({});

    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('MISSING_PATH');
    expectNoStandardizerWork();
  });
});
