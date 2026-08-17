import { describe, it, expect } from 'vitest';
import { sameJsonShape } from './sameJsonShape.js';

describe('sameJsonShape', () => {
  it('returns true for structurally equal small objects', () => {
    expect(sameJsonShape({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
  });

  it('returns true for nested equal objects', () => {
    expect(sameJsonShape(
      { counts: { a: 1, b: 2 }, lastDigest: '2026-05-21' },
      { counts: { a: 1, b: 2 }, lastDigest: '2026-05-21' },
    )).toBe(true);
  });

  it('returns false when a leaf value differs', () => {
    expect(sameJsonShape({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('returns false when a key is added or removed', () => {
    expect(sameJsonShape({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameJsonShape({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('treats null and undefined as different', () => {
    expect(sameJsonShape({ a: null }, { a: undefined })).toBe(false);
  });

  it('treats two nulls as equal', () => {
    expect(sameJsonShape(null, null)).toBe(true);
  });
});
// @vitest-environment node
