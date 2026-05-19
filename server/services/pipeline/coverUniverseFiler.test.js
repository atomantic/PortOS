import { describe, it, expect, beforeEach, vi } from 'vitest';

const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
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
const { fileCoverIntoUniverseCollection, fileCoverIntoSeriesCollection, fileCoverIntoAutoCollection } = await import('./coverUniverseFiler.js');

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

describe('fileCoverIntoSeriesCollection', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it('files the cover image into a per-series collection (creating it on first use)', async () => {
    const series = await seriesSvc.createSeries({ name: 'Solo Series' });
    await fileCoverIntoSeriesCollection({ seriesId: series.id, filename: 'cover-001.png' });
    const linked = await collections.findCollectionBySeriesId(series.id);
    expect(linked?.name).toBe('Series: Solo Series');
    expect(linked?.items.map((it) => it.ref)).toEqual(['cover-001.png']);
  });

  it('reuses an existing series-linked collection on subsequent filings', async () => {
    const series = await seriesSvc.createSeries({ name: 'Solo' });
    await fileCoverIntoSeriesCollection({ seriesId: series.id, filename: 'a.png' });
    await fileCoverIntoSeriesCollection({ seriesId: series.id, filename: 'b.png' });
    const fresh = await collections.findCollectionBySeriesId(series.id);
    expect(fresh.items.map((it) => it.ref).sort()).toEqual(['a.png', 'b.png']);
    // Only one collection exists for this series.
    const named = (await collections.listCollections()).filter((c) => c.seriesId === series.id);
    expect(named).toHaveLength(1);
  });

  it('no-ops when seriesId or filename is missing', async () => {
    await fileCoverIntoSeriesCollection({ seriesId: null, filename: 'x.png' });
    await fileCoverIntoSeriesCollection({ seriesId: 'ser-x', filename: '' });
    expect(await collections.listCollections()).toEqual([]);
  });

  it('no-ops when the series no longer exists', async () => {
    await fileCoverIntoSeriesCollection({ seriesId: 'ghost-series', filename: 'x.png' });
    expect(await collections.listCollections()).toEqual([]);
  });

  it('unlinks the per-series collection when the series gains a universe link mid-flight', async () => {
    // Re-link race: the series was universeless at the initial fetch (so we
    // committed to the per-series path), but `updateSeries` linked it to a
    // universe between then and the recovery check. Leaving the per-series
    // collection bound would violate the "linked series export under the
    // universe contract" invariant; recovery must unlink so the collection
    // becomes a normal user-owned bucket. The cover render added above is
    // preserved in the now-orphaned bucket either way.
    const series = await seriesSvc.createSeries({ name: 'Pre-Link' });
    const universe = await universeSvc.createUniverse({ name: 'Late' });
    // First getSeries (the one inside fileCoverIntoSeriesCollection that
    // commits to the per-series path) sees the universeless original.
    // Second getSeries (the recovery check after addItem) sees the linked
    // version — simulates an updateSeries landing during the collection
    // write window.
    const realGet = seriesSvc.getSeries;
    let call = 0;
    const spy = vi.spyOn(seriesSvc, 'getSeries').mockImplementation(async (id) => {
      call += 1;
      const fresh = await realGet(id);
      if (call >= 2 && fresh) return { ...fresh, universeId: universe.id };
      return fresh;
    });
    await fileCoverIntoSeriesCollection({ seriesId: series.id, filename: 'racy.png' });
    spy.mockRestore();
    // Recovery fired: the seriesId stamp was unlinked so the collection
    // is no longer attached to the series (orphaned-but-preserved bucket).
    expect(await collections.findCollectionBySeriesId(series.id)).toBeNull();
    // The cover render itself survives in the now-orphaned collection.
    const all = await collections.listCollections();
    const orphan = all.find((c) => c.items.some((it) => it.ref === 'racy.png'));
    expect(orphan).toBeTruthy();
    expect(orphan.seriesId).toBeFalsy();
  });

  it('re-routes to the universe collection when the series is universe-linked', async () => {
    // Guard against (a) a direct caller invoking this helper for an
    // already-linked series and (b) a parallel `updateSeries` adding a
    // universe link between the dispatcher's branch and this fetch. Either
    // way the cover must land in the universe collection, not a per-series
    // bucket that contradicts the canon link.
    const universe = await universeSvc.createUniverse({ name: 'Linked' });
    const series = await seriesSvc.createSeries({ name: 'Bound', universeId: universe.id });
    await fileCoverIntoSeriesCollection({ seriesId: series.id, filename: 'rerouted.png' });
    expect(await collections.findCollectionBySeriesId(series.id)).toBeNull();
    expect(await collections.findCollectionByUniverseId(universe.id)).toMatchObject({
      name: 'Universe: Linked',
      items: [expect.objectContaining({ ref: 'rerouted.png' })],
    });
  });

  it('serializes concurrent filings for the same series', async () => {
    const series = await seriesSvc.createSeries({ name: 'RaceSeries' });
    await Promise.all([
      fileCoverIntoSeriesCollection({ seriesId: series.id, filename: 'cover.png' }),
      fileCoverIntoSeriesCollection({ seriesId: series.id, filename: 'back.png' }),
    ]);
    const linked = await collections.findCollectionBySeriesId(series.id);
    expect(linked.items.map((it) => it.ref).sort()).toEqual(['back.png', 'cover.png']);
    const named = (await collections.listCollections()).filter((c) => c.name === 'Series: RaceSeries');
    expect(named).toHaveLength(1);
  });
});

