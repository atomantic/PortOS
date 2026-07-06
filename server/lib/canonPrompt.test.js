import { describe, it, expect } from 'vitest';
import {
  shortCanonDescriptorFragments,
  richCanonDescriptorFragments,
  descriptorForCanonEntry,
  hasCanonDescriptorContent,
  previewCanonFragments,
  shortCanonPrimaryField,
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

    describe('places', () => {
      it('joins description + palette + recurringDetails in order', () => {
        expect(descriptorForCanonEntry('places', {
          description: 'a dusty plaza',
          palette: 'ochre and copper',
          recurringDetails: 'cracked statue at center',
        })).toBe('a dusty plaza. Palette: ochre and copper. cracked statue at center');
      });

      it('prefixes palette with "Palette:"', () => {
        expect(descriptorForCanonEntry('places', { palette: 'noir' })).toBe('Palette: noir');
      });

      it('omits missing fields', () => {
        expect(descriptorForCanonEntry('places', {
          description: 'plaza',
          recurringDetails: 'statue',
        })).toBe('plaza. statue');
      });

      it('does NOT include era or weather (rich-only)', () => {
        expect(descriptorForCanonEntry('places', {
          description: 'plaza',
          era: '2099',
          weather: 'foggy',
        })).toBe('plaza');
      });

      it('trims whitespace-only fields', () => {
        expect(descriptorForCanonEntry('places', {
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

  describe('shortCanonPrimaryField', () => {
    it('returns the per-kind primary descriptor field (singular + plural kinds)', () => {
      expect(shortCanonPrimaryField('character')).toBe('physicalDescription');
      expect(shortCanonPrimaryField('characters')).toBe('physicalDescription');
      expect(shortCanonPrimaryField('object')).toBe('description');
      expect(shortCanonPrimaryField('objects')).toBe('description');
      // Places use a sequence — the first field is the primary.
      expect(shortCanonPrimaryField('place')).toBe('description');
      expect(shortCanonPrimaryField('places')).toBe('description');
    });
    it('returns null for an unknown kind', () => {
      expect(shortCanonPrimaryField('gadget')).toBeNull();
      expect(shortCanonPrimaryField(undefined)).toBeNull();
    });
  });

  describe('shortCanonDescriptorFragments', () => {
    it('returns empty array for unknown kind', () => {
      expect(shortCanonDescriptorFragments('unknown', { description: 'x' })).toEqual([]);
    });

    it('returns ordered fragments for places', () => {
      const frags = shortCanonDescriptorFragments('places', {
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

    it('includes era and weather for places', () => {
      const frags = richCanonDescriptorFragments('places', {
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
      expect(hasCanonDescriptorContent('places', { palette: 'noir' })).toBe(true);
      expect(hasCanonDescriptorContent('places', { weather: 'foggy' })).toBe(true);
      expect(hasCanonDescriptorContent('objects', { significance: 'x' })).toBe(true);
    });

    it('is false when no rich field is set', () => {
      expect(hasCanonDescriptorContent('characters', { name: 'Alice' })).toBe(false);
      expect(hasCanonDescriptorContent('places', { name: 'Plaza' })).toBe(false);
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
      expect(hasCanonDescriptorContent('places', {
        description: 'plaza',
        palette: '',
        era: '',
        weather: '',
        recurringDetails: '',
      })).toBe(true);
    });
  });

  describe('previewCanonFragments', () => {
    it('returns empty shape for null/non-object entry', () => {
      expect(previewCanonFragments('characters', null)).toEqual({ subtitle: '', body: [] });
      expect(previewCanonFragments('characters', undefined)).toEqual({ subtitle: '', body: [] });
      expect(previewCanonFragments('characters', 'nope')).toEqual({ subtitle: '', body: [] });
    });

    it('returns empty shape for unknown kind', () => {
      expect(previewCanonFragments('unknown', { name: 'x', description: 'y' }))
        .toEqual({ subtitle: '', body: [] });
    });

    it('accepts singular and plural kinds (normalizeKind passthrough)', () => {
      const entry = { physicalDescription: 'tall', role: 'protagonist' };
      expect(previewCanonFragments('character', entry).subtitle).toBe('protagonist');
      expect(previewCanonFragments('CHARACTERS', entry).subtitle).toBe('protagonist');
      expect(previewCanonFragments('place', { slugline: 'INT. — DAY' }).subtitle).toBe('INT. — DAY');
    });

    describe('characters', () => {
      it('returns role as subtitle and physicalDescription/personality/background as body in order', () => {
        expect(previewCanonFragments('characters', {
          name: 'Alice',
          role: 'protagonist',
          physicalDescription: 'tall, dark hair',
          personality: 'curious, restless',
          background: 'orphaned at twelve',
        })).toEqual({
          subtitle: 'protagonist',
          body: [
            { field: 'physicalDescription', value: 'tall, dark hair' },
            { field: 'personality', value: 'curious, restless' },
            { field: 'background', value: 'orphaned at twelve' },
          ],
        });
      });

      it('omits blank body fields and yields blank subtitle when role missing', () => {
        expect(previewCanonFragments('characters', {
          physicalDescription: 'tall',
          background: '',
        })).toEqual({
          subtitle: '',
          body: [{ field: 'physicalDescription', value: 'tall' }],
        });
      });

      it('trims whitespace-only fields', () => {
        expect(previewCanonFragments('characters', {
          role: '   ',
          physicalDescription: '  tall  ',
          personality: '',
          background: '  ',
        })).toEqual({
          subtitle: '',
          body: [{ field: 'physicalDescription', value: 'tall' }],
        });
      });

      it('does NOT include description as a fallback (preview is field-keyed, not legacy-fallback)', () => {
        expect(previewCanonFragments('characters', { description: 'old desc' }))
          .toEqual({ subtitle: '', body: [] });
      });
    });

    describe('places', () => {
      it('returns slugline as subtitle and description as body', () => {
        expect(previewCanonFragments('places', {
          name: 'The Plaza',
          slugline: 'EXT. — DUSK',
          description: 'a dusty plaza with a cracked statue',
        })).toEqual({
          subtitle: 'EXT. — DUSK',
          body: [{ field: 'description', value: 'a dusty plaza with a cracked statue' }],
        });
      });

      it('does NOT include palette/era/weather/recurringDetails (those are RICH-only)', () => {
        expect(previewCanonFragments('places', {
          slugline: 'INT.',
          description: 'plaza',
          palette: 'noir',
          era: '2099',
          weather: 'foggy',
          recurringDetails: 'statue',
        })).toEqual({
          subtitle: 'INT.',
          body: [{ field: 'description', value: 'plaza' }],
        });
      });
    });

    describe('objects', () => {
      it('returns empty subtitle and description+significance body', () => {
        expect(previewCanonFragments('objects', {
          name: 'Brass Key',
          description: 'tarnished brass key with a green ribbon',
          significance: 'opens the vault under the chapel',
        })).toEqual({
          subtitle: '',
          body: [
            { field: 'description', value: 'tarnished brass key with a green ribbon' },
            { field: 'significance', value: 'opens the vault under the chapel' },
          ],
        });
      });

      it('returns significance additively (not as fallback)', () => {
        expect(previewCanonFragments('objects', { significance: 'opens the vault' }))
          .toEqual({
            subtitle: '',
            body: [{ field: 'significance', value: 'opens the vault' }],
          });
      });
    });
  });

  describe('richCanonDescriptorFragments edge cases', () => {
    it('returns [] for empty places entry', () => {
      expect(richCanonDescriptorFragments('places', {})).toEqual([]);
    });

    it('coerces non-string field values to empty (no fragment)', () => {
      expect(richCanonDescriptorFragments('characters', {
        physicalDescription: 42,
        role: null,
      })).toEqual([]);
    });
  });
});
