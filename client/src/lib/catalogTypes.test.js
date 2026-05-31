import { describe, it, expect } from 'vitest';
import {
  CATALOG_TYPES,
  getCatalogType,
  CHARACTER_LIST_FIELDS,
} from './catalogTypes.js';

describe('catalogTypes — character sheet sections', () => {
  it('character/place/object carry grouped editorSections; light types do not', () => {
    expect(getCatalogType('character').editorSections).toBeTruthy();
    expect(getCatalogType('place').editorSections).toBeTruthy();
    expect(getCatalogType('object').editorSections).toBeTruthy();
    for (const id of ['idea', 'scene', 'concept']) {
      expect(getCatalogType(id).editorSections).toBeFalsy();
    }
  });

  it('editorFields is the flattened union of editorSections for rich types', () => {
    for (const id of ['character', 'place', 'object']) {
      const t = getCatalogType(id);
      const flat = t.editorSections.flatMap((s) => s.fields).map(([k]) => k);
      const fromFields = t.editorFields.map(([k]) => k);
      expect(fromFields).toEqual(flat);
    }
  });

  it('every section field tuple is [key, label, kind] with a valid kind', () => {
    for (const id of ['character', 'place', 'object']) {
      for (const section of getCatalogType(id).editorSections) {
        expect(typeof section.title).toBe('string');
        expect(Array.isArray(section.fields)).toBe(true);
        for (const [key, label, kind] of section.fields) {
          expect(typeof key).toBe('string');
          expect(typeof label).toBe('string');
          expect(['text', 'textarea']).toContain(kind);
        }
      }
    }
  });

  it('character sheet exposes the enriched canon scalar fields', () => {
    const keys = getCatalogType('character').editorFields.map(([k]) => k);
    // A representative slice of the sanitizeCharacter scalar fields the sheet
    // must now expose — identity, appearance, personality, goals, relationships.
    for (const k of ['role', 'pronouns', 'age', 'coreTheme', 'physicalDescription',
      'visualNotes', 'silhouetteNotes', 'personality', 'speechPattern',
      'motivations', 'likes', 'dislikes', 'background', 'relationships', 'skills', 'notes']) {
      expect(keys).toContain(k);
    }
  });

  it('section field keys are unique within a type (no key edited twice)', () => {
    for (const id of ['character', 'place', 'object']) {
      const keys = getCatalogType(id).editorFields.map(([k]) => k);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('CHARACTER_LIST_FIELDS describes read-only canon arrays with renderer kinds', () => {
    const byKey = Object.fromEntries(CHARACTER_LIST_FIELDS.map((f) => [f.key, f]));
    expect(byKey.colorPalette.kind).toBe('colorPalette');
    expect(byKey.stats.kind).toBe('kv');
    expect(byKey.aliases.kind).toBe('text');
  });

  it('CATALOG_TYPES stays frozen', () => {
    expect(Object.isFrozen(CATALOG_TYPES)).toBe(true);
  });
});
