import { describe, it, expect } from 'vitest';
import {
  buildSpriteRecord,
  applySpriteRecordPatch,
  mergeImportedRecord,
  isValidSpriteId,
} from './recordsLogic.js';

const NOW = '2026-07-22T00:00:00.000Z';

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
});
