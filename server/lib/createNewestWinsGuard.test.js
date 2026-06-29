import { describe, it, expect } from 'vitest';
import { createNewestWinsGuard } from './createNewestWinsGuard.js';

describe('createNewestWinsGuard', () => {
  it('reports an older queuedAt as stale once a newer one is marked', () => {
    const guard = createNewestWinsGuard();
    guard.mark('scene', '2026-06-29T00:00:02.000Z');
    expect(guard.isStale('scene', '2026-06-29T00:00:01.000Z')).toBe(true);
    expect(guard.isStale('scene', '2026-06-29T00:00:03.000Z')).toBe(false);
    // Equal timestamps are not stale — a re-applied render at the same instant wins.
    expect(guard.isStale('scene', '2026-06-29T00:00:02.000Z')).toBe(false);
  });

  it('treats an empty slot (nothing marked) as not stale', () => {
    const guard = createNewestWinsGuard();
    expect(guard.isStale('scene', '2026-06-29T00:00:01.000Z')).toBe(false);
  });

  it('treats an absent/null queuedAt as never stale and never records it', () => {
    const guard = createNewestWinsGuard();
    expect(guard.isStale('scene', null)).toBe(false);
    expect(guard.isStale('scene', undefined)).toBe(false);
    // Marking with no timestamp is a no-op — a later timed render still wins.
    guard.mark('scene', null);
    expect(guard.isStale('scene', '2026-06-29T00:00:01.000Z')).toBe(false);
  });

  it('keys are independent', () => {
    const guard = createNewestWinsGuard();
    guard.mark('a', '2026-06-29T00:00:05.000Z');
    expect(guard.isStale('a', '2026-06-29T00:00:01.000Z')).toBe(true);
    // A different slot is untouched.
    expect(guard.isStale('b', '2026-06-29T00:00:01.000Z')).toBe(false);
  });

  it('clear() drops all recorded slots', () => {
    const guard = createNewestWinsGuard();
    guard.mark('scene', '2026-06-29T00:00:05.000Z');
    guard.clear();
    expect(guard.isStale('scene', '2026-06-29T00:00:01.000Z')).toBe(false);
  });
});
