import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import issueRoutes from './issues.js';

vi.mock('../../services/apps.js', () => ({
  getAppById: vi.fn(),
}));
vi.mock('../../services/appIssues.js', () => ({
  listAppIssues: vi.fn(),
}));

import * as appsService from '../../services/apps.js';
import { listAppIssues } from '../../services/appIssues.js';

describe('GET /api/apps/:id/issues', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', issueRoutes);
    vi.clearAllMocks();
    appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Widget', repoPath: '/repo' });
  });

  it('passes the loaded app to the lister and returns its payload with app identity', async () => {
    listAppIssues.mockResolvedValue({
      forge: 'github',
      fullName: 'acme/widget',
      issues: [{ number: 1, title: 'Bug', labels: [], assignees: [] }],
      reason: 'ok',
      transient: false,
      remedy: null,
    });

    const response = await request(app).get('/api/apps/app-001/issues');

    expect(response.status).toBe(200);
    expect(listAppIssues).toHaveBeenCalledWith({ id: 'app-001', name: 'Widget', repoPath: '/repo' });
    expect(response.body).toMatchObject({
      appId: 'app-001',
      appName: 'Widget',
      forge: 'github',
      fullName: 'acme/widget',
      reason: 'ok',
      transient: false,
    });
    expect(response.body.issues).toHaveLength(1);
  });

  it('surfaces the transient sentinel verbatim rather than flattening it to an empty list', async () => {
    listAppIssues.mockResolvedValue({
      forge: 'github', fullName: 'acme/widget', issues: [],
      reason: 'gh-unauthenticated', transient: true, remedy: 'run gh auth login',
    });

    const response = await request(app).get('/api/apps/app-001/issues');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reason: 'gh-unauthenticated', transient: true, remedy: 'run gh auth login' });
  });

  it('404s for an unknown app without calling the forge', async () => {
    appsService.getAppById.mockResolvedValue(null);

    const response = await request(app).get('/api/apps/app-999/issues');

    expect(response.status).toBe(404);
    expect(listAppIssues).not.toHaveBeenCalled();
  });
});
