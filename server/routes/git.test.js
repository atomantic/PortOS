import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import gitRoutes from './git.js';

// Mock the git service — tests are guard-focused, not service-coverage.
vi.mock('../services/git.js', () => ({
  getStatus: vi.fn().mockResolvedValue({ files: [] }),
  getDiff: vi.fn().mockResolvedValue(''),
  getCommits: vi.fn().mockResolvedValue([]),
  stageFiles: vi.fn().mockResolvedValue(undefined),
  unstageFiles: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue({ sha: 'abc123' }),
  push: vi.fn().mockResolvedValue({ pushed: true }),
  getGitInfo: vi.fn().mockResolvedValue({}),
  getBranches: vi.fn().mockResolvedValue([]),
  getSubmodules: vi.fn().mockResolvedValue([]),
  getSubmodulePaths: vi.fn().mockResolvedValue([]),
  updateSubmodule: vi.fn().mockResolvedValue('abc'),
  getAppById: vi.fn(),
  updateBranches: vi.fn().mockResolvedValue({}),
  getBranchComparison: vi.fn().mockResolvedValue({}),
  pushAll: vi.fn().mockResolvedValue({}),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  checkout: vi.fn().mockResolvedValue({}),
  pull: vi.fn().mockResolvedValue({}),
  syncBranch: vi.fn().mockResolvedValue({}),
  getRemoteBranches: vi.fn().mockResolvedValue([]),
  mergeBranch: vi.fn().mockResolvedValue({}),
  checkoutRemoteBranch: vi.fn().mockResolvedValue({}),
  deleteMergedBranches: vi.fn().mockResolvedValue({}),
  deleteBranch: vi.fn().mockResolvedValue({})
}));

vi.mock('../services/apps.js', () => ({
  getAppById: vi.fn()
}));

vi.mock('../services/cosAgents.js', () => ({
  getAgents: vi.fn().mockResolvedValue([])
}));

// Mock workspace-roots so we control which paths are "allowed" without
// touching the real filesystem.
vi.mock('../lib/workspaceRoots.js', () => ({
  isWithinAllowedRoots: vi.fn()
}));

// Mock fs functions used by assertAllowedWorkspace.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
    realpathSync: vi.fn()
  };
});

import { existsSync, statSync, realpathSync } from 'fs';
import { isWithinAllowedRoots } from '../lib/workspaceRoots.js';
import * as cosAgentsService from '../services/cosAgents.js';
import * as gitService from '../services/git.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/git', gitRoutes);
  // Minimal error handler so ServerError shapes propagate cleanly.
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message, code: err.code });
  });
  return app;
}

describe('git routes — workspace root validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('path outside allowed roots → 403', () => {
    it.each([
      ['POST /status', '/status', { path: '/etc/passwd' }],
      ['POST /diff', '/diff', { path: '/etc' }],
      ['POST /commits', '/commits', { path: '/etc' }],
      ['POST /push', '/push', { path: '/etc' }],
      ['POST /pull', '/pull', { path: '/etc' }],
      ['POST /info', '/info', { path: '/etc' }],
      ['POST /branches', '/branches', { path: '/etc' }]
    ])('%s', async (_label, route, body) => {
      existsSync.mockReturnValue(true);
      statSync.mockReturnValue({ isDirectory: () => true });
      realpathSync.mockReturnValue(body.path);
      isWithinAllowedRoots.mockReturnValue(false);

      const app = makeApp();
      const res = await request(app).post(`/api/git${route}`).send(body);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });
  });

  describe('path within allowed roots → handler reached (200)', () => {
    it.each([
      ['POST /status', '/status', { path: '/Users/me/project' }],
      ['POST /diff', '/diff', { path: '/Users/me/project' }],
      ['POST /commits', '/commits', { path: '/Users/me/project' }],
      ['POST /push', '/push', { path: '/Users/me/project' }],
      ['POST /pull', '/pull', { path: '/Users/me/project' }],
      ['POST /info', '/info', { path: '/Users/me/project' }],
      ['POST /branches', '/branches', { path: '/Users/me/project' }]
    ])('%s', async (_label, route, body) => {
      existsSync.mockReturnValue(true);
      statSync.mockReturnValue({ isDirectory: () => true });
      realpathSync.mockReturnValue(body.path);
      isWithinAllowedRoots.mockReturnValue(true);

      const app = makeApp();
      const res = await request(app).post(`/api/git${route}`).send(body);

      expect(res.status).toBe(200);
    });
  });

  describe('missing / null path → 400', () => {
    it.each([
      ['POST /status', '/status'],
      ['POST /diff', '/diff'],
      ['POST /push', '/push']
    ])('%s', async (_label, route) => {
      const app = makeApp();
      const res = await request(app).post(`/api/git${route}`).send({});

      expect(res.status).toBe(400);
    });
  });

  it('path that does not exist → 400', async () => {
    existsSync.mockReturnValue(false);

    const app = makeApp();
    const res = await request(app)
      .post('/api/git/status')
      .send({ path: '/nonexistent/path' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
  });
});

