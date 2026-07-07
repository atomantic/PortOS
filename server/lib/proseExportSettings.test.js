/**
 * proseExportSettings.test.js — the per-series export-settings sanitizer +
 * resolver (#2181).
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeProseExportSettings,
  resolveExportSettings,
  TRIM_SIZES,
  INTERIOR_FONTS,
  DEFAULT_TRIM_SIZE,
  DEFAULT_INTERIOR_FONT,
} from './proseExportSettings.js';

describe('sanitizeProseExportSettings', () => {
  it('returns null for absent / non-object / all-default input', () => {
    expect(sanitizeProseExportSettings(undefined)).toBeNull();
    expect(sanitizeProseExportSettings(null)).toBeNull();
    expect(sanitizeProseExportSettings('nope')).toBeNull();
    expect(sanitizeProseExportSettings({})).toBeNull();
    // Unknown enum values collapse to null → still an empty husk → null.
    expect(sanitizeProseExportSettings({ trimSize: 'ghost', interiorFont: 'wingdings' })).toBeNull();
  });

  it('keeps valid trim size + font and drops invalid enums', () => {
    const out = sanitizeProseExportSettings({ trimSize: 'digest', interiorFont: 'courier' });
    expect(out.trimSize).toBe('digest');
    expect(out.interiorFont).toBe('courier');
    const bad = sanitizeProseExportSettings({ trimSize: 'ghost', interiorFont: 'courier' });
    expect(bad.trimSize).toBeNull();
    expect(bad.interiorFont).toBe('courier');
  });

  it('trims and bounds title-page text fields', () => {
    const out = sanitizeProseExportSettings({
      titlePageTitle: '  My Book  ',
      titlePageAuthor: 'Ada',
      copyright: '© 2026',
      dedication: 'For X.',
    });
    expect(out.titlePageTitle).toBe('My Book');
    expect(out.titlePageAuthor).toBe('Ada');
    expect(out.copyright).toBe('© 2026');
    expect(out.dedication).toBe('For X.');
    // A long title is clipped to the 200-char bound.
    const long = sanitizeProseExportSettings({ titlePageTitle: 'x'.repeat(500) });
    expect(long.titlePageTitle.length).toBe(200);
  });

  it('exposes stable allow-lists + defaults', () => {
    expect(Object.keys(TRIM_SIZES)).toContain(DEFAULT_TRIM_SIZE);
    expect(INTERIOR_FONTS).toContain(DEFAULT_INTERIOR_FONT);
    // Every trim size carries positive point dimensions.
    for (const dims of Object.values(TRIM_SIZES)) {
      expect(dims.width).toBeGreaterThan(0);
      expect(dims.height).toBeGreaterThan(0);
    }
  });
});

describe('resolveExportSettings', () => {
  it('fills blank fields from the series and applies defaults', () => {
    const r = resolveExportSettings({ name: 'Series Name', logline: 'A tale', author: 'Author' });
    expect(r.trimSize).toBe(DEFAULT_TRIM_SIZE);
    expect(r.interiorFont).toBe(DEFAULT_INTERIOR_FONT);
    expect(r.titlePageTitle).toBe('Series Name');
    expect(r.titlePageSubtitle).toBe('A tale');
    expect(r.titlePageAuthor).toBe('Author');
  });

  it('prefers explicit stored settings over series fallbacks', () => {
    const r = resolveExportSettings({
      name: 'Series Name',
      author: 'Author',
      exportSettings: { trimSize: 'a5', titlePageTitle: 'Override', titlePageAuthor: 'Other' },
    });
    expect(r.trimSize).toBe('a5');
    expect(r.titlePageTitle).toBe('Override');
    expect(r.titlePageAuthor).toBe('Other');
  });

  it('falls back to Untitled when the series has no name', () => {
    expect(resolveExportSettings({}).titlePageTitle).toBe('Untitled');
    expect(resolveExportSettings(null).titlePageTitle).toBe('Untitled');
  });
});
