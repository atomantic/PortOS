import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => fileStore.has(path) ? fileStore.get(path) : fallback),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

const svc = await import('./mediaCollections.js');

describe('mediaCollections service', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it('listCollections returns [] for fresh state', async () => {
    expect(await svc.listCollections()).toEqual([]);
  });

  it('createCollection persists a new collection', async () => {
    const c = await svc.createCollection({ name: 'Project A' });
    expect(c.id).toBe('uuid-1');
    expect(c.name).toBe('Project A');
    expect(c.items).toEqual([]);
    expect(c.coverKey).toBeNull();
    const all = await svc.listCollections();
    expect(all).toHaveLength(1);
  });

  it('addItem rejects duplicate (same kind+ref)', async () => {
    const c = await svc.createCollection({ name: 'A' });
    await svc.addItem(c.id, { kind: 'image', ref: 'foo.png' });
    await expect(svc.addItem(c.id, { kind: 'image', ref: 'foo.png' }))
      .rejects.toMatchObject({ code: svc.ERR_DUPLICATE });
  });

  it('many-to-many: same item can live in multiple collections', async () => {
    const a = await svc.createCollection({ name: 'A' });
    const b = await svc.createCollection({ name: 'B' });
    await svc.addItem(a.id, { kind: 'video', ref: 'vid-1' });
    await svc.addItem(b.id, { kind: 'video', ref: 'vid-1' });
    const all = await svc.listCollections();
    expect(all[0].items).toHaveLength(1);
    expect(all[1].items).toHaveLength(1);
  });

  it('removeItem clears coverKey when the cover is removed', async () => {
    const c = await svc.createCollection({ name: 'A' });
    await svc.addItem(c.id, { kind: 'image', ref: 'cover.png' });
    await svc.updateCollection(c.id, { coverKey: 'image:cover.png' });
    const after = await svc.removeItem(c.id, 'image:cover.png');
    expect(after.coverKey).toBeNull();
  });

  it('updateCollection rejects coverKey not in items', async () => {
    const c = await svc.createCollection({ name: 'A' });
    await expect(svc.updateCollection(c.id, { coverKey: 'image:missing.png' }))
      .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('deleteCollection removes the entry', async () => {
    const c = await svc.createCollection({ name: 'A' });
    await svc.deleteCollection(c.id);
    expect(await svc.listCollections()).toEqual([]);
  });

  it('findOrCreateCollectionByName returns the existing collection on case-insensitive match', async () => {
    const a = await svc.createCollection({ name: 'World: Foo' });
    const reused = await svc.findOrCreateCollectionByName({ name: '  world: foo  ' });
    expect(reused.id).toBe(a.id);
    expect(await svc.listCollections()).toHaveLength(1);
  });

  it('findOrCreateCollectionByName creates a new collection when no name matches', async () => {
    await svc.createCollection({ name: 'World: Foo' });
    const created = await svc.findOrCreateCollectionByName({
      name: 'World: Bar',
      description: 'desc',
    });
    expect(created.name).toBe('World: Bar');
    expect(created.description).toBe('desc');
    expect(await svc.listCollections()).toHaveLength(2);
  });

  it('findOrCreateCollectionByName validates name like createCollection', async () => {
    await expect(svc.findOrCreateCollectionByName({ name: '   ' }))
      .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  describe('bulkUpdateCollectionItems', () => {
    it('applies adds and removes in one write', async () => {
      const c = await svc.createCollection({ name: 'A' });
      await svc.addItem(c.id, { kind: 'image', ref: 'keep.png' });
      await svc.addItem(c.id, { kind: 'image', ref: 'drop.png' });
      const result = await svc.bulkUpdateCollectionItems(c.id, {
        add: [{ kind: 'image', ref: 'new1.png' }, { kind: 'video', ref: 'v1' }],
        remove: ['image:drop.png'],
      });
      expect(result.added).toBe(2);
      expect(result.removed).toBe(1);
      const refs = result.collection.items.map((it) => it.ref).sort();
      expect(refs).toEqual(['keep.png', 'new1.png', 'v1']);
    });

    it('is idempotent — re-adding an existing item is a no-op (not an error)', async () => {
      const c = await svc.createCollection({ name: 'A' });
      await svc.addItem(c.id, { kind: 'image', ref: 'foo.png' });
      const result = await svc.bulkUpdateCollectionItems(c.id, {
        add: [{ kind: 'image', ref: 'foo.png' }, { kind: 'image', ref: 'bar.png' }],
      });
      expect(result.added).toBe(1);
      expect(result.collection.items).toHaveLength(2);
    });

    it('silently ignores remove keys that aren\'t present', async () => {
      const c = await svc.createCollection({ name: 'A' });
      await svc.addItem(c.id, { kind: 'image', ref: 'foo.png' });
      const result = await svc.bulkUpdateCollectionItems(c.id, {
        remove: ['image:foo.png', 'image:ghost.png'],
      });
      expect(result.removed).toBe(1);
    });

    it('drops the cover when the cover item is removed', async () => {
      const c = await svc.createCollection({ name: 'A' });
      await svc.addItem(c.id, { kind: 'image', ref: 'cover.png' });
      await svc.updateCollection(c.id, { coverKey: 'image:cover.png' });
      const result = await svc.bulkUpdateCollectionItems(c.id, {
        remove: ['image:cover.png'],
      });
      expect(result.collection.coverKey).toBeNull();
    });

    it('rejects invalid item.kind without applying any partial mutation', async () => {
      const c = await svc.createCollection({ name: 'A' });
      await svc.addItem(c.id, { kind: 'image', ref: 'existing.png' });
      await expect(svc.bulkUpdateCollectionItems(c.id, {
        add: [{ kind: 'image', ref: 'ok.png' }, { kind: 'bogus', ref: 'bad.png' }],
        remove: ['image:existing.png'],
      })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
      const after = await svc.getCollection(c.id);
      expect(after.items.map((it) => it.ref)).toEqual(['existing.png']);
    });

    it('rejects when the collection would exceed ITEMS_MAX after the merge', async () => {
      const c = await svc.createCollection({ name: 'A' });
      // Seed a collection that's already at capacity via a hand-set file
      // (faster than calling addItem 5000 times).
      const all = await svc.listCollections();
      const fat = { ...all[0], items: Array.from({ length: svc.ITEMS_MAX }, (_, i) => ({
        kind: 'image', ref: `r${i}.png`, addedAt: new Date().toISOString(),
      })) };
      fileStore.set('/mock/data/media-collections.json', { collections: [fat] });
      await expect(svc.bulkUpdateCollectionItems(c.id, {
        add: [{ kind: 'image', ref: 'overflow.png' }],
      })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });

    it('throws ERR_NOT_FOUND for unknown collection id', async () => {
      await expect(svc.bulkUpdateCollectionItems('ghost', { add: [{ kind: 'image', ref: 'a.png' }] }))
        .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
    });

    it('rejects non-array add or remove', async () => {
      const c = await svc.createCollection({ name: 'A' });
      await expect(svc.bulkUpdateCollectionItems(c.id, { add: 'not-array' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
      await expect(svc.bulkUpdateCollectionItems(c.id, { remove: 'not-array' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });
  });

  it('sanitizes hand-edited JSON with bogus items', async () => {
    fileStore.set('/mock/data/media-collections.json', {
      collections: [
        { id: 'c1', name: 'OK', items: [
          { kind: 'image', ref: 'a.png' },
          { kind: 'image', ref: 'a.png' }, // duplicate -> dropped
          { kind: 'bogus', ref: 'b.png' }, // invalid kind -> dropped
          { ref: 'no-kind' },              // missing kind -> dropped
        ], coverKey: 'image:missing' },    // dangling cover -> nulled
      ],
    });
    const all = await svc.listCollections();
    expect(all[0].items).toHaveLength(1);
    expect(all[0].coverKey).toBeNull();
  });
});
