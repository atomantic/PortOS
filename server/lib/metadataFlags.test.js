import { describe, it, expect } from 'vitest';
import { isTruthyMeta, isFalsyMeta, sameMetaValue } from './metadataFlags.js';

describe('metadataFlags', () => {
  it.each([
    [true, true, false], ['true', true, false], [false, false, true], ['false', false, true],
    [undefined, false, false], [null, false, false], [1, false, false], ['1', false, false],
  ])('%j → truthy=%s falsy=%s', (value, truthy, falsy) => {
    expect(isTruthyMeta(value)).toBe(truthy);
    expect(isFalsyMeta(value)).toBe(falsy);
  });

  // A typed row (#16407) and a row stored before it must compare equal when they mean the same.
  it.each([
    [true, 'true', true], [3, '3', true], [null, undefined, true], [{ a: [1] }, { a: [1] }, true],
    [true, 'false', false], [3, '4', false], [null, '', false], [null, 'null', false], [{ a: 1 }, '[object Object]', false],
    [0, false, false], ['', undefined, false],
  ])('sameMetaValue(%j, %j) is %s', (a, b, same) => {
    expect(sameMetaValue(a, b)).toBe(same);
    expect(sameMetaValue(b, a)).toBe(same);
  });
});