describe('fileCoverIntoAutoCollection (dispatcher)', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it('routes a universe-linked series to the universe collection', async () => {
    const universe = await universeSvc.createUniverse({ name: 'Cosmos' });
    const series = await seriesSvc.createSeries({ name: 'S', universeId: universe.id });
    await fileCoverIntoAutoCollection({ seriesId: series.id, filename: 'cover.png' });
    expect(await collections.findCollectionByUniverseId(universe.id)).toMatchObject({
      name: 'Universe: Cosmos',
    });
    expect(await collections.findCollectionBySeriesId(series.id)).toBeNull();
  });

  it('routes a universeless series to the per-series collection', async () => {
    const series = await seriesSvc.createSeries({ name: 'Indie' });
    await fileCoverIntoAutoCollection({ seriesId: series.id, filename: 'cover.png' });
    expect(await collections.findCollectionBySeriesId(series.id)).toMatchObject({
      name: 'Series: Indie',
    });
  });

  it('does NOT fall through to a per-series collection when the universe link is dangling', async () => {
    // Dispatcher commits to the universe-path on `series.universeId` set,
    // even if the universe is missing — re-routing would mint a per-series
    // collection for a series the user clearly intended to be universe-owned.
    const series = await seriesSvc.createSeries({ name: 'Dangling', universeId: 'ghost-universe' });
    await fileCoverIntoAutoCollection({ seriesId: series.id, filename: 'x.png' });
    expect(await collections.listCollections()).toEqual([]);
  });

  it('no-ops when seriesId or filename is missing', async () => {
    await fileCoverIntoAutoCollection({ seriesId: null, filename: 'x.png' });
    await fileCoverIntoAutoCollection({ seriesId: 'ser-x', filename: '' });
    expect(await collections.listCollections()).toEqual([]);
  });

  it('preloads the dispatcher-fetched series into the universe leaf — skips the leaf\'s initial getSeries', async () => {
    // Universe-linked path: with the dispatcher passing _preloadedSeries,
    // the leaf must skip its `initialSeries` read but still perform the
    // race-detection re-read. Net effect: 2 getSeries calls total
    // (dispatcher + leaf re-read) instead of 3 (dispatcher + leaf initial
    // + leaf re-read). Capture call count before restoring the spy so a
    // failing assertion doesn't leak the spy into later tests.
    const universe = await universeSvc.createUniverse({ name: 'Pre' });
    const series = await seriesSvc.createSeries({ name: 'S', universeId: universe.id });
    const spy = vi.spyOn(seriesSvc, 'getSeries');
    await fileCoverIntoAutoCollection({ seriesId: series.id, filename: 'cover.png' });
    const callCount = spy.mock.calls.length;
    spy.mockRestore();
    expect(callCount).toBe(2);
    expect(await collections.findCollectionByUniverseId(universe.id)).toMatchObject({
      items: [expect.objectContaining({ ref: 'cover.png' })],
    });
  });

  it('does NOT preload the series leaf — its first read is the early re-route check', async () => {
    // The universeless branch deliberately keeps the series leaf's own
    // first getSeries call. That read is the race window for "a universe
    // link was added between dispatcher and leaf entry": catching it
    // there re-routes the cover into the universe collection. If we
    // collapsed that read by preloading, the cover would file into the
    // per-series collection and merely get orphaned by recovery —
    // landing nowhere useful. Pin the un-optimized 3-call shape so a
    // future "let's also preload the series leaf" refactor fails loud.
    const series = await seriesSvc.createSeries({ name: 'Indie' });
    const spy = vi.spyOn(seriesSvc, 'getSeries');
    await fileCoverIntoAutoCollection({ seriesId: series.id, filename: 'cover.png' });
    const callCount = spy.mock.calls.length;
    spy.mockRestore();
    expect(callCount).toBe(3);
    expect(await collections.findCollectionBySeriesId(series.id)).toMatchObject({
      items: [expect.objectContaining({ ref: 'cover.png' })],
    });
  });
});
