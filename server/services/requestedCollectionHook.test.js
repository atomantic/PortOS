import { describe, it, expect, vi, beforeEach } from 'vitest';

const collections = [];
vi.mock('./mediaCollections.js', () => ({
  ERR_DUPLICATE: 'DUPLICATE',
  findOrCreateCollectionByName: vi.fn(async ({ name }) => {
    await new Promise((r) => setTimeout(r, 5));
    let c = collections.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) { c = { id: `c${collections.length}`, name, items: [] }; collections.push(c); }
    return c;
  }),
  addItem: vi.fn(async (id, item) => {
    const c = collections.find((x) => x.id === id);
    if (c.items.some((i) => i.kind === item.kind && i.ref === item.ref)) throw Object.assign(new Error('dup'), { code: 'DUPLICATE' });
    c.items.push(item);
  }),
}));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const { initRequestedCollectionHook, __testing } = await import('./requestedCollectionHook.js');

beforeEach(() => { __testing.reset(); collections.length = 0; initRequestedCollectionHook(); });

describe('requested collection hook', () => {
  it('creates the named collection once and files image and video renders into it', async () => {
    mediaJobEvents.emit('completed', { kind: 'image', id: 'j1', params: { collectionName: 'Sketches' }, result: { filename: 'a.png' } });
    mediaJobEvents.emit('completed', { kind: 'video', id: 'j2', params: { collectionName: ' sketches ' }, result: { generationId: 'gen-2' } });
    mediaJobEvents.emit('completed', { kind: 'image', id: 'j1', params: { collectionName: 'Sketches' }, result: { filename: 'a.png' } });
    await __testing.drain();
    expect(collections).toHaveLength(1);
    expect(collections[0].items).toEqual([{ kind: 'image', ref: 'a.png' }, { kind: 'video', ref: 'gen-2' }]);
  });

  it('ignores jobs without a collection name', async () => {
    mediaJobEvents.emit('completed', { kind: 'image', id: 'j3', params: {}, result: { filename: 'b.png' } });
    await __testing.drain();
    expect(collections).toHaveLength(0);
  });
});
