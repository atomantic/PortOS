import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorEvents, errorMiddleware } from '../lib/errorHandler.js';

const observeError = vi.fn();
beforeAll(() => errorEvents.on('error', observeError));
afterAll(() => errorEvents.off('error', observeError));

const x = vi.hoisted(() => ({
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
  deleteDraft: vi.fn(),
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
  updateDraft: vi.fn(),
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

  it('validates edits, returns the updated draft, and broadcasts the affected account', async () => {
    const id = '00000000-0000-4000-8000-000000000010';
    const accountId = '00000000-0000-4000-8000-000000000001';
    const emit = vi.fn();
    app.set('io', { emit });
    const updated = { id, accountId, body: 'Revised draft', state: 'draft' };
    x.updateDraft.mockResolvedValueOnce(updated);
    const response = await request(app).patch(`/api/x/drafts/${id}`).send({ body: ' Revised draft ' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(updated);
    expect(x.updateDraft).toHaveBeenCalledWith(id, { body: 'Revised draft' });
    expect(emit).toHaveBeenCalledWith('x:changed', { accountId });

    for (const payload of [{}, { body: ' ' }, { body: 'x'.repeat(4001) }, { body: 'Hi', state: 'approved' }]) {
      expect((await request(app).patch(`/api/x/drafts/${id}`).send(payload)).status).toBe(400);
    }
    expect((await request(app).patch('/api/x/drafts/invalid').send({ body: 'Hi' })).status).toBe(400);
    expect(x.updateDraft).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls.filter(([event]) => event === 'x:changed')).toEqual([['x:changed', { accountId }]]);
  });

  it('returns a conflict for a draft in a state that forbids editing', async () => {
    x.updateDraft.mockResolvedValueOnce(null);
    const response = await request(app).patch('/api/x/drafts/00000000-0000-4000-8000-000000000010').send({ body: 'Hi' });
    expect(response.status).toBe(409);
  });

  it('deletes a local draft with an empty response and broadcasts only on success', async () => {
    const id = '00000000-0000-4000-8000-000000000010';
    const accountId = '00000000-0000-4000-8000-000000000001';
    const emit = vi.fn();
    app.set('io', { emit });
    x.deleteDraft.mockResolvedValueOnce(accountId).mockResolvedValueOnce(null);

    expect((await request(app).delete('/api/x/drafts/invalid')).status).toBe(400);
    const response = await request(app).delete(`/api/x/drafts/${id}`);
    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect((await request(app).delete(`/api/x/drafts/${id}`)).status).toBe(404);
    expect(x.deleteDraft.mock.calls).toEqual([[id], [id]]);
    expect(emit.mock.calls.filter(([event]) => event === 'x:changed')).toEqual([['x:changed', { accountId }]]);
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
