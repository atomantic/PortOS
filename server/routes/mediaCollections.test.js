import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real mediaCollections service (collection store on disk) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-collections-') }));
afterAll(cleanupTempDataRoots);

// Only POST /:id/localize uses the peer-pull module, and it is network-bound. Stubbing it also
// keeps the whole peer-sync import graph out of this suite's load time.
vi.mock('../services/sharing/peerSyncAssets.js', () => ({
  pullMissingAssetsFromPeer: vi.fn(),
}));
vi.mock('../services/instances.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getPeers: vi.fn(async () => []),
}));

const { default: router } = await import('./mediaCollections.js');
const { getPeers } = await import('../services/instances.js');
const { markHosted } = await import('../services/peerHostedMedia.js');
const { pullMissingAssetsFromPeer } = await import('../services/sharing/peerSyncAssets.js');
const { saveHistory } = await import('../services/videoGen/history.js');

const app = express();
app.use(express.json());
app.use('/api/media/collections', router);
app.use(errorMiddleware);

const BASE = '/api/media/collections';
const api = (method, path = '', body) => request(app)[method](`${BASE}${path}`).send(body);
const create = async (name = 'Concept Art') => (await api('post', '', { name })).body;
const keysOf = (collection) => collection.items.map((i) => `${i.kind}:${i.ref}`);

it('copies the hosted filename attached to the collection video ID by history', async () => {
  const { id } = await create('Imported video');
  await api('post', `/${id}/items`, { kind: 'video', ref: 'imported-id' });
  await markHosted('video-peer', [{ kind: 'video', filename: 'imported.webm' }]);
  expect((await api('get', `/${id}`)).body.items[0]).toMatchObject({ location: 'missing' });

  await saveHistory([{ id: 'imported-id', filename: 'imported.webm' }]);
  const peers = [{ instanceId: 'video-peer', enabled: true }];
  vi.mocked(getPeers).mockResolvedValueOnce(peers).mockResolvedValueOnce(peers).mockResolvedValueOnce(peers);
  expect((await api('get', `/${id}`)).body.items[0]).toMatchObject({ location: 'remote', hostPeerId: 'video-peer' });
  const response = await api('post', `/${id}/localize`, { keys: ['video:imported-id'] });
  expect(response.body).toEqual({ requested: 1, started: 1 });
  await vi.waitFor(() => expect(pullMissingAssetsFromPeer).toHaveBeenCalledWith('video-peer',
    [{ kind: 'video', filename: 'imported.webm' }], { includeMismatched: false }));
});

describe('mediaCollections routes — create / read / patch / delete', () => {
  it('creates a collection that reads back by id and in the list, then patches and soft-deletes it', async () => {
    const created = await api('post', '', { name: 'Concept Art', description: 'refs' });
    expect(created.status).toBe(201);
    const { id } = created.body;

    const fetched = await api('get', `/${id}`);
    expect(fetched.body).toMatchObject({ id, name: 'Concept Art', description: 'refs', items: [] });
    expect((await api('get')).body.map((c) => c.id)).toContain(id);

    expect((await api('patch', `/${id}`, { name: 'Renamed' })).status).toBe(200);
    expect((await api('get', `/${id}`)).body).toMatchObject({ name: 'Renamed', description: 'refs' });

    expect((await api('delete', `/${id}`)).status).toBe(200);
    expect((await api('get', `/${id}`)).status).toBe(404);
    expect((await api('get')).body.map((c) => c.id)).not.toContain(id);
  });

  it('404s for an unknown collection and rejects an empty patch', async () => {
    expect((await api('get', '/mc-ghost')).status).toBe(404);
    const { id } = await create('Patchable');
    expect((await api('patch', `/${id}`, {})).status).toBe(400);
  });
});

