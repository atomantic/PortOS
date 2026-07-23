import { describe, it, expect } from 'vitest';
import {
  buildSpriteRecord,
  applySpriteRecordPatch,
  mergeImportedRecord,
  isValidSpriteId,
  SPRITE_RECORD_KINDS,
} from './recordsLogic.js';

const NOW = '2026-07-22T00:00:00.000Z';

describe('SPRITE_RECORD_KINDS', () => {
  it('carries the noun taxonomy plus the legacy props value (#2932)', () => {
    expect(SPRITE_RECORD_KINDS).toEqual(['character', 'place', 'object', 'props']);
  });
});

describe('isValidSpriteId', () => {
  it('accepts kebab-case slugs', () => {
    expect(isValidSpriteId('pioneer')).toBe(true);
    expect(isValidSpriteId('landing-kit')).toBe(true);
  });

  it('rejects traversal-capable and malformed ids', () => {
    for (const bad of ['../etc', 'a/b', 'UPPER', '', '-lead', null, 'a'.repeat(65)]) {
      expect(isValidSpriteId(bad)).toBe(false);
    }
  });
});

describe('buildSpriteRecord', () => {
  it('defaults kind/status and falls back name to the id', () => {
    const r = buildSpriteRecord({}, { id: 'hero', now: NOW });
    expect(r).toMatchObject({ id: 'hero', kind: 'character', name: 'hero', status: 'draft', deleted: false });
    expect(r.createdAt).toBe(NOW);
  });

  it('keeps spec/chromaKey/importedFrom when provided', () => {
    const spec = { characterId: 'hero', archetype: 'adult-humanoid-v1' };
    const r = buildSpriteRecord(
      { kind: 'props', name: ' Flora ', status: 'imported', spec, chromaKey: '#FF00FF', importedFrom: { sourceRoot: '/x' } },
      { id: 'flora', now: NOW },
    );
    expect(r.kind).toBe('props');
    expect(r.name).toBe('Flora');
    expect(r.spec).toBe(spec);
    expect(r.chromaKey).toBe('#FF00FF');
    expect(r.importedFrom.sourceRoot).toBe('/x');
  });

  it('accepts the new place/object noun kinds (#2932)', () => {
    expect(buildSpriteRecord({ kind: 'place', name: 'Saloon' }, { id: 'saloon', now: NOW }).kind).toBe('place');
    expect(buildSpriteRecord({ kind: 'object', name: 'Lantern' }, { id: 'lantern', now: NOW }).kind).toBe('object');
  });

  it('falls back to character for an unknown kind', () => {
    expect(buildSpriteRecord({ kind: 'nonsense', name: 'X' }, { id: 'x', now: NOW }).kind).toBe('character');
  });
});

describe('applySpriteRecordPatch', () => {
  const base = buildSpriteRecord({ name: 'Hero', chromaKey: '#FF00FF' }, { id: 'hero', now: NOW });

  it('key-absent preserves; key-present applies (including a clear)', () => {
    const next = applySpriteRecordPatch(base, { notes: 'walk set locked', chromaKey: null });
    expect(next.name).toBe('Hero');
    expect(next.notes).toBe('walk set locked');
    expect(next.chromaKey).toBeNull();
    expect(next.updatedAt).not.toBe(base.updatedAt);
  });

  it('ignores keys outside the whitelist', () => {
    const next = applySpriteRecordPatch(base, { id: 'evil', deleted: true });
    expect(next.id).toBe('hero');
    expect(next.deleted).toBe(false);
  });

  it('reclassifies kind to a valid value but ignores an unknown one (#2932)', () => {
    expect(applySpriteRecordPatch(base, { kind: 'place' }).kind).toBe('place');
    expect(applySpriteRecordPatch(base, { kind: 'bogus' }).kind).toBe('character');
  });
});

describe('mergeImportedRecord', () => {
  const existing = {
    ...buildSpriteRecord({ name: 'Hero', chromaKey: '#00FF00' }, { id: 'hero', now: NOW }),
    notes: 'user note',
    publishBinding: { appId: 'my-game' },
  };
  const imported = buildSpriteRecord(
    { name: 'Hero v2', status: 'imported', spec: { a: 1 }, chromaKey: '#FF00FF', importedFrom: { sourceRoot: '/y' } },
    { id: 'hero', now: '2026-07-23T00:00:00.000Z' },
  );

  it('refreshes source-derived fields but keeps user-managed ones', () => {
    const next = mergeImportedRecord(existing, imported, '2026-07-23T00:00:00.000Z');
    expect(next.name).toBe('Hero v2');
    expect(next.spec).toEqual({ a: 1 });
    expect(next.notes).toBe('user note');
    expect(next.publishBinding).toEqual({ appId: 'my-game' });
    expect(next.chromaKey).toBe('#00FF00'); // manually-set key survives re-import
    expect(next.createdAt).toBe(NOW);
  });

  it('uses the imported record wholesale when nothing exists', () => {
    const next = mergeImportedRecord(null, imported, '2026-07-23T00:00:00.000Z');
    expect(next.chromaKey).toBe('#FF00FF');
    expect(next.notes).toBeNull();
  });

  it('an explicitly cleared chromaKey stays cleared on re-import', () => {
    const cleared = { ...existing, chromaKey: null };
    const next = mergeImportedRecord(cleared, imported, '2026-07-23T00:00:00.000Z');
    expect(next.chromaKey).toBeNull(); // || would resurrect the import default
  });
});

describe('deriveSpriteId', () => {
  it('kebabs a display name into a valid id', async () => {
    const { deriveSpriteId } = await import('./recordsLogic.js');
    expect(deriveSpriteId('Trail Hand #2')).toBe('trail-hand-2');
    expect(deriveSpriteId('  Pioneer  ')).toBe('pioneer');
  });

  it('returns null when nothing derivable remains', async () => {
    const { deriveSpriteId } = await import('./recordsLogic.js');
    expect(deriveSpriteId('!!!')).toBeNull();
    expect(deriveSpriteId('')).toBeNull();
    expect(deriveSpriteId(null)).toBeNull();
  });
});
