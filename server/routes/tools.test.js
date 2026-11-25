import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real tools registry (one JSON file per tool) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-tools-routes-') }));
afterAll(cleanupTempDataRoots);

const { default: toolsRoutes } = await import('./tools.js');

const app = express();
app.use(express.json());
app.use('/api/tools', toolsRoutes);
app.use(errorMiddleware);

const api = (method, path = '', body) => request(app)[method](`/api/tools${path}`).send(body);

describe('tools routes', () => {
  it('registers a tool that reads back by id and in the list, then updates, disables and deletes it', async () => {
    const created = await api('post', '', { id: 'sd-api', name: 'Stable Diffusion', category: 'image-generation', description: 'SD API tool', promptHints: 'use for pictures' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'sd-api', enabled: true });

    expect((await api('get', '/sd-api')).body).toMatchObject({ name: 'Stable Diffusion', category: 'image-generation' });
    expect((await api('get')).body.map((t) => t.id)).toContain('sd-api');

    const updated = await api('put', '/sd-api', { name: 'Updated SD', enabled: false });
    expect(updated.status).toBe(200);
    expect((await api('get', '/sd-api')).body).toMatchObject({ id: 'sd-api', name: 'Updated SD', category: 'image-generation', enabled: false });

    expect((await api('delete', '/sd-api')).status).toBe(204);
    expect((await api('get', '/sd-api')).status).toBe(404);
    expect((await api('get')).body.map((t) => t.id)).not.toContain('sd-api');
  });

  it('auto-generates an id when none is supplied and the tool is retrievable under it', async () => {
    const created = await api('post', '', { name: 'Auto Generated Tool', category: 'test' });
    expect(created.status).toBe(201);
    expect(created.body.id).toEqual(expect.any(String));
    expect((await api('get', `/${created.body.id}`)).body.name).toBe('Auto Generated Tool');
  });

  it('answers 404 for an unknown tool on read and update, without creating it', async () => {
    expect((await api('get', '/nonexistent')).status).toBe(404);
    expect((await api('put', '/nonexistent', { name: 'Test' })).status).toBe(404);
    expect((await api('get', '/nonexistent')).status).toBe(404);
  });

  it('refuses a missing name, and path-traversal ids without persisting anything', async () => {
    const before = (await api('get')).body.length;
    expect((await api('post', '', { category: 'test' })).status).toBe(400);
    expect((await api('post', '', { id: '../etc/passwd', name: 'Bad', category: 'test' })).status).toBe(400);
    expect((await api('get', '/..%2F..%2Fetc')).status).toBe(400);
    expect((await api('put', '/..%2Fhack', { name: 'Test' })).status).toBe(400);
    expect((await api('delete', '/..%2Fhack')).status).toBe(400);
    expect((await api('get')).body).toHaveLength(before);
  });
});
