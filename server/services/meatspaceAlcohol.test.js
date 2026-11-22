import { describe, it, expect, vi } from 'vitest';
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

  it('excludes the day 7 days ago from the 7-day window', () => {
    // 2 drinks on each of the last 8 calendar days: the 7-day window is today-6..today,
    // so the 8th day (today-7) must not count. 14 drinks / 7 days, not 16 / 7.
    const entries = [];
    for (let i = 0; i < 8; i++) {
      entries.push({ date: daysAgo(i), alcohol: { standardDrinks: 2, drinks: [{}] } });
    }
    const result = computeRollingAverages(entries, 'male');
    expect(result.avg7day).toBe(2);
    expect(result.weeklyTotal).toBe(14);
    expect(result.riskLevel).toBe('moderate');
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

// Substance writes must log an id and a date, never the drink name, ounces, ABV, or
// the computed standard-drink total: the process log is copied into diagnostic bundles
// and outlives the record (#17348).
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readJSONFile: vi.fn(),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('./mortalLoomStore.js', () => ({
  isMortalLoomEnabled: vi.fn().mockResolvedValue(false),
  readDailyLogIfEnabled: vi.fn().mockResolvedValue(null),
  mlArrayIfEnabled: vi.fn().mockResolvedValue(null),
  mlPush: vi.fn(), mlPatchById: vi.fn(), mlRemoveById: vi.fn(), mlIdAtDateIndex: vi.fn()
}));

describe('drink logs never carry the drink name or measurements', () => {
  it('log, edit, remove, and custom-button writes keep name, oz, ABV, and the total off stdout', async () => {
    const fileUtils = await import('../lib/fileUtils.js');
    const { logDrink, updateDrink, removeDrink, addCustomDrink, updateCustomDrink, removeCustomDrink } = await import('./meatspaceAlcohol.js');
    let store = { entries: [], lastEntryDate: null };
    let buttons = { drinks: [] };
    fileUtils.readJSONFile.mockImplementation(async path => structuredClone(String(path).endsWith('daily-log.json') ? store : buttons));
    fileUtils.atomicWrite.mockImplementation(async (path, data) => {
      if (String(path).endsWith('daily-log.json')) store = structuredClone(data);
      else buttons = structuredClone(data);
    });
    const stdout = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => { stdout.push(args.join(' ')); });
    try {
      const date = '2024-06-01';
      const logged = await logDrink({ name: 'Zzyzx Fixture Ale', oz: 13.37, abv: 6.66, count: 1, date });
      const total = String(logged.standardDrinks);
      await updateDrink(date, 0, { oz: 17.91, abv: 8.42, id: logged.drink.id });
      await removeDrink(date, 0, logged.drink.id);
      await addCustomDrink({ name: 'Zzyzx Custom Button', oz: 13.37, abv: 6.66 });
      await updateCustomDrink(0, { name: 'Zzyzx Renamed Button' });
      await removeCustomDrink(0);

      const output = stdout.join('\n');
      for (const secret of ['Zzyzx', '13.37', '17.91', '6.66', '8.42', total]) {
        expect(output).not.toContain(secret);
      }
      expect(stdout.filter(line => line.includes(logged.drink.id))).toHaveLength(3);
      expect(stdout.some(line => line.includes(date))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
