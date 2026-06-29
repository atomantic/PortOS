import { describe, it, expect, vi } from 'vitest';
import { evictOldest, ORPHAN_BUFFER_MAX } from './boundedMap.js';

describe('evictOldest', () => {
  it('is a no-op when the map is within budget', () => {
    const m = new Map([['a', 1], ['b', 2]]);
    expect(evictOldest(m, 2)).toBe(0);
    expect([...m.keys()]).toEqual(['a', 'b']);
  });

  it('evicts oldest-first until size <= max', () => {
    const m = new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
    expect(evictOldest(m, 2)).toBe(2);
    // 'a' and 'b' were inserted first → evicted; newest two survive.
    expect([...m.keys()]).toEqual(['c', 'd']);
  });

  it('treats a delete()+set() refresh as LRU — refreshed key survives', () => {
    const m = new Map([['a', 1], ['b', 2], ['c', 3]]);
    // Touch 'a': move it to the newest position.
    m.delete('a');
    m.set('a', 11);
    evictOldest(m, 2);
    // 'b' is now the oldest and is evicted; 'a' survives despite being inserted first.
    expect([...m.keys()]).toEqual(['c', 'a']);
  });

  it('invokes onEvict(key) for each removed key, after the map delete', () => {
    const m = new Map([['a', 1], ['b', 2], ['c', 3]]);
    const seen = [];
    evictOldest(m, 1, (key) => {
      seen.push(key);
      expect(m.has(key)).toBe(false); // already removed from the main map
    });
    expect(seen).toEqual(['a', 'b']);
    expect([...m.keys()]).toEqual(['c']);
  });

  it('returns 0 and does nothing for an empty map', () => {
    const m = new Map();
    const onEvict = vi.fn();
    expect(evictOldest(m, 0, onEvict)).toBe(0);
    expect(onEvict).not.toHaveBeenCalled();
  });

  it('can drain to zero when max is 0', () => {
    const m = new Map([['a', 1], ['b', 2]]);
    expect(evictOldest(m, 0)).toBe(2);
    expect(m.size).toBe(0);
  });

  it('exposes the shared orphan-buffer cap', () => {
    expect(ORPHAN_BUFFER_MAX).toBe(64);
  });
});
