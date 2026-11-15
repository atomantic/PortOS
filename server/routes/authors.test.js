import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real authors service (file backend under the test runner) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-authors-routes-') }));
afterAll(cleanupTempDataRoots);

const { default: authorsRoutes } = await import('./authors.js');

const app = express();
app.use(express.json());
app.use('/api/authors', authorsRoutes);
app.use(errorMiddleware);

const api = (method, path = '', body) => request(app)[method](`/api/authors${path}`).send(body);

describe('authors routes', () => {
  it('creates an author that reads back by id and in the list, then patches and soft-deletes it', async () => {
    const created = await api('post', '', { name: 'Jane Example', bio: 'blurb' });
    expect(created.status).toBe(201);
    const { id } = created.body;

    const fetched = await api('get', `/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ id, name: 'Jane Example', bio: 'blurb' });
    expect((await api('get')).body.map((a) => a.id)).toContain(id);

    const patched = await api('patch', `/${id}`, { name: 'Janet Example' });
    expect(patched.status).toBe(200);
    expect((await api('get', `/${id}`)).body).toMatchObject({ name: 'Janet Example', bio: 'blurb' });

    expect((await api('delete', `/${id}`)).status).toBe(200);
    expect((await api('get', `/${id}`)).status).toBe(404);
    expect((await api('get')).body.map((a) => a.id)).not.toContain(id);
  });

  // Regression guard: every client caller (Authors page, AuthorPicker) calls
  // listAuthors() with no query params. If this ever returns an envelope instead
  // of a bare array, those lists silently render empty.
  it('lists a bare unbounded array by default and a bounded envelope when pagination is requested', async () => {
    for (let i = 0; i < 4; i++) await api('post', '', { name: `Paged ${i}` });

    const bare = await api('get');
    expect(Array.isArray(bare.body)).toBe(true);
    const total = bare.body.length;
    expect(total).toBeGreaterThanOrEqual(4);

    const page = await api('get', '?limit=2&offset=1');
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total, limit: 2, offset: 1 });
    expect(page.body.items.map((a) => a.id)).toEqual(bare.body.slice(1, 3).map((a) => a.id));
  });

  it('rejects a missing name and an empty patch without persisting anything', async () => {
    const before = (await api('get')).body.length;
    expect((await api('post', '', { bio: 'no name' })).status).toBe(400);
    expect((await api('get')).body).toHaveLength(before);

    const { body } = await api('post', '', { name: 'Stable' });
    expect((await api('patch', `/${body.id}`, {})).status).toBe(400);
    expect((await api('get', `/${body.id}`)).body.name).toBe('Stable');
  });

  it('returns 404 for an unknown author', async () => {
    expect((await api('get', '/auth-missing')).status).toBe(404);
  });
});
