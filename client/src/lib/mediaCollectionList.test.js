import { describe, it, expect } from 'vitest';
import {
  applyCollectionView, splitCollectionName, isAutoCollection, collectionItemCount,
  normalizeCollectionSort, DEFAULT_COLLECTION_SORT, COLLECTION_SORTS,
} from './mediaCollectionList.js';

const item = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'image', ref: `${i}.png` }));

const unsorted = { id: 'unsorted', name: 'Unsorted', synthetic: true, items: item(3) };
const userFull = { id: 'u1', name: 'Concept Art', items: item(5), updatedAt: '2026-07-01T00:00:00Z' };
const userEmpty = { id: 'u2', name: 'Zeppelins', items: [], updatedAt: '2026-07-05T00:00:00Z' };
const autoFull = {
  id: 'p1', name: 'Creative Director: Nightly Surreal — 2026-07-30', items: item(2),
  description: 'Auto-created for project p1', updatedAt: '2026-07-30T00:00:00Z',
};
const autoEmpty = {
  id: 'p2', name: 'Creative Director: Nightly Surreal — 2026-08-01', items: [],
  description: 'Auto-created for project p2', updatedAt: '2026-08-01T00:00:00Z',
};

const ids = (list) => list.map((c) => c.id);

describe('splitCollectionName', () => {
  it('lifts the shared auto-creator prefix into a badge label', () => {
    expect(splitCollectionName('Creative Director: Nightly Surreal — 2026-08-01'))
      .toEqual({ badge: 'Creative Director', title: 'Nightly Surreal — 2026-08-01' });
  });

  it('covers every server-side auto-creator prefix', () => {
    expect(splitCollectionName('Writers Room: The Deep').badge).toBe('Writers Room');
    expect(splitCollectionName('Universe: Example Universe').badge).toBe('Universe');
    expect(splitCollectionName('Series: Example Series').badge).toBe('Series');
  });

  it('leaves a user-named collection alone', () => {
    expect(splitCollectionName('Concept Art')).toEqual({ badge: null, title: 'Concept Art' });
  });

  it('does not strip a name that is nothing but the prefix', () => {
    expect(splitCollectionName('Creative Director: ').badge).toBe(null);
  });

  it('tolerates a missing name', () => {
    expect(splitCollectionName(undefined)).toEqual({ badge: null, title: '' });
  });
});

describe('isAutoCollection', () => {
  it('recognizes each marker independently', () => {
    expect(isAutoCollection({ id: 'x', name: 'Creative Director: Foo' })).toBe(true);
    expect(isAutoCollection({ id: 'x', name: 'Foo', description: 'Auto-created for project x' })).toBe(true);
    // Writers Room buckets carry a random uuid and no universe/series link, so
    // the name + description markers are the only ones that can fire.
    expect(isAutoCollection({ id: 'x', name: 'Writers Room: The Deep' })).toBe(true);
    expect(isAutoCollection({ id: 'x', name: 'Foo', description: 'Auto-generated images for "The Deep"' })).toBe(true);
    expect(isAutoCollection({ id: 'uc-universe-1', name: 'Foo' })).toBe(true);
    expect(isAutoCollection({ id: 'sc-series-1', name: 'Foo' })).toBe(true);
    expect(isAutoCollection({ id: 'x', name: 'Foo', universeId: 'u1' })).toBe(true);
    expect(isAutoCollection({ id: 'x', name: 'Foo', seriesId: 's1' })).toBe(true);
  });

  it('is false for a user-created collection and for the synthetic Unsorted entry', () => {
    expect(isAutoCollection(userEmpty)).toBe(false);
    expect(isAutoCollection(unsorted)).toBe(false);
    expect(isAutoCollection(null)).toBe(false);
  });

  it('prefers the server-stamped source over the markers in both directions', () => {
    // source:'auto' classifies a record no marker would have caught — the whole
    // point of stamping provenance server-side (#3311).
    expect(isAutoCollection({ id: 'x', name: 'Nightly Renders', source: 'auto' })).toBe(true);
    // source:'user' wins over a name that merely looks auto-generated.
    expect(isAutoCollection({ id: 'x', name: 'Universe: My Own Bucket', source: 'user' })).toBe(false);
    expect(isAutoCollection({ id: 'x', name: 'Foo', universeId: 'u1', source: 'user' })).toBe(false);
    // Synthetic still short-circuits ahead of any stamp.
    expect(isAutoCollection({ ...unsorted, source: 'auto' })).toBe(false);
  });

  it('falls back to the markers when a peer sends no source at all', () => {
    // An older peer strips the field; absent must NOT read as 'user'.
    expect(isAutoCollection({ id: 'uc-universe-1', name: 'Universe: Example' })).toBe(true);
    expect(isAutoCollection({ id: 'x', name: 'Concept Art', source: undefined })).toBe(false);
    // A garbage value is not a stamp either — fall through to the markers.
    expect(isAutoCollection({ id: 'x', name: 'Writers Room: The Deep', source: 'nonsense' })).toBe(true);
  });
});

