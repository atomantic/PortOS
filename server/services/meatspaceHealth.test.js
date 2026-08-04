import { describe, it, expect, vi, beforeEach } from 'vitest';

// classifyBP is pure and lives in the client bundle (client/src/components/meatspace/
// bpClassification.js) — "ported from MortalLoom's CardioFitnessEngine so PortOS and
// the iOS/macOS companion app report identical categories for the same reading" per
// its own header comment. It has no server-side counterpart to reimplement: import
// the real, shared source of truth directly rather than keeping a second inline copy
// that could silently drift from what the UI actually classifies.
import { classifyBP } from '../../client/src/components/meatspace/bpClassification.js';

// getBodyHistory / addBodyEntry / getBloodPressureHistory / addBloodPressureReading
// in meatspaceHealth.js do NOT expose their filter/sort/merge logic as standalone
// pure functions — it's inlined in each async service function. Rather than keep
// reimplementing that logic locally (the anti-pattern this file used to have),
// exercise the real exported functions with fs/promises + mortalLoomStore mocked
// at the I/O boundary, mirroring meatspaceCustomDrinks.test.js's established
// pattern for this same service directory.

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  readJSONFile: vi.fn(),
  getDateString: vi.fn(() => '2024-06-01'),
  PATHS: {
    root: '/mock',
    data: '/mock/data',
    meatspace: '/mock/data/meatspace'
  },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (filePath, data) => {
    const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
    const { writeFile } = await import('fs/promises');
    return writeFile(filePath, payload);
  })
}));

vi.mock('./mortalLoomStore.js', () => ({
  isMortalLoomEnabled: vi.fn().mockResolvedValue(false),
  mlArrayIfEnabled: vi.fn().mockResolvedValue(null),
  mlPush: vi.fn(),
  mlPatchById: vi.fn(),
  mlRemoveById: vi.fn(),
  mlUpsertHealthMetricByDate: vi.fn()
}));

import { writeFile } from 'fs/promises';
import { readJSONFile, getDateString } from '../lib/fileUtils.js';
import {
  getBodyHistory,
  addBodyEntry,
  getBloodPressureHistory,
  addBloodPressureReading
} from './meatspaceHealth.js';

beforeEach(() => {
  vi.clearAllMocks();
  getDateString.mockReturnValue('2024-06-01');
});

// =============================================================================
// BP CLASSIFICATION TESTS (AHA/ACC 2017, ported from MortalLoom CardioFitnessEngine)
// =============================================================================

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

// =============================================================================
// BODY HISTORY TESTS (real getBodyHistory, fs mocked)
// =============================================================================

describe('getBodyHistory', () => {
  it('returns empty array for no body entries', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-01-01', nutrition: { calories: 2000 } }]
    });
    expect(await getBodyHistory()).toEqual([]);
  });

  it('extracts and sorts body entries chronologically', async () => {
    readJSONFile.mockResolvedValue({
      entries: [
        { date: '2024-03-01', body: { weightLbs: 160 } },
        { date: '2024-01-01', body: { weightLbs: 165 } },
        { date: '2024-02-01', body: { weightLbs: 162 } }
      ]
    });
    const result = await getBodyHistory();
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ date: '2024-01-01', weightLbs: 165 });
    expect(result[2].date).toBe('2024-03-01');
  });

  it('filters out entries with empty body objects', async () => {
    readJSONFile.mockResolvedValue({
      entries: [
        { date: '2024-01-01', body: {} },
        { date: '2024-01-02', body: { weightLbs: 160 } }
      ]
    });
    const result = await getBodyHistory();
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2024-01-02');
  });
});

// =============================================================================
// BODY ENTRY MERGE TESTS (real addBodyEntry, fs mocked)
// =============================================================================

