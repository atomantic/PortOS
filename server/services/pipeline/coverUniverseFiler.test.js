import { describe, it, expect, beforeEach, vi } from 'vitest';

const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) =>
    fileStore.has(path) ? fileStore.get(path) : fallback,
  ),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

const collections = await import('../mediaCollections.js');
const seriesSvc = await import('./series.js');
const universeSvc = await import('../universeBuilder.js');
const { fileCoverIntoUniverseCollection } = await import('./coverUniverseFiler.js');

describe('fileCoverIntoUniverseCollection', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it('files the cover image into the universe collection (creating it on first use)', async () => {
    const universe = await universeSvc.createUniverse({ name: 'Foo' });
    const series = await seriesSvc.createSeries({ name: 'My Series', universeId: universe.id });
    await fileCoverIntoUniverseCollection({ seriesId: series.id, filename: 'cover-001.png' });
    const linked = await collections.findCollectionByUniverseId(universe.id);
    expect(linked?.name).toBe('Universe: Foo');
    expect(linked?.items.map((it) => it.ref)).toEqual(['cover-001.png']);
  });

  it('reuses an existing universe-linked collection', async () => {
    const universe = await universeSvc.createUniverse({ name: 'Foo' });
    const existing = await collections.findOrCreateCollectionByName({
      name: 'Universe: Foo', universeId: universe.id,
    });
    const series = await seriesSvc.createSeries({ name: 'S', universeId: universe.id });
    await fileCoverIntoUniverseCollection({ seriesId: series.id, filename: 'a.png' });
    await fileCoverIntoUniverseCollection({ seriesId: series.id, filename: 'b.png' });
    const fresh = await collections.getCollection(existing.id);
    expect(fresh.items.map((it) => it.ref).sort()).toEqual(['a.png', 'b.png']);
  });

  it('swallows duplicate filings silently (same cover re-rendered)', async () => {
    const universe = await universeSvc.createUniverse({ name: 'Foo' });
    const series = await seriesSvc.createSeries({ name: 'S', universeId: universe.id });
    await fileCoverIntoUniverseCollection({ seriesId: series.id, filename: 'dup.png' });
    await fileCoverIntoUniverseCollection({ seriesId: series.id, filename: 'dup.png' });
    const linked = await collections.findCollectionByUniverseId(universe.id);
    expect(linked.items).toHaveLength(1);
  });

  it('no-ops when the series has no universeId', async () => {
    const series = await seriesSvc.createSeries({ name: 'S' });
    await fileCoverIntoUniverseCollection({ seriesId: series.id, filename: 'x.png' });
    expect(await collections.listCollections()).toEqual([]);
  });

  it('no-ops when seriesId or filename is missing', async () => {
    await fileCoverIntoUniverseCollection({ seriesId: null, filename: 'x.png' });
    await fileCoverIntoUniverseCollection({ seriesId: 'ser-x', filename: '' });
    expect(await collections.listCollections()).toEqual([]);
  });

  it('no-ops when the series references a missing universe', async () => {
    const series = await seriesSvc.createSeries({ name: 'S', universeId: 'ghost-universe' });
    await fileCoverIntoUniverseCollection({ seriesId: series.id, filename: 'x.png' });
    expect(await collections.listCollections()).toEqual([]);
  });

  it('never hijacks a same-named collection belonging to a different universe', async () => {
    // Universe A already owns a "Universe: Twin" bucket.
    const universeA = await universeSvc.createUniverse({ name: 'Twin' });
    const ownedByA = await collections.findOrCreateCollectionByName({
      name: 'Universe: Twin', universeId: universeA.id,
    });
    // Universe B (different id, same display name) renders its first cover.
    const universeB = await universeSvc.createUniverse({ name: 'Twin' });
    const seriesB = await seriesSvc.createSeries({ name: 'B-Series', universeId: universeB.id });
    await fileCoverIntoUniverseCollection({ seriesId: seriesB.id, filename: 'b-cover.png' });
    // Universe A's bucket must be untouched.
    const a = await collections.getCollection(ownedByA.id);
    expect(a.items).toHaveLength(0);
    // Universe B got its own properly-stamped bucket.
    const b = await collections.findCollectionByUniverseId(universeB.id);
    expect(b).not.toBeNull();
    expect(b.id).not.toBe(ownedByA.id);
    expect(b.items.map((it) => it.ref)).toEqual(['b-cover.png']);
  });

  it('serializes concurrent filings for the same universe (no orphan collections from a race)', async () => {
    const universe = await universeSvc.createUniverse({ name: 'Race' });
    const series = await seriesSvc.createSeries({ name: 'S', universeId: universe.id });
    // Two completions back-to-back before the collection exists — the
    // shared file-level write tail in mediaCollections.js must serialize
    // the create-or-find write so only one collection is persisted and
    // both filenames land in it.
    await Promise.all([
      fileCoverIntoUniverseCollection({ seriesId: series.id, filename: 'cover.png' }),
      fileCoverIntoUniverseCollection({ seriesId: series.id, filename: 'back.png' }),
    ]);
    const linked = await collections.findCollectionByUniverseId(universe.id);
    expect(linked).not.toBeNull();
    expect(linked.items.map((it) => it.ref).sort()).toEqual(['back.png', 'cover.png']);
    // Only one "Universe: Race" collection — no race-induced duplicate.
    const all = await collections.listCollections();
    const named = all.filter((c) => c.name === 'Universe: Race');
    expect(named).toHaveLength(1);
  });
});
