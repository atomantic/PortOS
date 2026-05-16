import { describe, expect, it } from 'vitest';
import { recommendStructure, describeStructure } from './seasonStructure.js';

describe('recommendStructure', () => {
  it('returns null for non-positive totals', () => {
    expect(recommendStructure(0)).toBeNull();
    expect(recommendStructure(-5)).toBeNull();
    expect(recommendStructure(null)).toBeNull();
    expect(recommendStructure(undefined)).toBeNull();
  });

  it('keeps 12 or fewer in a single volume', () => {
    expect(recommendStructure(6)).toEqual({ seasons: 1, perSeason: [6] });
    expect(recommendStructure(10)).toEqual({ seasons: 1, perSeason: [10] });
    expect(recommendStructure(12)).toEqual({ seasons: 1, perSeason: [12] });
  });

  it('lands the canonical 3-volume arc points', () => {
    // 18 = 3 × 6 (tight)
    expect(recommendStructure(18)).toEqual({ seasons: 3, perSeason: [6, 6, 6] });
    // 24 = 3 × 8 (sweet spot)
    expect(recommendStructure(24)).toEqual({ seasons: 3, perSeason: [8, 8, 8] });
    // 30 = 3 × 10 (streaming pacing)
    expect(recommendStructure(30)).toEqual({ seasons: 3, perSeason: [10, 10, 10] });
  });

  it('splits 13–17 issues into two volumes', () => {
    expect(recommendStructure(13)).toEqual({ seasons: 2, perSeason: [7, 6] });
    expect(recommendStructure(16)).toEqual({ seasons: 2, perSeason: [8, 8] });
    expect(recommendStructure(17)).toEqual({ seasons: 2, perSeason: [9, 8] });
  });

  it('front-loads remainder into earlier volumes', () => {
    expect(recommendStructure(20)).toEqual({ seasons: 3, perSeason: [7, 7, 6] });
    expect(recommendStructure(22)).toEqual({ seasons: 3, perSeason: [8, 7, 7] });
  });

  it('caps at 5 volumes for very long runs', () => {
    expect(recommendStructure(50).seasons).toBe(5);
    expect(recommendStructure(100).seasons).toBe(5);
    expect(recommendStructure(100).perSeason.reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('describeStructure', () => {
  it('renders even splits compactly', () => {
    expect(describeStructure({ seasons: 1, perSeason: [12] })).toBe('1 volume × 12 episodes');
    expect(describeStructure({ seasons: 3, perSeason: [8, 8, 8] })).toBe('3 volumes × 8 episodes');
  });

  it('renders uneven splits with the per-volume breakdown', () => {
    expect(describeStructure({ seasons: 3, perSeason: [8, 7, 7] })).toBe('3 volumes × ~7 (8, 7, 7)');
  });

  it('returns empty string for null', () => {
    expect(describeStructure(null)).toBe('');
  });
});
