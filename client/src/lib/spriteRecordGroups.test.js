import { describe, it, expect } from 'vitest';
import {
  groupSpriteRecords,
  filterSpriteRecords,
  groupKeyForKind,
  SPRITE_RECORD_GROUPS,
  NEW_SPRITE_KINDS,
} from './spriteRecordGroups.js';

const RECORDS = [
  { id: 'pioneer', name: 'Pioneer', kind: 'character', status: 'draft' },
  { id: 'saloon', name: 'Dusty Saloon', kind: 'place', status: 'imported' },
  { id: 'lantern', name: 'Lantern', kind: 'object', status: 'draft' },
  { id: 'crates', name: 'Crate Family', kind: 'props', status: 'imported' },
];

describe('groupKeyForKind', () => {
  it('maps each kind to its noun group, folding props into objects', () => {
    expect(groupKeyForKind('character')).toBe('characters');
    expect(groupKeyForKind('place')).toBe('places');
    expect(groupKeyForKind('object')).toBe('objects');
    expect(groupKeyForKind('props')).toBe('objects');
  });

  it('parks an unknown/legacy kind in objects rather than dropping it', () => {
    expect(groupKeyForKind('mystery')).toBe('objects');
    expect(groupKeyForKind(undefined)).toBe('objects');
  });
});

describe('groupSpriteRecords', () => {
  it('groups under Characters / Places / Objects in render order', () => {
    const groups = groupSpriteRecords(RECORDS);
    expect(groups.map((g) => g.label)).toEqual(['Characters', 'Places', 'Objects']);
  });

  it('folds legacy props records into Objects alongside object (#2932 regression)', () => {
    const objects = groupSpriteRecords(RECORDS).find((g) => g.key === 'objects');
    expect(objects.records.map((r) => r.id)).toEqual(['lantern', 'crates']);
  });

  it('omits empty groups', () => {
    const groups = groupSpriteRecords([{ id: 'a', name: 'A', kind: 'character' }]);
    expect(groups.map((g) => g.key)).toEqual(['characters']);
  });

  it('tolerates a non-array input', () => {
    expect(groupSpriteRecords(null)).toEqual([]);
  });
});

describe('filterSpriteRecords', () => {
  it('returns the (bounded) full list for an empty query', () => {
    expect(filterSpriteRecords(RECORDS, '')).toHaveLength(4);
    expect(filterSpriteRecords(RECORDS, '   ')).toHaveLength(4);
  });

  it('matches multi-term substrings across name/id/kind (AND semantics)', () => {
    expect(filterSpriteRecords(RECORDS, 'dusty').map((r) => r.id)).toEqual(['saloon']);
    // "place" matches only via the kind field
    expect(filterSpriteRecords(RECORDS, 'place').map((r) => r.id)).toEqual(['saloon']);
    // both terms must match somewhere
    expect(filterSpriteRecords(RECORDS, 'crate props').map((r) => r.id)).toEqual(['crates']);
    expect(filterSpriteRecords(RECORDS, 'crate character')).toEqual([]);
  });

  it('caps the suggestion list at the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: `Char ${i}`, kind: 'character' }));
    expect(filterSpriteRecords(many, 'char')).toHaveLength(8);
    expect(filterSpriteRecords(many, 'char', 3)).toHaveLength(3);
  });
});

describe('exported constants', () => {
  it('SPRITE_RECORD_GROUPS covers character/place/object/props exactly once', () => {
    const kinds = SPRITE_RECORD_GROUPS.flatMap((g) => g.kinds);
    expect(kinds.sort()).toEqual(['character', 'object', 'place', 'props']);
  });

  it('NEW_SPRITE_KINDS never offers the import-only props kind', () => {
    expect(NEW_SPRITE_KINDS.map((k) => k.value)).toEqual(['character', 'place', 'object']);
  });
});