describe('collectionItemCount', () => {
  it('treats a missing/malformed items array as empty', () => {
    expect(collectionItemCount({ items: null })).toBe(0);
    expect(collectionItemCount(undefined)).toBe(0);
    expect(collectionItemCount({ items: item(4) })).toBe(4);
  });
});

describe('normalizeCollectionSort', () => {
  it('accepts every advertised sort id', () => {
    for (const s of COLLECTION_SORTS) expect(normalizeCollectionSort(s.id)).toBe(s.id);
  });

  it('coerces an unknown/absent value to the default', () => {
    expect(normalizeCollectionSort('bogus')).toBe(DEFAULT_COLLECTION_SORT);
    expect(normalizeCollectionSort(null)).toBe(DEFAULT_COLLECTION_SORT);
  });
});

describe('applyCollectionView', () => {
  const all = [unsorted, userFull, userEmpty, autoFull, autoEmpty];

  it('pins Unsorted first, then non-empty/user-created, then auto-generated empties', () => {
    const out = applyCollectionView(all);
    expect(out[0].id).toBe('unsorted');
    // autoEmpty is the newest by updatedAt but still sorts last — its bucket wins.
    expect(out[out.length - 1].id).toBe('p2');
    // A user's own empty collection is NOT demoted with the auto empties.
    expect(out.indexOf(userEmpty)).toBeLessThan(out.length - 1);
  });

  it('does not mutate the input array', () => {
    const input = [...all];
    applyCollectionView(input, { sort: 'name' });
    expect(input).toEqual(all);
  });

  it('searches name and description with AND-token semantics', () => {
    expect(ids(applyCollectionView(all, { query: 'nightly 08-01' }))).toEqual(['p2']);
    expect(ids(applyCollectionView(all, { query: 'project p1' }))).toEqual(['p1']);
    expect(applyCollectionView(all, { query: 'nothing matches this' })).toEqual([]);
  });

  it('ignores case and surrounding whitespace in the query', () => {
    expect(ids(applyCollectionView(all, { query: '  CONCEPT  ' }))).toEqual(['u1']);
  });

  it('sorts by name using the prefix-stripped title so auto entries interleave', () => {
    const out = applyCollectionView([userFull, autoFull], { sort: 'name' });
    // "Nightly…" < "Concept…" would be false on the raw names ("Creative
    // Director: Nightly" sorts before "Concept Art"), so this asserts the strip.
    expect(ids(out)).toEqual(['u1', 'p1']);
  });

  it('sorts by descending item count', () => {
    expect(ids(applyCollectionView([autoFull, userFull], { sort: 'count' }))).toEqual(['u1', 'p1']);
  });

  it('sorts a never-stamped record last rather than treating it as the oldest', () => {
    const noStamp = { id: 'n1', name: 'No timestamps', items: item(1) };
    const out = applyCollectionView([noStamp, userFull], { sort: 'updated' });
    expect(ids(out)).toEqual(['u1', 'n1']);
  });

  it('falls back to the default sort for an unknown sort id', () => {
    expect(ids(applyCollectionView(all, { sort: 'bogus' })))
      .toEqual(ids(applyCollectionView(all, { sort: DEFAULT_COLLECTION_SORT })));
  });

  it('handles an absent list', () => {
    expect(applyCollectionView(undefined, {})).toEqual([]);
    expect(applyCollectionView([])).toEqual([]);
  });
});
// @vitest-environment node
