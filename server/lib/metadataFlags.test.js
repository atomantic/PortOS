import { describe, it, expect } from 'vitest';
import { isTruthyMeta, isFalsyMeta } from './metadataFlags.js';

describe('metadataFlags', () => {
  it.each([
    [true, true, false], ['true', true, false], [false, false, true], ['false', false, true],
    [undefined, false, false], [null, false, false], [1, false, false], ['1', false, false],
  ])('%j → truthy=%s falsy=%s', (value, truthy, falsy) => {
    expect(isTruthyMeta(value)).toBe(truthy);
    expect(isFalsyMeta(value)).toBe(falsy);
  });
});
