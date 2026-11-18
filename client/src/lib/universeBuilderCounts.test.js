// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { compilePrompts, synthesizeCanonPrompt } from '../../../server/services/universeBuilder/compile.js';
import {
  totalVariationCount, canonEntryHasContent, countCanonWithContent,
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
    ['default variations', {}, 3],
    ['selected variation category', { selection: { heroes_and_villains: 'all' } }, 2],
    ['normalized category and case-insensitive labels', { selection: { 'Heroes & Villains': ['ARC'] } }, 1],
    ['category aliases use the last selection', { selection: { heroes_and_villains: 'all', 'Heroes & Villains': ['ARC'] } }, 1],
    ['empty normalized category is ignored', { selection: { '!!!': 'all' } }, 0],
    ['default sheets', { promptMode: 'sheets' }, 2],
    ['selected sheets', { promptMode: 'sheets', sheetSelection: ['poster'] }, 1],
    ['canon without selection', { promptMode: 'canon' }, 0],
    ['canon with an empty-seed entry', { promptMode: 'canon', canonSelection: { characters: 'all' } }, 1],
    ['canon selected by slugline', { promptMode: 'canon', canonSelection: { places: ['the-rift'] } }, 1],
    ['combined selection with default sheets', {
      promptMode: 'all',
      selection: { heroes_and_villains: 'all' },
      canonSelection: { objects: 'all' },
    }, 5],
    ['combined selection', {
      promptMode: 'all',
      selection: { 'Heroes & Villains': 'all' },
      sheetSelection: ['sheet'],
      canonSelection: { objects: 'all' },
    }, 4],
  ])('counts %s like the server', (_label, scope, expected) => {
    const w = world();
    const compiledCount = compilePrompts(w, scope).length;
    expect(compiledCount).toBe(expected);
    expect(scopedPromptCount(w, scope)).toBe(compiledCount);
  });
});

describe('Universe Builder server canon seed parity', () => {
  it.each([
    ['characters', { prompt: 'An explorer' }, true],
    ['characters', { name: 'Nova' }, true],
    ['characters', { slugline: 'X' }, false],
    ['characters', { name: ' ', prompt: ' ' }, false],
    ['places', { slugline: 'THE-RIFT' }, true],
    ['objects', { description: 'Brushed brass' }, true],
    ['objects', null, false],
  ])('matches canon seed presence for %s with %j', (kind, entry, expected) => {
    const hasSeed = Boolean(synthesizeCanonPrompt(kind, entry));
    expect(hasSeed).toBe(expected);
    expect(canonEntryHasContent(entry, kind)).toBe(hasSeed);
  });
});