describe('mediaCollections routes — provenance (#3311)', () => {
  it('persists a valid source through PATCH and rejects an unknown one', async () => {
    const { id } = await create('Provenance');
    expect((await api('patch', `/${id}`, { source: 'auto' })).status).toBe(200);
    expect((await api('get', `/${id}`)).body.source).toBe('auto');

    expect((await api('patch', `/${id}`, { source: 'robot' })).status).toBe(400);
    expect((await api('get', `/${id}`)).body.source).toBe('auto');
  });

  it('strips source from a create body so a client cannot claim provenance', async () => {
    const created = await api('post', '', { name: 'Claimed', source: 'auto' });
    expect(created.status).toBe(201);
    expect((await api('get', `/${created.body.id}`)).body.source).toBe('user');
  });
});

describe('mediaCollections routes — join', () => {
  it('creates a named collection with the union of items and keeps the sources when asked', async () => {
    const first = await create('First source');
    const second = await create('Second source');
    await api('post', `/${first.id}/items`, { kind: 'image', ref: 'shared' });
    await api('post', `/${second.id}/items`, { kind: 'image', ref: 'shared' });
    await api('post', `/${second.id}/items`, { kind: 'video', ref: 'shared' });

    const joined = await api('post', '/join', {
      name: '  Selected media — 2026  ', collectionIds: [first.id, second.id, first.id], keepOriginals: true,
    });
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({ name: 'Selected media — 2026', source: 'user', removedCollectionIds: [] });
    expect([first.id, second.id]).not.toContain(joined.body.id);
    expect(keysOf((await api('get', `/${joined.body.id}`)).body)).toEqual(['image:shared', 'video:shared']);
    expect(keysOf((await api('get', `/${first.id}`)).body)).toEqual(['image:shared']);
    expect(keysOf((await api('get', `/${second.id}`)).body)).toEqual(['image:shared', 'video:shared']);
  });

  it('merges into the same-named collection and retires the other sources', async () => {
    const keeper = await create('Creative Director: Daily Video');
    const dated = await create('Creative Director: Daily Video — 2026-07-16');
    const twin = await create('creative director: daily video');
    await api('post', `/${keeper.id}/items`, { kind: 'video', ref: 'v1' });
    await api('post', `/${dated.id}/items`, { kind: 'video', ref: 'v2' });
    await api('post', `/${twin.id}/items`, { kind: 'video', ref: 'v3' });

    const joined = await api('post', '/join', { name: 'Creative Director: Daily Video', collectionIds: [dated.id, keeper.id, twin.id] });
    expect(joined.status).toBe(201);
    // Both case-insensitive matches qualify; the first selected one in order wins.
    expect(joined.body.id).toBe(keeper.id);
    expect(joined.body.removedCollectionIds).toEqual([dated.id, twin.id]);
    expect(keysOf((await api('get', `/${keeper.id}`)).body)).toEqual(['video:v1', 'video:v2', 'video:v3']);
    expect((await api('get', `/${dated.id}`)).status).toBe(404);
    expect((await api('get', `/${twin.id}`)).status).toBe(404);
    const names = (await api('get')).body.map((c) => c.name);
    expect(names.filter((n) => n.toLowerCase() === 'creative director: daily video')).toHaveLength(1);
  });

  it('re-points a Creative Director project at the merged collection before retiring its old one', async () => {
    const { createProject, getProject } = await import('../services/creativeDirector/local.js');
    const project = await createProject({ name: 'Daily Video — 2026-07-17', aspectRatio: '16:9', quality: 'standard', modelId: 'example-model', targetDurationSeconds: 10 });
    const target = await create('Creative Director: Daily Video');

    const joined = await api('post', '/join', { name: target.name, collectionIds: [project.collectionId, target.id] });
    expect(joined.body.removedCollectionIds).toEqual([project.collectionId]);
    expect((await getProject(project.id)).collectionId).toBe(target.id);
  });

  it('rejects invalid selections without creating a destination', async () => {
    const first = await create('Available source');
    const second = await create('Deleted source');
    await api('delete', `/${second.id}`);

    const name = 'Incomplete join';
    expect((await api('post', '/join', { name, collectionIds: [first.id, first.id] })).status).toBe(400);
    expect((await api('post', '/join', { name, collectionIds: [first.id, second.id] })).status).toBe(404);
    expect((await api('get')).body.map((c) => c.name)).not.toContain(name);
  });
});

