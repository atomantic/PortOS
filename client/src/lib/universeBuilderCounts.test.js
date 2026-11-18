// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  totalVariationCount, countCanonWithContent,
  renderPromptCount, scopedPromptCount,
} from './universeBuilderCounts.js';

const world = () => ({
  categories: {
    heroes_and_villains: { variations: [{ label: 'Arc' }, { label: 'Rival' }] },
    cities: { variations: [{ label: 'c' }] },
  },
  compositeSheets: [{ label: 'Poster' }, { label: 'Sheet' }],
  characters: [
    { name: 'Nova', prompt: 'A drifter.' },
    { name: '' }, // no anchor, no content → skipped
  ],
  places: [
    { slugline: 'THE-RIFT' }, // places allow slugline-only
  ],
  objects: [
    { prompt: 'A brass sextant.' },
  ],
});

describe('universeBuilderCounts — totalVariationCount', () => {
  it('sums variations across buckets', () => {
    expect(totalVariationCount(world())).toBe(3);
  });
  it('tolerates missing categories', () => {
    expect(totalVariationCount({})).toBe(0);
    expect(totalVariationCount(undefined)).toBe(0);
  });
});

describe('universeBuilderCounts — canon content', () => {
  it('countCanonWithContent filters empty-seed entries', () => {
    const w = world();
    expect(countCanonWithContent(w, 'characters')).toBe(1);
    expect(countCanonWithContent(w, 'places')).toBe(1);
    expect(countCanonWithContent(w, 'objects')).toBe(1);
  });
});

describe('universeBuilderCounts — renderPromptCount', () => {
  it('modes cover variations / sheets / canon / all', () => {
    const w = world();
    expect(renderPromptCount(w, 'variations')).toBe(3);
    expect(renderPromptCount(w, 'sheets')).toBe(2);
    expect(renderPromptCount(w, 'canon')).toBe(3);
    expect(renderPromptCount(w, 'all')).toBe(3 + 2 + 3);
  });
});

describe('universeBuilderCounts — scopedPromptCount', () => {
  it('returns 0 for a null scope', () => {
    expect(scopedPromptCount(world(), null)).toBe(0);
  });
  it.each([
    ['normalizes category keys and matches labels case-insensitively', { 'Heroes & Villains': ['ARC'] }, 1],
    ['uses the last selection for category aliases', { heroes_and_villains: 'all', 'Heroes & Villains': ['ARC'] }, 1],
    ['skips keys that normalize to an empty category', { '!!!': 'all' }, 0],
  ])('%s', (_label, selection, expected) => {
    expect(scopedPromptCount(world(), { selection })).toBe(expected);
  });
});
