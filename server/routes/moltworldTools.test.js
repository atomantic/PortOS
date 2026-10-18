import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const client = vi.hoisted(() => ({
  joinWorld: vi.fn(), build: vi.fn(), think: vi.fn(),
  getProfile: vi.fn(), getBalance: vi.fn(), getRateLimitStatus: vi.fn(),
}));
vi.mock('../services/platformAccounts.js', () => ({ getAccountWithCredentials: vi.fn(), recordActivity: vi.fn() }));
vi.mock('../services/agentPersonalities.js', () => ({ getAgentById: vi.fn() }));
vi.mock('../services/agentActivity.js', () => ({ logActivity: vi.fn() }));
vi.mock('../services/moltworldQueue.js', () => ({
  getQueue: vi.fn(), addAction: vi.fn(), removeAction: vi.fn(), markCompleted: vi.fn(), markFailed: vi.fn(),
}));
vi.mock('../integrations/moltworld/index.js', () => ({ createMoltworldClient: vi.fn(() => client) }));

import * as platformAccounts from '../services/platformAccounts.js';
import * as agentActivity from '../services/agentActivity.js';
import * as moltworldQueue from '../services/moltworldQueue.js';
import { createMoltworldClient } from '../integrations/moltworld/index.js';
import moltworldToolsRoutes from './moltworldTools.js';

const app = express();
app.use(express.json());
app.use('/api/agents/tools/moltworld', moltworldToolsRoutes);
app.use(errorMiddleware);
const BASE = '/api/agents/tools/moltworld';

const account = (over = {}) => ({
  id: 'acct-1', status: 'active', platform: 'moltworld',
  credentials: { apiKey: 'key-example', agentId: 'mw-agent', username: 'example-agent' }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  platformAccounts.getAccountWithCredentials.mockResolvedValue(account());
});

describe('/api/agents/tools/moltworld', () => {
  it('acts in the world with the account credentials and logs the action for the agent', async () => {
    client.think.mockResolvedValue({ ok: true });
    const res = await request(app).post(`${BASE}/think`).send({ accountId: 'acct-1', agentId: 'agent-1', thought: 'hello' });
    expect(res.status).toBe(200);
    expect(createMoltworldClient).toHaveBeenCalledWith('key-example', 'mw-agent');
    expect(client.think).toHaveBeenCalledWith('hello');
    expect(platformAccounts.recordActivity).toHaveBeenCalledWith('acct-1');
    expect(agentActivity.logActivity).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-1', action: 'mw_think' }));
  });

  it('refuses a missing, inactive, or non-Moltworld account before calling the world', async () => {
    const body = { accountId: 'acct-1', thought: 'hello' };
    platformAccounts.getAccountWithCredentials.mockResolvedValueOnce(null);
    expect((await request(app).post(`${BASE}/think`).send(body)).status).toBe(404);
    platformAccounts.getAccountWithCredentials.mockResolvedValueOnce(account({ status: 'suspended' }));
    const inactive = await request(app).post(`${BASE}/think`).send(body);
    expect(inactive.status).toBe(400);
    expect(inactive.body.code).toBe('ACCOUNT_INACTIVE');
    platformAccounts.getAccountWithCredentials.mockResolvedValueOnce(account({ platform: 'moltbook' }));
    const wrong = await request(app).post(`${BASE}/think`).send(body);
    expect(wrong.body.code).toBe('WRONG_PLATFORM');
    expect(client.think).not.toHaveBeenCalled();
  });

  it('rejects a build outside the world bounds', async () => {
    const res = await request(app).post(`${BASE}/build`).send({ accountId: 'acct-1', x: 9999, y: 0, z: 0 });
    expect(res.status).toBe(400);
    expect(client.build).not.toHaveBeenCalled();
  });

  it('reads status for an account and requires the account id', async () => {
    client.getProfile.mockResolvedValue({ x: 1, y: 2 });
    client.getBalance.mockResolvedValue({ sim: 10 });
    const res = await request(app).get(`${BASE}/status?accountId=acct-1`);
    expect(res.body).toEqual({ profile: { x: 1, y: 2 }, balance: { sim: 10 } });

    for (const path of ['status', 'balance', 'rate-limits']) {
      const missing = await request(app).get(`${BASE}/${path}`);
      expect(missing.status, path).toBe(400);
      expect(missing.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('answers 404 when a queue item cannot be removed or settled', async () => {
    moltworldQueue.removeAction.mockReturnValue(null);
    moltworldQueue.markFailed.mockReturnValue(null);
    expect((await request(app).delete(`${BASE}/queue/q9`)).status).toBe(404);
    expect((await request(app).post(`${BASE}/queue/q9/fail`).send({ error: 'boom' })).status).toBe(404);
    expect(moltworldQueue.markFailed).toHaveBeenCalledWith('q9', 'boom');
  });
});
