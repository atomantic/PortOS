import { describe, it, expect } from 'vitest';
import {
  VISUAL_STYLES,
  getVisualStyle,
  sanitizeVisualStyleRef,
  resolveVisualStyle,
  listVisualStyles,
} from './visualStyles.js';

describe('visualStyles — catalog shape invariants', () => {
  it('catalog is a non-empty frozen array', () => {
    expect(Array.isArray(VISUAL_STYLES)).toBe(true);
    expect(VISUAL_STYLES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(VISUAL_STYLES)).toBe(true);
  });

  it('every entry has id, name, description, and a non-empty promptFragment', () => {
    for (const s of VISUAL_STYLES) {
      expect(typeof s.id).toBe('string');
      expect(s.id.length).toBeGreaterThan(0);
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.description).toBe('string');
      expect(typeof s.promptFragment).toBe('string');
      expect(s.promptFragment.trim().length).toBeGreaterThan(0);
    }
  });

  it('ids are unique', () => {
    const ids = VISUAL_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes a graphic-novel preset for the comic-pages default', () => {
    expect(VISUAL_STYLES.some((s) => s.id === 'graphic-novel')).toBe(true);
  });

  it('listVisualStyles returns a plain (non-frozen) copy', () => {
    const list = listVisualStyles();
    expect(Object.isFrozen(list)).toBe(false);
    expect(list.length).toBe(VISUAL_STYLES.length);
  });
});

describe('visualStyles — getVisualStyle', () => {
  it('returns the catalog entry for a known id', () => {
    const s = getVisualStyle('graphic-novel');
    expect(s).toBeTruthy();
    expect(s.id).toBe('graphic-novel');
  });

  it('returns null for unknown / empty / non-string ids', () => {
    expect(getVisualStyle('does-not-exist')).toBe(null);
    expect(getVisualStyle('')).toBe(null);
    expect(getVisualStyle(null)).toBe(null);
    expect(getVisualStyle(undefined)).toBe(null);
    expect(getVisualStyle(42)).toBe(null);
  });
});

describe('visualStyles — sanitizeVisualStyleRef', () => {
  it('returns null for null / undefined / non-objects', () => {
    expect(sanitizeVisualStyleRef(null)).toBe(null);
    expect(sanitizeVisualStyleRef(undefined)).toBe(null);
    expect(sanitizeVisualStyleRef('graphic-novel')).toBe(null);
    expect(sanitizeVisualStyleRef(42)).toBe(null);
  });

  it('drops unknown ids but keeps customPrompt', () => {
    const out = sanitizeVisualStyleRef({ id: 'does-not-exist', customPrompt: 'foo' });
    expect(out).toEqual({ id: null, customPrompt: 'foo' });
  });

  it('returns null when both id and customPrompt are empty', () => {
    expect(sanitizeVisualStyleRef({ id: '', customPrompt: '' })).toBe(null);
    expect(sanitizeVisualStyleRef({ id: 'unknown', customPrompt: '   ' })).toBe(null);
  });

  it('keeps a valid id with no customPrompt', () => {
    expect(sanitizeVisualStyleRef({ id: 'graphic-novel' })).toEqual({
      id: 'graphic-novel', customPrompt: null,
    });
  });

  it('trims customPrompt and caps at 2000 chars', () => {
    const long = 'x'.repeat(3000);
    const out = sanitizeVisualStyleRef({ id: 'cinematic', customPrompt: `  ${long}  ` });
    expect(out.customPrompt.length).toBe(2000);
    expect(out.id).toBe('cinematic');
  });
});

describe('visualStyles — resolveVisualStyle priority', () => {
  const series = { visualStyleDefault: { id: 'cinematic' } };
  const issueWithOverride = {
    stages: { comicPages: { visualStyleOverride: { id: 'anime' } } },
  };
  const issueWithoutOverride = { stages: { comicPages: {} } };

  it('uses stage override when present', () => {
    const r = resolveVisualStyle(series, issueWithOverride, 'comicPages');
    expect(r.id).toBe('anime');
  });

  it('falls back to series default when no override', () => {
    const r = resolveVisualStyle(series, issueWithoutOverride, 'comicPages');
    expect(r.id).toBe('cinematic');
  });

  it('falls back to stage catalog default when neither override nor series default', () => {
    const r = resolveVisualStyle({}, { stages: { comicPages: {} } }, 'comicPages');
    expect(r.id).toBe('graphic-novel');
  });

  it('storyboards defaults to cinematic when nothing is set', () => {
    const r = resolveVisualStyle({}, {}, 'storyboards');
    expect(r.id).toBe('cinematic');
  });

  it('episodeVideo defaults to cinematic when nothing is set', () => {
    const r = resolveVisualStyle({}, {}, 'episodeVideo');
    expect(r.id).toBe('cinematic');
  });

  it('returns null when stageId has no fallback and nothing is configured', () => {
    expect(resolveVisualStyle({}, {}, 'unknown-stage')).toBe(null);
  });

  it('appends customPrompt onto the catalog promptFragment', () => {
    const r = resolveVisualStyle(
      { visualStyleDefault: { id: 'graphic-novel', customPrompt: 'extra ink weight' } },
      {},
      'comicPages',
    );
    expect(r.promptFragment).toMatch(/halftone/);
    expect(r.promptFragment).toMatch(/extra ink weight/);
  });

  it('handles customPrompt-only refs (id: null)', () => {
    const r = resolveVisualStyle(
      { visualStyleDefault: { id: null, customPrompt: 'noir-leaning watercolor' } },
      {},
      'comicPages',
    );
    expect(r.id).toBe(null);
    expect(r.name).toBe('Custom');
    expect(r.promptFragment).toBe('noir-leaning watercolor');
  });
});
