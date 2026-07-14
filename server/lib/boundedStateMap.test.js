import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBoundedStateMap } from './boundedStateMap.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createBoundedStateMap', () => {
  it('behaves like a Map for get/set/has/delete/size', () => {
    const m = createBoundedStateMap();
    expect(m.has('a')).toBe(false);
    expect(m.get('a')).toBeUndefined();
    m.set('a', { v: 1 });
    expect(m.has('a')).toBe(true);
    expect(m.get('a')).toEqual({ v: 1 });
    expect(m.size).toBe(1);
    expect(m.delete('a')).toBe(true);
    expect(m.delete('a')).toBe(false);
    expect(m.size).toBe(0);
  });

  it('preserves in-place mutations of stored objects', () => {
    const m = createBoundedStateMap();
    m.set('a', { count: 0 });
    m.get('a').count += 1;
    expect(m.get('a').count).toBe(1);
  });

  it('evicts entries idle longer than ttlMs on the next write', () => {
    vi.useFakeTimers();
    const m = createBoundedStateMap({ ttlMs: 1000 });
    m.set('old', 1);
    vi.advanceTimersByTime(1500); // 'old' is now stale
    m.set('new', 2); // triggers the lazy sweep
    expect(m.has('old')).toBe(false);
    expect(m.has('new')).toBe(true);
    expect(m.size).toBe(1);
  });

  it('get() refreshes recency so an actively-used key survives the TTL sweep', () => {
    vi.useFakeTimers();
    const m = createBoundedStateMap({ ttlMs: 1000 });
    m.set('a', 1);
    vi.advanceTimersByTime(800);
    m.get('a'); // touch — resets lastAccess
    vi.advanceTimersByTime(800); // 1600ms since set, but only 800ms since touch
    m.set('b', 2); // sweep runs
    expect(m.has('a')).toBe(true);
  });

  it('enforces the LRU cap, shedding the least-recently accessed entries', () => {
    // Fake timers so each access gets a distinct timestamp — otherwise
    // same-millisecond ties make the eviction order ambiguous. ttl large so
    // only the size cap can evict.
    vi.useFakeTimers();
    const m = createBoundedStateMap({ maxSize: 3, ttlMs: 60 * 60 * 1000 });
    m.set('a', 1);
    vi.advanceTimersByTime(10);
    m.set('b', 2);
    vi.advanceTimersByTime(10);
    m.set('c', 3);
    vi.advanceTimersByTime(10);
    m.get('a'); // 'a' most recently used; 'b' now the oldest
    vi.advanceTimersByTime(10);
    m.set('d', 4); // over cap → evict least-recently accessed ('b')
    expect(m.size).toBe(3);
    expect(m.has('b')).toBe(false);
    expect(m.has('a')).toBe(true);
    expect(m.has('c')).toBe(true);
    expect(m.has('d')).toBe(true);
  });

  it('clear() empties the map', () => {
    const m = createBoundedStateMap();
    m.set('a', 1);
    m.set('b', 2);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.has('a')).toBe(false);
  });
});
