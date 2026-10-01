import { describe, expect, it } from 'vitest';
import { applySheetPointer, applySheetPointerToCharacter, listSheetPointers, readSheetPointer } from './sheetPointers.js';

describe('persisted reference-sheet layout', () => {
  it('round-trips both legacy and named sheets without mutating the canon snapshot', () => {
    const original = { id: 'character-example', referenceSheets: { profile: 'profile.png' } };
    const standard = applySheetPointerToCharacter(original, 'standard', 'standard.png');
    const blueprint = applySheetPointerToCharacter(standard, 'blueprint', 'blueprint.png');
    expect(original).toEqual({ id: 'character-example', referenceSheets: { profile: 'profile.png' } });
    expect(readSheetPointer(blueprint, 'standard')).toBe('standard.png');
    expect(readSheetPointer(blueprint, 'blueprint')).toBe('blueprint.png');
    expect(readSheetPointer(blueprint, 'unknown')).toBeNull();
    expect(listSheetPointers(blueprint)).toEqual([
      { variant: 'standard', filename: 'standard.png' },
      { variant: 'profile', filename: 'profile.png' },
      { variant: 'blueprint', filename: 'blueprint.png' },
    ]);
    const cleared = applySheetPointerToCharacter(applySheetPointerToCharacter(blueprint, 'standard', null), 'blueprint', null);
    expect(listSheetPointers(cleared)).toEqual([{ variant: 'profile', filename: 'profile.png' }]);
    expect(cleared.referenceSheets).not.toHaveProperty('blueprint');
  });

  it('keeps the same snapshot for repeated writes and already-cleared slots', () => {
    const character = { referenceSheetImageRef: 'standard.png', referenceSheets: { profile: 'profile.png' } };
    expect(applySheetPointerToCharacter(character, 'standard', 'standard.png')).toBe(character);
    expect(applySheetPointerToCharacter(character, 'profile', 'profile.png')).toBe(character);
    expect(applySheetPointerToCharacter(character, 'unknown', null)).toBe(character);
    const empty = {};
    expect(applySheetPointerToCharacter(empty, 'standard', null)).toBe(empty);
  });

  it('preserves the browser default variant without changing the server variant contract', () => {
    const character = { referenceSheetImageRef: 'standard.png' };
    expect(applySheetPointer(character, undefined, 'standard.png')).toBe(character);
    expect(applySheetPointer({}, '', 'standard.png')).toEqual({ referenceSheetImageRef: 'standard.png' });
    expect(applySheetPointerToCharacter({}, '', 'named.png')).toEqual({ referenceSheets: { '': 'named.png' } });
  });

  it('tolerates absent characters and malformed persisted map slots', () => {
    expect(readSheetPointer(null, 'standard')).toBeNull();
    expect(listSheetPointers(null)).toEqual([]);
    expect(applySheetPointerToCharacter(null, 'standard', 'sheet.png')).toBeNull();
    const character = { referenceSheets: ['not-a-map'] };
    expect(readSheetPointer(character, 'profile')).toBeNull();
    expect(listSheetPointers(character)).toEqual([]);
    expect(applySheetPointerToCharacter(character, 'profile', 'profile.png')).toEqual({ referenceSheets: { profile: 'profile.png' } });
  });
});
