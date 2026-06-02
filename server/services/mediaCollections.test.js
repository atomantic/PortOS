import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockNoPeerSync } from '../lib/mockPathsDataRoot.js';

// Real per-suite tmpdir backing the per-record media-collections/ layout that
// migration 059 produces. The fileUtils mock below overrides PATHS.data so the
// service + collectionStore land here instead of the real ./data; everything
// else (atomicWrite/readJSONFile/ensureDir) uses the real impl so the store's
// readdir/lstat/rm operate against a real fs tree.
const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'media-collections-test-'));
const COLLECTIONS_DIR = join(TEST_DATA_ROOT, 'media-collections');

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

// Suppress the fire-and-forget dynamic import so tests don't load the real
// peerSync module graph (which reads the live peer registry and imports
// universe/series services).
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync());

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

const svc = await import('./mediaCollections.js');
const cj = await import('../lib/conflictJournal.js');

// Wipe + recreate the collections dir before every test so each starts clean.
// The empty dir means collectionStore's readdir is the source of truth and its
// process-local knownIds fallback never leaks ids across tests.
//
// Also wipe the conflict-journal + base-hash side store and reset the
// conflictJournal in-memory base-hash cache: mergeMediaCollectionsFromSync now
// seeds/advances per-collection base hashes, and that Map is module-level — so
// without a reset a base hash seeded by an earlier test's insert would bleed
// into a later test that reuses the same collection id and spuriously trip the
// 3-way divergence detector (base==null is the correct first-merge state).
function resetStore() {
  rmSync(COLLECTIONS_DIR, { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'sharing'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'conflict-journal'), { recursive: true, force: true });
  mkdirSync(COLLECTIONS_DIR, { recursive: true });
  cj.__resetBaseHashCacheForTests();
  uuidCounter = 0;
}

// Seed per-record files exactly as migration 059 would (one dir per record +
// a type-level index.json). Takes the same `{ collections: [...] }` shape the
// suite previously handed to the monolithic file store.
async function seedState({ collections = [] } = {}) {
  await mkdir(COLLECTIONS_DIR, { recursive: true });
  for (const c of collections) {
    const recDir = join(COLLECTIONS_DIR, c.id);
    await mkdir(recDir, { recursive: true });
    await writeFile(join(recDir, 'index.json'), JSON.stringify(c, null, 2));
  }
  await writeFile(join(COLLECTIONS_DIR, 'index.json'), JSON.stringify({
    schemaVersion: 1, type: 'mediaCollections', updatedAt: new Date().toISOString(), config: {},
  }, null, 2));
}

// Read the raw persisted record (pre-sanitize) for storage-level assertions.
async function readStored(id) {
  const raw = await readFile(join(COLLECTIONS_DIR, id, 'index.json'), 'utf-8').catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});

beforeEach(() => resetStore());

