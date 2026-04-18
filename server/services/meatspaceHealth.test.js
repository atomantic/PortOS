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

// =============================================================================
// BLOOD PRESSURE TESTS
// =============================================================================

// Pure versions of the BP logic in meatspaceHealth.js / mortalLoomStore.js,
// copied here per project convention (see BODY HISTORY TESTS above).

function extractBloodPressureHistory(healthMetrics) {
  return healthMetrics
    .filter(m => m?.bloodPressureSystolic != null && m?.bloodPressureDiastolic != null)
    .map(m => ({ date: m.date, systolic: m.bloodPressureSystolic, diastolic: m.bloodPressureDiastolic }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function upsertHealthMetricByDate(healthMetrics, date, patch) {
  const existing = healthMetrics.find(m => m.date === date);
  if (existing) {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== null) existing[k] = v;
    }
    return { metrics: healthMetrics, entry: existing };
  }
  const created = { date, ...patch };
  return { metrics: [...healthMetrics, created], entry: created };
}

describe('extractBloodPressureHistory', () => {
  it('filters entries missing either systolic or diastolic', () => {
    const metrics = [
      { date: '2024-01-01', bloodPressureSystolic: 118, bloodPressureDiastolic: 78 },
      { date: '2024-01-02', bloodPressureSystolic: 125 },
      { date: '2024-01-03', bloodPressureDiastolic: 82 },
      { date: '2024-01-04', heartRate: 60 }
    ];
    const result = extractBloodPressureHistory(metrics);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: '2024-01-01', systolic: 118, diastolic: 78 });
  });

  it('sorts ascending by date', () => {
    const metrics = [
      { date: '2024-03-01', bloodPressureSystolic: 130, bloodPressureDiastolic: 85 },
      { date: '2024-01-01', bloodPressureSystolic: 120, bloodPressureDiastolic: 80 },
      { date: '2024-02-01', bloodPressureSystolic: 125, bloodPressureDiastolic: 82 }
    ];
    const result = extractBloodPressureHistory(metrics);
    expect(result.map(r => r.date)).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
  });
});

describe('upsertHealthMetricByDate', () => {
  it('appends a new entry when the date is unseen', () => {
    const { metrics, entry } = upsertHealthMetricByDate(
      [{ date: '2024-01-01', heartRate: 60 }],
      '2024-02-01',
      { bloodPressureSystolic: 120, bloodPressureDiastolic: 80 }
    );
    expect(metrics).toHaveLength(2);
    expect(entry).toMatchObject({ date: '2024-02-01', bloodPressureSystolic: 120, bloodPressureDiastolic: 80 });
  });

  it('merges new BP fields into the existing entry for the same date', () => {
    const metrics = [{ date: '2024-01-01', heartRate: 62, hrv: 50 }];
    const { metrics: next, entry } = upsertHealthMetricByDate(
      metrics,
      '2024-01-01',
      { bloodPressureSystolic: 118, bloodPressureDiastolic: 78 }
    );
    expect(next).toHaveLength(1);
    expect(entry).toMatchObject({
      date: '2024-01-01', heartRate: 62, hrv: 50,
      bloodPressureSystolic: 118, bloodPressureDiastolic: 78
    });
  });

  it('overwrites the BP fields on a repeat reading for the same date', () => {
    const metrics = [{ date: '2024-01-01', bloodPressureSystolic: 140, bloodPressureDiastolic: 90 }];
    const { entry } = upsertHealthMetricByDate(
      metrics,
      '2024-01-01',
      { bloodPressureSystolic: 122, bloodPressureDiastolic: 81 }
    );
    expect(entry.bloodPressureSystolic).toBe(122);
    expect(entry.bloodPressureDiastolic).toBe(81);
  });

  it('ignores null/undefined patch fields so partial updates do not wipe data', () => {
    const metrics = [{ date: '2024-01-01', bloodPressureSystolic: 120, bloodPressureDiastolic: 80 }];
    const { entry } = upsertHealthMetricByDate(
      metrics,
      '2024-01-01',
      { bloodPressureSystolic: 125, bloodPressureDiastolic: null }
    );
    expect(entry.bloodPressureSystolic).toBe(125);
    expect(entry.bloodPressureDiastolic).toBe(80);
  });
});

// =============================================================================
// BP CLASSIFICATION TESTS (AHA/ACC 2017, ported from MortalLoom CardioFitnessEngine)
// =============================================================================

function classifyBP(systolic, diastolic) {
  if (systolic > 180 || diastolic > 120) return 'crisis';
  if (systolic >= 140 || diastolic >= 90) return 'highStage2';
  if (systolic >= 130 || diastolic >= 80) return 'highStage1';
  if (systolic >= 120) return 'elevated';
  return 'normal';
}

describe('classifyBP', () => {
  it.each([
    [110, 70, 'normal'],
    [119, 79, 'normal'],
    [120, 79, 'elevated'],
    [125, 75, 'elevated'],
    [130, 75, 'highStage1'],
    [115, 82, 'highStage1'],
    [140, 85, 'highStage2'],
    [135, 92, 'highStage2'],
    [185, 95, 'crisis'],
    [150, 125, 'crisis']
  ])('classifies %d/%d as %s', (sys, dia, expected) => {
    expect(classifyBP(sys, dia)).toBe(expected);
  });
});
