import { describe, it, expect } from 'vitest';
import { equalByKeys, equalListByKeys } from './compareHelpers.js';

describe('equalByKeys', () => {
  it('returns true when every listed key matches', () => {
    expect(equalByKeys(
      { status: 'ok', lastRun: '2026-05-24', extra: 1 },
      { status: 'ok', lastRun: '2026-05-24', extra: 999 },
      ['status', 'lastRun'],
    )).toBe(true);
  });

  it('returns false when a listed key differs', () => {
    expect(equalByKeys({ status: 'ok' }, { status: 'error' }, ['status'])).toBe(false);
  });

  it('ignores unlisted keys', () => {
    expect(equalByKeys({ a: 1, b: 2 }, { a: 1, b: 3 }, ['a'])).toBe(true);
  });

  it('reads dotted paths with optional chaining', () => {
    expect(equalByKeys(
      { counts: { total: 3 } },
      { counts: { total: 3 } },
      ['counts.total'],
    )).toBe(true);
    expect(equalByKeys(
      { counts: { total: 3 } },
      { counts: { total: 4 } },
      ['counts.total'],
    )).toBe(false);
  });

  it('treats a missing intermediate object as undefined (both missing = equal)', () => {
    expect(equalByKeys({}, {}, ['counts.total'])).toBe(true);
    expect(equalByKeys({ counts: { total: 1 } }, {}, ['counts.total'])).toBe(false);
  });

  it('is null/undefined-safe on the top-level objects', () => {
    expect(equalByKeys(undefined, undefined, ['total'])).toBe(true);
    expect(equalByKeys(undefined, { total: 1 }, ['total'])).toBe(false);
  });

  it('supports function keys for derived comparisons', () => {
    const normCount = (d) => d?.count ?? 1;
    expect(equalByKeys({ count: undefined }, { count: 1 }, [normCount])).toBe(true);
    expect(equalByKeys({ count: 2 }, { count: 1 }, [normCount])).toBe(false);
  });
});

describe('equalListByKeys', () => {
  it('returns true for arrays of equal length with matching items', () => {
    expect(equalListByKeys(
      [{ id: 'a', n: 1 }, { id: 'b', n: 2 }],
      [{ id: 'a', n: 1 }, { id: 'b', n: 2 }],
      ['id', 'n'],
    )).toBe(true);
  });

  it('returns false on length mismatch', () => {
    expect(equalListByKeys([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }], ['id'])).toBe(false);
  });

  it('returns false when any item differs on a key', () => {
    expect(equalListByKeys(
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'a' }, { id: 'c' }],
      ['id'],
    )).toBe(false);
  });

  it('ignores unlisted item fields', () => {
    expect(equalListByKeys(
      [{ id: 'a', mtime: 1 }],
      [{ id: 'a', mtime: 99 }],
      ['id'],
    )).toBe(true);
  });

  it('compares nested item fields via dotted paths', () => {
    expect(equalListByKeys(
      [{ id: 'a', context: { running: 2 } }],
      [{ id: 'a', context: { running: 2 } }],
      ['id', 'context.running'],
    )).toBe(true);
    expect(equalListByKeys(
      [{ id: 'a', context: { running: 2 } }],
      [{ id: 'a', context: { running: 3 } }],
      ['id', 'context.running'],
    )).toBe(false);
  });

  it('falls back to reference identity for non-arrays', () => {
    expect(equalListByKeys(null, null, ['id'])).toBe(true);
    expect(equalListByKeys(undefined, undefined, ['id'])).toBe(true);
    expect(equalListByKeys(null, [{ id: 'a' }], ['id'])).toBe(false);
    expect(equalListByKeys([{ id: 'a' }], null, ['id'])).toBe(false);
    // distinct non-array objects are NOT structurally equal — identity only,
    // so a real change can't be silently deduped away
    expect(equalListByKeys({}, {}, ['id'])).toBe(false);
    expect(equalListByKeys({ id: 'a' }, { id: 'a' }, ['id'])).toBe(false);
    // the same reference compares equal
    const shared = { id: 'a' };
    expect(equalListByKeys(shared, shared, ['id'])).toBe(true);
  });

  it('treats two empty arrays as equal', () => {
    expect(equalListByKeys([], [], ['id'])).toBe(true);
  });
});
