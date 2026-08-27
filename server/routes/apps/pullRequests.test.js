import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import pullRequestRoutes from './pullRequests.js';

vi.mock('../../services/apps.js', () => ({
  getAppById: vi.fn(),
}));
vi.mock('../../services/appPullRequests.js', () => ({
  listAppPullRequests: vi.fn(),
}));
vi.mock('../../services/cos.js', () => ({
  getAllTasks: vi.fn(),
}));
vi.mock('../../services/codeReview.js', () => ({
  resolveReviewLoopOptions: vi.fn(),
}));
vi.mock('../../services/agentWorktreeCleanup.js', () => ({
  spawnReviewLoopFollowUp: vi.fn(),
}));

import * as appsService from '../../services/apps.js';
import { listAppPullRequests } from '../../services/appPullRequests.js';
import { getAllTasks } from '../../services/cos.js';
import { resolveReviewLoopOptions } from '../../services/codeReview.js';
import { spawnReviewLoopFollowUp } from '../../services/agentWorktreeCleanup.js';

const APP = { id: 'app-001', name: 'Widget', repoPath: '/repo', workTracker: 'auto' };
const PULL_REQUEST = {
  number: 17,
  title: 'Fix the save path',
  url: 'https://github.com/acme/widget/pull/17',
  headBranch: 'fix/save-path',
};

const listResult = () => ({
  forge: 'github',
  tracker: 'github',
  fullName: 'acme/widget',
  pullRequests: [PULL_REQUEST],
  reason: 'ok',
  transient: false,
  headline: null,
  remedy: null,
});

describe('app pull-request routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', pullRequestRoutes);
    vi.clearAllMocks();
    appsService.getAppById.mockResolvedValue(APP);
    listAppPullRequests.mockResolvedValue(listResult());
    getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [] } });
    resolveReviewLoopOptions.mockResolvedValue({
      reviewers: ['copilot'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      reviewStopMode: 'all',
      reviewerApplies: false,
      reviewerModels: null,
      reviewerEfforts: null,
    });
    spawnReviewLoopFollowUp.mockResolvedValue({
      id: 'sys-rl-1',
      status: 'pending',
      description: '[Review Loop] Resolve and merge PR #17 for Widget (https://github.com/acme/widget/pull/17)',
    });
  });

  it('lists open requests and annotates an active resolve task', async () => {
    getAllTasks.mockResolvedValue({
      user: { tasks: [] },
      cos: { tasks: [{
        id: 'sys-rl-existing',
        status: 'in_progress',
        description: 'existing',
        metadata: { app: 'app-001', reviewLoopFollowUp: true, reviewLoopPRNumber: 17 },
      }] },
    });

    const response = await request(app).get('/api/apps/app-001/pull-requests');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ appId: 'app-001', appName: 'Widget', forge: 'github' });
    expect(response.body.pullRequests[0].agentAction).toEqual({ taskId: 'sys-rl-existing', status: 'in_progress' });
  });

  it('preserves the transient forge sentinel', async () => {
    listAppPullRequests.mockResolvedValue({
      forge: 'github', fullName: 'acme/widget', pullRequests: [],
      reason: 'gh-unauthenticated', transient: true, remedy: 'run gh auth login',
      headline: "Couldn't reach GitHub",
    });

    const response = await request(app).get('/api/apps/app-001/pull-requests');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reason: 'gh-unauthenticated', transient: true, remedy: 'run gh auth login' });
  });

  it('queues the shared review-loop follow-up with a non-Copilot coding reviewer', async () => {
    const response = await request(app).post('/api/apps/app-001/pull-requests/17/resolve');

    expect(response.status).toBe(202);
    expect(spawnReviewLoopFollowUp).toHaveBeenCalledWith(expect.objectContaining({
      originalTask: expect.objectContaining({
        id: 'app-pr-app-001-17',
        metadata: { app: 'app-001' },
      }),
      prUrl: PULL_REQUEST.url,
      prBranch: 'fix/save-path',
      sourceWorkspace: '/repo',
      reviewers: ['codex'],
    }));
    expect(response.body).toMatchObject({
      task: { id: 'sys-rl-1', status: 'pending' },
      duplicate: false,
      pullRequest: { agentAction: { taskId: 'sys-rl-1', status: 'pending' } },
    });
  });

  it('returns the existing active task instead of queuing a duplicate', async () => {
    const existing = {
      id: 'sys-rl-existing',
      status: 'blocked',
      description: 'existing',
      metadata: { app: 'app-001', reviewLoopFollowUp: true, reviewLoopPRNumber: 17 },
    };
    getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [existing] } });

    const response = await request(app).post('/api/apps/app-001/pull-requests/17/resolve');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ duplicate: true, task: { id: 'sys-rl-existing', status: 'blocked' } });
    expect(spawnReviewLoopFollowUp).not.toHaveBeenCalled();
  });

  it('fails closed when active CoS task state cannot be read', async () => {
    getAllTasks.mockRejectedValue(new Error('task store unavailable'));

    const response = await request(app).post('/api/apps/app-001/pull-requests/17/resolve');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('AGENT_ACTION_UNAVAILABLE');
    expect(spawnReviewLoopFollowUp).not.toHaveBeenCalled();
  });

  it('rejects a request that is no longer open', async () => {
    listAppPullRequests.mockResolvedValue({ ...listResult(), pullRequests: [] });

    const response = await request(app).post('/api/apps/app-001/pull-requests/17/resolve');

    expect(response.status).toBe(404);
    expect(spawnReviewLoopFollowUp).not.toHaveBeenCalled();
  });

  it('validates the PR/MR number before querying the forge', async () => {
    const response = await request(app).post('/api/apps/app-001/pull-requests/not-a-number/resolve');

    expect(response.status).toBe(400);
    expect(listAppPullRequests).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown app', async () => {
    appsService.getAppById.mockResolvedValue(null);

    const response = await request(app).get('/api/apps/app-999/pull-requests');

    expect(response.status).toBe(404);
    expect(listAppPullRequests).not.toHaveBeenCalled();
  });
});
