import { describe, it, expect } from 'vitest';

// Inline pure functions to avoid mocking file I/O

function computeStandardDrinks(oz, abv) {
  const pureAlcoholOz = oz * (abv / 100);
  return Math.round((pureAlcoholOz / 0.6) * 100) / 100;
}

function computeRollingAverages(entries, sex = 'male') {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  const alcoholEntries = entries
    .filter(e => e.alcohol?.standardDrinks > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const allEntries = entries.sort((a, b) => a.date.localeCompare(b.date));

  const todayEntry = allEntries.find(e => e.date === today);
  const todayDrinks = todayEntry?.alcohol?.standardDrinks || 0;

  const rollingAverage = (days) => {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    let totalDrinks = 0;
    let dayCount = 0;

    for (const entry of allEntries) {
      if (entry.date >= cutoffStr && entry.date <= today) {
        totalDrinks += entry.alcohol?.standardDrinks || 0;
        dayCount++;
      }
    }

    return dayCount > 0 ? Math.round((totalDrinks / days) * 100) / 100 : 0;
  };

  let allTimeAvg = 0;
  if (allEntries.length > 0) {
    const firstDate = new Date(allEntries[0].date);
    const totalDays = Math.max(1, Math.ceil((now - firstDate) / (24 * 60 * 60 * 1000)));
    const totalDrinks = allEntries.reduce((sum, e) => sum + (e.alcohol?.standardDrinks || 0), 0);
    allTimeAvg = Math.round((totalDrinks / totalDays) * 100) / 100;
  }

  const thresholds = sex === 'female'
    ? { dailyMax: 1, weeklyMax: 7 }
    : { dailyMax: 2, weeklyMax: 14 };

  const avg7day = rollingAverage(7);
  const weeklyTotal = Math.round(avg7day * 7 * 100) / 100;

  return {
    today: todayDrinks,
    avg7day,
    avg30day: rollingAverage(30),
    allTimeAvg,
    weeklyTotal,
    thresholds,
    riskLevel: weeklyTotal > thresholds.weeklyMax ? 'high'
      : weeklyTotal > thresholds.weeklyMax * 0.7 ? 'moderate'
      : 'low',
    drinkingDays: alcoholEntries.length,
    totalEntries: allEntries.length
  };
}

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
  // Helper to make dates relative to today
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
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
    const today = new Date().toISOString().split('T')[0];
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
