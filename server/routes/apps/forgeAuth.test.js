import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import forgeAuthRoutes from './forgeAuth.js';

vi.mock('../../services/apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('../../lib/workTracker.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveAppForgeTarget: vi.fn(),
}));
vi.mock('../../services/forgeAuth.js', () => ({ resolveForgeForRepo: vi.fn() }));
vi.mock('../../services/forgeScopeRefresh.js', () => ({
  startForgeScopeRefresh: vi.fn(),
  attachForgeScopeRefreshClient: vi.fn(),
  cancelForgeScopeRefresh: vi.fn(),
  hasForgeScopeRefresh: vi.fn(),
}));

import * as appsService from '../../services/apps.js';
import { resolveAppForgeTarget } from '../../lib/workTracker.js';
import { resolveForgeForRepo } from '../../services/forgeAuth.js';
import { startForgeScopeRefresh, cancelForgeScopeRefresh, hasForgeScopeRefresh } from '../../services/forgeScopeRefresh.js';

const APP = { id: 'app-001', name: 'Widget', repoPath: '/repo', forgeAccount: null };
const JOB_ID = '11111111-1111-4111-8111-111111111111';

describe('app forge-auth routes', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/apps', forgeAuthRoutes);
    appsService.getAppById.mockResolvedValue(APP);
    resolveAppForgeTarget.mockResolvedValue({
      tracker: 'github',
      target: { forge: 'github', repoSpec: 'ghe.example.com/acme/widget', webHost: 'ghe.example.com', apiHost: 'ghe.example.com' },
    });
    resolveForgeForRepo.mockResolvedValue({ host: 'ghe.example.com', account: null });
    startForgeScopeRefresh.mockResolvedValue({ jobId: JOB_ID, host: 'ghe.example.com', scopes: ['workflow'], adopted: false });
  });

  it('starts the refresh for the host derived from the app origin, never from the request', async () => {
    const response = await request(app).post('/api/apps/app-001/forge-auth/refresh')
      .send({ scopes: ['workflow'], host: 'attacker.example.net' });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ jobId: JOB_ID, host: 'ghe.example.com' });
    expect(startForgeScopeRefresh).toHaveBeenCalledWith({ host: 'ghe.example.com', scopes: ['workflow'], expectedAccount: null });
  });

  it('hands the account merges authenticate as to the service so a non-active account is caught', async () => {
    resolveForgeForRepo.mockResolvedValue({ host: 'ghe.example.com', account: 'owner-acct' });

    await request(app).post('/api/apps/app-001/forge-auth/refresh').send({ scopes: ['workflow'] });

    expect(startForgeScopeRefresh).toHaveBeenCalledWith(expect.objectContaining({ expectedAccount: 'owner-acct' }));
  });

  it('normalizes host case and rejects an unresolved origin separately', async () => {
    resolveAppForgeTarget.mockResolvedValue({ target: { forge: 'github', webHost: 'GHE.EXAMPLE.COM' } });
    const response = await request(app).post('/api/apps/app-001/forge-auth/refresh').send({ scopes: ['workflow'] });
    expect(response.status).toBe(202);
    expect(startForgeScopeRefresh).toHaveBeenCalledWith(expect.objectContaining({ host: 'ghe.example.com' }));
    startForgeScopeRefresh.mockClear();
    resolveForgeForRepo.mockResolvedValue({ host: null, account: null });
    const missing = await request(app).post('/api/apps/app-001/forge-auth/refresh').send({ scopes: ['workflow'] });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('FORGE_REFRESH_UNSUPPORTED');
    expect(startForgeScopeRefresh).not.toHaveBeenCalled();
  });

  it('refuses a changed origin instead of refreshing an account on another host', async () => {
    resolveForgeForRepo.mockResolvedValue({ host: 'github.com', account: 'owner-acct' });
    const response = await request(app).post('/api/apps/app-001/forge-auth/refresh').send({ scopes: ['workflow'] });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('FORGE_REFRESH_HOST_CHANGED');
    expect(startForgeScopeRefresh).not.toHaveBeenCalled();
  });

  it('does not refresh the active account when the configured pin is unavailable', async () => {
    const error = Object.assign(new Error('Pinned account unavailable'), { status: 409, code: 'FORGE_ACCOUNT_UNAVAILABLE' });
    resolveForgeForRepo.mockRejectedValue(error);
    const response = await request(app).post('/api/apps/app-001/forge-auth/refresh').send({ scopes: ['workflow'] });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('FORGE_ACCOUNT_UNAVAILABLE');
    expect(startForgeScopeRefresh).not.toHaveBeenCalled();
  });

  it('refuses GitLab, where glab has no scope refresh', async () => {
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'gitlab', target: { forge: 'gitlab', webHost: 'gitlab.example.com' } });

    const response = await request(app).post('/api/apps/app-001/forge-auth/refresh').send({ scopes: ['workflow'] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('FORGE_REFRESH_UNSUPPORTED');
    expect(startForgeScopeRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ['no scopes', {}],
    ['an empty list', { scopes: [] }],
    ['a malformed scope', { scopes: ['workflow; rm -rf /'] }],
  ])('rejects %s before touching gh', async (_label, body) => {
    const response = await request(app).post('/api/apps/app-001/forge-auth/refresh').send(body);

    expect(response.status).toBe(400);
    expect(startForgeScopeRefresh).not.toHaveBeenCalled();
  });

  it('answers 404 for the event stream of a refresh that does not exist', async () => {
    hasForgeScopeRefresh.mockReturnValue(false);

    const response = await request(app).get(`/api/apps/app-001/forge-auth/refresh/${JOB_ID}/events`);

    expect(response.status).toBe(404);
  });

  it('cancels a refresh by id', async () => {
    cancelForgeScopeRefresh.mockReturnValue(true);

    const response = await request(app).post(`/api/apps/app-001/forge-auth/refresh/${JOB_ID}/cancel`);

    expect(response.body).toEqual({ canceled: true });
    expect(cancelForgeScopeRefresh).toHaveBeenCalledWith(JOB_ID);
  });
});
