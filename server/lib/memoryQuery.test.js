import { describe, it, expect } from 'vitest';
import {
  projectIndexMeta,
  filterMemoryIndex,
  compareMemoryEntries,
  passesSearchMetaFilters,
  passesHybridMetaFilters,
  fuseRankingsRRF,
  RRF_K
} from './memoryQuery.js';

describe('projectIndexMeta', () => {
  it('projects only the lightweight index fields', () => {
    const memory = {
      id: 'm1', type: 'fact', category: 'work', tags: ['a'], summary: 's',
      importance: 0.7, createdAt: '2024-01-01T00:00:00Z', status: 'active',
      sourceAppId: 'brain',
      // fields that must NOT leak into the index entry
      content: 'long content', embedding: [1, 2, 3], confidence: 0.9, accessCount: 5
    };
    expect(projectIndexMeta(memory)).toEqual({
      id: 'm1', type: 'fact', category: 'work', tags: ['a'], summary: 's',
      importance: 0.7, createdAt: '2024-01-01T00:00:00Z', status: 'active',
      sourceAppId: 'brain'
    });
  });
});

describe('filterMemoryIndex', () => {
  const memories = [
    { id: '1', type: 'fact', category: 'work', tags: ['x'], status: 'active', sourceAppId: 'brain' },
    { id: '2', type: 'note', category: 'home', tags: ['y'], status: 'active', sourceAppId: 'app1' },
    { id: '3', type: 'fact', category: 'work', tags: ['x', 'z'], status: 'archived', sourceAppId: 'app1' }
  ];

  it('defaults to active status', () => {
    expect(filterMemoryIndex(memories).map(m => m.id)).toEqual(['1', '2']);
  });

  it('filters by explicit status', () => {
    expect(filterMemoryIndex(memories, { status: 'archived' }).map(m => m.id)).toEqual(['3']);
  });

  it('filters by types', () => {
    expect(filterMemoryIndex(memories, { types: ['fact'] }).map(m => m.id)).toEqual(['1']);
  });

  it('filters by categories', () => {
    expect(filterMemoryIndex(memories, { categories: ['home'] }).map(m => m.id)).toEqual(['2']);
  });

  it('filters by tags (any match)', () => {
    expect(filterMemoryIndex(memories, { tags: ['y'] }).map(m => m.id)).toEqual(['2']);
  });

  it('filters by appId', () => {
    expect(filterMemoryIndex(memories, { appId: 'app1' }).map(m => m.id)).toEqual(['2']);
  });

  it('excludes brain entries with __not_brain sentinel', () => {
    expect(filterMemoryIndex(memories, { appId: '__not_brain' }).map(m => m.id)).toEqual(['2']);
  });
});

describe('compareMemoryEntries', () => {
  it('sorts by date descending by default semantics', () => {
    const cmp = compareMemoryEntries('createdAt', 'desc');
    const arr = [
      { createdAt: '2024-01-01T00:00:00Z' },
      { createdAt: '2024-03-01T00:00:00Z' },
      { createdAt: '2024-02-01T00:00:00Z' }
    ].sort(cmp);
    expect(arr.map(a => a.createdAt)).toEqual([
      '2024-03-01T00:00:00Z', '2024-02-01T00:00:00Z', '2024-01-01T00:00:00Z'
    ]);
  });

  it('sorts ascending', () => {
    const cmp = compareMemoryEntries('importance', 'asc');
    const arr = [{ importance: 0.9 }, { importance: 0.1 }, { importance: 0.5 }].sort(cmp);
    expect(arr.map(a => a.importance)).toEqual([0.1, 0.5, 0.9]);
  });

  it('sorts numbers descending', () => {
    const cmp = compareMemoryEntries('importance', 'desc');
    const arr = [{ importance: 0.1 }, { importance: 0.9 }, { importance: 0.5 }].sort(cmp);
    expect(arr.map(a => a.importance)).toEqual([0.9, 0.5, 0.1]);
  });

  it('places missing values last regardless of order', () => {
    const cmp = compareMemoryEntries('importance', 'desc');
    const arr = [{ importance: undefined }, { importance: 0.5 }, { importance: null }].sort(cmp);
    expect(arr[0].importance).toBe(0.5);
    expect(arr[1].importance == null).toBe(true);
    expect(arr[2].importance == null).toBe(true);
  });

  it('falls back to string comparison', () => {
    const cmp = compareMemoryEntries('type', 'asc');
    const arr = [{ type: 'note' }, { type: 'fact' }, { type: 'decision' }].sort(cmp);
    expect(arr.map(a => a.type)).toEqual(['decision', 'fact', 'note']);
  });
});

