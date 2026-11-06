import { describe, expect, it, vi } from 'vitest';
import { loadMusicVideoSubjectSizes } from './subjectScale.js';

// Uniquely catches a shot's scale chip reading the wrong age's height or losing
// a place's or prop's size on the way from Casting.
describe('loadMusicVideoSubjectSizes', () => {
  const records = {
    'cat-kid': { type: 'character', payload: { age: '30', stats: [{ label: 'Height', value: '5 ft 6 in tall' }], forms: [{ id: 'form-aaaaaaaa', label: 'Age 7', age: '7' }] } },
    'cat-adult': { type: 'character', payload: { stats: [{ label: 'Height', value: '6 ft 1 in' }] } },
    'cat-bike': { type: 'object', payload: { size: 'handlebars 3 ft 4 in tall' } },
    'cat-gone': { type: 'object', deleted: true, payload: { size: '1 ft' } },
  };
  const catalog = { getIngredient: vi.fn(async (id) => {
    if (id === 'cat-fail') throw new Error('offline');
    return records[id] || null;
  }) };

  it('reads each subject\'s height or size live, the linked age first', async () => {
    const project = {
      concept: { subjects: [
        { id: 'k7', kind: 'character', name: 'Example Kid', ingredientId: 'cat-kid', castForm: { id: 'form-aaaaaaaa', label: 'Age 7', age: 7 } },
        { id: 'k30', kind: 'character', name: 'Example Kid grown', ingredientId: 'cat-kid' },
        { id: 'ad', kind: 'character', name: 'Example Dad', ingredientId: 'cat-adult' },
        { id: 'bk', kind: 'object', name: 'Example bike', ingredientId: 'cat-bike' },
        { id: 'gn', kind: 'object', name: 'Example gone', ingredientId: 'cat-gone' },
        { id: 'fl', kind: 'object', name: 'Example offline', ingredientId: 'cat-fail' },
        { id: 'cs', kind: 'character', name: 'Example Stranger' },
      ] },
      castAndSets: { direction: { cast: [{ id: 'c1', name: 'example stranger', height: '5 ft 2 in' }] } },
    };
    const sizes = await loadMusicVideoSubjectSizes(project, { catalog });
    expect(sizes).toEqual({
      k7: 'about 4 ft (122 cm)',
      k30: '5 ft 6 in',
      ad: '6 ft 1 in',
      bk: 'handlebars 3 ft 4 in tall',
      cs: '5 ft 2 in',
    });
    expect(catalog.getIngredient).toHaveBeenCalledTimes(5);
  });
});
