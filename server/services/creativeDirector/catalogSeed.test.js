import { describe, it, expect } from 'vitest';
import { buildCastFromIngredients } from './catalogSeed.js';

describe('buildCastFromIngredients (#1808)', () => {
  it('maps catalog types to CD ref roles', () => {
    const cast = buildCastFromIngredients([
      { id: 'c1', name: 'Mara', type: 'character', payload: {} },
      { id: 'p1', name: 'The Spire', type: 'place', payload: {} },
      { id: 'o1', name: 'Brass Key', type: 'object', payload: {} },
      { id: 's1', name: 'The Reveal', type: 'scene', payload: {} },
      { id: 'i1', name: 'Loose idea', type: 'idea', payload: {} },
    ]);
    expect(cast.map((m) => [m.type, m.role])).toEqual([
      ['character', 'cast'],
      ['place', 'location'],
      ['object', 'prop'],
      ['scene', 'scene'],
      ['idea', 'reference'], // unmapped → generic reference
    ]);
  });

  it('carries the stable ingredientId and a display name', () => {
    const [member] = buildCastFromIngredients([{ id: 'c1', name: ' Mara ', type: 'character', payload: {} }]);
    expect(member.ingredientId).toBe('c1');
    expect(member.name).toBe('Mara'); // trimmed
  });

  it('falls back to (untitled) for a blank name', () => {
    const [member] = buildCastFromIngredients([{ id: 'c1', name: '   ', type: 'character', payload: {} }]);
    expect(member.name).toBe('(untitled)');
  });

  it('omits summary when the payload yields nothing', () => {
    const [member] = buildCastFromIngredients([{ id: 'c1', name: 'Mara', type: 'character', payload: {} }]);
    expect(member).not.toHaveProperty('summary');
  });

  it('includes a summary derived from the payload when present', () => {
    const [member] = buildCastFromIngredients([
      { id: 'c1', name: 'Mara', type: 'character', payload: { physicalDescription: 'A tall figure in a grey coat.' } },
    ]);
    expect(member.summary).toContain('grey coat');
  });

  it('skips records without an id and caps at 50 members', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, name: `N${i}`, type: 'character', payload: {} }));
    const cast = buildCastFromIngredients([{ name: 'no id', type: 'character', payload: {} }, ...many]);
    expect(cast).toHaveLength(50);
    expect(cast.every((m) => m.ingredientId)).toBe(true);
  });

  it('returns [] for non-array / empty input', () => {
    expect(buildCastFromIngredients(null)).toEqual([]);
    expect(buildCastFromIngredients(undefined)).toEqual([]);
    expect(buildCastFromIngredients([])).toEqual([]);
  });
});
