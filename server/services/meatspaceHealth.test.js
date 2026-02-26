import { describe, it, expect } from 'vitest';

// Inline pure functions to avoid mocking file I/O

function computeNutritionAverages(entries) {
  if (entries.length === 0) return null;

  const sums = {};
  const counts = {};
  for (const entry of entries) {
    for (const [key, val] of Object.entries(entry.nutrition)) {
      if (val != null) {
        sums[key] = (sums[key] || 0) + val;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  }

  const averages = {};
  for (const key of Object.keys(sums)) {
    averages[key] = Math.round((sums[key] / counts[key]) * 10) / 10;
  }
  return averages;
}

function extractBodyHistory(entries) {
  return entries
    .filter(e => e.body && Object.keys(e.body).length > 0)
    .map(e => ({ date: e.date, ...e.body }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function mergeBodyEntry(existingBody, newBody) {
  return { ...(existingBody || {}), ...newBody };
}

function sortByDate(items) {
  return [...items].sort((a, b) => a.date.localeCompare(b.date));
}

// =============================================================================
// NUTRITION AVERAGES TESTS
// =============================================================================

describe('computeNutritionAverages', () => {
  it('returns null for empty entries', () => {
    expect(computeNutritionAverages([])).toBeNull();
  });

  it('computes averages for single entry', () => {
    const entries = [{ nutrition: { calories: 2000, fatG: 80, carbG: 250 } }];
    const result = computeNutritionAverages(entries);
    expect(result.calories).toBe(2000);
    expect(result.fatG).toBe(80);
    expect(result.carbG).toBe(250);
  });

  it('computes averages across multiple entries', () => {
    const entries = [
      { nutrition: { calories: 1500, fatG: 60 } },
      { nutrition: { calories: 2500, fatG: 100 } }
    ];
    const result = computeNutritionAverages(entries);
    expect(result.calories).toBe(2000);
    expect(result.fatG).toBe(80);
  });

  it('handles sparse data (some fields missing)', () => {
    const entries = [
      { nutrition: { calories: 1800, fiberG: 30 } },
      { nutrition: { calories: 2200 } }
    ];
    const result = computeNutritionAverages(entries);
    expect(result.calories).toBe(2000);
    expect(result.fiberG).toBe(30); // only 1 entry had fiber
  });

  it('skips null values in averages', () => {
    const entries = [
      { nutrition: { calories: 2000, fatG: null } },
      { nutrition: { calories: 1800, fatG: 70 } }
    ];
    const result = computeNutritionAverages(entries);
    expect(result.calories).toBe(1900);
    expect(result.fatG).toBe(70); // only counted non-null
  });

  it('rounds to one decimal place', () => {
    const entries = [
      { nutrition: { calories: 1000 } },
      { nutrition: { calories: 1001 } },
      { nutrition: { calories: 1002 } }
    ];
    const result = computeNutritionAverages(entries);
    expect(result.calories).toBe(1001);
  });
});

// =============================================================================
// BODY HISTORY TESTS
// =============================================================================

describe('extractBodyHistory', () => {
  it('returns empty array for no body entries', () => {
    const entries = [
      { date: '2024-01-01', nutrition: { calories: 2000 } }
    ];
    expect(extractBodyHistory(entries)).toEqual([]);
  });

  it('extracts and sorts body entries', () => {
    const entries = [
      { date: '2024-03-01', body: { weightLbs: 160 } },
      { date: '2024-01-01', body: { weightLbs: 165 } },
      { date: '2024-02-01', body: { weightLbs: 162 } }
    ];
    const result = extractBodyHistory(entries);
    expect(result).toHaveLength(3);
    expect(result[0].date).toBe('2024-01-01');
    expect(result[0].weightLbs).toBe(165);
    expect(result[2].date).toBe('2024-03-01');
  });

  it('filters out entries with empty body objects', () => {
    const entries = [
      { date: '2024-01-01', body: {} },
      { date: '2024-01-02', body: { weightLbs: 160 } }
    ];
    const result = extractBodyHistory(entries);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2024-01-02');
  });
});

// =============================================================================
// BODY ENTRY MERGE TESTS
// =============================================================================

describe('mergeBodyEntry', () => {
  it('creates body from scratch when no existing data', () => {
    const result = mergeBodyEntry(null, { weightLbs: 160 });
    expect(result).toEqual({ weightLbs: 160 });
  });

  it('merges new fields into existing body', () => {
    const existing = { weightLbs: 160 };
    const result = mergeBodyEntry(existing, { fatPct: 15 });
    expect(result).toEqual({ weightLbs: 160, fatPct: 15 });
  });

  it('overwrites existing fields', () => {
    const existing = { weightLbs: 160, fatPct: 15 };
    const result = mergeBodyEntry(existing, { weightLbs: 158 });
    expect(result).toEqual({ weightLbs: 158, fatPct: 15 });
  });
});

// =============================================================================
// SORT TESTS
// =============================================================================

describe('sortByDate', () => {
  it('sorts chronologically', () => {
    const items = [
      { date: '2024-12-01' },
      { date: '2024-01-15' },
      { date: '2024-06-20' }
    ];
    const result = sortByDate(items);
    expect(result[0].date).toBe('2024-01-15');
    expect(result[1].date).toBe('2024-06-20');
    expect(result[2].date).toBe('2024-12-01');
  });

  it('does not mutate original array', () => {
    const items = [{ date: '2024-12-01' }, { date: '2024-01-01' }];
    sortByDate(items);
    expect(items[0].date).toBe('2024-12-01');
  });
});
