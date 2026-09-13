import { describe, it, expect } from 'vitest';
import { withUnlistedOption } from './withUnlistedOption';

describe('withUnlistedOption', () => {
  const list = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];

  it('returns the list unchanged when value is blank', () => {
    expect(withUnlistedOption(list, '', (id) => ({ id, label: id }))).toBe(list);
    expect(withUnlistedOption(list, null, (id) => ({ id, label: id }))).toBe(list);
    expect(withUnlistedOption(list, undefined, (id) => ({ id, label: id }))).toBe(list);
  });

  it('returns the list unchanged when value is already present', () => {
    expect(withUnlistedOption(list, 'b', (id) => ({ id, label: id }))).toBe(list);
  });

  it('prepends a synthetic option when value is missing from the list', () => {
    const result = withUnlistedOption(list, 'stale', (id) => ({ id, label: `${id} (unavailable)` }));
    expect(result).toEqual([{ id: 'stale', label: 'stale (unavailable)' }, ...list]);
  });

  it('matches on a custom key instead of the id default', () => {
    const named = [{ name: 'alpha' }, { name: 'beta' }];
    expect(withUnlistedOption(named, 'alpha', (name) => ({ name }), { key: 'name' })).toBe(named);
    expect(withUnlistedOption(named, 'gamma', (name) => ({ name }), { key: 'name' }))
      .toEqual([{ name: 'gamma' }, ...named]);
  });

  it('never mutates the input list', () => {
    const original = [...list];
    withUnlistedOption(list, 'stale', (id) => ({ id }));
    expect(list).toEqual(original);
  });
});
