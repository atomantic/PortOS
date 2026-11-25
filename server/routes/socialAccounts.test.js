import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real social-accounts service (cached JSON store) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-social-accounts-routes-') }));
afterAll(cleanupTempDataRoots);

const { default: socialAccountsRoutes } = await import('./socialAccounts.js');

const app = express();
app.use(express.json());
app.use('/api/digital-twin/social-accounts', socialAccountsRoutes);
app.use(errorMiddleware);
const BASE = '/api/digital-twin/social-accounts';

describe('/api/digital-twin/social-accounts', () => {
  it('creates a valid account with schema defaults that reads back, and refuses an unknown platform', async () => {
    const ok = await request(app).post(BASE).send({ platform: 'github', username: 'example-user' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      platform: 'github', username: 'example-user', bio: '', ingestionEnabled: false,
      url: 'https://github.com/example-user',
    });
    const read = await request(app).get(`${BASE}/${ok.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: ok.body.id, platform: 'github', contentTypes: [] });

    const before = (await request(app).get(BASE)).body.accounts.length;
    const bad = await request(app).post(BASE).send({ platform: 'myspace', username: 'example-user' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    expect((await request(app).get(BASE)).body.accounts).toHaveLength(before);
  });

  it('filters the list by platform or category from the query string', async () => {
    await request(app).post(BASE).send({ platform: 'linkedin', username: 'pro-user' });
    const byPlatform = await request(app).get(`${BASE}?platform=linkedin`);
    expect(byPlatform.body.accounts.length).toBeGreaterThan(0);
    expect(byPlatform.body.accounts.every((a) => a.platform === 'linkedin')).toBe(true);

    const byCategory = await request(app).get(`${BASE}?category=professional`);
    expect(byCategory.body.accounts.map((a) => a.username)).toContain('pro-user');
    expect(byCategory.body.accounts.every((a) => a.platform === 'linkedin')).toBe(true);

    const repeated = await request(app).get(`${BASE}?platform=x&platform=github`);
    expect(repeated.status).toBe(400);
  });

  it('updates an account, then deletes it so it is gone from reads and stats', async () => {
    const { body: created } = await request(app).post(BASE).send({ platform: 'reddit', username: 'to-delete' });
    const updated = await request(app).put(`${BASE}/${created.id}`).send({ bio: 'new bio' });
    expect(updated.status).toBe(200);
    expect((await request(app).get(`${BASE}/${created.id}`)).body.bio).toBe('new bio');

    const statsBefore = (await request(app).get(`${BASE}/stats`)).body;
    expect((await request(app).delete(`${BASE}/${created.id}`)).status).toBe(204);
    expect((await request(app).get(`${BASE}/${created.id}`)).status).toBe(404);
    const statsAfter = (await request(app).get(`${BASE}/stats`)).body;
    expect(statsAfter.total).toBe(statsBefore.total - 1);
  });

  it('answers 404 for a missing account on read, update and delete', async () => {
    expect((await request(app).get(`${BASE}/missing`)).status).toBe(404);
    expect((await request(app).put(`${BASE}/missing`).send({ bio: 'x' })).status).toBe(404);
    expect((await request(app).delete(`${BASE}/missing`)).status).toBe(404);
  });
});