describe('passesSearchMetaFilters', () => {
  const meta = { type: 'fact', category: 'work', tags: ['x'], status: 'active', sourceAppId: 'app1' };

  it('rejects missing meta', () => {
    expect(passesSearchMetaFilters(undefined, {})).toBe(false);
  });

  it('rejects non-active meta', () => {
    expect(passesSearchMetaFilters({ ...meta, status: 'archived' }, {})).toBe(false);
  });

  it('passes active meta with no filters', () => {
    expect(passesSearchMetaFilters(meta, {})).toBe(true);
  });

  it('applies type/category/tag filters', () => {
    expect(passesSearchMetaFilters(meta, { types: ['note'] })).toBe(false);
    expect(passesSearchMetaFilters(meta, { categories: ['home'] })).toBe(false);
    expect(passesSearchMetaFilters(meta, { tags: ['y'] })).toBe(false);
    expect(passesSearchMetaFilters(meta, { types: ['fact'], categories: ['work'], tags: ['x'] })).toBe(true);
  });

  it('honors __not_brain sentinel', () => {
    expect(passesSearchMetaFilters({ ...meta, sourceAppId: 'brain' }, { appId: '__not_brain' })).toBe(false);
    expect(passesSearchMetaFilters(meta, { appId: '__not_brain' })).toBe(true);
  });

  it('filters by specific appId', () => {
    expect(passesSearchMetaFilters(meta, { appId: 'other' })).toBe(false);
    expect(passesSearchMetaFilters(meta, { appId: 'app1' })).toBe(true);
  });
});

describe('passesHybridMetaFilters', () => {
  const meta = { type: 'fact', category: 'work', tags: ['x'], status: 'active', sourceAppId: 'brain' };

  it('does NOT special-case __not_brain (matches original behavior)', () => {
    // With appId === '__not_brain', a brain entry's sourceAppId !== '__not_brain' -> filtered out
    expect(passesHybridMetaFilters(meta, { appId: '__not_brain' })).toBe(false);
  });

  it('passes active meta with no filters', () => {
    expect(passesHybridMetaFilters(meta, {})).toBe(true);
  });

  it('rejects non-active or missing', () => {
    expect(passesHybridMetaFilters(undefined, {})).toBe(false);
    expect(passesHybridMetaFilters({ ...meta, status: 'archived' }, {})).toBe(false);
  });
});

describe('fuseRankingsRRF', () => {
  it('uses the standard RRF constant of 60', () => {
    expect(RRF_K).toBe(60);
  });

  it('computes weighted RRF scores across both rankings', () => {
    const bm25 = [{ id: 'a' }, { id: 'b' }];
    const vector = [{ id: 'b' }, { id: 'c' }];
    const scores = fuseRankingsRRF(bm25, vector, { ftsWeight: 0.4, vectorWeight: 0.6 });

    // a: only bm25 rank 1
    expect(scores.get('a')).toEqual({
      bm25Rank: 1, vectorRank: null, rrfScore: 0.4 / (60 + 1)
    });
    // c: only vector rank 2
    expect(scores.get('c')).toEqual({
      bm25Rank: null, vectorRank: 2, rrfScore: 0.6 / (60 + 2)
    });
    // b: bm25 rank 2 + vector rank 1
    const b = scores.get('b');
    expect(b.bm25Rank).toBe(2);
    expect(b.vectorRank).toBe(1);
    expect(b.rrfScore).toBeCloseTo(0.4 / (60 + 2) + 0.6 / (60 + 1), 12);
  });

  it('returns an empty map for empty inputs', () => {
    expect(fuseRankingsRRF([], [], { ftsWeight: 0.4, vectorWeight: 0.6 }).size).toBe(0);
  });
});
