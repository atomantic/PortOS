import { describe, it, expect } from 'vitest';
import {
  STYLE_PRESETS,
  STYLE_PRESET_IDS,
  STYLE_ID,
  ALL_STYLE_IDS,
  EMPTY_IMAGE_STYLE,
  getStylePresetById,
  findStylePreset
} from './writersRoomStylePresets.js';

describe('writersRoomStylePresets', () => {
  describe('STYLE_PRESETS catalog', () => {
    it('exposes a non-empty preset list', () => {
      expect(Array.isArray(STYLE_PRESETS)).toBe(true);
      expect(STYLE_PRESETS.length).toBeGreaterThan(0);
    });

    it('every preset has the required fields', () => {
      for (const p of STYLE_PRESETS) {
        expect(typeof p.id).toBe('string');
        expect(p.id.length).toBeGreaterThan(0);
        expect(typeof p.label).toBe('string');
        expect(p.label.length).toBeGreaterThan(0);
        expect(typeof p.category).toBe('string');
        expect(p.category.length).toBeGreaterThan(0);
        expect(typeof p.prompt).toBe('string');
        expect(p.prompt.length).toBeGreaterThan(0);
        expect(typeof p.negativePrompt).toBe('string');
      }
    });

    it('preset ids are unique (the cache map relies on this)', () => {
      const seen = new Set();
      for (const p of STYLE_PRESETS) {
        expect(seen.has(p.id), `duplicate preset id: ${p.id}`).toBe(false);
        seen.add(p.id);
      }
    });

    it('STYLE_PRESET_IDS mirrors the preset id list in order', () => {
      expect(STYLE_PRESET_IDS).toEqual(STYLE_PRESETS.map(p => p.id));
    });
  });

  describe('STYLE_ID sentinels', () => {
    it('exposes none/custom sentinels', () => {
      expect(STYLE_ID.NONE).toBe('none');
      expect(STYLE_ID.CUSTOM).toBe('custom');
    });

    it('ALL_STYLE_IDS prefixes sentinels then preset ids', () => {
      expect(ALL_STYLE_IDS[0]).toBe(STYLE_ID.NONE);
      expect(ALL_STYLE_IDS[1]).toBe(STYLE_ID.CUSTOM);
      expect(ALL_STYLE_IDS.slice(2)).toEqual(STYLE_PRESET_IDS);
    });

    it('EMPTY_IMAGE_STYLE is the none-preset zero-value', () => {
      expect(EMPTY_IMAGE_STYLE).toEqual({
        presetId: STYLE_ID.NONE,
        prompt: '',
        negativePrompt: ''
      });
    });
  });

  describe('getStylePresetById', () => {
    it('returns the matching preset', () => {
      const cinematic = getStylePresetById('cinematic');
      expect(cinematic).not.toBeNull();
      expect(cinematic.id).toBe('cinematic');
      expect(cinematic.label).toBe('Cinematic');
    });

    it('returns null for unknown ids', () => {
      expect(getStylePresetById('this-id-does-not-exist')).toBeNull();
    });

    it('returns null for nullish / non-string input', () => {
      expect(getStylePresetById(null)).toBeNull();
      expect(getStylePresetById(undefined)).toBeNull();
      expect(getStylePresetById('')).toBeNull();
      expect(getStylePresetById(42)).toBeNull();
    });
  });

  describe('findStylePreset', () => {
    it('returns the matching preset', () => {
      const noir = findStylePreset('noir');
      expect(noir).not.toBeNull();
      expect(noir.id).toBe('noir');
    });

    it('returns null for unknown ids', () => {
      expect(findStylePreset('not-a-real-style')).toBeNull();
    });

    it('agrees with getStylePresetById for every known id', () => {
      for (const id of STYLE_PRESET_IDS) {
        expect(findStylePreset(id)).toBe(getStylePresetById(id));
      }
    });
  });
});
