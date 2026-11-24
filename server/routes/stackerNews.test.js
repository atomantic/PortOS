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
  createActionWithOutcome: vi.fn(),
  executeApprovedAction: vi.fn(),
  listAccounts: vi.fn(async () => []),
  verifyConnection: vi.fn(async () => ({ configured: true, connected: true, transport: 'browser', username: 'example_steward' })),
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
    expect(stackerNews.createActionWithOutcome).not.toHaveBeenCalled();
  });

  it.each([
    ['draft_post', { territoryId: '10000000-0000-4000-8000-000000000002', payload: { title: 'New post', body: 'Post body' } }],
    ['publish_post', { territoryId: '10000000-0000-4000-8000-000000000002', payload: { title: 'New post', body: 'Post body' } }],
    ['draft_comment', { itemId: '10000000-0000-4000-8000-000000000003', payload: { body: 'Comment body' } }],
    ['publish_comment', { itemId: '10000000-0000-4000-8000-000000000003', payload: { body: 'Comment body' } }],
  ])('accepts a %s with only its own target', async (kind, fields) => {
    const data = { accountId: '10000000-0000-4000-8000-000000000001', kind, ...fields };
    stackerNews.createActionWithOutcome.mockResolvedValueOnce({
      action: { ...data, id: 'queued-action', state: 'pending_review' },
      created: true,
      changed: true,
    });

    const response = await request(app).post('/api/stacker-news/actions').send(data);

    expect(response.status).toBe(201);
    expect(stackerNews.createActionWithOutcome).toHaveBeenCalledExactlyOnceWith(data);
    expect(response.body).toMatchObject({ id: 'queued-action', state: 'pending_review' });
  });

  it('accepts only named manual item handoff intents', async () => {
    stackerNews.createActionWithOutcome.mockResolvedValue({
      action: { id: 'action', accountId: '00000000-0000-4000-8000-000000000001' },
      created: true,
      changed: true,
    });
    const accepted = await request(app).post('/api/stacker-news/actions').send({
      accountId: '00000000-0000-4000-8000-000000000001',
      itemId: '00000000-0000-4000-8000-000000000002',
      kind: 'open_browser',
      destination: 'item',
      payload: { intent: 'moderate' },
    });
    expect(accepted.status).toBe(201);
    expect(stackerNews.createActionWithOutcome).toHaveBeenCalledWith(expect.objectContaining({ payload: { intent: 'moderate' } }));

    const rejected = await request(app).post('/api/stacker-news/actions').send({
      accountId: '00000000-0000-4000-8000-000000000001',
      itemId: '00000000-0000-4000-8000-000000000002',
      kind: 'open_browser',
      destination: 'item',
      payload: { intent: 'delete-account' },
    });
    expect(rejected.status).toBe(400);
  });

  it('returns the same action body on replay and broadcasts only when the transaction changed state', async () => {
    const emit = vi.fn();
    app.set('io', { emit });
    const accountId = '00000000-0000-4000-8000-000000000001';
    const action = { id: 'action', accountId };
    stackerNews.createActionWithOutcome
      .mockResolvedValueOnce({ action, created: true, changed: true })
      .mockResolvedValueOnce({ action, created: false, changed: false })
      .mockResolvedValueOnce({ action, created: false, changed: true });
    const submit = () => request(app).post('/api/stacker-news/actions').send({
      accountId, kind: 'draft_post', territoryId: '00000000-0000-4000-8000-000000000002',
      payload: { title: 'Example post', body: 'Example text' },
    });

    const created = await submit();
    expect(created.status).toBe(201);
    expect(created.body).toEqual(action);
    expect(emit).toHaveBeenCalledExactlyOnceWith('stacker-news:changed', { accountId });

    emit.mockClear();
    const replay = await submit();
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(action);
    expect(emit).not.toHaveBeenCalled();

    const transitioned = await submit();
    expect(transitioned.status).toBe(200);
    expect(emit).toHaveBeenCalledExactlyOnceWith('stacker-news:changed', { accountId });
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
