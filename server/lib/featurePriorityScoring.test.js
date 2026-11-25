import { describe, it, expect } from 'vitest';
import {
  MIN_EVIDENCE_DAYS,
  learnedTier,
  lastActiveAgeDays,
  resolveTier,
  scoreActiveDays,
} from './featurePriorityScoring.js';

const NOW = Date.parse('2026-11-24T15:30:00Z');
const daysAgo = (n) => new Date(Date.parse('2026-11-24T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => daysAgo(from + i));

describe('scoreActiveDays', () => {
  it('weighs a day by 0.5 ** (age / 14)', () => {
    expect(scoreActiveDays([daysAgo(0)], NOW)).toBeCloseTo(1, 10);
    expect(scoreActiveDays([daysAgo(14)], NOW)).toBeCloseTo(0.5, 10);
    expect(scoreActiveDays([daysAgo(28)], NOW)).toBeCloseTo(0.25, 10);
  });

  it('counts a repeated day once and skips days outside the 90-day window, future days and junk', () => {
    expect(scoreActiveDays([daysAgo(0), daysAgo(0)], NOW)).toBeCloseTo(1, 10);
    expect(scoreActiveDays([daysAgo(89)], NOW)).toBeGreaterThan(0);
    expect(scoreActiveDays([daysAgo(90), daysAgo(-1), 'yesterday', null, 20261124], NOW)).toBe(0);
    expect(scoreActiveDays(undefined, NOW)).toBe(0);
  });

  it('accepts a Date or epoch milliseconds for now', () => {
    expect(scoreActiveDays([daysAgo(0)], new Date(NOW))).toBeCloseTo(1, 10);
  });
});

describe('lastActiveAgeDays', () => {
  it('returns the age of the newest day in the window, or null', () => {
    expect(lastActiveAgeDays([daysAgo(40), daysAgo(3), daysAgo(10)], NOW)).toBe(3);
    expect(lastActiveAgeDays([daysAgo(120)], NOW)).toBeNull();
    expect(lastActiveAgeDays([], NOW)).toBeNull();
  });
});

describe('learnedTier', () => {
  const base = { lastActiveAgeDays: 0, optional: false, evidenceDays: MIN_EVIDENCE_DAYS };

  it('withholds a verdict until the install has 14 distinct active days', () => {
    expect(learnedTier({ ...base, score: 50, evidenceDays: 13 })).toBeNull();
    expect(learnedTier({ ...base, score: 50, evidenceDays: 14 })).toBe('P0');
    expect(learnedTier({ ...base, score: 50, evidenceDays: undefined })).toBeNull();
  });

  it('pins the score thresholds at 6 and 1.5', () => {
    expect(learnedTier({ ...base, score: 6 })).toBe('P0');
    expect(learnedTier({ ...base, score: 5.99 })).toBe('P1');
    expect(learnedTier({ ...base, score: 1.5 })).toBe('P1');
    expect(learnedTier({ ...base, score: 1.49 })).toBe('P2');
    expect(learnedTier({ ...base, score: 0 })).toBe('P2');
  });

  it('never learns a core area below P2, however long it sat unused', () => {
    expect(learnedTier({ ...base, score: 0, lastActiveAgeDays: null })).toBe('P2');
    expect(learnedTier({ ...base, score: 0, lastActiveAgeDays: 89 })).toBe('P2');
  });

  it('learns P3 only for an optional area with no active day in the last 30', () => {
    const optional = { ...base, optional: true, score: 0 };
    expect(learnedTier({ ...optional, lastActiveAgeDays: null })).toBe('P3');
    expect(learnedTier({ ...optional, lastActiveAgeDays: 30 })).toBe('P3');
    expect(learnedTier({ ...optional, lastActiveAgeDays: 29 })).toBe('P2');
    expect(learnedTier({ ...optional, score: 3, lastActiveAgeDays: 45 })).toBe('P3');
  });

  it('scores a real history end to end', () => {
    const daily = range(0, 13);
    expect(learnedTier({ ...base, score: scoreActiveDays(daily, NOW), evidenceDays: daily.length })).toBe('P0');
    const sparse = [daysAgo(1), daysAgo(10), daysAgo(20), daysAgo(40)];
    expect(learnedTier({ ...base, score: scoreActiveDays(sparse, NOW) })).toBe('P1');
  });
});

describe('resolveTier', () => {
  it('lets a pin beat the feature-off rule and the learned tier', () => {
    expect(resolveTier({ pinned: 'P0', featureEnabled: false, lastActiveAgeDays: null, learned: 'P3' }))
      .toEqual({ tier: 'P0', source: 'pinned' });
    expect(resolveTier({ pinned: 'P3', learned: 'P0' })).toEqual({ tier: 'P3', source: 'pinned' });
  });

  it('ignores a pin that is not a tier', () => {
    expect(resolveTier({ pinned: 'P9', learned: 'P2' })).toEqual({ tier: 'P2', source: 'learned' });
    expect(resolveTier({ pinned: '', learned: null })).toEqual({ tier: 'P1', source: 'default' });
  });

  it('marks a disabled optional feature P3 without needing the evidence gate', () => {
    expect(resolveTier({ featureEnabled: false, lastActiveAgeDays: null, learned: null })).toEqual({ tier: 'P3', source: 'feature-off' });
    expect(resolveTier({ featureEnabled: false, lastActiveAgeDays: 30, learned: 'P0' })).toEqual({ tier: 'P3', source: 'feature-off' });
  });

  it('keeps a disabled feature that was used in the last 30 days on its learned tier', () => {
    expect(resolveTier({ featureEnabled: false, lastActiveAgeDays: 29, learned: 'P1' })).toEqual({ tier: 'P1', source: 'learned' });
    expect(resolveTier({ featureEnabled: false, lastActiveAgeDays: 2, learned: null })).toEqual({ tier: 'P1', source: 'default' });
  });

  it('never treats an enabled or core area as feature-off', () => {
    expect(resolveTier({ featureEnabled: true, lastActiveAgeDays: null, learned: 'P2' })).toEqual({ tier: 'P2', source: 'learned' });
    expect(resolveTier({ lastActiveAgeDays: null, learned: null })).toEqual({ tier: 'P1', source: 'default' });
  });
});