describe('addBodyEntry', () => {
  it('creates a body entry from scratch when the date is unseen', async () => {
    readJSONFile.mockResolvedValue({ entries: [], lastEntryDate: null });
    const result = await addBodyEntry({ date: '2024-01-01', weightLbs: 160 });
    expect(result).toEqual({ date: '2024-01-01', weightLbs: 160 });
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('merges new fields into an existing body entry for the same date', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-01-01', body: { weightLbs: 160 } }],
      lastEntryDate: '2024-01-01'
    });
    const result = await addBodyEntry({ date: '2024-01-01', fatPct: 15 });
    expect(result).toEqual({ date: '2024-01-01', weightLbs: 160, fatPct: 15 });
  });

  it('overwrites an existing field on a repeat entry for the same date', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-01-01', body: { weightLbs: 160, fatPct: 15 } }],
      lastEntryDate: '2024-01-01'
    });
    const result = await addBodyEntry({ date: '2024-01-01', weightLbs: 158 });
    expect(result).toEqual({ date: '2024-01-01', weightLbs: 158, fatPct: 15 });
  });

  it('defaults to the local calendar day when no date is given', async () => {
    readJSONFile.mockResolvedValue({ entries: [], lastEntryDate: null });
    getDateString.mockReturnValue('2024-06-01');
    const result = await addBodyEntry({ weightLbs: 170 });
    expect(result.date).toBe('2024-06-01');
  });
});

// =============================================================================
// BLOOD PRESSURE HISTORY TESTS (real getBloodPressureHistory, fs mocked)
// =============================================================================

describe('getBloodPressureHistory', () => {
  it('filters entries missing either systolic or diastolic', async () => {
    readJSONFile.mockResolvedValue({
      entries: [
        { date: '2024-01-01', bloodPressureSystolic: 118, bloodPressureDiastolic: 78 },
        { date: '2024-01-02', bloodPressureSystolic: 125 },
        { date: '2024-01-03', bloodPressureDiastolic: 82 },
        { date: '2024-01-04', heartRate: 60 }
      ]
    });
    const result = await getBloodPressureHistory();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: '2024-01-01', systolic: 118, diastolic: 78 });
  });

  it('sorts ascending by date', async () => {
    readJSONFile.mockResolvedValue({
      entries: [
        { date: '2024-03-01', bloodPressureSystolic: 130, bloodPressureDiastolic: 85 },
        { date: '2024-01-01', bloodPressureSystolic: 120, bloodPressureDiastolic: 80 },
        { date: '2024-02-01', bloodPressureSystolic: 125, bloodPressureDiastolic: 82 }
      ]
    });
    const result = await getBloodPressureHistory();
    expect(result.map(r => r.date)).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
  });
});

// =============================================================================
// BLOOD PRESSURE UPSERT TESTS (real addBloodPressureReading, fs mocked)
// =============================================================================

describe('addBloodPressureReading', () => {
  it('appends a new entry when the date is unseen', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-01-01', heartRate: 60 }]
    });
    const result = await addBloodPressureReading({ date: '2024-02-01', systolic: 120, diastolic: 80 });
    expect(result).toEqual({ date: '2024-02-01', systolic: 120, diastolic: 80 });
    const written = JSON.parse(writeFile.mock.calls[0][1]);
    expect(written.entries).toHaveLength(2);
  });

  it('merges BP fields into the existing entry, preserving unrelated fields', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-01-01', heartRate: 62, hrv: 50 }]
    });
    await addBloodPressureReading({ date: '2024-01-01', systolic: 118, diastolic: 78 });
    const written = JSON.parse(writeFile.mock.calls[0][1]);
    expect(written.entries[0]).toEqual({
      date: '2024-01-01', heartRate: 62, hrv: 50,
      bloodPressureSystolic: 118, bloodPressureDiastolic: 78
    });
  });

  it('overwrites the BP fields on a repeat reading for the same date', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-01-01', bloodPressureSystolic: 140, bloodPressureDiastolic: 90 }]
    });
    const result = await addBloodPressureReading({ date: '2024-01-01', systolic: 122, diastolic: 81 });
    expect(result).toEqual({ date: '2024-01-01', systolic: 122, diastolic: 81 });
  });

  it('defaults to the local calendar day when no date is given', async () => {
    readJSONFile.mockResolvedValue({ entries: [] });
    getDateString.mockReturnValue('2024-06-01');
    const result = await addBloodPressureReading({ systolic: 118, diastolic: 76 });
    expect(result.date).toBe('2024-06-01');
  });
});
