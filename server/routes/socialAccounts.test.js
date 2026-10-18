import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/socialAccounts.js', () => ({
  getAllAccounts: vi.fn(),
  getAccountsByPlatform: vi.fn(),
  getAccountsByCategory: vi.fn(),
  getAccountById: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  getSupportedPlatforms: vi.fn(),
  getAccountStats: vi.fn(),
}));

import * as socialAccounts from '../services/socialAccounts.js';
import socialAccountsRoutes from './socialAccounts.js';

const app = express();
app.use(express.json());
app.use('/api/digital-twin/social-accounts', socialAccountsRoutes);
app.use(errorMiddleware);
const BASE = '/api/digital-twin/social-accounts';

beforeEach(() => {
  vi.clearAllMocks();
  socialAccounts.createAccount.mockImplementation(async (data) => ({ id: 'acct-1', ...data }));
});

describe('/api/digital-twin/social-accounts', () => {
  it('creates a valid account with schema defaults and refuses an unknown platform', async () => {
    const ok = await request(app).post(BASE).send({ platform: 'github', username: 'example-user' });
    expect(ok.status).toBe(201);
    expect(socialAccounts.createAccount).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'github', username: 'example-user', bio: '', contentTypes: [], ingestionEnabled: false,
    }));

    socialAccounts.createAccount.mockClear();
    const bad = await request(app).post(BASE).send({ platform: 'myspace', username: 'example-user' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    expect(socialAccounts.createAccount).not.toHaveBeenCalled();
  });

  it('creates the valid rows of a bulk import and reports the invalid ones', async () => {
    const res = await request(app).post(`${BASE}/bulk`).send({ accounts: [
      { platform: 'x', username: 'example-user' },
      { platform: 'x' },
    ] });
    expect(res.status).toBe(201);
    expect(res.body.summary).toEqual({ created: 1, failed: 1 });
    expect(res.body.results[1]).toMatchObject({ success: false, input: { platform: 'x' } });
    expect(socialAccounts.createAccount).toHaveBeenCalledTimes(1);
  });

  it('filters the list by platform or category from the query string', async () => {
    socialAccounts.getAccountsByPlatform.mockResolvedValue([{ id: 'a' }]);
    const res = await request(app).get(`${BASE}?platform=github`);
    expect(res.body).toEqual({ accounts: [{ id: 'a' }] });
    expect(socialAccounts.getAccountsByPlatform).toHaveBeenCalledWith('github');

    socialAccounts.getAccountsByCategory.mockResolvedValue([]);
    await request(app).get(`${BASE}?category=professional`);
    expect(socialAccounts.getAccountsByCategory).toHaveBeenCalledWith('professional');

    const repeated = await request(app).get(`${BASE}?platform=x&platform=github`);
    expect(repeated.status).toBe(400);
  });

  it('answers 404 for a missing account on read, update and delete, and 204 on a real delete', async () => {
    socialAccounts.getAccountById.mockResolvedValue(null);
    socialAccounts.updateAccount.mockResolvedValue(null);
    socialAccounts.deleteAccount.mockResolvedValue(false);
    expect((await request(app).get(`${BASE}/missing`)).status).toBe(404);
    expect((await request(app).put(`${BASE}/missing`).send({ bio: 'x' })).status).toBe(404);
    expect((await request(app).delete(`${BASE}/missing`)).status).toBe(404);

    socialAccounts.deleteAccount.mockResolvedValue(true);
    expect((await request(app).delete(`${BASE}/acct-1`)).status).toBe(204);
  });
});