describe('mediaCollections service', () => {

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

  it('addItem rejects refs with true path-traversal segments (but allows .. inside a basename)', async () => {
    // Mirrors sanitizeItem's path-traversal rejection on the write boundary.
    // Reject path SEPARATORS and exact `.`/`..` path segments — NOT every
    // ref containing the substring `..`. Legitimate gallery filenames like
    // `my..render.png` round-trip through reads + peer sync and must be
    // addable through the API too.
    const c = await svc.createCollection({ name: 'A' });
    for (const ref of ['../etc/passwd', 'subdir/file.png', 'a\\b.png', '..', '.']) {
      await expect(svc.addItem(c.id, { kind: 'image', ref }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    }
    // And the inverse: refs with `..` in the basename SHOULD succeed.
    await expect(svc.addItem(c.id, { kind: 'image', ref: 'foo..bar.png' }))
      .resolves.toBeTruthy();
  });

  it('bulkUpdateCollectionItems rejects path-traversal refs up-front', async () => {
    const c = await svc.createCollection({ name: 'A' });
    await expect(svc.bulkUpdateCollectionItems(c.id, {
      add: [{ kind: 'image', ref: '../etc/passwd' }],
    })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
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

  it('deleteCollection soft-deletes: absent from live list, present with deleted===true in includeDeleted list', async () => {
    const c = await svc.createCollection({ name: 'A' });
    await svc.deleteCollection(c.id);
    expect(await svc.listCollections()).toEqual([]);
    const all = await svc.listCollections({ includeDeleted: true });
    expect(all).toHaveLength(1);
    expect(all[0].deleted).toBe(true);
    expect(all[0].id).toBe(c.id);
  });

  it('write mutators map a malformed id to ERR_NOT_FOUND (not a raw store error → 500)', async () => {
    // A path-param id that fails the store allowlist (e.g. "has space",
    // "../escape") must surface as a clean NOT_FOUND — the same result the
    // pre-split scan gave — instead of throwing an uncoded error from
    // queueRecordWrite that the route mapper would turn into a 500.
    for (const bad of ['has space', '../escape', 'a/b']) {
      await expect(svc.addItem(bad, { kind: 'image', ref: 'x.png' }))
        .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      await expect(svc.updateCollection(bad, { description: 'x' }))
        .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      await expect(svc.deleteCollection(bad))
        .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      await expect(svc.removeItem(bad, 'image:x.png'))
        .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      await expect(svc.bulkUpdateCollectionItems(bad, { add: [{ kind: 'image', ref: 'x.png' }] }))
        .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
    }
  });

  it('deleteCollection clears coverKey on the persisted tombstone (no dangling cover in the wire record)', async () => {
    const c = await svc.createCollection({ name: 'WithCover' });
    await svc.addItem(c.id, { kind: 'image', ref: 'cover.png' });
    await svc.updateCollection(c.id, { coverKey: 'image:cover.png' });
    await svc.deleteCollection(c.id);
    // Assert on the PERSISTED record — listCollections' sanitizer would null a
    // dangling coverKey on read regardless, so inspect storage directly.
    const stored = await readStored(c.id);
    expect(stored.deleted).toBe(true);
    expect(stored.items).toEqual([]);
    expect(stored.coverKey).toBeNull();
  });

  it('deleteCollection emits recordDeleted for mediaCollection and receivable via recordEvents', async () => {
    const { recordEvents } = await import('./sharing/recordEvents.js');
    const deletedEvts = [];
    const handler = (evt) => deletedEvts.push(evt);
    recordEvents.on('deleted', handler);
    try {
      const c = await svc.createCollection({ name: 'B' });
      await svc.deleteCollection(c.id);
      expect(deletedEvts).toContainEqual(expect.objectContaining({ recordKind: 'mediaCollection', recordId: c.id }));
    } finally {
      recordEvents.off('deleted', handler);
    }
  });

  it('updateCollection throws ERR_NOT_FOUND on a soft-deleted collection', async () => {
    const c = await svc.createCollection({ name: 'Live' });
    await svc.deleteCollection(c.id);
    await expect(svc.updateCollection(c.id, { name: 'Revived' }))
      .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it('item mutators (addItem/removeItem/bulkUpdateCollectionItems) throw ERR_NOT_FOUND on a tombstone', async () => {
    const c = await svc.createCollection({ name: 'Live' });
    await svc.addItem(c.id, { kind: 'image', ref: 'keep.png' });
    await svc.deleteCollection(c.id);
    // All three behave as not-found after soft-delete (no tombstone resurrection).
    await expect(svc.addItem(c.id, { kind: 'image', ref: 'new.png' }))
      .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
    await expect(svc.removeItem(c.id, 'image:keep.png'))
      .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
    await expect(svc.bulkUpdateCollectionItems(c.id, { add: [{ kind: 'image', ref: 'b.png' }] }))
      .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it('deleteCollection is idempotent on an already-tombstoned record (no re-stamp, no re-emit)', async () => {
    const { recordEvents } = await import('./sharing/recordEvents.js');
    const c = await svc.createCollection({ name: 'DoubleDelete' });
    await svc.deleteCollection(c.id);
    const firstDeletedAt = (await svc.listCollections({ includeDeleted: true })).find((x) => x.id === c.id).deletedAt;
    await new Promise((r) => setTimeout(r, 5)); // ensure a later timestamp WOULD differ if re-stamped
    const deletedEvts = [];
    const handler = (evt) => deletedEvts.push(evt);
    recordEvents.on('deleted', handler);
    try {
      const res = await svc.deleteCollection(c.id);
      expect(res).toEqual({ id: c.id });
      const afterSecond = (await svc.listCollections({ includeDeleted: true })).find((x) => x.id === c.id);
      expect(afterSecond.deletedAt).toBe(firstDeletedAt); // not re-stamped
      expect(deletedEvts).toEqual([]);                    // not re-emitted
    } finally {
      recordEvents.off('deleted', handler);
    }
  });

  it('deleteCollection emits recordUpdated on the universe when the deleted collection was linked', async () => {
    const events = [];
    const { recordEvents } = await import('./sharing/recordEvents.js');
    const listener = (evt) => events.push(evt);
    recordEvents.on('updated', listener);
    try {
      const linked = await svc.findOrCreateUniverseCollection({
        universeId: 'u-1', universeName: 'Foo',
      });
      events.length = 0; // ignore the create-time emit
      await svc.deleteCollection(linked.id);
      expect(events).toContainEqual(expect.objectContaining({ recordKind: 'universe', recordId: 'u-1' }));
    } finally {
      recordEvents.off('updated', listener);
    }
  });

  it('deleteCollection does NOT emit when the deleted collection was unlinked', async () => {
    const events = [];
    const { recordEvents } = await import('./sharing/recordEvents.js');
    const listener = (evt) => events.push(evt);
    recordEvents.on('updated', listener);
    try {
      const c = await svc.createCollection({ name: 'Orphan' });
      events.length = 0;
      await svc.deleteCollection(c.id);
      expect(events).toEqual([]);
    } finally {
      recordEvents.off('updated', listener);
    }
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
      await seedState({ collections: [fat] });
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

  describe('universe-linked collections', () => {
    it('updateCollection rejects a name change when the collection is universe-linked', async () => {
      const linked = await svc.findOrCreateCollectionByName({
        name: 'Universe: Foo', universeId: 'u-1',
      });
      await expect(svc.updateCollection(linked.id, { name: 'Renamed' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
      // Other patches (coverKey, description) still go through.
      const updated = await svc.updateCollection(linked.id, { description: 'new desc' });
      expect(updated.description).toBe('new desc');
    });

    it('updateCollection allows a same-name PATCH (no-op) on universe-linked collections', async () => {
      const linked = await svc.findOrCreateCollectionByName({
        name: 'Universe: Foo', universeId: 'u-1',
      });
      const result = await svc.updateCollection(linked.id, { name: linked.name });
      expect(result.name).toBe('Universe: Foo');
    });

    it('universeCollectionNameFor produces the canonical "Universe: <name>" string and truncates', () => {
      expect(svc.universeCollectionNameFor('Foo')).toBe('Universe: Foo');
      const long = 'x'.repeat(200);
      expect(svc.universeCollectionNameFor(long).length).toBe(svc.NAME_MAX_LENGTH);
    });

    it('findCollectionByUniverseId locates the linked collection (or returns null)', async () => {
      expect(await svc.findCollectionByUniverseId('u-ghost')).toBeNull();
      const linked = await svc.findOrCreateCollectionByName({
        name: 'Universe: Foo', universeId: 'u-1',
      });
      const found = await svc.findCollectionByUniverseId('u-1');
      expect(found?.id).toBe(linked.id);
    });

    it('findCollectionByUniverseId falls back to the scan for a legacy record at a random id', async () => {
      // A pre-migration-038 collection carries the universeId at a random id,
      // so the deterministic loadOne fast-path misses it — the full scan must
      // still resolve it.
      const now = new Date().toISOString();
      await seedState({ collections: [
        { id: 'uuid-legacy', name: 'Universe: Foo', description: '', coverKey: null, universeId: 'u-1', items: [], createdAt: now, updatedAt: now },
      ] });
      const found = await svc.findCollectionByUniverseId('u-1');
      expect(found?.id).toBe('uuid-legacy');
    });

    it('findCollectionByUniverseId skips a tombstone at the deterministic id and finds the live legacy record', async () => {
      // A tombstone sitting at uc-<id> must not shadow a still-live collection
      // carrying the same universeId at a random id (fast-path excludes
      // deleted, fallback scan finds the live one).
      const now = new Date().toISOString();
      await seedState({ collections: [
        { id: 'uc-u-1', name: 'Universe: Foo', description: '', coverKey: null, universeId: 'u-1', items: [], createdAt: now, updatedAt: now, deleted: true, deletedAt: now },
        { id: 'uuid-live', name: 'Universe: Foo', description: '', coverKey: null, universeId: 'u-1', items: [], createdAt: now, updatedAt: now },
      ] });
      const found = await svc.findCollectionByUniverseId('u-1');
      expect(found?.id).toBe('uuid-live');
    });

    it('findCollectionByUniverseId prefers the canonical deterministic id when a live random-id duplicate also carries the stamp', async () => {
      // A transient duplicate — e.g. an unconverged peer pushed a random-id
      // copy while a converged canonical copy already exists. The fast path
      // deterministically returns the canonical uc-<id> record (the converged
      // cross-machine identity) rather than whichever the directory scan
      // happened to list first (the old loadAll order was filesystem-dependent,
      // so this also removes a source of non-determinism). Items union-merge on
      // sync, so the random-id duplicate is reconciled without loss.
      const now = new Date().toISOString();
      await seedState({ collections: [
        { id: 'uc-u-1', name: 'Universe: Foo', description: '', coverKey: null, universeId: 'u-1', items: [], createdAt: now, updatedAt: now },
        { id: 'uuid-dupe', name: 'Universe: Foo', description: '', coverKey: null, universeId: 'u-1', items: [], createdAt: now, updatedAt: now },
      ] });
      const found = await svc.findCollectionByUniverseId('u-1');
      expect(found?.id).toBe('uc-u-1');
    });

    it('renameCollectionForUniverse cascades a new name onto the linked collection', async () => {
      const linked = await svc.findOrCreateCollectionByName({
        name: 'Universe: Foo', universeId: 'u-1',
      });
      const updated = await svc.renameCollectionForUniverse('u-1', 'Bar');
      expect(updated.id).toBe(linked.id);
      expect(updated.name).toBe('Universe: Bar');
      const fresh = await svc.getCollection(linked.id);
      expect(fresh.name).toBe('Universe: Bar');
    });

    it('renameCollectionForUniverse is a no-op when no linked collection exists', async () => {
      const result = await svc.renameCollectionForUniverse('u-nope', 'Bar');
      expect(result).toBeNull();
    });

    it('renameCollectionForUniverse no-ops when the name already matches', async () => {
      const linked = await svc.findOrCreateCollectionByName({
        name: 'Universe: Foo', universeId: 'u-1',
      });
      const result = await svc.renameCollectionForUniverse('u-1', 'Foo');
      expect(result.name).toBe(linked.name);
      expect(result.updatedAt).toBe(linked.updatedAt);
    });

    it('renameCollectionForUniverse updates ALL matching collections (handles hand-edited duplicates)', async () => {
      // Two linked collections with the same universeId — could happen from
      // a pre-serialization race or a hand-edited file. Both must be
      // renamed; otherwise the straggler stays rename-locked under the
      // stale name.
      const a = await svc.findOrCreateCollectionByName({
        name: 'Universe: OldName', universeId: 'u-1',
      });
      await seedState({
        collections: [
          a,
          { ...a, id: 'dup-id', name: 'Universe: OldName' },
        ],
      });
      await svc.renameCollectionForUniverse('u-1', 'NewName');
      const all = await svc.listCollections();
      const linked = all.filter((c) => c.universeId === 'u-1');
      expect(linked).toHaveLength(2);
      expect(linked.map((c) => c.name).sort()).toEqual([
        'Universe: NewName', 'Universe: NewName',
      ]);
    });

    it('unlinkCollectionsForUniverse clears the universeId on linked collections (preserves items)', async () => {
      const linked = await svc.findOrCreateCollectionByName({
        name: 'Universe: Foo', universeId: 'u-1',
      });
      await svc.addItem(linked.id, { kind: 'image', ref: 'art.png' });
      const cleared = await svc.unlinkCollectionsForUniverse('u-1');
      expect(cleared).toEqual([linked.id]);
      const fresh = await svc.getCollection(linked.id);
      expect(fresh.universeId).toBeNull();
      expect(fresh.items).toHaveLength(1);
      // Lock released — renames now succeed.
      const renamed = await svc.updateCollection(linked.id, { name: 'Orphan Bucket' });
      expect(renamed.name).toBe('Orphan Bucket');
    });

    it('unlinkCollectionsForUniverse is a no-op when no collection is linked', async () => {
      expect(await svc.unlinkCollectionsForUniverse('ghost')).toEqual([]);
      expect(await svc.unlinkCollectionsForUniverse(null)).toEqual([]);
    });

    it('unlinkCollectionsForUniverse preserves updatedAt (cascade side-effect, not a user edit)', async () => {
      // The bump would let the unlinked bucket out-race its own tombstone on a
      // peer during a universe merge — see unlinkCollectionsForUniverse's note.
      await seedState({
        collections: [{
          id: 'uc-u1', name: 'Universe: Foo', description: '', coverKey: null,
          universeId: 'u-1', seriesId: null,
          items: [{ kind: 'image', ref: 'art.png', addedAt: '2026-05-26T13:00:00.000Z' }],
          createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-26T13:00:00.000Z',
        }],
      });
      await svc.unlinkCollectionsForUniverse('u-1');
      const fresh = (await svc.listCollections()).find(c => c.id === 'uc-u1');
      expect(fresh.universeId).toBeNull();
      expect(fresh.updatedAt).toBe('2026-05-26T13:00:00.000Z');
      expect(fresh.items).toHaveLength(1);
    });

    describe('findOrCreateUniverseCollection', () => {
      it('mints a DETERMINISTIC id (uc-<universeId>) so federated peers converge, not a random UUID', async () => {
        const c = await svc.findOrCreateUniverseCollection({ universeId: 'u-1', universeName: 'Foo' });
        expect(c.id).toBe('uc-u-1');
        expect(svc.linkedCollectionId({ universeId: 'u-1' })).toBe('uc-u-1');
        // Series mirror.
        const s = await svc.findOrCreateSeriesCollection({ seriesId: 's-9', seriesName: 'Bar' });
        expect(s.id).toBe('sc-s-9');
      });

      it('findOrCreateCollectionByName canonicalizes the id when backfilling a universe link onto an orphan', async () => {
        const orphan = await svc.findOrCreateCollectionByName({ name: 'Universe: Legacy' });
        expect(orphan.id).not.toMatch(/^uc-/); // standalone → random id
        // Referencing it WITH a universeId must adopt the deterministic id, not
        // keep the random one (which couldn't converge across peers).
        const linked = await svc.findOrCreateCollectionByName({ name: 'Universe: Legacy', universeId: 'u-legacy' });
        expect(linked.id).toBe('uc-u-legacy');
        expect(linked.universeId).toBe('u-legacy');
        const all = await svc.listCollections();
        expect(all.filter((c) => c.name === 'Universe: Legacy')).toHaveLength(1);
        expect(all.some((c) => c.id === orphan.id)).toBe(false); // old random id gone
      });

      it('backfill prefers an existing live canonical collection over promoting a same-named orphan', async () => {
        // Universe already has its canonical collection (with items)…
        const canonical = await svc.findOrCreateUniverseCollection({ universeId: 'u-x', universeName: 'X' });
        await svc.addItem(canonical.id, { kind: 'image', ref: 'keep.png' });
        // …plus a same-named orphan. A name-first backfill must NOT clobber the
        // canonical record's items — it returns the canonical one.
        const result = await svc.findOrCreateCollectionByName({ name: 'Universe: X', universeId: 'u-x' });
        expect(result.id).toBe('uc-u-x');
        expect(result.items.map((i) => i.ref)).toContain('keep.png');
      });

      it('findOrCreateCollectionByName slices an overlong universeId for both the id and the stored field', async () => {
        // An overlong owner id must yield the same canonical id the universeId-first
        // path computes (it slices to UNIVERSE_ID_MAX=80) — otherwise the backfill/
        // create here and findOrCreateUniverseCollection would diverge and duplicate.
        const overlong = 'u-' + 'x'.repeat(200);
        const sliced = overlong.slice(0, 80);
        const c = await svc.findOrCreateCollectionByName({ name: 'Universe: Big', universeId: overlong });
        expect(c.id).toBe(`uc-${sliced}`);
        expect(c.universeId).toBe(sliced);
        expect(svc.linkedCollectionId({ universeId: overlong })).toBe(`uc-${sliced}`);
      });

      it('findOrCreateCollectionByName trims a padded universeId so it converges (no uc- u1 -style ids)', async () => {
        // A padded id must normalize to the same canonical id an unpadded caller
        // gets — the presence guard and the slice operate on the trimmed value.
        const c = await svc.findOrCreateCollectionByName({ name: 'Universe: Padded', universeId: '  u-pad  ' });
        expect(c.id).toBe('uc-u-pad');
        expect(c.universeId).toBe('u-pad');
      });

      it('revives the deterministic id after delete instead of duplicating it (tombstone reclaim)', async () => {
        const c = await svc.findOrCreateUniverseCollection({ universeId: 'u-1', universeName: 'Foo' });
        await svc.addItem(c.id, { kind: 'image', ref: 'x.png' });
        await svc.deleteCollection(c.id); // tombstone at uc-u-1
        const revived = await svc.findOrCreateUniverseCollection({ universeId: 'u-1', universeName: 'Foo' });
        expect(revived.id).toBe('uc-u-1');
        expect(revived.deleted).toBeFalsy();
        // Exactly one live collection at the deterministic id — the tombstone was
        // reclaimed, not left to shadow the fresh record in listCollections' dedup.
        const live = await svc.listCollections();
        expect(live.filter((x) => x.id === 'uc-u-1')).toHaveLength(1);
      });

      it('returns the existing universeId-linked collection on second call', async () => {
        const first = await svc.findOrCreateUniverseCollection({
          universeId: 'u-1', universeName: 'Foo',
        });
        const second = await svc.findOrCreateUniverseCollection({
          universeId: 'u-1', universeName: 'Foo',
        });
        expect(second.id).toBe(first.id);
        expect(await svc.listCollections()).toHaveLength(1);
      });

      it('does NOT adopt an unlinked same-name collection — creates a fresh stamped bucket', async () => {
        // The unlinked legacy bucket might be (a) a true pre-link legacy
        // collection OR (b) an orphan left behind by deleteUniverse. We
        // can't tell them apart, and adopting (b) would silently mix the
        // deleted universe's renders into the new same-named universe.
        const legacy = await svc.createCollection({ name: 'Universe: Foo' });
        const linked = await svc.findOrCreateUniverseCollection({
          universeId: 'u-1', universeName: 'Foo',
        });
        expect(linked.id).not.toBe(legacy.id);
        expect(linked.universeId).toBe('u-1');
        // Both collections exist independently.
        expect(await svc.listCollections()).toHaveLength(2);
      });

      it('does NOT re-adopt a post-deleteUniverse orphan when a new same-named universe arrives', async () => {
        // Stand in for the deleteUniverse flow: link, fill, then unlink.
        const first = await svc.findOrCreateUniverseCollection({
          universeId: 'u-A', universeName: 'Cosmos',
        });
        await svc.addItem(first.id, { kind: 'image', ref: 'oldA.png' });
        await svc.unlinkCollectionsForUniverse('u-A');
        // A brand-new universe with the same display name renders for the
        // first time. The orphan still carries the canonical name, but
        // must NOT be adopted — otherwise oldA.png would silently appear
        // in the new universe's bucket.
        const fresh = await svc.findOrCreateUniverseCollection({
          universeId: 'u-B', universeName: 'Cosmos',
        });
        expect(fresh.id).not.toBe(first.id);
        expect(fresh.universeId).toBe('u-B');
        expect(fresh.items).toEqual([]);
        // The orphan kept its items — user can manually relink or rename.
        const orphan = await svc.getCollection(first.id);
        expect(orphan.universeId).toBeNull();
        expect(orphan.items.map((it) => it.ref)).toEqual(['oldA.png']);
      });

      it('refuses to adopt a same-name collection already linked to a different universe', async () => {
        const owned = await svc.findOrCreateUniverseCollection({
          universeId: 'u-A', universeName: 'Twin',
        });
        const own = await svc.findOrCreateUniverseCollection({
          universeId: 'u-B', universeName: 'Twin',
        });
        expect(own.id).not.toBe(owned.id);
        expect(own.universeId).toBe('u-B');
        expect(await svc.listCollections()).toHaveLength(2);
      });

      it('survives a universe rename — same universeId still resolves to the linked bucket', async () => {
        const first = await svc.findOrCreateUniverseCollection({
          universeId: 'u-1', universeName: 'OldName',
        });
        const reuse = await svc.findOrCreateUniverseCollection({
          universeId: 'u-1', universeName: 'NewName',
        });
        expect(reuse.id).toBe(first.id);
      });

      it('does NOT reconcile a drifted name on universeId-match path', async () => {
        // The caller-supplied universeName can be stale (a snapshot taken
        // before this call entered the write tail), so reconciling here
        // could revert a concurrent rename cascade. The cascade itself
        // (renameCollectionForUniverse) is the canonical path for name
        // updates; a stale name from a failed cascade survives until the
        // user re-triggers it.
        const first = await svc.findOrCreateUniverseCollection({
          universeId: 'u-1', universeName: 'NewName',
        });
        const current = await svc.listCollections();
        current[0] = { ...current[0], name: 'Universe: SomeOtherName' };
        await seedState({ collections: current });
        const found = await svc.findOrCreateUniverseCollection({
          universeId: 'u-1', universeName: 'NewName',
        });
        expect(found.id).toBe(first.id);
        // The drifted name is preserved — caller doesn't get to reconcile.
        expect(found.name).toBe('Universe: SomeOtherName');
      });

      it('serializes concurrent first-time filings (no race-induced duplicate or orphan)', async () => {
        // Same-universe race: cover + back-cover for the first time.
        await Promise.all([
          svc.findOrCreateUniverseCollection({ universeId: 'u-1', universeName: 'Race' }),
          svc.findOrCreateUniverseCollection({ universeId: 'u-1', universeName: 'Race' }),
        ]);
        const linked = await svc.findCollectionByUniverseId('u-1');
        expect(linked).not.toBeNull();
        expect(await svc.listCollections()).toHaveLength(1);
      });

      it('serializes concurrent first-time filings for two universes that share a display name', async () => {
        // Both universes named "Twin" but with different ids. Without the
        // mutex, both first-time creates would observe pre-create state and
        // the second writeAll would clobber the first.
        await Promise.all([
          svc.findOrCreateUniverseCollection({ universeId: 'u-A', universeName: 'Twin' }),
          svc.findOrCreateUniverseCollection({ universeId: 'u-B', universeName: 'Twin' }),
        ]);
        const a = await svc.findCollectionByUniverseId('u-A');
        const b = await svc.findCollectionByUniverseId('u-B');
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(a.id).not.toBe(b.id);
        expect(await svc.listCollections()).toHaveLength(2);
      });

      it('requires universeId and universeName', async () => {
        await expect(svc.findOrCreateUniverseCollection({ universeName: 'X' }))
          .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
        await expect(svc.findOrCreateUniverseCollection({ universeId: 'u-1' }))
          .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
      });

      it('normalizes an overlong universeId once — lookup and storage agree (no duplicate-on-retry)', async () => {
        // Caller passes a universeId longer than UNIVERSE_ID_MAX (80).
        // Without the normalize-once fix, the create path slices for
        // storage but the lookup compares the raw value — so the second
        // call wouldn't find the row it just created and would mint a
        // duplicate.
        const overlong = 'u-' + 'x'.repeat(200);
        const first = await svc.findOrCreateUniverseCollection({
          universeId: overlong, universeName: 'Foo',
        });
        const second = await svc.findOrCreateUniverseCollection({
          universeId: overlong, universeName: 'Foo',
        });
        expect(second.id).toBe(first.id);
        expect(await svc.listCollections()).toHaveLength(1);
        // The stamped id is the sliced value, not the raw overlong input.
        expect(first.universeId.length).toBeLessThanOrEqual(80);
      });
    });

    describe('cross-path write serialization', () => {
      it('addItem racing unlinkCollectionsForUniverse — neither drops items', async () => {
        // Two completely different write paths racing on the same file.
        // Without the file-level write tail, unlink's stale snapshot would
        // clobber the in-flight addItem that completed first.
        const linked = await svc.findOrCreateUniverseCollection({
          universeId: 'u-1', universeName: 'Foo',
        });
        await Promise.all([
          svc.addItem(linked.id, { kind: 'image', ref: 'race-1.png' }),
          svc.unlinkCollectionsForUniverse('u-1'),
          svc.addItem(linked.id, { kind: 'image', ref: 'race-2.png' }),
        ]);
        const fresh = await svc.getCollection(linked.id);
        const refs = fresh.items.map((it) => it.ref).sort();
        expect(refs).toEqual(['race-1.png', 'race-2.png']);
      });

      it('rename + addItem from two paths — both end states persist', async () => {
        const linked = await svc.findOrCreateUniverseCollection({
          universeId: 'u-1', universeName: 'Old',
        });
        await Promise.all([
          svc.addItem(linked.id, { kind: 'image', ref: 'cover.png' }),
          svc.renameCollectionForUniverse('u-1', 'New'),
        ]);
        const fresh = await svc.getCollection(linked.id);
        expect(fresh.name).toBe('Universe: New');
        expect(fresh.items.map((it) => it.ref)).toEqual(['cover.png']);
      });
    });
  });

  describe('series-linked collections', () => {
    it('updateCollection rejects a name change when the collection is series-linked', async () => {
      const linked = await svc.findOrCreateSeriesCollection({
        seriesId: 'ser-1', seriesName: 'Foo',
      });
      await expect(svc.updateCollection(linked.id, { name: 'Renamed' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });

    it('seriesCollectionNameFor produces the canonical "Series: <name>" string and truncates', () => {
      expect(svc.seriesCollectionNameFor('Foo')).toBe('Series: Foo');
      const long = 'x'.repeat(200);
      expect(svc.seriesCollectionNameFor(long).length).toBe(svc.NAME_MAX_LENGTH);
    });

    it('findCollectionBySeriesId locates the linked collection (or returns null)', async () => {
      expect(await svc.findCollectionBySeriesId('ser-ghost')).toBeNull();
      const linked = await svc.findOrCreateSeriesCollection({
        seriesId: 'ser-1', seriesName: 'Foo',
      });
      const found = await svc.findCollectionBySeriesId('ser-1');
      expect(found?.id).toBe(linked.id);
    });

    it('findCollectionBySeriesId falls back to the scan for a legacy record at a random id', async () => {
      const now = new Date().toISOString();
      await seedState({ collections: [
        { id: 'uuid-legacy', name: 'Series: Foo', description: '', coverKey: null, seriesId: 'ser-1', items: [], createdAt: now, updatedAt: now },
      ] });
      const found = await svc.findCollectionBySeriesId('ser-1');
      expect(found?.id).toBe('uuid-legacy');
    });

    it('findOrCreateSeriesCollection adopts a legacy series record at a random id instead of duplicating', async () => {
      // The deterministic loadOne fast-path misses a pre-migration-038 record,
      // so the full scan must still find + reuse it rather than minting a new
      // sc-<id> collection.
      const now = new Date().toISOString();
      await seedState({ collections: [
        { id: 'uuid-legacy', name: 'Series: Foo', description: '', coverKey: null, seriesId: 'ser-1', items: [], createdAt: now, updatedAt: now },
      ] });
      const got = await svc.findOrCreateSeriesCollection({ seriesId: 'ser-1', seriesName: 'Foo' });
      expect(got.id).toBe('uuid-legacy');
    });

    it('findOrCreateSeriesCollection returns the existing series-linked collection on second call', async () => {
      const first = await svc.findOrCreateSeriesCollection({
        seriesId: 'ser-1', seriesName: 'Foo',
      });
      const second = await svc.findOrCreateSeriesCollection({
        seriesId: 'ser-1', seriesName: 'Foo',
      });
      expect(second.id).toBe(first.id);
      expect(await svc.listCollections()).toHaveLength(1);
    });

    it('findOrCreateSeriesCollection requires both seriesId and seriesName', async () => {
      await expect(svc.findOrCreateSeriesCollection({ seriesName: 'X' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
      await expect(svc.findOrCreateSeriesCollection({ seriesId: 'ser-1' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });

    it('renameCollectionForSeries cascades a new name onto the linked collection', async () => {
      const linked = await svc.findOrCreateSeriesCollection({
        seriesId: 'ser-1', seriesName: 'Foo',
      });
      const updated = await svc.renameCollectionForSeries('ser-1', 'Bar');
      expect(updated.id).toBe(linked.id);
      expect(updated.name).toBe('Series: Bar');
    });

    it('unlinkCollectionsForSeries clears the seriesId (preserves items)', async () => {
      const linked = await svc.findOrCreateSeriesCollection({
        seriesId: 'ser-1', seriesName: 'Foo',
      });
      await svc.addItem(linked.id, { kind: 'image', ref: 'cover.png' });
      const cleared = await svc.unlinkCollectionsForSeries('ser-1');
      expect(cleared).toEqual([linked.id]);
      const fresh = await svc.getCollection(linked.id);
      expect(fresh.seriesId).toBeNull();
      expect(fresh.items).toHaveLength(1);
      // Lock released — renames now succeed.
      const renamed = await svc.updateCollection(linked.id, { name: 'Orphan' });
      expect(renamed.name).toBe('Orphan');
    });

    it('unlinkCollectionsForSeries preserves updatedAt (cascade side-effect, not a user edit)', async () => {
      await seedState({
        collections: [{
          id: 'sc-ser1', name: 'Series: Foo', description: '', coverKey: null,
          universeId: null, seriesId: 'ser-1',
          items: [{ kind: 'image', ref: 'cover.png', addedAt: '2026-05-26T13:00:00.000Z' }],
          createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-26T13:00:00.000Z',
        }],
      });
      await svc.unlinkCollectionsForSeries('ser-1');
      const fresh = (await svc.listCollections()).find(c => c.id === 'sc-ser1');
      expect(fresh.seriesId).toBeNull();
      expect(fresh.updatedAt).toBe('2026-05-26T13:00:00.000Z');
      expect(fresh.items).toHaveLength(1);
    });

    it('addItem on a series-linked collection emits recordUpdated("series", seriesId)', async () => {
      const events = [];
      const { recordEvents } = await import('./sharing/recordEvents.js');
      const listener = (evt) => events.push(evt);
      recordEvents.on('updated', listener);
      try {
        const linked = await svc.findOrCreateSeriesCollection({
          seriesId: 'ser-1', seriesName: 'Foo',
        });
        events.length = 0;
        await svc.addItem(linked.id, { kind: 'image', ref: 'x.png' });
        expect(events).toContainEqual(expect.objectContaining({ recordKind: 'series', recordId: 'ser-1' }));
      } finally {
        recordEvents.off('updated', listener);
      }
    });

    it('deleteCollection emits recordUpdated("series", seriesId) when the deleted collection was series-linked', async () => {
      const events = [];
      const { recordEvents } = await import('./sharing/recordEvents.js');
      const listener = (evt) => events.push(evt);
      recordEvents.on('updated', listener);
      try {
        const linked = await svc.findOrCreateSeriesCollection({
          seriesId: 'ser-1', seriesName: 'Foo',
        });
        events.length = 0;
        await svc.deleteCollection(linked.id);
        expect(events).toContainEqual(expect.objectContaining({ recordKind: 'series', recordId: 'ser-1' }));
      } finally {
        recordEvents.off('updated', listener);
      }
    });

    it('sanitizer drops seriesId when universeId is also set (universeId wins)', async () => {
      await seedState({
        collections: [{
          id: 'c1', name: 'Mixed', items: [],
          universeId: 'u-1', seriesId: 'ser-1',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      });
      const [c] = await svc.listCollections();
      expect(c.universeId).toBe('u-1');
      expect(c.seriesId).toBeNull();
    });
  });

  it('sanitizes hand-edited JSON with bogus items', async () => {
    await seedState({
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

describe('mergeMediaCollectionsFromSync', () => {
  it('returns {applied:false,count:0} for empty / non-array input', async () => {
    expect(await svc.mergeMediaCollectionsFromSync(null)).toEqual({ applied: false, count: 0 });
    expect(await svc.mergeMediaCollectionsFromSync('nope')).toEqual({ applied: false, count: 0 });
    expect(await svc.mergeMediaCollectionsFromSync([])).toEqual({ applied: false, count: 0 });
  });

  it('applies a multi-record batch (bounded fan-out) — all distinct ids land, count is exact', async () => {
    // The parallelized snapshot-apply path: a batch larger than the concurrency
    // bound, mixing inserts with a no-op (identical to an existing record, which
    // must NOT count as changed). Confirms every distinct id is written and the
    // returned count reflects only the records that actually changed.
    await seedState({
      collections: [{
        id: 'c-existing', name: 'Existing', description: '', coverKey: null,
        universeId: null, seriesId: null,
        items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T00:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z',
      }],
    });
    const remotes = [];
    for (let i = 0; i < 12; i++) {
      remotes.push({
        id: `c-batch-${i}`, name: `Batch ${i}`, description: '', coverKey: null,
        universeId: null, seriesId: null,
        items: [{ kind: 'image', ref: `b${i}.png`, addedAt: '2026-05-22T01:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T01:00:00Z',
      });
    }
    // A remote identical to the existing record → merges to no change.
    remotes.push({
      id: 'c-existing', name: 'Existing', description: '', coverKey: null,
      universeId: null, seriesId: null,
      items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T00:00:00Z' }],
      createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z',
    });

    const result = await svc.mergeMediaCollectionsFromSync(remotes);
    expect(result).toEqual({ applied: true, count: 12 }); // 12 new, the identical one no-ops
    const ids = (await svc.listCollections()).map((c) => c.id).sort();
    expect(ids).toContain('c-existing');
    for (let i = 0; i < 12; i++) expect(ids).toContain(`c-batch-${i}`);
  });

  it('rethrows after the whole batch settles + still flushes when a worker fails', async () => {
    // Error-handling contract for the parallel fan-out: if one record's write
    // throws, the call must reject (throw-on-failure preserved) — but only AFTER
    // every other in-flight worker settles, so no write leaks into the
    // background past the rejection, and the base-hash flush still runs for the
    // records that DID complete.
    const store = svc.mediaCollectionStore();
    const realSave = store.saveOneNow.bind(store);
    const saveSpy = vi.spyOn(store, 'saveOneNow').mockImplementation((id, rec) => {
      if (id === 'c-boom') return Promise.reject(new Error('disk full'));
      return realSave(id, rec);
    });
    const mk = (id) => ({
      id, name: id, description: '', coverKey: null, universeId: null, seriesId: null,
      items: [{ kind: 'image', ref: `${id}.png`, addedAt: '2026-05-22T01:00:00Z' }],
      createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T01:00:00Z',
    });
    const remotes = ['c-ok-1', 'c-ok-2', 'c-boom', 'c-ok-3'].map(mk);

    await expect(svc.mergeMediaCollectionsFromSync(remotes)).rejects.toThrow('disk full');
    saveSpy.mockRestore();

    // The non-failing records all persisted (no early abort skipped them) and
    // each carries a seeded base hash (the flush ran despite the throw).
    const persisted = new Set((await svc.listCollections()).map((c) => c.id));
    for (const id of ['c-ok-1', 'c-ok-2', 'c-ok-3']) {
      expect(persisted.has(id)).toBe(true);
      expect(await cj.getSyncBaseHash('mediaCollection', id)).not.toBeNull();
    }
    expect(persisted.has('c-boom')).toBe(false);
    expect(await cj.getSyncBaseHash('mediaCollection', 'c-boom')).toBeNull();
  });

  it('inserts a previously-unseen collection', async () => {
    const remote = {
      id: 'c-remote',
      name: 'From Peer',
      description: '',
      coverKey: null,
      universeId: 'u-1',
      seriesId: null,
      items: [{ kind: 'image', ref: 'peer.png', addedAt: '2026-05-22T01:00:00Z' }],
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T01:00:00Z',
    };
    const result = await svc.mergeMediaCollectionsFromSync([remote]);
    expect(result).toEqual({ applied: true, count: 1 });
    const all = await svc.listCollections();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('c-remote');
    expect(all[0].items).toHaveLength(1);
    expect(all[0].items[0].ref).toBe('peer.png');
  });

  it('unions items by kind:ref so neither side ever loses a render', async () => {
    await seedState({
      collections: [{
        id: 'c1',
        name: 'A',
        description: '',
        coverKey: null,
        universeId: null,
        seriesId: null,
        items: [
          { kind: 'image', ref: 'local-only.png', addedAt: '2026-05-22T01:00:00Z' },
          { kind: 'image', ref: 'shared.png', addedAt: '2026-05-22T01:00:00Z' },
        ],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T01:00:00Z',
      }],
    });
    const remote = {
      id: 'c1',
      name: 'A',
      description: '',
      coverKey: null,
      universeId: null,
      seriesId: null,
      items: [
        { kind: 'image', ref: 'remote-only.png', addedAt: '2026-05-22T02:00:00Z' },
        { kind: 'image', ref: 'shared.png', addedAt: '2026-05-22T02:00:00Z' },
      ],
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T02:00:00Z',
    };
    const result = await svc.mergeMediaCollectionsFromSync([remote]);
    expect(result.applied).toBe(true);
    const all = await svc.listCollections();
    const refs = all[0].items.map(i => i.ref).sort();
    expect(refs).toEqual(['local-only.png', 'remote-only.png', 'shared.png']);
    // Shared item keeps the EARLIER addedAt (sync replay shouldn't bump it)
    const shared = all[0].items.find(i => i.ref === 'shared.png');
    expect(shared.addedAt).toBe('2026-05-22T01:00:00Z');
  });

  it('LWW: newer remote wins on top-level scalars (name, description, coverKey)', async () => {
    await seedState({
      collections: [{
        id: 'c1',
        name: 'Old Name',
        description: 'old',
        coverKey: null,
        universeId: null,
        seriesId: null,
        items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T01:00:00Z',
      }],
    });
    const remote = {
      id: 'c1',
      name: 'New Name',
      description: 'new',
      coverKey: 'image:a.png',
      universeId: null,
      seriesId: null,
      items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' }],
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T03:00:00Z',
    };
    await svc.mergeMediaCollectionsFromSync([remote]);
    const [merged] = await svc.listCollections();
    expect(merged.name).toBe('New Name');
    expect(merged.description).toBe('new');
    expect(merged.coverKey).toBe('image:a.png');
    expect(merged.updatedAt).toBe('2026-05-22T03:00:00Z');
  });

  it('LWW: older remote loses on scalars, but items still union', async () => {
    await seedState({
      collections: [{
        id: 'c1',
        name: 'Local',
        description: 'local',
        coverKey: null,
        universeId: null,
        seriesId: null,
        items: [{ kind: 'image', ref: 'local.png', addedAt: '2026-05-22T02:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T03:00:00Z',
      }],
    });
    const remote = {
      id: 'c1',
      name: 'Remote',
      description: 'remote',
      coverKey: null,
      universeId: null,
      seriesId: null,
      items: [{ kind: 'image', ref: 'remote.png', addedAt: '2026-05-22T01:00:00Z' }],
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T01:00:00Z',
    };
    await svc.mergeMediaCollectionsFromSync([remote]);
    const [merged] = await svc.listCollections();
    // Newer local wins on scalars
    expect(merged.name).toBe('Local');
    expect(merged.description).toBe('local');
    expect(merged.updatedAt).toBe('2026-05-22T03:00:00Z');
    // But items still union — that's the entire point of the merge
    expect(merged.items.map(i => i.ref).sort()).toEqual(['local.png', 'remote.png']);
  });

  it('universe-merge cascade race: an unlink does not out-race the collection tombstone', async () => {
    // Repro of the real peer bug. A universe merge tombstones the loser auto-
    // collection (with the merge-time updatedAt) AND tombstones the loser
    // universe. On the receiving peer the UNIVERSE tombstone's cascade
    // (unlinkCollectionsForUniverse) lands first and nulls the collection's
    // universeId. If that unlink bumped updatedAt to "now", the collection's
    // own (older) tombstone would then lose LWW and a live duplicate would
    // survive. Because the cascade unlink preserves updatedAt, the tombstone
    // still wins and converges to deleted.
    await seedState({
      collections: [{
        id: 'uc-loser',
        name: 'Universe: Clandestiny',
        description: '',
        coverKey: null,
        universeId: 'u-loser',
        seriesId: null,
        items: [{ kind: 'image', ref: 'folded.png', addedAt: '2026-05-26T13:00:00.000Z' }],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-26T13:00:00.000Z', // last real edit, BEFORE the merge
      }],
    });
    // 1. Universe tombstone cascade hits the receiver first.
    await svc.unlinkCollectionsForUniverse('u-loser');
    const afterUnlink = (await svc.listCollections()).find(c => c.id === 'uc-loser');
    expect(afterUnlink.universeId).toBeNull();
    expect(afterUnlink.updatedAt).toBe('2026-05-26T13:00:00.000Z'); // NOT bumped
    // 2. The collection's own tombstone (merge-time, newer than the last edit) arrives.
    await svc.mergeMediaCollectionsFromSync([{
      id: 'uc-loser',
      name: 'Universe: Clandestiny',
      description: '',
      coverKey: null,
      universeId: null,
      seriesId: null,
      items: [],
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-26T13:31:33.807Z',
      deleted: true,
      deletedAt: '2026-05-26T13:31:33.807Z',
    }]);
    // No live duplicate left behind.
    expect((await svc.listCollections()).some(c => c.id === 'uc-loser')).toBe(false);
    const tomb = (await svc.listCollections({ includeDeleted: true })).find(c => c.id === 'uc-loser');
    expect(tomb.deleted).toBe(true);
    expect(tomb.items).toEqual([]);
  });

  it('reports count:0 when nothing actually changes (no-op no-op)', async () => {
    await seedState({
      collections: [{
        id: 'c1',
        name: 'A',
        description: '',
        coverKey: null,
        universeId: null,
        seriesId: null,
        items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T01:00:00Z',
      }],
    });
    const same = {
      id: 'c1',
      name: 'A',
      description: '',
      coverKey: null,
      universeId: null,
      seriesId: null,
      items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' }],
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T01:00:00Z',
    };
    const result = await svc.mergeMediaCollectionsFromSync([same]);
    expect(result).toEqual({ applied: false, count: 0 });
  });

  it('drops dangling coverKey that points at an item missing post-union', async () => {
    await seedState({
      collections: [{
        id: 'c1',
        name: 'A',
        description: '',
        coverKey: null,
        universeId: null,
        seriesId: null,
        items: [{ kind: 'image', ref: 'local.png', addedAt: '2026-05-22T01:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T01:00:00Z',
      }],
    });
    const remote = {
      id: 'c1',
      name: 'A',
      description: '',
      coverKey: 'image:nope.png', // points at an item that doesn't exist
      universeId: null,
      seriesId: null,
      items: [{ kind: 'image', ref: 'remote.png', addedAt: '2026-05-22T02:00:00Z' }],
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T03:00:00Z',
    };
    await svc.mergeMediaCollectionsFromSync([remote]);
    const [merged] = await svc.listCollections();
    expect(merged.coverKey).toBeNull();
  });

  it('skips records that fail sanitization (missing id, empty name)', async () => {
    const result = await svc.mergeMediaCollectionsFromSync([
      { name: 'no-id', items: [] },
      { id: 'has-id', name: '', items: [] },
      { id: 'good', name: 'Real', description: '', coverKey: null, universeId: null, seriesId: null, items: [], createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z' },
    ]);
    expect(result).toEqual({ applied: true, count: 1 });
    const all = await svc.listCollections();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('good');
  });

  it('skips a record whose id is not a valid store path-segment WITHOUT aborting the batch', async () => {
    // A malformed/peer-supplied id like '../../escape' can't be persisted (the
    // store's id allowlist would throw inside queueRecordWrite). sanitizeCollection
    // must drop it at the boundary so the valid records in the same batch still merge.
    const result = await svc.mergeMediaCollectionsFromSync([
      { id: '../../escape', name: 'Evil', description: '', coverKey: null, universeId: null, seriesId: null, items: [], createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z' },
      { id: 'has space', name: 'Spacey', items: [], createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z' },
      { id: 'valid-after-bad', name: 'Survivor', description: '', coverKey: null, universeId: null, seriesId: null, items: [], createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z' },
    ]);
    expect(result).toEqual({ applied: true, count: 1 });
    const all = await svc.listCollections({ includeDeleted: true });
    expect(all.map((c) => c.id)).toEqual(['valid-after-bad']);
  });

  it('rejects items whose ref contains path-traversal tokens', async () => {
    // Defense in depth — a peer can push a collection containing a ref
    // like '../etc/passwd' via the linkedCollection field. sanitizeItem
    // must drop these BEFORE they hit disk so the sender-side
    // buildAssetManifestForCollection (and any future downstream consumer)
    // never sees an unsafe ref.
    const result = await svc.mergeMediaCollectionsFromSync([{
      id: 'c-evil',
      name: 'Evil',
      description: '',
      coverKey: null,
      universeId: null,
      seriesId: null,
      items: [
        { kind: 'image', ref: '../etc/passwd', addedAt: '2026-05-22T01:00:00Z' },
        { kind: 'image', ref: 'subdir/file.png', addedAt: '2026-05-22T01:00:00Z' },
        { kind: 'image', ref: 'C:\\Windows\\System32', addedAt: '2026-05-22T01:00:00Z' },
        { kind: 'image', ref: 'real.png', addedAt: '2026-05-22T01:00:00Z' },
      ],
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T01:00:00Z',
    }]);
    expect(result.applied).toBe(true);
    const [merged] = await svc.listCollections();
    // Only the safe ref survived sanitization
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0].ref).toBe('real.png');
  });

  it('compares collection updatedAt as parsed milliseconds (not lexicographic)', async () => {
    // Same hazard as the addedAt case: sanitizeCollection accepts any
    // Date.parse-able string for `updatedAt`, so a non-ISO but valid
    // timestamp could compare incorrectly as a string and flip LWW the
    // wrong way. The slash-format timestamp here ('05/22/2026 18:00 UTC')
    // sorts BEFORE the ISO timestamp lexicographically ('0' < '2'), but
    // it's actually LATER in real time — so remote should win.
    await seedState({
      collections: [{
        id: 'c1', name: 'Local', description: 'local', coverKey: null,
        universeId: null, seriesId: null,
        items: [],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T10:00:00Z',
      }],
    });
    await svc.mergeMediaCollectionsFromSync([{
      id: 'c1', name: 'Remote', description: 'remote', coverKey: null,
      universeId: null, seriesId: null,
      items: [],
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '05/22/2026 18:00:00 UTC',
    }]);
    const [merged] = await svc.listCollections();
    // Numeric compare: 18:00 > 10:00 → remote wins → name flips to "Remote"
    expect(merged.name).toBe('Remote');
    expect(merged.description).toBe('remote');
  });

  it('LWW: unparseable updatedAt never overrides a valid one', async () => {
    // Defense in depth — a hand-edit or corrupted record shipping a
    // garbage `updatedAt` shouldn't be able to claim "newer" than a valid
    // local record and overwrite its scalars.
    await seedState({
      collections: [{
        id: 'c1', name: 'Local', description: 'local', coverKey: null,
        universeId: null, seriesId: null,
        items: [],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T03:00:00Z',
      }],
    });
    await svc.mergeMediaCollectionsFromSync([{
      id: 'c1', name: 'Remote', description: 'remote', coverKey: null,
      universeId: null, seriesId: null,
      items: [],
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: 'not a real timestamp',
    }]);
    const [merged] = await svc.listCollections();
    expect(merged.name).toBe('Local');
    expect(merged.description).toBe('local');
  });

  it('preserves deleted + deletedAt through sync merge', async () => {
    await svc.mergeMediaCollectionsFromSync([{
      id: 'c1', name: 'C1', items: [],
      deleted: true, deletedAt: '2026-05-23T00:00:00.000Z',
      updatedAt: '2026-05-23T00:00:00.000Z',
    }]);
    const live = await svc.listCollections();
    expect(live.find((c) => c.id === 'c1')).toBeUndefined();
    const all = await svc.listCollections({ includeDeleted: true });
    const c = all.find((x) => x.id === 'c1');
    expect(c?.deleted).toBe(true);
    expect(c?.deletedAt).toBe('2026-05-23T00:00:00.000Z');
  });

  it('a newer remote tombstone deletes a local live collection', async () => {
    const c = await svc.createCollection({ name: 'WillDie' });
    const tombstone = {
      id: c.id,
      name: 'WillDie',
      description: '',
      coverKey: null,
      universeId: null,
      seriesId: null,
      items: [],
      createdAt: c.createdAt,
      updatedAt: '2099-01-01T00:00:00.000Z',
      deleted: true,
      deletedAt: '2099-01-01T00:00:00.000Z',
    };
    await svc.mergeMediaCollectionsFromSync([tombstone]);
    expect(await svc.listCollections()).toEqual([]);
    const all = await svc.listCollections({ includeDeleted: true });
    const found = all.find((x) => x.id === c.id);
    expect(found?.deleted).toBe(true);
  });

  it('an older remote tombstone does NOT delete a newer local collection', async () => {
    const c = await svc.createCollection({ name: 'Survivor' });
    const tombstone = {
      id: c.id,
      name: 'Survivor',
      description: '',
      coverKey: null,
      universeId: null,
      seriesId: null,
      items: [],
      createdAt: c.createdAt,
      updatedAt: '2000-01-01T00:00:00.000Z',
      deleted: true,
      deletedAt: '2000-01-01T00:00:00.000Z',
    };
    await svc.mergeMediaCollectionsFromSync([tombstone]);
    const live = await svc.listCollections();
    expect(live.find((x) => x.id === c.id)).toBeTruthy();
    expect(live.find((x) => x.id === c.id)?.deleted).toBeFalsy();
  });

  it('a remote tombstone for an unknown id is recorded as a tombstone (no resurrection)', async () => {
    const tombstone = {
      id: 'ghost-id',
      name: 'Ghost',
      description: '',
      coverKey: null,
      universeId: null,
      seriesId: null,
      items: [],
      createdAt: '2026-05-23T00:00:00.000Z',
      updatedAt: '2026-05-23T00:00:00.000Z',
      deleted: true,
      deletedAt: '2026-05-23T00:00:00.000Z',
    };
    await svc.mergeMediaCollectionsFromSync([tombstone]);
    expect(await svc.listCollections()).toEqual([]);
    const all = await svc.listCollections({ includeDeleted: true });
    const found = all.find((x) => x.id === 'ghost-id');
    expect(found?.deleted).toBe(true);
  });

  it('a tombstone missing deletedAt falls back to updatedAt (not the older createdAt)', async () => {
    // A hand-edited / legacy tombstone may carry deleted:true with no explicit
    // deletedAt. The effective deletion time should align with the most-recent
    // timestamp (updatedAt), not createdAt — otherwise LWW + GC see it as far
    // older than it really is.
    await seedState({
      collections: [{
        id: 'c1', name: 'Gone', description: '', coverKey: null,
        universeId: null, seriesId: null, items: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-05-22T03:00:00.000Z',
        deleted: true,
        // deletedAt intentionally omitted
      }],
    });
    const [c] = await svc.listCollections({ includeDeleted: true });
    expect(c.deleted).toBe(true);
    expect(c.deletedAt).toBe('2026-05-22T03:00:00.000Z');
  });

  it('compares addedAt as parsed milliseconds (not lexicographic) when picking the earlier item', async () => {
    // sanitizeItem accepts any Date.parse-able string, not strictly ISO-8601.
    // Lexicographic compare would order "05/22/2026 ..." AFTER "2026-..." (the
    // digit '0' sorts before '2'), but as parsed timestamps the slash-format
    // is actually EARLIER here. Numeric compare keeps "earlier wins" honest
    // across formats.
    await seedState({
      collections: [{
        id: 'c1', name: 'A', description: '', coverKey: null,
        universeId: null, seriesId: null,
        items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T10:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T01:00:00Z',
      }],
    });
    await svc.mergeMediaCollectionsFromSync([{
      id: 'c1', name: 'A', description: '', coverKey: null,
      universeId: null, seriesId: null,
      items: [{ kind: 'image', ref: 'a.png', addedAt: '05/22/2026 08:00:00 UTC' }],
      createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T02:00:00Z',
    }]);
    const [merged] = await svc.listCollections();
    // The 08:00 slash-format timestamp is earlier than 10:00 ISO; numeric
    // compare picks it. Lexicographic compare would have picked the ISO one.
    expect(Date.parse(merged.items[0].addedAt)).toBe(Date.parse('05/22/2026 08:00:00 UTC'));
  });
});

describe('mergeMediaCollectionsFromSync — conflict journal', () => {
  const baseColl = (over = {}) => ({
    id: 'c1', name: 'Bucket', description: 'd', coverKey: null,
    universeId: null, seriesId: null,
    items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-01T00:00:00Z' }],
    createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z', ...over,
  });
  const journalEntries = () => cj.conflictJournalStore().loadAll();

  it('seeds a base hash on first insert (new record) so a future divergence is detectable', async () => {
    await svc.mergeMediaCollectionsFromSync([baseColl()]);
    expect(await cj.getSyncBaseHash('mediaCollection', 'c1'))
      .toBe(cj.contentHashForRecord('mediaCollection', baseColl()));
    expect(await journalEntries()).toHaveLength(0);
  });

  it('item-only divergence does NOT journal (items union-merged, never lost)', async () => {
    // Establish a shared base, then both sides add different items only.
    await svc.mergeMediaCollectionsFromSync([baseColl()]);
    // Local adds an item directly on disk; remote arrives with a different item.
    await seedState({ collections: [baseColl({
      items: [
        { kind: 'image', ref: 'a.png', addedAt: '2026-05-01T00:00:00Z' },
        { kind: 'image', ref: 'local.png', addedAt: '2026-05-02T00:00:00Z' },
      ],
      updatedAt: '2026-05-02T00:00:00Z',
    })] });
    const before = (await journalEntries()).length;
    await svc.mergeMediaCollectionsFromSync([baseColl({
      items: [
        { kind: 'image', ref: 'a.png', addedAt: '2026-05-01T00:00:00Z' },
        { kind: 'image', ref: 'remote.png', addedAt: '2026-05-03T00:00:00Z' },
      ],
      updatedAt: '2026-05-03T00:00:00Z',
    })]);
    expect((await journalEntries()).length).toBe(before);
    // ...and both items survived the union (the whole reason scalars-only is safe).
    const [merged] = await svc.listCollections();
    expect(merged.items.map((i) => i.ref).sort()).toEqual(['a.png', 'local.png', 'remote.png']);
  });

  it('journals when a newer remote overwrites a diverged local scalar (name)', async () => {
    await svc.mergeMediaCollectionsFromSync([baseColl()]);          // seed base
    await seedState({ collections: [baseColl({ name: 'LOCAL rename', updatedAt: '2026-05-02T00:00:00Z' })] });
    await svc.mergeMediaCollectionsFromSync([baseColl({ name: 'REMOTE rename', updatedAt: '2026-05-03T00:00:00Z' })]);
    const entries = await journalEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ recordKind: 'mediaCollection', recordId: 'c1', status: 'pending' });
    expect(entries[0].localSnapshot.name).toBe('LOCAL rename');
    // Remote won LWW; local archived.
    const [merged] = await svc.listCollections();
    expect(merged.name).toBe('REMOTE rename');
  });

  it('does NOT journal when local wins LWW (its scalars are kept, nothing lost)', async () => {
    await svc.mergeMediaCollectionsFromSync([baseColl()]);          // seed base
    await seedState({ collections: [baseColl({ name: 'LOCAL rename', updatedAt: '2026-05-05T00:00:00Z' })] });
    // Older remote — local wins; no overwrite, no journal.
    await svc.mergeMediaCollectionsFromSync([baseColl({ name: 'REMOTE rename', updatedAt: '2026-05-03T00:00:00Z' })]);
    expect(await journalEntries()).toHaveLength(0);
    const [merged] = await svc.listCollections();
    expect(merged.name).toBe('LOCAL rename');
  });
});

describe('createCollection — event emission', () => {
  it('emits a mediaCollection updated event with the created record id', async () => {
    const { recordEvents } = await import('./sharing/recordEvents.js');
    const updatedEvts = [];
    const handler = (evt) => updatedEvts.push(evt);
    recordEvents.on('updated', handler);
    try {
      const c = await svc.createCollection({ name: 'New' });
      expect(updatedEvts).toContainEqual(
        expect.objectContaining({ recordKind: 'mediaCollection', recordId: c.id }),
      );
    } finally {
      recordEvents.off('updated', handler);
    }
  });
});

describe('findOrCreate* — announces new collections to the sync pipeline', () => {
  // A newly-created universe/series-linked (or named) collection must emit a
  // mediaCollection 'updated' event so a peer with mediaCollections syncing
  // enabled (but universe/series sync off) still receives it via per-record sync.
  // It must NOT re-announce on a find-existing hit (would churn every render).
  const collectMediaUpdateIds = async (fn) => {
    const { recordEvents } = await import('./sharing/recordEvents.js');
    const ids = [];
    const handler = (evt) => { if (evt.recordKind === 'mediaCollection') ids.push(evt.recordId); };
    recordEvents.on('updated', handler);
    try { await fn(); } finally { recordEvents.off('updated', handler); }
    return ids;
  };

  it('findOrCreateUniverseCollection announces on create, stays quiet on find-existing', async () => {
    const created = await collectMediaUpdateIds(() =>
      svc.findOrCreateUniverseCollection({ universeId: 'u1', universeName: 'Iron Veil' }));
    const c = await svc.findCollectionByUniverseId('u1');
    expect(created).toEqual([c.id]);
    const again = await collectMediaUpdateIds(() =>
      svc.findOrCreateUniverseCollection({ universeId: 'u1', universeName: 'Iron Veil' }));
    expect(again).toEqual([]);
  });

  it('findOrCreateSeriesCollection announces on create, stays quiet on find-existing', async () => {
    const created = await collectMediaUpdateIds(() =>
      svc.findOrCreateSeriesCollection({ seriesId: 's1', seriesName: 'Salt Run' }));
    expect(created).toHaveLength(1);
    const again = await collectMediaUpdateIds(() =>
      svc.findOrCreateSeriesCollection({ seriesId: 's1', seriesName: 'Salt Run' }));
    expect(again).toEqual([]);
  });

  it('findOrCreateCollectionByName announces on create, stays quiet on find-existing', async () => {
    const created = await collectMediaUpdateIds(() =>
      svc.findOrCreateCollectionByName({ name: 'Loose Bucket' }));
    expect(created).toHaveLength(1);
    const again = await collectMediaUpdateIds(() =>
      svc.findOrCreateCollectionByName({ name: 'Loose Bucket' }));
    expect(again).toEqual([]);
  });
});

describe('mutators — mediaCollection updated emission (standalone per-record sync)', () => {
  // A standalone collection (no universe/series link) reaches a directly-
  // subscribed peer ONLY through the per-record mediaCollection push pipeline,
  // so every content mutator must emit a mediaCollection 'updated' event or the
  // edit silently never propagates.
  const collectMediaUpdates = async (fn) => {
    const { recordEvents } = await import('./sharing/recordEvents.js');
    const ids = [];
    const handler = (evt) => { if (evt.recordKind === 'mediaCollection') ids.push(evt.recordId); };
    recordEvents.on('updated', handler);
    try {
      await fn();
    } finally {
      recordEvents.off('updated', handler);
    }
    return ids;
  };

  it('updateCollection emits a mediaCollection updated event', async () => {
    const c = await svc.createCollection({ name: 'Standalone' });
    const ids = await collectMediaUpdates(() => svc.updateCollection(c.id, { description: 'changed' }));
    expect(ids).toContain(c.id);
  });

  it('addItem emits a mediaCollection updated event', async () => {
    const c = await svc.createCollection({ name: 'Standalone' });
    const ids = await collectMediaUpdates(() => svc.addItem(c.id, { kind: 'image', ref: 'x.png' }));
    expect(ids).toContain(c.id);
  });

  it('removeItem emits a mediaCollection updated event', async () => {
    const c = await svc.createCollection({ name: 'Standalone' });
    await svc.addItem(c.id, { kind: 'image', ref: 'x.png' });
    const ids = await collectMediaUpdates(() => svc.removeItem(c.id, 'image:x.png'));
    expect(ids).toContain(c.id);
  });

  it('bulkUpdateCollectionItems emits a mediaCollection updated event when items change', async () => {
    const c = await svc.createCollection({ name: 'Standalone' });
    const ids = await collectMediaUpdates(() =>
      svc.bulkUpdateCollectionItems(c.id, { add: [{ kind: 'image', ref: 'y.png' }] }),
    );
    expect(ids).toContain(c.id);
  });
});

describe('pruneTombstonedCollections', () => {
  it('prunes tombstoned collections older than the cutoff and returns the count', async () => {
    // Create a live collection and soft-delete it with an old timestamp by
    // injecting the tombstone directly into the file store.
    const c = await svc.createCollection({ name: 'ToDelete' });
    const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    // Re-seed the record as a tombstone carrying an old deletedAt.
    const stored = await readStored(c.id);
    await seedState({ collections: [{ ...stored, deleted: true, deletedAt: oldTs, updatedAt: oldTs, items: [] }] });

    // Seed a base hash so we can confirm the prune evicts it.
    await cj.setSyncBaseHash('mediaCollection', c.id, cj.contentHashForRecord('mediaCollection', stored));
    expect(await cj.getSyncBaseHash('mediaCollection', c.id)).not.toBeNull();

    const result = await svc.pruneTombstonedCollections(Date.now());
    expect(result).toEqual({ pruned: 1 });
    expect(await svc.listCollections({ includeDeleted: true })).toHaveLength(0);
    // The conflict-journal base hash is evicted so the side store doesn't leak.
    expect(await cj.getSyncBaseHash('mediaCollection', c.id)).toBeNull();
  });

  it('prunes a multi-candidate batch (bounded fan-out) — only the old tombstones, exact count', async () => {
    // The parallelized GC sweep: more candidates than the concurrency bound,
    // interleaved with a live record and a too-recent tombstone that must survive.
    const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const futureTs = new Date(Date.now() + 60 * 1000).toISOString();
    const collections = [];
    for (let i = 0; i < 10; i++) {
      collections.push({
        id: `c-old-${i}`, name: `Old ${i}`, description: '', coverKey: null,
        universeId: null, seriesId: null, items: [],
        createdAt: oldTs, updatedAt: oldTs, deleted: true, deletedAt: oldTs,
      });
    }
    collections.push({
      id: 'c-live', name: 'Live', description: '', coverKey: null,
      universeId: null, seriesId: null, items: [],
      createdAt: oldTs, updatedAt: oldTs, deleted: false, deletedAt: null,
    });
    collections.push({
      id: 'c-recent', name: 'RecentDelete', description: '', coverKey: null,
      universeId: null, seriesId: null, items: [],
      createdAt: oldTs, updatedAt: futureTs, deleted: true, deletedAt: futureTs,
    });
    await seedState({ collections });

    const result = await svc.pruneTombstonedCollections(Date.now());
    expect(result).toEqual({ pruned: 10 }); // 10 old tombstones; live + recent survive
    const surviving = (await svc.listCollections({ includeDeleted: true })).map((c) => c.id).sort();
    expect(surviving).toEqual(['c-live', 'c-recent']);
  });

  it('does NOT prune a live collection', async () => {
    await svc.createCollection({ name: 'Live' });
    const result = await svc.pruneTombstonedCollections(Date.now());
    expect(result).toEqual({ pruned: 0 });
    expect(await svc.listCollections()).toHaveLength(1);
  });

  it('does NOT prune a tombstone newer than the cutoff', async () => {
    const c = await svc.createCollection({ name: 'RecentDelete' });
    // Re-seed as a tombstone with a future timestamp (simulating a delete that just happened).
    const futureTs = new Date(Date.now() + 60 * 1000).toISOString();
    const stored = await readStored(c.id);
    await seedState({ collections: [{ ...stored, deleted: true, deletedAt: futureTs, updatedAt: futureTs, items: [] }] });

    // Cut-off is now; the tombstone's deletedAt is in the future → not pruned.
    const result = await svc.pruneTombstonedCollections(Date.now());
    expect(result).toEqual({ pruned: 0 });
    const all = await svc.listCollections({ includeDeleted: true });
    expect(all).toHaveLength(1);
    expect(all[0].deleted).toBe(true);
  });

  it('returns { pruned: 0 } without touching the file when cutoff is not a finite number', async () => {
    await svc.createCollection({ name: 'A' });
    expect(await svc.pruneTombstonedCollections(NaN)).toEqual({ pruned: 0 });
    expect(await svc.pruneTombstonedCollections(Infinity)).toEqual({ pruned: 0 });
  });
});
