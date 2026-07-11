import { describe, it, expect } from 'vitest';
import {
  TRUNK_TABS, TRUNK_BY_ID, TRUNK_BY_KIND, BUCKET_CANON,
  groupBucketsByKind, normalizeCategoryKey, humanizeCategory,
  ensureDraftCategories, getCategoryKeys, compositeKindLabel, COMPOSITE_BOARD_KINDS,
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
