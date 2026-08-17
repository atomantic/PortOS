import { describe, it, expect } from 'vitest';
import {
  TRUNK_TABS, TRUNK_BY_ID, TRUNK_BY_KIND, BUCKET_CANON,
  groupBucketsByKind, normalizeCategoryKey, humanizeCategory,
  ensureDraftCategories, getCategoryKeys, compositeKindLabel, COMPOSITE_BOARD_KINDS,
  adoptServerEntryIds, adoptServerCategoryIds,
} from './universeBuilderShared.js';

describe('universeBuilderShared — trunk maps', () => {
  it('indexes trunks by id and kind', () => {
    expect(TRUNK_TABS).toHaveLength(3);
    expect(TRUNK_BY_ID.cast.kind).toBe('characters');
    expect(TRUNK_BY_KIND.places.id).toBe('places');
    expect(BUCKET_CANON).toBe('canon');
  });
});

describe('universeBuilderShared — groupBucketsByKind', () => {
  it('bins buckets by kind and folds unknown/missing into other', () => {
    const grouped = groupBucketsByKind({
      heroes: { kind: 'characters' },
      cities: { kind: 'places' },
      loot: { kind: 'objects' },
      misc: { kind: 'weird' },
      untagged: {},
    });
    expect(grouped.characters).toEqual(['heroes']);
    expect(grouped.places).toEqual(['cities']);
    expect(grouped.objects).toEqual(['loot']);
    expect(grouped.other.sort()).toEqual(['misc', 'untagged']);
  });

  it('tolerates empty / missing input', () => {
    expect(groupBucketsByKind()).toEqual({ characters: [], places: [], objects: [], other: [] });
  });
});

describe('universeBuilderShared — normalizeCategoryKey', () => {
  it('slugifies to lowercase underscore keys', () => {
    expect(normalizeCategoryKey('  Heroes & Villains  ')).toBe('heroes_and_villains');
    expect(normalizeCategoryKey('Deep   Space!!')).toBe('deep_space');
    expect(normalizeCategoryKey('__weird__')).toBe('weird');
  });

  it('returns empty string for blank / nullish input', () => {
    expect(normalizeCategoryKey('')).toBe('');
    expect(normalizeCategoryKey(null)).toBe('');
    expect(normalizeCategoryKey('!!!')).toBe('');
  });
});

describe('universeBuilderShared — humanizeCategory', () => {
  it('uses the label table when present', () => {
    expect(humanizeCategory('landscapes')).toBe('Landscapes');
  });

  it('title-cases unknown keys', () => {
    expect(humanizeCategory('deep_space')).toBe('Deep Space');
    expect(humanizeCategory('')).toBe('');
  });

  it('title-cases Object.prototype keys instead of returning the inherited member', () => {
    // Category keys are user-authored and reach here from unvalidated sidecar
    // metadata, so an unguarded lookup would hand back a function.
    expect(humanizeCategory('constructor')).toBe('Constructor');
    expect(humanizeCategory('toString')).toBe('ToString');
  });
});

describe('universeBuilderShared — draft categories', () => {
  it('ensureDraftCategories seeds the world defaults and preserves overrides', () => {
    const out = ensureDraftCategories({ heroes: { variations: [{ label: 'x' }] } });
    expect(out.heroes.variations).toHaveLength(1);
    // Seeded default keys exist too.
    expect(Object.keys(out).length).toBeGreaterThan(1);
  });

  it('getCategoryKeys dedupes normalized keys', () => {
    const keys = getCategoryKeys({ Heroes: {}, heroes: {}, 'Deep Space': {} });
    expect(keys).toContain('heroes');
    expect(keys).toContain('deep_space');
    expect(keys.filter((k) => k === 'heroes')).toHaveLength(1);
  });
});

describe('universeBuilderShared — compositeKindLabel', () => {
  it('maps a known kind and falls back to reference sheet', () => {
    expect(compositeKindLabel('world_pitch_poster')).toBe('World pitch poster');
    expect(compositeKindLabel('nonsense')).toBe('Reference sheet');
    expect(COMPOSITE_BOARD_KINDS.length).toBeGreaterThan(0);
  });
});