// Helper: configure the workspace mocks to allow a path through
function allowWorkspace(path = '/Users/me/project') {
  existsSync.mockReturnValue(true);
  statSync.mockReturnValue({ isDirectory: () => true });
  realpathSync.mockReturnValue(path);
  isWithinAllowedRoots.mockReturnValue(true);
}

describe('git routes — active agent branch exclusion', () => {
  const WORKSPACE = '/Users/me/project';

  beforeEach(() => {
    vi.clearAllMocks();
    allowWorkspace(WORKSPACE);
  });

  describe('POST /api/git/cleanup-merged — active agent branches are passed to service', () => {
    it('passes the active agent worktreeBranch as an excludeBranches Set to deleteMergedBranches', async () => {
      cosAgentsService.getAgents.mockResolvedValue([
        { status: 'running', metadata: { worktreeBranch: 'feature/agent-work' } },
        { status: 'stopped', metadata: { worktreeBranch: 'feature/done-work' } },
      ]);
      gitService.deleteMergedBranches.mockResolvedValue({ deleted: [], protected: ['feature/agent-work'] });

      const app = makeApp();
      const res = await request(app)
        .post('/api/git/cleanup-merged')
        .send({ path: WORKSPACE });

      expect(res.status).toBe(200);
      expect(gitService.deleteMergedBranches).toHaveBeenCalledWith(
        WORKSPACE,
        expect.objectContaining({
          excludeBranches: expect.any(Set),
        })
      );
      const { excludeBranches } = gitService.deleteMergedBranches.mock.calls[0][1];
      // Running agent branch is excluded
      expect(excludeBranches.has('feature/agent-work')).toBe(true);
      // Stopped agent branch is NOT excluded (only running agents protect branches)
      expect(excludeBranches.has('feature/done-work')).toBe(false);
    });

    it('passes an empty Set when no agents are running', async () => {
      cosAgentsService.getAgents.mockResolvedValue([]);
      gitService.deleteMergedBranches.mockResolvedValue({ deleted: [] });

      const app = makeApp();
      await request(app)
        .post('/api/git/cleanup-merged')
        .send({ path: WORKSPACE });

      const { excludeBranches } = gitService.deleteMergedBranches.mock.calls[0][1];
      expect(excludeBranches.size).toBe(0);
    });

    it('still passes an empty Set when getAgents rejects (catch guard)', async () => {
      cosAgentsService.getAgents.mockRejectedValue(new Error('service down'));
      gitService.deleteMergedBranches.mockResolvedValue({ deleted: [] });

      const app = makeApp();
      const res = await request(app)
        .post('/api/git/cleanup-merged')
        .send({ path: WORKSPACE });

      // Should not 500 — getAgents failure is swallowed via .catch(() => [])
      expect(res.status).toBe(200);
      const { excludeBranches } = gitService.deleteMergedBranches.mock.calls[0][1];
      expect(excludeBranches.size).toBe(0);
    });
  });

  describe('POST /api/git/delete-branch — active agent branches are excluded', () => {
    it('passes the active agent branches as excludeBranches to deleteBranch', async () => {
      cosAgentsService.getAgents.mockResolvedValue([
        { status: 'running', metadata: { worktreeBranch: 'feature/agent-active' } },
      ]);
      gitService.deleteBranch.mockResolvedValue({ branch: 'feature/other', results: { local: 'deleted' } });

      const app = makeApp();
      const res = await request(app)
        .post('/api/git/delete-branch')
        .send({ path: WORKSPACE, branch: 'feature/other', local: true });

      expect(res.status).toBe(200);
      expect(gitService.deleteBranch).toHaveBeenCalledWith(
        WORKSPACE,
        'feature/other',
        expect.objectContaining({
          excludeBranches: expect.any(Set),
        })
      );
      const { excludeBranches } = gitService.deleteBranch.mock.calls[0][2];
      expect(excludeBranches.has('feature/agent-active')).toBe(true);
    });

    it('returns 400 when branch param is missing', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/git/delete-branch')
        .send({ path: WORKSPACE, local: true });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(gitService.deleteBranch).not.toHaveBeenCalled();
    });

    it('returns 400 when neither local nor remote is true', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/git/delete-branch')
        .send({ path: WORKSPACE, branch: 'feature/x' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(gitService.deleteBranch).not.toHaveBeenCalled();
    });

    it('service error propagates as 500', async () => {
      cosAgentsService.getAgents.mockResolvedValue([]);
      gitService.deleteBranch.mockRejectedValue(
        Object.assign(new Error('Cannot delete branch in active use by an agent: feature/agent-active'), { status: 500 })
      );

      const app = makeApp();
      const res = await request(app)
        .post('/api/git/delete-branch')
        .send({ path: WORKSPACE, branch: 'feature/agent-active', local: true });

      expect(res.status).toBe(500);
    });
  });
});
