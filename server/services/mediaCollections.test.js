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
      fileStore.set('/mock/data/media-collections.json', {
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

    describe('findOrCreateUniverseCollection', () => {
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
        fileStore.set('/mock/data/media-collections.json', { collections: current });
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