describe('adoptServerEntryIds', () => {
  it('fills ids onto id-less entries by label', () => {
    const local = [{ label: 'A' }, { label: 'B', id: 'keep-me' }];
    const server = [{ label: 'A', id: 'sheet-a' }, { label: 'B', id: 'keep-me' }];
    expect(adoptServerEntryIds(local, server)).toEqual([
      { label: 'A', id: 'sheet-a' },
      { label: 'B', id: 'keep-me' },
    ]);
  });

  it('keeps an id the server record also has', () => {
    const local = [{ label: 'A', id: 'real-a' }, { label: 'B', id: 'real-b' }];
    const server = [{ label: 'A', id: 'real-a' }, { label: 'B', id: 'real-b' }];
    expect(adoptServerEntryIds(local, server)).toBe(local);
  });

  // Records written before entry ids were persisted get a FRESH uuid minted on
  // every read, so the draft's copy is transient — and /render persists a
  // different set before queueing jobs against it. An id the server doesn't have
  // is not the key anything is stored under, so it gets replaced.
  it('replaces a transient id the server record does not have', () => {
    const local = [{ label: 'A', id: 'transient-a' }];
    const server = [{ label: 'A', id: 'persisted-a' }];
    expect(adoptServerEntryIds(local, server)[0].id).toBe('persisted-a');
  });

  // The guard that keeps this from re-keying a row out from under an in-flight
  // job: a real id always wins, even when a sibling row shares its label.
  it('does not hand a real id to a different row that shares the label', () => {
    const local = [{ label: 'Dup', id: 'transient' }, { label: 'Dup', id: 'real' }];
    const server = [{ label: 'Dup', id: 'real' }];
    expect(adoptServerEntryIds(local, server).map((e) => e.id)).toEqual(['transient', 'real']);
  });

  // Two boards can legitimately share a label. Claiming each server id at most
  // once makes them fill in order rather than both taking the first match — and
  // an id already held locally is excluded from the pool so it can't be handed
  // to a different row.
  it('claims each server id once across duplicate labels', () => {
    const local = [{ label: 'Dup' }, { label: 'Dup' }, { label: 'Dup', id: 'held' }];
    const server = [
      { label: 'Dup', id: 'held' },
      { label: 'Dup', id: 's1' },
      { label: 'Dup', id: 's2' },
    ];
    expect(adoptServerEntryIds(local, server).map((e) => e.id)).toEqual(['s1', 's2', 'held']);
  });

  // Same-reference-when-unchanged is the contract callers use to skip a setState.
  it('returns the same array when nothing needed filling', () => {
    const local = [{ label: 'A', id: 'a' }];
    expect(adoptServerEntryIds(local, [{ label: 'A', id: 'a' }])).toBe(local);
    expect(adoptServerEntryIds(local, [])).toBe(local);
    expect(adoptServerEntryIds(local, null)).toBe(local);
  });

  // An empty/failed server list must not strip ids off every row — "no server
  // entries" is not evidence that the local ids are fake.
  it('leaves ids alone when the server list has none to offer', () => {
    const local = [{ label: 'A', id: 'a' }, { label: 'B' }];
    expect(adoptServerEntryIds(local, [])).toBe(local);
    expect(adoptServerEntryIds(local, [{ label: 'C', id: 'c' }])).toBe(local);
  });

  it('leaves an entry alone when no server entry shares its label', () => {
    const local = [{ label: 'Missing' }];
    expect(adoptServerEntryIds(local, [{ label: 'Other', id: 'x' }])).toBe(local);
  });
});

describe('adoptServerCategoryIds', () => {
  it('fills variation ids per bucket and preserves untouched buckets by reference', () => {
    const untouched = { kind: 'places', variations: [{ label: 'P', id: 'p1' }] };
    const local = { cast: { kind: 'characters', variations: [{ label: 'V' }] }, places: untouched };
    const server = {
      cast: { variations: [{ label: 'V', id: 'v1' }] },
      places: { variations: [{ label: 'P', id: 'p1' }] },
    };
    const next = adoptServerCategoryIds(local, server);
    expect(next.cast.variations[0].id).toBe('v1');
    expect(next.cast.kind).toBe('characters');
    expect(next.places).toBe(untouched);
  });

  it('returns the same object when no bucket changed', () => {
    const local = { cast: { variations: [{ label: 'V', id: 'v1' }] } };
    expect(adoptServerCategoryIds(local, { cast: { variations: [{ label: 'V', id: 'v1' }] } })).toBe(local);
    expect(adoptServerCategoryIds(local, null)).toBe(local);
  });
});
// @vitest-environment node
