import { describe, it, expect } from 'vitest';
import { deepMerge, isPlainObject, canonicalStringify } from './objects.js';

describe('isPlainObject', () => {
  it('returns true for plain `{}`-shaped values', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('returns false for null, undefined, primitives, and arrays', () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject(0)).toBe(false);
    expect(isPlainObject('')).toBe(false);
    expect(isPlainObject('hello')).toBe(false);
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject(false)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  it('returns true for class instances and Date — matches inline-call-site semantics', () => {
    // Documented contract: this is "non-null, non-array `object`", not
    // "constructor === Object". Existing call sites run against JSON.parse
    // output that never carries exotic prototypes, so the loose check is
    // intentional. Lock it in.
    expect(isPlainObject(new Date())).toBe(true);
    expect(isPlainObject(new Map())).toBe(true);
    class Foo { }
    expect(isPlainObject(new Foo())).toBe(true);
  });
});

describe('deepMerge', () => {
  it('merges nested objects recursively', () => {
    const base = { a: { b: 1, c: 2 }, d: 3 };
    const patch = { a: { c: 20, e: 30 } };
    expect(deepMerge(base, patch)).toEqual({ a: { b: 1, c: 20, e: 30 }, d: 3 });
  });

  it('overrides primitives at the patch key', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
    expect(deepMerge({ a: 'old' }, { a: 'new' })).toEqual({ a: 'new' });
    expect(deepMerge({ a: true }, { a: false })).toEqual({ a: false });
  });

  it('replaces arrays rather than merging them (canonical contract)', () => {
    expect(deepMerge({ items: [1, 2, 3] }, { items: [9] })).toEqual({ items: [9] });
    expect(deepMerge({ a: { items: [1, 2] } }, { a: { items: [] } })).toEqual({ a: { items: [] } });
  });

  it('treats null as a value override, not as object-to-recurse', () => {
    expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({ a: null });
    expect(deepMerge({ a: null }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
  });

  it('preserves base keys not mentioned in patch', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 20 })).toEqual({ a: 1, b: 20 });
  });

  it('returns base unchanged when patch is undefined', () => {
    const base = { a: 1 };
    expect(deepMerge(base, undefined)).toBe(base);
  });

  it('returns patch directly when patch is not a plain object (number, string, array)', () => {
    expect(deepMerge({ a: 1 }, 42)).toBe(42);
    expect(deepMerge({ a: 1 }, 'replace')).toBe('replace');
    const arr = [1, 2];
    expect(deepMerge({ a: 1 }, arr)).toBe(arr);
  });

  it('does not mutate the base object', () => {
    const base = { a: { b: 1 } };
    const snapshot = JSON.parse(JSON.stringify(base));
    deepMerge(base, { a: { c: 2 } });
    expect(base).toEqual(snapshot);
  });

  it('handles missing base keys cleanly when patch has nested objects', () => {
    // base.a doesn't exist; patch.a is an object — should land verbatim
    expect(deepMerge({}, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });

  it('treats a missing/null/non-object base as an empty object', () => {
    // `base?.[k]` recursion guard already tolerated missing bases — formalize
    // it for the top-level so callers can pass `deepMerge(saved ?? null, patch)`
    // without a TypeError when saved was never written.
    expect(deepMerge(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge(null, { a: 1, b: { c: 2 } })).toEqual({ a: 1, b: { c: 2 } });
    expect(deepMerge(42, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge('string', { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge([1, 2], { a: 1 })).toEqual({ a: 1 });
  });
});

describe('canonicalStringify', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = canonicalStringify({ b: 1, a: 2, c: 3 });
    const b = canonicalStringify({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('sorts keys recursively in nested objects', () => {
    const a = canonicalStringify({ outer: { z: 1, a: 2 }, first: true });
    const b = canonicalStringify({ first: true, outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array order (order is semantic for arrays)', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalStringify([1, 2, 3])).not.toBe(canonicalStringify([3, 2, 1]));
  });

  it('serializes primitives via native JSON rules', () => {
    expect(canonicalStringify('hi')).toBe('"hi"');
    expect(canonicalStringify(42)).toBe('42');
    expect(canonicalStringify(true)).toBe('true');
    expect(canonicalStringify(null)).toBe('null');
  });

  it('drops undefined / function values inside objects (matches JSON.stringify)', () => {
    expect(canonicalStringify({ a: 1, b: undefined, c: () => {} })).toBe('{"a":1}');
  });

  it('serializes undefined array elements as null (matches JSON.stringify)', () => {
    expect(canonicalStringify([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('serializes SPARSE-array holes as null, not invalid JSON (matches JSON.stringify)', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 2];
    expect(canonicalStringify(sparse)).toBe('[1,null,2]');
    expect(canonicalStringify(sparse)).toBe(JSON.stringify(sparse));
  });

  it('handles nested arrays of objects with sorted keys', () => {
    const a = canonicalStringify({ items: [{ y: 1, x: 2 }] });
    const b = canonicalStringify({ items: [{ x: 2, y: 1 }] });
    expect(a).toBe(b);
  });

  it('serializes a Date via native JSON rules (toJSON → ISO), not {} (matches JSON.stringify)', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    expect(canonicalStringify(d)).toBe(JSON.stringify(d));
    expect(canonicalStringify(d)).toBe('"2026-01-02T03:04:05.000Z"');
  });

  it('serializes a nested Date value through native rules', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    expect(canonicalStringify({ when: d })).toBe('{"when":"2026-01-02T03:04:05.000Z"}');
  });

  it('still key-sorts an Object.create(null) value (prototype null is canonical-sortable)', () => {
    const o = Object.create(null);
    o.b = 1; o.a = 2;
    expect(canonicalStringify(o)).toBe('{"a":2,"b":1}');
  });

  it('serializes a class instance with toJSON via native rules (not key-sorted own props)', () => {
    class Box { constructor() { this.z = 1; this.a = 2; } toJSON() { return { tag: 'box' }; } }
    expect(canonicalStringify(new Box())).toBe(JSON.stringify(new Box()));
    expect(canonicalStringify(new Box())).toBe('{"tag":"box"}');
  });
});
