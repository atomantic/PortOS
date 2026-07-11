import { describe, it, expect } from 'vitest';
import {
  totalVariationCount, canonEntryHasContent, countCanonWithContent,
  renderPromptCount, scopedPromptCount,
} from './universeBuilderCounts.js';

const world = () => ({
  categories: {
    heroes: { variations: [{ label: 'a' }, { label: 'b' }] },
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
  it('counts prompt / name anchors and places slugline', () => {
    const w = world();
    expect(canonEntryHasContent(w.characters[0], 'characters')).toBe(true);
    expect(canonEntryHasContent(w.characters[1], 'characters')).toBe(false);
    expect(canonEntryHasContent(w.places[0], 'places')).toBe(true);
    // slugline is a places-only anchor — characters ignore it.
    expect(canonEntryHasContent({ slugline: 'X' }, 'characters')).toBe(false);
    expect(canonEntryHasContent(null, 'objects')).toBe(false);
  });
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
  it('counts a variation selection', () => {
    expect(scopedPromptCount(world(), { promptMode: 'variations', selection: { heroes: 'all' } })).toBe(2);
  });
  it('variations with no selection means all categories', () => {
    expect(scopedPromptCount(world(), { promptMode: 'variations' })).toBe(3);
  });
  it('sheets default to every sheet when sheetSelection omitted', () => {
    expect(scopedPromptCount(world(), { promptMode: 'sheets' })).toBe(2);
  });
  it('sheets honor a label array selection', () => {
    expect(scopedPromptCount(world(), { promptMode: 'sheets', sheetSelection: ['poster'] })).toBe(1);
  });
  it('canon selection counts only content-bearing entries', () => {
    expect(scopedPromptCount(world(), { promptMode: 'canon', canonSelection: { characters: 'all' } })).toBe(1);
  });
  it('canon with no selection renders nothing', () => {
    expect(scopedPromptCount(world(), { promptMode: 'canon' })).toBe(0);
  });
  it('all-mode sums sheets + variations + canon selections', () => {
    const scope = {
      promptMode: 'all',
      selection: { heroes: 'all' },
      canonSelection: { objects: 'all' },
    };
    // 2 sheets (default all) + 2 hero variations + 1 object canon = 5
    expect(scopedPromptCount(world(), scope)).toBe(5);
  });
});
