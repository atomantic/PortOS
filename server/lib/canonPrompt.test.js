import { describe, it, expect } from 'vitest';
import {
  shortCanonDescriptorFragments,
  richCanonDescriptorFragments,
  descriptorForCanonEntry,
  hasCanonDescriptorContent,
} from './canonPrompt.js';

describe('canonPrompt.js', () => {
  describe('descriptorForCanonEntry', () => {
    it('returns empty string for null/non-object entry', () => {
      expect(descriptorForCanonEntry('characters', null)).toBe('');
      expect(descriptorForCanonEntry('characters', undefined)).toBe('');
      expect(descriptorForCanonEntry('characters', 'not an object')).toBe('');
    });

    it('returns empty string for unknown kind', () => {
      expect(descriptorForCanonEntry('unknown', { physicalDescription: 'tall' })).toBe('');
    });

    it('accepts singular and plural kinds', () => {
      const entry = { physicalDescription: 'tall' };
      expect(descriptorForCanonEntry('characters', entry)).toBe('tall');
      expect(descriptorForCanonEntry('character', entry)).toBe('tall');
      expect(descriptorForCanonEntry('CHARACTERS', entry)).toBe('tall');
    });

    describe('characters', () => {
      it('uses physicalDescription as primary', () => {
        expect(descriptorForCanonEntry('characters', {
          physicalDescription: 'tall, dark hair',
          description: 'old desc',
        })).toBe('tall, dark hair');
      });

      it('falls back to description when physicalDescription is missing', () => {
        expect(descriptorForCanonEntry('characters', { description: 'old desc' })).toBe('old desc');
      });

      it('falls back to description when physicalDescription is whitespace-only', () => {
        expect(descriptorForCanonEntry('characters', {
          physicalDescription: '   ',
          description: 'old desc',
        })).toBe('old desc');
      });

      it('returns empty when neither field is set', () => {
        expect(descriptorForCanonEntry('characters', { name: 'Alice' })).toBe('');
      });

      it('does NOT include role (role is rich-only)', () => {
        expect(descriptorForCanonEntry('characters', {
          physicalDescription: 'tall',
          role: 'protagonist',
        })).toBe('tall');
      });
    });

    describe('settings', () => {
      it('joins description + palette + recurringDetails in order', () => {
        expect(descriptorForCanonEntry('settings', {
          description: 'a dusty plaza',
          palette: 'ochre and copper',
          recurringDetails: 'cracked statue at center',
        })).toBe('a dusty plaza. Palette: ochre and copper. cracked statue at center');
      });

      it('prefixes palette with "Palette:"', () => {
        expect(descriptorForCanonEntry('settings', { palette: 'noir' })).toBe('Palette: noir');
      });

      it('omits missing fields', () => {
        expect(descriptorForCanonEntry('settings', {
          description: 'plaza',
          recurringDetails: 'statue',
        })).toBe('plaza. statue');
      });

      it('does NOT include era or weather (rich-only)', () => {
        expect(descriptorForCanonEntry('settings', {
          description: 'plaza',
          era: '2099',
          weather: 'foggy',
        })).toBe('plaza');
      });

      it('trims whitespace-only fields', () => {
        expect(descriptorForCanonEntry('settings', {
          description: '  plaza  ',
          palette: '   ',
          recurringDetails: 'statue',
        })).toBe('plaza. statue');
      });
    });

    describe('objects', () => {
      it('uses description as primary', () => {
        expect(descriptorForCanonEntry('objects', {
          description: 'a brass key',
          significance: 'opens the vault',
        })).toBe('a brass key');
      });

      it('falls back to significance when description is missing', () => {
        expect(descriptorForCanonEntry('objects', { significance: 'opens the vault' }))
          .toBe('opens the vault');
      });

      it('returns empty when neither field is set', () => {
        expect(descriptorForCanonEntry('objects', { name: 'Brass Key' })).toBe('');
      });
    });
  });

  describe('shortCanonDescriptorFragments', () => {
    it('returns empty array for unknown kind', () => {
      expect(shortCanonDescriptorFragments('unknown', { description: 'x' })).toEqual([]);
    });

    it('returns ordered fragments for settings', () => {
      const frags = shortCanonDescriptorFragments('settings', {
        description: 'plaza',
        palette: 'noir',
        recurringDetails: 'statue',
      });
      expect(frags).toEqual([
        { field: 'description', value: 'plaza' },
        { field: 'palette', value: 'noir', prefix: 'Palette' },
        { field: 'recurringDetails', value: 'statue' },
      ]);
    });

    it('returns a single primary fragment for characters with physicalDescription', () => {
      expect(shortCanonDescriptorFragments('characters', { physicalDescription: 'tall' }))
        .toEqual([{ field: 'physicalDescription', value: 'tall' }]);
    });

    it('returns a single fallback fragment for characters with only description', () => {
      expect(shortCanonDescriptorFragments('characters', { description: 'old desc' }))
        .toEqual([{ field: 'description', value: 'old desc' }]);
    });
  });

  describe('richCanonDescriptorFragments', () => {
    it('includes role for characters', () => {
      const frags = richCanonDescriptorFragments('characters', {
        physicalDescription: 'tall',
        role: 'protagonist',
      });
      expect(frags).toEqual([
        { field: 'physicalDescription', value: 'tall' },
        { field: 'role', value: 'protagonist' },
      ]);
    });

    it('includes era and weather for settings', () => {
      const frags = richCanonDescriptorFragments('settings', {
        description: 'plaza',
        palette: 'noir',
        era: '2099',
        weather: 'foggy',
        recurringDetails: 'statue',
      });
      expect(frags).toEqual([
        { field: 'description', value: 'plaza' },
        { field: 'palette', value: 'noir', prefix: 'Palette' },
        { field: 'era', value: '2099', prefix: 'Era' },
        { field: 'weather', value: 'foggy', prefix: 'Weather' },
        { field: 'recurringDetails', value: 'statue' },
      ]);
    });

    it('includes significance additively for objects (not as fallback)', () => {
      const frags = richCanonDescriptorFragments('objects', {
        description: 'a brass key',
        significance: 'opens the vault',
      });
      expect(frags).toEqual([
        { field: 'description', value: 'a brass key' },
        { field: 'significance', value: 'opens the vault', prefix: 'Significance' },
      ]);
    });

    it('does NOT fall back to description for characters', () => {
      expect(richCanonDescriptorFragments('characters', { description: 'old desc' })).toEqual([]);
    });
  });

  describe('hasCanonDescriptorContent', () => {
    it('is true when any rich field is set', () => {
      expect(hasCanonDescriptorContent('characters', { physicalDescription: 'tall' })).toBe(true);
      expect(hasCanonDescriptorContent('characters', { role: 'protagonist' })).toBe(true);
      expect(hasCanonDescriptorContent('settings', { palette: 'noir' })).toBe(true);
      expect(hasCanonDescriptorContent('settings', { weather: 'foggy' })).toBe(true);
      expect(hasCanonDescriptorContent('objects', { significance: 'x' })).toBe(true);
    });

    it('is false when no rich field is set', () => {
      expect(hasCanonDescriptorContent('characters', { name: 'Alice' })).toBe(false);
      expect(hasCanonDescriptorContent('settings', { name: 'Plaza' })).toBe(false);
      expect(hasCanonDescriptorContent('objects', {})).toBe(false);
    });

    it('treats whitespace-only fields as empty', () => {
      expect(hasCanonDescriptorContent('characters', { physicalDescription: '   ' })).toBe(false);
    });

    it('is false for unknown kind (defensive — known kinds always pass through)', () => {
      expect(hasCanonDescriptorContent('unknown', { physicalDescription: 'tall' })).toBe(false);
    });

    it('is false for null entry', () => {
      expect(hasCanonDescriptorContent('characters', null)).toBe(false);
    });

    it('short-circuits on first non-blank field (does not allocate array)', () => {
      // Sanity-check that adding extra blank fields after the first hit
      // doesn't change the result — guards against accidental regression
      // back to length-of-array-based implementation.
      expect(hasCanonDescriptorContent('settings', {
        description: 'plaza',
        palette: '',
        era: '',
        weather: '',
        recurringDetails: '',
      })).toBe(true);
    });
  });

  describe('richCanonDescriptorFragments edge cases', () => {
    it('returns [] for empty settings entry', () => {
      expect(richCanonDescriptorFragments('settings', {})).toEqual([]);
    });

    it('coerces non-string field values to empty (no fragment)', () => {
      expect(richCanonDescriptorFragments('characters', {
        physicalDescription: 42,
        role: null,
      })).toEqual([]);
    });
  });
});
