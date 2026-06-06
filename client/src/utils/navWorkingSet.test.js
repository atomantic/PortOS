import { describe, it, expect } from 'vitest';
import {
  RECENT_KEY, PINNED_KEY, RECENT_CAP,
  recordVisit, togglePin, isPinned,
} from './navWorkingSet.js';

describe('navWorkingSet — constants', () => {
  it('exposes stable localStorage keys and a cap of 5', () => {
    expect(RECENT_KEY).toBe('portos-nav-recent');
    expect(PINNED_KEY).toBe('portos-nav-pinned');
    expect(RECENT_CAP).toBe(5);
  });
});

describe('recordVisit', () => {
  it('prepends a new path most-recent-first', () => {
    expect(recordVisit('/b', ['/a'])).toEqual(['/b', '/a']);
  });

  it('dedups — moves an existing path to the front without duplicating', () => {
    expect(recordVisit('/a', ['/b', '/a', '/c'])).toEqual(['/a', '/b', '/c']);
  });

  it('caps the list at RECENT_CAP entries', () => {
    const result = recordVisit('/new', ['/1', '/2', '/3', '/4', '/5']);
    expect(result).toEqual(['/new', '/1', '/2', '/3', '/4']);
    expect(result).toHaveLength(RECENT_CAP);
    expect(result).not.toContain('/5'); // oldest entry dropped past the cap
  });

  it('ignores falsy / non-string paths (returns the list unchanged)', () => {
    expect(recordVisit('', ['/a'])).toEqual(['/a']);
    expect(recordVisit(null, ['/a'])).toEqual(['/a']);
    expect(recordVisit(undefined, ['/a'])).toEqual(['/a']);
    expect(recordVisit(42, ['/a'])).toEqual(['/a']);
  });

  it('tolerates a non-array current list', () => {
    expect(recordVisit('/a', null)).toEqual(['/a']);
    expect(recordVisit('/a', undefined)).toEqual(['/a']);
  });
});

describe('togglePin / isPinned', () => {
  it('adds a path when absent', () => {
    expect(togglePin('/a', [])).toEqual(['/a']);
  });

  it('removes a path when present', () => {
    expect(togglePin('/a', ['/a', '/b'])).toEqual(['/b']);
  });

  it('ignores falsy paths', () => {
    expect(togglePin('', ['/a'])).toEqual(['/a']);
    expect(togglePin(null, ['/a'])).toEqual(['/a']);
  });

  it('tolerates a non-array current list', () => {
    expect(togglePin('/a', null)).toEqual(['/a']);
  });

  it('isPinned reports membership', () => {
    expect(isPinned('/a', ['/a', '/b'])).toBe(true);
    expect(isPinned('/c', ['/a', '/b'])).toBe(false);
    expect(isPinned('/a', null)).toBe(false);
  });
});
