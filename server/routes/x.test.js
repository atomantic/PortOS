import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const x = vi.hoisted(() => ({
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
  getAccount: vi.fn(),
  listAccounts: vi.fn(),
  listDrafts: vi.fn(),
  listPosts: vi.fn(),
  openAccountDestination: vi.fn(),
  openApprovedDraft: vi.fn(),
  reviewDraft: vi.fn(),
  syncAccount: vi.fn(),
  updateAccount: vi.fn(),
  createDraft: vi.fn(),
}));
vi.mock('../services/x.js', () => x);

import xRoutes from './x.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/x', xRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('X routes', () => {
  let app;

  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
    x.listAccounts.mockResolvedValue([]);
  });

  it('exposes the supervised read/write capabilities', async () => {
    const response = await request(app).get('/api/x/capabilities');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      readTransport: 'managed-browser',
      automaticPublishing: false,
      writes: ['draft', 'manual-compose-handoff'],
    });
  });

  it('normalizes an @ handle and does not accept an arbitrary username', async () => {
    x.createAccount.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', username: 'example_user' });
    const created = await request(app).post('/api/x/accounts').send({ label: 'Example', username: '@Example_User' });
    expect(created.status).toBe(201);
    expect(x.createAccount).toHaveBeenCalledWith(expect.objectContaining({ username: 'Example_User' }));

    const rejected = await request(app).post('/api/x/accounts').send({ label: 'Bad', username: 'not valid' });
    expect(rejected.status).toBe(400);
    expect(x.createAccount).toHaveBeenCalledTimes(1);
  });

  it('keeps browser handoffs behind the named destination allowlist', async () => {
    x.openAccountDestination.mockResolvedValue({ pageId: 'page-1', url: 'https://x.com/example_user' });
    const response = await request(app)
      .post('/api/x/accounts/00000000-0000-4000-8000-000000000001/open')
      .send({ kind: 'profile' });
    expect(response.status).toBe(200);
    expect(x.openAccountDestination).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', 'profile');

    const rejected = await request(app)
      .post('/api/x/accounts/00000000-0000-4000-8000-000000000001/open')
      .send({ kind: 'javascript' });
    expect(rejected.status).toBe(400);
  });
});
