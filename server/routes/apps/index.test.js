import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';

// Keep this an assembly test: the domain route tests mount their sub-router
// directly, so they cannot catch a missing router.use() in this barrel.
const { passThrough } = vi.hoisted(() => ({
  passThrough: (_req, _res, next) => next(),
}));
vi.mock('./crud.js', () => ({ default: passThrough }));
vi.mock('./lifecycle.js', () => ({ default: passThrough }));
vi.mock('./viteTls.js', () => ({ default: passThrough }));
vi.mock('./xcode.js', () => ({ default: passThrough }));
vi.mock('./icons.js', () => ({ default: passThrough }));
vi.mock('./taskTypes.js', () => ({ default: passThrough }));
vi.mock('./issues.js', () => ({ default: passThrough }));
vi.mock('./launch.js', () => ({ default: passThrough }));
vi.mock('./documents.js', () => ({ default: passThrough }));
vi.mock('./agents.js', () => ({ default: passThrough }));
vi.mock('./spriteBindings.js', () => ({ default: passThrough }));
vi.mock('./repositorySources.js', () => ({ default: passThrough }));
vi.mock('../../services/apps.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getAppById: vi.fn(),
}));

import appsRoutes from './index.js';
import * as appsService from '../../services/apps.js';

describe('apps route assembly', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use('/api/apps', appsRoutes);
    vi.clearAllMocks();
    appsService.getAppById.mockResolvedValue(null);
  });

  it('mounts the pull-request route through the apps barrel', async () => {
    const response = await request(app).get('/api/apps/app-999/pull-requests');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'App not found', code: 'NOT_FOUND' });
    expect(appsService.getAppById).toHaveBeenCalledWith('app-999');
  });
});
