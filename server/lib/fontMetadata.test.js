/**
 * Reading a family name out of an uploaded font (#10345): TrueType/OpenType
 * and WOFF2, preferring the typographic family, and null for anything that is
 * not a single font, so an upload never throws on a bad file.
 */
import { describe, expect, it } from 'vitest';
import { sfntWithNames, woff2WithNames } from '../services/musicVideo/__fontFixture.js';
import { fontContainer, fontFamilyName } from './fontMetadata.js';

describe('fontFamilyName', () => {
  const names = [[1, 1, 'Example Mac Name'], [3, 1, 'Example Sans Light'], [3, 16, 'Example Sans']];

  it('reads the typographic family, preferring it over the style-linked one', () => {
    expect(fontFamilyName(sfntWithNames(names))).toBe('Example Sans');
    expect(fontFamilyName(sfntWithNames([[1, 1, 'Plain Family']]))).toBe('Plain Family');
  });

  it('reads the name table out of a WOFF2 container', () => {
    expect(fontContainer(woff2WithNames(names))).toBe('woff2');
    expect(fontFamilyName(woff2WithNames(names))).toBe('Example Sans');
  });

  it('answers null for files that are not a readable single font', () => {
    expect(fontFamilyName(Buffer.from('not a font at all, just text'))).toBeNull();
    expect(fontFamilyName(Buffer.from('ttcf\0\0\0\0\0\0\0\0\0\0\0\0'))).toBeNull(); // a collection
    expect(fontFamilyName(sfntWithNames(names).subarray(0, 30))).toBeNull(); // truncated
    expect(fontFamilyName(woff2WithNames(names).subarray(0, 60))).toBeNull(); // corrupt brotli stream
    expect(fontFamilyName(null)).toBeNull();
  });
});
