import { describe, it, expect } from 'vitest';
import { computeStandardDrinks, computeRollingAverages } from './meatspaceAlcohol.js';
import { getDateString } from '../lib/fileUtils.js';

// =============================================================================
// STANDARD DRINKS TESTS
// =============================================================================

describe('computeStandardDrinks', () => {
  it('calculates standard drinks for a 12oz 5% beer', () => {
    expect(computeStandardDrinks(12, 5)).toBe(1);
  });

  it('calculates standard drinks for a 5oz 12% wine', () => {
    expect(computeStandardDrinks(5, 12)).toBe(1);
  });

  it('calculates standard drinks for a 1.5oz 40% spirit', () => {
    expect(computeStandardDrinks(1.5, 40)).toBe(1);
  });

  it('handles Guinness (14.9oz @ 4.2%)', () => {
    // 14.9 * 0.042 = 0.6258 oz pure alcohol / 0.6 = 1.043
    expect(computeStandardDrinks(14.9, 4.2)).toBe(1.04);
  });

  it('handles double IPA pint (16oz @ 8%)', () => {
    // 16 * 0.08 = 1.28 / 0.6 = 2.1333
    expect(computeStandardDrinks(16, 8)).toBe(2.13);
  });

  it('returns 0 for 0 ABV', () => {
    expect(computeStandardDrinks(12, 0)).toBe(0);
  });

  it('returns 0 for 0 oz', () => {
    expect(computeStandardDrinks(0, 5)).toBe(0);
  });
});

// =============================================================================
// ROLLING AVERAGES TESTS
// =============================================================================

describe('computeRollingAverages', () => {
  // Helper to make dates relative to today. computeRollingAverages derives "today"
  // from getDateString (local calendar date), NOT a UTC toISOString() split — a
  // UTC-based fixture here would drift by a day from the function's own "today"
  // near local midnight in any timezone west of UTC. Match the real semantics.
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return getDateString(d);
  };

  it('does not reorder the caller’s entries', () => {
    const entries = [{ date: daysAgo(0) }, { date: daysAgo(2) }, { date: daysAgo(1) }];
    const dates = entries.map(entry => entry.date);
    computeRollingAverages(entries);
    expect(entries.map(entry => entry.date)).toEqual(dates);
  });

  it('returns zeros for empty entries', () => {
    const result = computeRollingAverages([]);
    expect(result.today).toBe(0);
    expect(result.avg7day).toBe(0);
    expect(result.avg30day).toBe(0);
    expect(result.allTimeAvg).toBe(0);
    expect(result.riskLevel).toBe('low');
  });

  it('computes today drinks from matching entry', () => {
    const today = getDateString();
    const entries = [
      { date: today, alcohol: { standardDrinks: 2.5, drinks: [{ name: 'Beer', oz: 12, abv: 5 }] } }
    ];
    const result = computeRollingAverages(entries);
    expect(result.today).toBe(2.5);
  });

  it('computes 7-day rolling average', () => {
    const entries = [];
    for (let i = 0; i < 7; i++) {
      entries.push({
        date: daysAgo(i),
        alcohol: { standardDrinks: 2, drinks: [{}] }
      });
    }
    const result = computeRollingAverages(entries);
    expect(result.avg7day).toBe(2); // 14 drinks / 7 days
    expect(result.weeklyTotal).toBe(14);
  });

  it('uses female NIAAA thresholds', () => {
    const entries = [];
    for (let i = 0; i < 7; i++) {
      entries.push({
        date: daysAgo(i),
        alcohol: { standardDrinks: 1.5, drinks: [{}] }
      });
    }
    const result = computeRollingAverages(entries, 'female');
    expect(result.thresholds.weeklyMax).toBe(7);
    expect(result.weeklyTotal).toBe(10.5);
    expect(result.riskLevel).toBe('high');
  });

  it('classifies moderate risk correctly', () => {
    // Male weekly max = 14, 70% = 9.8
    // 11 drinks/week should be moderate
    const entries = [];
    for (let i = 0; i < 7; i++) {
      entries.push({
        date: daysAgo(i),
        alcohol: { standardDrinks: 11 / 7, drinks: [{}] }
      });
    }
    const result = computeRollingAverages(entries, 'male');
    expect(result.riskLevel).toBe('moderate');
  });

  it('classifies low risk correctly', () => {
    const entries = [
      { date: daysAgo(0), alcohol: { standardDrinks: 1, drinks: [{}] } },
      { date: daysAgo(1) },
      { date: daysAgo(2) },
      { date: daysAgo(3) },
      { date: daysAgo(4) },
      { date: daysAgo(5) },
      { date: daysAgo(6) }
    ];
    const result = computeRollingAverages(entries, 'male');
    expect(result.riskLevel).toBe('low');
  });

  it('counts drinking days separately from total entries', () => {
    const entries = [
      { date: daysAgo(0), alcohol: { standardDrinks: 2, drinks: [{}] } },
      { date: daysAgo(1) }, // no alcohol
      { date: daysAgo(2), alcohol: { standardDrinks: 1, drinks: [{}] } }
    ];
    const result = computeRollingAverages(entries);
    expect(result.drinkingDays).toBe(2);
    expect(result.totalEntries).toBe(3);
  });
});

// Custom drink normalization and index validation are covered by meatspaceCustomDrinks.test.js
// which exercises the actual service exports (getCustomDrinks, updateCustomDrink, etc.)
