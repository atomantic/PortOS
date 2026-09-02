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
  getSubmoduleOverview: vi.fn().mockResolvedValue({ submodules: [], defaultBranch: 'main' }),
  getSubmodulePaths: vi.fn().mockResolvedValue([]),
  updateSubmodule: vi.fn().mockResolvedValue({ newCommit: 'abc', committed: false }),
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

vi.mock('../services/cosAgentLifecycle.js', () => ({
  getAgents: vi.fn().mockResolvedValue([])
}));

// Mock workspace-roots so we control which paths are "allowed" without
// touching the real filesystem.
vi.mock('../lib/workspaceRoots.js', () => ({
  isWithinAllowedRoots: vi.fn(),
  outsideAllowedRootsMessage: vi.fn((realPath, { field = 'path' } = {}) => `${field} is outside allowed directories: ${realPath}`)
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
import { isWithinAllowedRoots, outsideAllowedRootsMessage } from '../lib/workspaceRoots.js';
import * as cosAgentLifecycleService from '../services/cosAgentLifecycle.js';
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
      expect(outsideAllowedRootsMessage).toHaveBeenCalledWith(body.path);
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
      cosAgentLifecycleService.getAgents.mockResolvedValue([
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
      cosAgentLifecycleService.getAgents.mockResolvedValue([]);
      gitService.deleteMergedBranches.mockResolvedValue({ deleted: [] });

      const app = makeApp();
      await request(app)
        .post('/api/git/cleanup-merged')
        .send({ path: WORKSPACE });

      const { excludeBranches } = gitService.deleteMergedBranches.mock.calls[0][1];
      expect(excludeBranches.size).toBe(0);
    });

    it('still passes an empty Set when getAgents rejects (catch guard)', async () => {
      cosAgentLifecycleService.getAgents.mockRejectedValue(new Error('service down'));
      gitService.deleteMergedBranches.mockResolvedValue({ deleted: [] });

      const app = makeApp();
      const res = await request(app)
        .post('/api/git/cleanup-merged')
        .send({ path: WORKSPACE });

      // Should not 500 — getAgents failure is swallowed via .catch(() => [])
      expect(res.status).toBe(200);
      const { excludeBranches, activeAgentIds } = gitService.deleteMergedBranches.mock.calls[0][1];
      expect(excludeBranches.size).toBe(0);
      // Cleanup now tears worktrees down, so an unreadable agent list must NOT
      // read as "nothing is running" — null makes the reaper hold every agent tree.
      expect(activeAgentIds).toBeNull();
    });

    it('protects running AND paused agent worktrees via activeAgentIds', async () => {
      cosAgentLifecycleService.getAgents.mockResolvedValue([
        { id: 'agent-running', status: 'running', metadata: { worktreeBranch: 'feature/agent-work' } },
        { id: 'agent-paused', status: 'paused' },
        { id: 'agent-done', status: 'completed' },
      ]);
      gitService.deleteMergedBranches.mockResolvedValue({ deleted: [] });

      const app = makeApp();
      await request(app)
        .post('/api/git/cleanup-merged')
        .send({ path: WORKSPACE });

      const { activeAgentIds } = gitService.deleteMergedBranches.mock.calls[0][1];
      expect(activeAgentIds.has('agent-running')).toBe(true);
      // A paused agent keeps its worktree as resume context.
      expect(activeAgentIds.has('agent-paused')).toBe(true);
      expect(activeAgentIds.has('agent-done')).toBe(false);
    });
  });

  describe('POST /api/git/delete-branch — active agent branches are excluded', () => {
    it('passes the active agent branches as excludeBranches to deleteBranch', async () => {
      cosAgentLifecycleService.getAgents.mockResolvedValue([
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
      cosAgentLifecycleService.getAgents.mockResolvedValue([]);
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

describe('git routes — submodules', () => {
  const WORKSPACE = '/Users/me/project';

  beforeEach(() => {
    vi.clearAllMocks();
    allowWorkspace(WORKSPACE);
  });

  it('GET /submodules/status without repoPath reads the PortOS checkout', async () => {
    gitService.getSubmoduleOverview.mockResolvedValue({
      submodules: [{ path: 'lib/dep', name: 'dep' }],
      defaultBranch: 'main'
    });

    const app = makeApp();
    const res = await request(app).get('/api/git/submodules/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ submodules: [{ path: 'lib/dep', name: 'dep' }], defaultBranch: 'main' });
    // Undefined, not a string — the service falls back to the PortOS checkout.
    expect(gitService.getSubmoduleOverview).toHaveBeenCalledWith(undefined);
  });

  it('GET /submodules/status?repoPath scopes the read to that repo', async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/git/submodules/status?repoPath=${encodeURIComponent(WORKSPACE)}`);

    expect(res.status).toBe(200);
    expect(gitService.getSubmoduleOverview).toHaveBeenCalledWith(WORKSPACE);
  });

  it('GET /submodules/status rejects a repoPath outside allowed roots', async () => {
    isWithinAllowedRoots.mockReturnValue(false);
    realpathSync.mockReturnValue('/etc');

    const app = makeApp();
    const res = await request(app)
      .get('/api/git/submodules/status?repoPath=%2Fetc');

    expect(res.status).toBe(403);
    expect(gitService.getSubmoduleOverview).not.toHaveBeenCalled();
  });

  it('POST /submodules/update forwards repoPath + commit and echoes the commit result', async () => {
    gitService.updateSubmodule.mockResolvedValue({
      newCommit: 'def4567',
      committed: true,
      commitSha: 'aaa1111',
      commitNote: 'committed on main',
      defaultBranch: 'main',
      currentBranch: 'main'
    });

    const app = makeApp();
    const res = await request(app)
      .post('/api/git/submodules/update')
      .send({ path: 'lib/dep', repoPath: WORKSPACE, commit: true });

    expect(res.status).toBe(200);
    expect(gitService.updateSubmodule).toHaveBeenCalledWith('lib/dep', { repoPath: WORKSPACE, commit: true });
    expect(res.body).toEqual({
      success: true,
      newCommit: 'def4567',
      committed: true,
      commitSha: 'aaa1111',
      commitNote: 'committed on main',
      defaultBranch: 'main',
      currentBranch: 'main'
    });
    // The service owns the known-submodule check; the route must not re-list.
    expect(gitService.getSubmodulePaths).not.toHaveBeenCalled();
  });

  it('POST /submodules/update defaults commit to false when the flag is absent', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/git/submodules/update')
      .send({ path: 'lib/dep' });

    expect(res.status).toBe(200);
    expect(gitService.updateSubmodule).toHaveBeenCalledWith('lib/dep', { repoPath: undefined, commit: false });
  });

  it('POST /submodules/update rejects a missing path with a 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/git/submodules/update').send({});

    expect(res.status).toBe(400);
    expect(gitService.updateSubmodule).not.toHaveBeenCalled();
  });

  it('POST /submodules/update surfaces the service 400 for an unknown submodule path', async () => {
    gitService.updateSubmodule.mockRejectedValue(
      Object.assign(new Error('Unknown submodule path: lib/other'), { status: 400, code: 'VALIDATION_ERROR' })
    );

    const app = makeApp();
    const res = await request(app)
      .post('/api/git/submodules/update')
      .send({ path: 'lib/other', repoPath: WORKSPACE });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('POST /submodules/update rejects a repoPath outside allowed roots', async () => {
    isWithinAllowedRoots.mockReturnValue(false);
    realpathSync.mockReturnValue('/etc');

    const app = makeApp();
    const res = await request(app)
      .post('/api/git/submodules/update')
      .send({ path: 'lib/dep', repoPath: '/etc' });

    expect(res.status).toBe(403);
    expect(gitService.updateSubmodule).not.toHaveBeenCalled();
  });
});
