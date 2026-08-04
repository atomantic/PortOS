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
// UPDATE DRINK TESTS (inline logic mirroring updateDrink service)
// =============================================================================

describe('updateDrink logic', () => {
  it('updates oz and recalculates standard drinks for the day', () => {
    // Simulate a day entry with two drinks
    const entry = {
      date: '2024-06-15',
      alcohol: {
        drinks: [
          { name: 'Beer', oz: 12, abv: 5, count: 1 },
          { name: 'Wine', oz: 5, abv: 12, count: 1 }
        ],
        standardDrinks: 2 // 1 + 1
      }
    };

    // Update first drink oz from 12 to 24 (doubling it)
    const drink = entry.alcohol.drinks[0];
    drink.oz = 24;

    // Recalculate total (same logic as updateDrink)
    entry.alcohol.standardDrinks = entry.alcohol.drinks.reduce((sum, d) => {
      return sum + computeStandardDrinks((d.oz || 0) * (d.count || 1), d.abv || 0);
    }, 0);
    entry.alcohol.standardDrinks = Math.round(entry.alcohol.standardDrinks * 100) / 100;

    // 24oz @ 5% = 2 std drinks, 5oz @ 12% = 1 std drink => total 3
    expect(entry.alcohol.standardDrinks).toBe(3);
    expect(drink.oz).toBe(24);
  });

  it('updates abv and recalculates correctly', () => {
    const entry = {
      date: '2024-06-15',
      alcohol: {
        drinks: [
          { name: 'Mystery', oz: 12, abv: 5, count: 1 }
        ],
        standardDrinks: 1
      }
    };

    // Change ABV from 5% to 10%
    entry.alcohol.drinks[0].abv = 10;

    entry.alcohol.standardDrinks = entry.alcohol.drinks.reduce((sum, d) => {
      return sum + computeStandardDrinks((d.oz || 0) * (d.count || 1), d.abv || 0);
    }, 0);
    entry.alcohol.standardDrinks = Math.round(entry.alcohol.standardDrinks * 100) / 100;

    // 12oz @ 10% = 1.2 pure oz / 0.6 = 2
    expect(entry.alcohol.standardDrinks).toBe(2);
  });

  it('updates name without affecting calculations', () => {
    const drink = { name: 'Old Name', oz: 12, abv: 5, count: 1 };
    drink.name = 'New IPA';
    expect(drink.name).toBe('New IPA');
    expect(computeStandardDrinks(drink.oz * drink.count, drink.abv)).toBe(1);
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
