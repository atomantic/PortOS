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
