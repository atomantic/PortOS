import { describe, it, expect } from 'vitest';
import { computeDomainAverages, domainLabel, computeGoalProgress, hasGoals } from './constants';

describe('domainLabel', () => {
  it('maps known domain keys to their human label', () => {
    expect(domainLabel('math')).toBe('Mental Math');
    expect(domainLabel('verbal')).toBe('Verbal Agility');
  });

  it('labels the catch-all bucket "Other"', () => {
    expect(domainLabel('other')).toBe('Other');
  });

  it('falls back to the raw key for unknown domains', () => {
    expect(domainLabel('mystery')).toBe('mystery');
  });
});

describe('computeDomainAverages', () => {
  it('derives the domain from the drill TYPE, not the coarse module segment', () => {
    // pun-wordplay lives under the `wordplay` domain even though its coarse
    // module is `llm-drills`; multiplication is `math`.
    const result = computeDomainAverages({
      'mental-math:multiplication': 90,
      'llm-drills:pun-wordplay': 60,
    });
    const byKey = Object.fromEntries(result.map(d => [d.key, d]));
    expect(byKey.math.score).toBe(90);
    expect(byKey.math.label).toBe('Mental Math');
    expect(byKey.wordplay.score).toBe(60);
    expect(byKey.wordplay.label).toBe('Wordplay');
  });

  it('averages multiple drills within the same domain (rounded)', () => {
    // pun-wordplay + word-association are both `wordplay`: mean(60, 71) = 65.5 → 66
    const result = computeDomainAverages({
      'llm-drills:pun-wordplay': 60,
      'llm-drills:word-association': 71,
    });
    expect(result).toEqual([{ key: 'wordplay', label: 'Wordplay', score: 66 }]);
  });

  it('sorts strongest domain first', () => {
    const result = computeDomainAverages({
      'mental-math:multiplication': 40,
      'llm-drills:pun-wordplay': 90,
      'llm-drills:story-recall': 70,
    });
    expect(result.map(d => d.key)).toEqual(['wordplay', 'verbal', 'math']);
  });

  it('buckets unmapped drill types under "other"', () => {
    const result = computeDomainAverages({ 'legacy:removed-drill': 50 });
    expect(result).toEqual([{ key: 'other', label: 'Other', score: 50 }]);
  });

  it('returns an empty list for empty stats', () => {
    expect(computeDomainAverages({})).toEqual([]);
    expect(computeDomainAverages()).toEqual([]);
  });
});

describe('hasGoals (issue #2100)', () => {
  it('is false for absent/empty/legacy goals', () => {
    expect(hasGoals(undefined)).toBe(false);
    expect(hasGoals(null)).toBe(false);
    expect(hasGoals({})).toBe(false);
    expect(hasGoals({ dailyMinutes: 0 })).toBe(false);
  });

  it('is true once any positive target is set', () => {
    expect(hasGoals({ streakTarget: 10 })).toBe(true);
  });
});

describe('computeGoalProgress (issue #2100)', () => {
  it('reports progress for each set goal whose metric is known', () => {
    const rows = computeGoalProgress(
      { dailyMinutes: 20, weeklySessions: 5, streakTarget: 10 },
      { todayMinutes: 14, weekSessions: 5, currentStreak: 6 },
    );
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    expect(byKey.dailyMinutes.pct).toBe(70);
    expect(byKey.dailyMinutes.met).toBe(false);
    expect(byKey.weeklySessions.met).toBe(true);
    expect(byKey.weeklySessions.pct).toBe(100);
    expect(byKey.streakTarget.current).toBe(6);
  });

  it('skips goals whose metric is unavailable (e.g. Morse WPM with no data)', () => {
    const rows = computeGoalProgress(
      { morseWpmTarget: 15, streakTarget: 5 },
      { currentStreak: 3 }, // no morseWpm
    );
    expect(rows.map(r => r.key)).toEqual(['streakTarget']);
  });

  it('clamps pct to 100 when the target is exceeded', () => {
    const rows = computeGoalProgress({ streakTarget: 5 }, { currentStreak: 12 });
    expect(rows[0].pct).toBe(100);
    expect(rows[0].met).toBe(true);
  });

  it('returns no rows for absent goals', () => {
    expect(computeGoalProgress({}, { currentStreak: 5 })).toEqual([]);
    expect(computeGoalProgress(undefined, {})).toEqual([]);
  });
});
