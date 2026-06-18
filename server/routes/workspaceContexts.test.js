/**
 * Route tests for workspace-contexts (#902): param validation, 404 on
 * unknown app id, and dispatch to the service. The service is mocked — these
 * are guard/wiring tests, not service coverage (that lives in
 * services/workspaceContext.test.js).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import workspaceContextsRoutes from './workspaceContexts.js';

vi.mock('../services/workspaceContext.js', () => ({
  listContexts: vi.fn().mockResolvedValue([{ appId: 'app-1', appName: 'X' }]),
  getContext: vi.fn(),
  saveContext: vi.fn(),
  restoreContext: vi.fn(),
  deleteContext: vi.fn()
}));

import * as wc from '../services/workspaceContext.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/workspace-contexts', workspaceContextsRoutes);
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message, code: err.code });
  });
  return app;
}

describe('workspace-contexts routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET / lists contexts', async () => {
    const res = await request(makeApp()).get('/api/workspace-contexts');
    expect(res.status).toBe(200);
    expect(res.body.contexts).toEqual([{ appId: 'app-1', appName: 'X' }]);
  });

  it('GET /:appId returns the context', async () => {
    wc.getContext.mockResolvedValue({ appId: 'app-1', branch: 'main' });
    const res = await request(makeApp()).get('/api/workspace-contexts/app-1');
    expect(res.status).toBe(200);
    expect(res.body.branch).toBe('main');
    expect(wc.getContext).toHaveBeenCalledWith('app-1');
  });

  it('GET /:appId → 404 when the service returns null', async () => {
    wc.getContext.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/workspace-contexts/ghost');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('rejects an app id with illegal characters → 400', async () => {
    const res = await request(makeApp()).get('/api/workspace-contexts/bad%2Fid');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(wc.getContext).not.toHaveBeenCalled();
  });

  it('POST /:appId/save dispatches to saveContext', async () => {
    wc.saveContext.mockResolvedValue({ appId: 'app-1', savedAt: 'now' });
    const res = await request(makeApp()).post('/api/workspace-contexts/app-1/save');
    expect(res.status).toBe(200);
    expect(res.body.savedAt).toBe('now');
    expect(wc.saveContext).toHaveBeenCalledWith('app-1');
  });

  it('POST /:appId/restore dispatches to restoreContext', async () => {
    wc.restoreContext.mockResolvedValue({ appId: 'app-1', restorable: { shellSessions: [] } });
    const res = await request(makeApp()).post('/api/workspace-contexts/app-1/restore');
    expect(res.status).toBe(200);
    expect(res.body.restorable.shellSessions).toEqual([]);
  });

  it('POST /:appId/save → 404 when app unknown', async () => {
    wc.saveContext.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/workspace-contexts/ghost/save');
    expect(res.status).toBe(404);
  });

  it('DELETE /:appId returns the deleted flag', async () => {
    wc.deleteContext.mockResolvedValue(true);
    const res = await request(makeApp()).delete('/api/workspace-contexts/app-1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});
