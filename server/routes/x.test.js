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

  it('normalizes an @ handle and does not accept an arbitrary username', async () => {
    x.createAccount.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', username: 'example_user' });
    const created = await request(app).post('/api/x/accounts').send({ label: 'Example', username: '@Example_User' });
    expect(created.status).toBe(201);
    expect(x.createAccount).toHaveBeenCalledWith(expect.objectContaining({ username: 'Example_User' }));

    const rejected = await request(app).post('/api/x/accounts').send({ label: 'Bad', username: 'not valid' });
    expect(rejected.status).toBe(400);
    expect(x.createAccount).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a missing draft and 409 only for a wrong-state one', async () => {
    const id = '00000000-0000-4000-8000-000000000010';
    const missing = Object.assign(new Error('X draft not found'), { status: 404 });
    x.reviewDraft.mockRejectedValueOnce(missing);
    expect((await request(app).post(`/api/x/drafts/${id}/review`).send({ state: 'approved' })).status).toBe(404);
    x.reviewDraft.mockResolvedValueOnce(null);
    expect((await request(app).post(`/api/x/drafts/${id}/review`).send({ state: 'approved' })).status).toBe(409);
    x.openApprovedDraft.mockRejectedValueOnce(missing);
    expect((await request(app).post(`/api/x/drafts/${id}/open`).send({})).status).toBe(404);
    x.openApprovedDraft.mockResolvedValueOnce(null);
    expect((await request(app).post(`/api/x/drafts/${id}/open`).send({})).status).toBe(409);
  });

  it.each(['posts', 'drafts'])('404s %s for an unknown account and 200s an empty list for a real one', async (kind) => {
    const id = '00000000-0000-4000-8000-000000000001';
    x.listPosts.mockResolvedValue([]);
    x.listDrafts.mockResolvedValue([]);
    x.getAccount.mockResolvedValueOnce(null);
    expect((await request(app).get(`/api/x/accounts/${id}/${kind}`)).status).toBe(404);
    x.getAccount.mockResolvedValueOnce({ id });
    const ok = await request(app).get(`/api/x/accounts/${id}/${kind}`);
    expect(ok.status).toBe(200);
    expect(ok.body[kind]).toEqual([]);
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