describe('mediaCollections routes — items', () => {
  it('adds and removes single items, 409s on a duplicate and 404s on a missing one', async () => {
    const { id } = await create('Items');
    expect((await api('post', `/${id}/items`, { kind: 'image', ref: 'a.png' })).status).toBe(200);
    expect((await api('post', `/${id}/items`, { kind: 'video', ref: 'v1' })).status).toBe(200);
    expect(keysOf((await api('get', `/${id}`)).body)).toEqual(['image:a.png', 'video:v1']);

    expect((await api('post', `/${id}/items`, { kind: 'image', ref: 'a.png' })).status).toBe(409);

    expect((await api('delete', `/${id}/items/${encodeURIComponent('image:a.png')}`)).status).toBe(200);
    expect(keysOf((await api('get', `/${id}`)).body)).toEqual(['video:v1']);
    expect((await api('delete', `/${id}/items/${encodeURIComponent('image:a.png')}`)).status).toBe(404);
  });
});

describe('mediaCollections routes — POST /:id/items/bulk', () => {
  it('400s when both add and remove are empty', async () => {
    const { id } = await create('Bulk empty');
    expect((await api('post', `/${id}/items/bulk`, {})).status).toBe(400);
  });

  it('400s for unknown body fields, an invalid kind or a ref containing ":" and adds nothing', async () => {
    const { id } = await create('Bulk invalid');
    const bodies = [
      { add: [{ kind: 'image', ref: 'a.png' }], bogus: true },
      { add: [{ kind: 'movie', ref: 'x.mp4' }] },
      { add: [{ kind: 'image', ref: 'bad:ref.png' }] },
    ];
    for (const body of bodies) expect((await api('post', `/${id}/items/bulk`, body)).status).toBe(400);
    expect((await api('get', `/${id}`)).body.items).toEqual([]);
  });

  it('returns { collection, added, removed } and persists the combined change', async () => {
    const { id } = await create('Bulk');
    await api('post', `/${id}/items`, { kind: 'image', ref: 'b.png' });

    const r = await api('post', `/${id}/items/bulk`, {
      add: [{ kind: 'image', ref: 'a.png' }, { kind: 'video', ref: 'v1' }],
      remove: ['image:b.png'],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 2, removed: 1 });
    expect(keysOf(r.body.collection)).toEqual(['image:a.png', 'video:v1']);
    expect(keysOf((await api('get', `/${id}`)).body)).toEqual(['image:a.png', 'video:v1']);

    // Re-adding what is already present is an idempotent no-op, not a 409.
    const again = await api('post', `/${id}/items/bulk`, { add: [{ kind: 'image', ref: 'a.png' }] });
    expect(again.body).toMatchObject({ added: 0, removed: 0 });
  });

  it('404s for an unknown collection', async () => {
    const r = await api('post', '/mc-ghost/items/bulk', { add: [{ kind: 'image', ref: 'a.png' }] });
    expect(r.status).toBe(404);
  });
});

describe('mediaCollections routes — GET / pagination', () => {
  // Regression guard: every client caller (apiImageVideo.listMediaCollections)
  // calls this with no query params. If it ever returns an envelope instead of
  // a bare array, those pickers silently render empty.
  it('returns the unbounded bare array by default and a bounded envelope when pagination is requested', async () => {
    for (let i = 0; i < 4; i++) await create(`Paged ${i}`);

    const bare = await api('get');
    expect(Array.isArray(bare.body)).toBe(true);
    const total = bare.body.length;
    expect(total).toBeGreaterThanOrEqual(4);

    const page = await api('get', '?limit=2&offset=1');
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total, limit: 2, offset: 1 });
    expect(page.body.items.map((c) => c.id)).toEqual(bare.body.slice(1, 3).map((c) => c.id));
  });

  it('400s on a repeated pagination key', async () => {
    const res = await api('get', '?limit=1&limit=2');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
