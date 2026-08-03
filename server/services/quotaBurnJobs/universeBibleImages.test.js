import { describe, expect, it } from 'vitest';
import { buildRenderSelection, findMissingImageEntries } from './universeBibleImages.js';

const universe = {
  id: 'u1',
  name: 'Example Universe',
  categories: {
    landscapes: {
      variations: [
        { id: 'v1', label: 'Salt Flats', imageRefs: [] },
        { id: 'v2', label: 'Rendered Ridge', imageRefs: ['ridge.png'] },
      ],
    },
  },
  compositeSheets: [{ id: 's1', label: 'Cast Sheet' }],
  characters: [
    { id: 'c1', name: 'Alice', imageRefs: [] },
    { id: 'c2', name: 'Bob', imageRefs: ['bob.png'] },
  ],
  places: [{ id: 'p1', slugline: 'EXT. FOUNDRY — DAY' }],
  objects: [],
};

describe('findMissingImageEntries', () => {
  it('returns only entries whose imageRefs are empty', () => {
    const rows = findMissingImageEntries(universe);
    expect(rows.map((row) => row.label)).toEqual(['Salt Flats', 'Cast Sheet', 'Alice', 'EXT. FOUNDRY — DAY']);
  });

  it('falls back to a place\'s slugline, matching what compilePrompts selects on', () => {
    // A canon place may carry ONLY a slugline. Keying on `name` alone would make
    // those entries permanently unselectable — they would show as pending
    // forever and never render.
    const rows = findMissingImageEntries(universe, { scope: 'canon' });
    expect(rows.some((row) => row.label === 'EXT. FOUNDRY — DAY')).toBe(true);
  });

  it('honors a narrowed scope', () => {
    expect(findMissingImageEntries(universe, { scope: 'variations' }).map((r) => r.label)).toEqual(['Salt Flats']);
    expect(findMissingImageEntries(universe, { scope: 'sheets' }).map((r) => r.label)).toEqual(['Cast Sheet']);
  });

  it('tolerates an empty or malformed universe', () => {
    expect(findMissingImageEntries(null)).toEqual([]);
    expect(findMissingImageEntries({})).toEqual([]);
  });
});

describe('buildRenderSelection', () => {
  it('splits rows back into the three shapes compilePrompts reads', () => {
    expect(buildRenderSelection(findMissingImageEntries(universe))).toEqual({
      selection: { landscapes: ['Salt Flats'] },
      canonSelection: { characters: ['Alice'], places: ['EXT. FOUNDRY — DAY'] },
      sheetSelection: ['Cast Sheet'],
    });
  });
});
