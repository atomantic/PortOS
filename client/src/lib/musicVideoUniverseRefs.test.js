import { describe, it, expect } from 'vitest';
import { pullUniverseCanonReferences, MUSIC_VIDEO_MAX_REFERENCES } from './musicVideoUniverseRefs.js';

describe('pullUniverseCanonReferences', () => {
  it('maps characters/places/objects to character/set/prop references, preferring primaryImageRef over imageRefs[0]', () => {
    const universe = {
      characters: [
        { id: 'c1', name: 'Nyra', primaryImageRef: 'nyra-primary.png', imageRefs: ['nyra-other.png'] },
        { id: 'c2', name: 'No Image' }, // no image at all — nothing to pull
      ],
      places: [{ id: 'p1', name: 'Harbor', imageRefs: ['harbor.png'] }],
      objects: [{ id: 'o1', name: 'Lantern', primaryImageRef: 'lantern.png' }],
    };
    const { next, added, skipped } = pullUniverseCanonReferences(universe, []);
    expect(added).toBe(3);
    expect(skipped).toBe(1); // 'No Image' has neither primaryImageRef nor imageRefs
    expect(next).toEqual([
      { id: expect.any(String), imageId: 'nyra-primary.png', role: 'character', label: 'Nyra', condition: false },
      { id: expect.any(String), imageId: 'harbor.png', role: 'set', label: 'Harbor', condition: false },
      { id: expect.any(String), imageId: 'lantern.png', role: 'prop', label: 'Lantern', condition: false },
    ]);
    // Every pulled reference gets its OWN id — sharing one (e.g. all
    // `undefined`) would make VisualSpecPanel's by-id edit/remove handlers
    // treat several rows as a single one until the server round-trips ids.
    expect(new Set(next.map((r) => r.id)).size).toBe(3);
  });

  it('is idempotent: an image already present as a reference is skipped, not duplicated', () => {
    const universe = { characters: [{ id: 'c1', name: 'Nyra', primaryImageRef: 'nyra.png' }], places: [], objects: [] };
    const existing = [{ id: 'r0', imageId: 'nyra.png', role: 'character', condition: false }];
    const { next, added, skipped } = pullUniverseCanonReferences(universe, existing);
    expect(added).toBe(0);
    expect(skipped).toBe(1);
    expect(next).toBe(existing); // unchanged reference — no-op save
  });

  it('two canon entries sharing one image only add it once', () => {
    const universe = {
      characters: [
        { id: 'c1', name: 'Twin A', primaryImageRef: 'shared.png' },
        { id: 'c2', name: 'Twin B', primaryImageRef: 'shared.png' },
      ],
      places: [], objects: [],
    };
    const { next, added } = pullUniverseCanonReferences(universe, []);
    expect(added).toBe(1);
    expect(next).toHaveLength(1);
  });

  it('respects the 24-reference cap, reporting the overflow as skipped', () => {
    const characters = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: `Char ${i}`, primaryImageRef: `char-${i}.png` }));
    const universe = { characters, places: [], objects: [] };
    // 20 existing references already fill most of the 24-cap; room for only 4 more.
    const existing = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, imageId: `existing-${i}.png`, role: 'mood', condition: false }));
    const { next, added, skipped } = pullUniverseCanonReferences(universe, existing);
    expect(added).toBe(4);
    expect(skipped).toBe(16);
    expect(next).toHaveLength(MUSIC_VIDEO_MAX_REFERENCES);
  });

  it('truncates an overlong canon name to the 120-char reference label limit', () => {
    const longName = 'X'.repeat(200);
    const universe = { characters: [{ id: 'c1', name: longName, primaryImageRef: 'c.png' }], places: [], objects: [] };
    const { next } = pullUniverseCanonReferences(universe, []);
    expect(next[0].label).toHaveLength(120);
  });
});
