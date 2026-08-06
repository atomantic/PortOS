import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/stackerNews.js', () => ({
  createAccount: vi.fn(async ({ label, username }) => ({
    id: '00000000-0000-4000-8000-000000000001',
    label,
    username,
    apiKeyConfigured: true,
  })),
  createAction: vi.fn(),
  executeApprovedAction: vi.fn(),
  listAccounts: vi.fn(async () => []),
  verifyConnection: vi.fn(async () => ({ configured: true, connected: true, transport: 'browser', username: 'example_steward' })),
  stackerNewsCapabilities: { browserReads: ['me'], api: { reads: ['me'] } },
}));

import * as stackerNews from '../services/stackerNews.js';
import stackerNewsRoutes from './stackerNews.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/stacker-news', stackerNewsRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('Stacker News routes', () => {
  let app;

  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  it('creates an account without returning its credential', async () => {
    const response = await request(app).post('/api/stacker-news/accounts').send({
      label: 'Example steward',
      username: 'example_steward',
      apiKey: 'never-return-this',
    });

    expect(response.status).toBe(201);
    expect(stackerNews.createAccount).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'never-return-this' }));
    expect(response.body).toMatchObject({ apiKeyConfigured: true, username: 'example_steward' });
    expect(response.body).not.toHaveProperty('apiKey');
  });

  it('rejects action kinds outside the fixed allowlist before calling the service', async () => {
    const response = await request(app).post('/api/stacker-news/actions').send({
      accountId: '00000000-0000-4000-8000-000000000001',
      kind: 'zap',
    });

    expect(response.status).toBe(400);
    expect(stackerNews.createAction).not.toHaveBeenCalled();
  });

  it('accepts only named manual item handoff intents', async () => {
    stackerNews.createAction.mockResolvedValue({ id: 'action', accountId: '00000000-0000-4000-8000-000000000001' });
    const accepted = await request(app).post('/api/stacker-news/actions').send({
      accountId: '00000000-0000-4000-8000-000000000001',
      itemId: '00000000-0000-4000-8000-000000000002',
      kind: 'open_browser',
      destination: 'item',
      payload: { intent: 'moderate' },
    });
    expect(accepted.status).toBe(201);
    expect(stackerNews.createAction).toHaveBeenCalledWith(expect.objectContaining({ payload: { intent: 'moderate' } }));

    const rejected = await request(app).post('/api/stacker-news/actions').send({
      accountId: '00000000-0000-4000-8000-000000000001',
      itemId: '00000000-0000-4000-8000-000000000002',
      kind: 'open_browser',
      destination: 'item',
      payload: { intent: 'delete-account' },
    });
    expect(rejected.status).toBe(400);
  });

  it('executes only through the dedicated approved-action primitive', async () => {
    stackerNews.executeApprovedAction.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000010',
      accountId: '00000000-0000-4000-8000-000000000001',
      state: 'completed',
    });
    const response = await request(app).post('/api/stacker-news/actions/00000000-0000-4000-8000-000000000010/execute').send({});
    expect(response.status).toBe(200);
    expect(stackerNews.executeApprovedAction).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000010');
  });

  it('accepts a read transport on create and rejects one outside the two named transports', async () => {
    const created = await request(app).post('/api/stacker-news/accounts').send({
      label: 'Example steward',
      username: 'example_steward',
      readTransport: 'browser',
    });
    expect(created.status).toBe(201);
    expect(stackerNews.createAccount).toHaveBeenCalledWith(expect.objectContaining({ readTransport: 'browser' }));

    const rejected = await request(app).post('/api/stacker-news/accounts').send({
      label: 'Example steward',
      username: 'example_steward',
      readTransport: 'graphql',
    });
    expect(rejected.status).toBe(400);
  });

  it('verifies through the account transport by default and through an explicit override when asked', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const fallback = await request(app).post(`/api/stacker-news/accounts/${id}/verify`).send({});
    expect(fallback.status).toBe(200);
    expect(stackerNews.verifyConnection).toHaveBeenCalledWith(id, {});

    await request(app).post(`/api/stacker-news/accounts/${id}/verify`).send({ transport: 'api' });
    expect(stackerNews.verifyConnection).toHaveBeenCalledWith(id, { transport: 'api' });

    const rejected = await request(app).post(`/api/stacker-news/accounts/${id}/verify`).send({ transport: 'telepathy' });
    expect(rejected.status).toBe(400);
  });
});
