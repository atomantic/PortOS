import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
const store = vi.hoisted(() => ({ get: vi.fn(), sources: vi.fn(), relations: vi.fn(), revisions: vi.fn(), media: vi.fn(), missing: vi.fn(), siblings: vi.fn(), context: vi.fn(), cover: vi.fn() }));
vi.mock('../services/catalogDB.js', () => ({ getIngredient: store.get, listSourcesForIngredient: store.sources, listRelationsForIngredient: store.relations,
  listIngredientRevisions: store.revisions, listMediaForIngredient: store.media, getMissingMediaForIngredient: store.missing, listSiblingIngredientsBySource: store.siblings, getIngredientMediaCover: store.cover }));
vi.mock('../services/catalogSync.js', () => ({}));
vi.mock('../services/catalogPrimitives.js', () => ({ getPrimitiveContext: store.context, setPrimitiveOwner: vi.fn(), forkPrimitive: vi.fn() }));
vi.mock('../services/catalogDB/identityAccess.js', () => ({ getCatalogIdentityAccess: async () => null }));
import router from './catalog.js';
const app = express();
app.use('/api/catalog', router);
app.use(errorMiddleware);
const path = '/api/catalog/ingredients/example-primitive/details';
beforeEach(() => {
  vi.clearAllMocks();
  store.get.mockResolvedValue({ id: 'example-primitive', type: 'character', name: 'Example courier', payload: { physicalDescription: 'x'.repeat(14500) }, embedding: [1, 2, 3] });
  store.sources.mockResolvedValue([]); store.relations.mockResolvedValue({ inbound: [], outbound: [] }); store.siblings.mockResolvedValue(new Map());
  store.revisions.mockResolvedValue({ items: Array.from({ length: 10 }, (_, id) => ({ id, payload: { description: 'r'.repeat(8000) } })) });
  store.media.mockResolvedValue(Array.from({ length: 50 }, (_, id) => ({ mediaKey: `example-${id}.png`, kind: 'reference', metadata: { prompt: 'm'.repeat(4700) } })));
  store.missing.mockResolvedValue([]);
  store.cover.mockResolvedValue({ portraitKey: 'example-cover.png', referenceKey: null });
  store.context.mockImplementation(async (_id, { includeDerived }) => ({ status: 'needs-review', owner: null, refs: [], usageComplete: includeDerived }));
});
describe('purpose-specific catalog detail loading', () => {
  it('returns the usable profile without waiting for media, history or derived usage', async () => {
    store.revisions.mockImplementation(() => new Promise(() => {})); store.media.mockImplementation(() => new Promise(() => {}));
    store.context.mockImplementation((_id, options) => options.includeDerived ? new Promise(() => {}) : Promise.resolve({ refs: [], status: 'needs-review', usageComplete: false }));
    const response = await request(app).get(`${path}?view=profile`);
    expect(response.status).toBe(200);
    expect(response.body.ingredient.name).toBe('Example courier');
    expect(response.body.universeContext.usageComplete).toBe(false);
    expect(response.body.coverMedia.portraitKey).toBe('example-cover.png');
    expect(response.body).not.toHaveProperty('media'); expect(response.body).not.toHaveProperty('revisions');
    expect(response.body.ingredient).not.toHaveProperty('embedding');
    expect(store.media).not.toHaveBeenCalled(); expect(store.revisions).not.toHaveBeenCalled(); expect(store.missing).not.toHaveBeenCalled();
  });
  it('keeps full-detail compatibility and reuses the one media read for integrity', async () => {
    const full = await request(app).get(path);
    const profile = await request(app).get(`${path}?view=profile`);
    expect(full.status).toBe(200); expect(full.body.revisions).toHaveLength(10); expect(full.body.media).toHaveLength(50);
    const fullBytes = Buffer.byteLength(JSON.stringify(full.body)); const profileBytes = Buffer.byteLength(JSON.stringify(profile.body));
    expect(profileBytes).toBeLessThan(fullBytes / 10);
    expect(store.media).toHaveBeenCalledTimes(1);
    expect(store.missing).toHaveBeenCalledWith('example-primitive', { media: full.body.media });
    store.media.mockClear(); store.missing.mockClear();
    const media = await request(app).get(`${path}?view=media`);
    expect(media.status).toBe(200); expect(media.body.media).toHaveLength(50); expect(media.body).not.toHaveProperty('ingredient');
    expect(store.media).toHaveBeenCalledTimes(1); expect(store.missing).toHaveBeenCalledWith('example-primitive', { media: media.body.media });
    console.log(`📊 Synthetic HTTP detail bytes: full=${fullBytes}, profile=${profileBytes}; no live content or latency claim`);
  });
  it('rejects unknown projections before storage work', async () => {
    expect((await request(app).get(`${path}?view=unknown`)).status).toBe(400);
    expect(store.get).not.toHaveBeenCalled();
  });
});
