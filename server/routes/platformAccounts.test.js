import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/platformAccounts.js', () => ({
  getAccountsByAgent: vi.fn(),
  getAccountsByPlatform: vi.fn(),
  getAllAccounts: vi.fn(),
  createAccount: vi.fn(),
}));
vi.mock('../services/agent/agentPersonalities.js', () => ({
  getAgentById: vi.fn(),
}));
vi.mock('../services/history.js', () => ({ logAction: vi.fn() }));
vi.mock('../integrations/moltbook/index.js', () => ({}));
vi.mock('../integrations/moltworld/index.js', () => ({}));

const accounts = await import('../services/platformAccounts.js');
const agentPersonalities = await import('../services/agent/agentPersonalities.js');
const platformAccountRoutes = (await import('./platformAccounts.js')).default;

const app = express();
app.use(express.json());
app.use('/api/agents/accounts', platformAccountRoutes);
app.use(errorMiddleware);

describe('GET /api/agents/accounts (#16428)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('narrows an agent listing by platform', async () => {
    accounts.getAccountsByAgent.mockResolvedValue([{ id: 'a1', platform: 'moltbook' }, { id: 'a2', platform: 'moltworld' }]);
    const res = await request(app).get('/api/agents/accounts?agentId=agent-1&platform=moltbook');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'a1', platform: 'moltbook' }]);
    expect(accounts.getAccountsByAgent).toHaveBeenCalledWith('agent-1');
  });

  it('refuses a repeated filter key with 400 before reaching the service', async () => {
    const res = await request(app).get('/api/agents/accounts?agentId=a&agentId=b');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(accounts.getAccountsByAgent).not.toHaveBeenCalled();
    expect(accounts.getAllAccounts).not.toHaveBeenCalled();
  });
});

describe('POST /api/agents/accounts (#18138)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 VALIDATION_ERROR when POST arrives without a body or JSON content-type', async () => {
    const res = await request(app).post('/api/agents/accounts');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(agentPersonalities.getAgentById).not.toHaveBeenCalled();
    expect(accounts.createAccount).not.toHaveBeenCalled();
  });

  it('creates an account directly when credentials are provided', async () => {
    agentPersonalities.getAgentById.mockResolvedValue({ id: 'agent-1' });
    accounts.createAccount.mockResolvedValue({ id: 'acc-1', agentId: 'agent-1', platform: 'moltbook' });

    const res = await request(app).post('/api/agents/accounts').send({
      agentId: 'agent-1',
      platform: 'moltbook',
      credentials: { apiKey: 'test-key', username: 'test-bot' },
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('acc-1');
    expect(accounts.createAccount).toHaveBeenCalledTimes(1);
  });
});
