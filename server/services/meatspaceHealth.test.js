import { describe, it, expect } from 'vitest';

// Inline pure functions to avoid mocking file I/O

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
