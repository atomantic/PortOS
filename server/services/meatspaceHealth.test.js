import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

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
  // meatspaceHealth reaches daily-log.json through the shared reader (#4112), which
  // imports this export even though the body-history path never calls it — a mock
  // factory that omits it would throw on the first access if that ever changes.
  readDailyLogIfEnabled: vi.fn().mockResolvedValue(null),
  mlPush: vi.fn(),
  mlPatchById: vi.fn(),
  mlRemoveById: vi.fn(),
  mlRemoveWhere: vi.fn(),
  mlUpsertHealthMetricByDate: vi.fn(),
  mlClearHealthMetricFields: vi.fn(),
  mlMergeClinicalBloodTests: vi.fn()
}));

import { writeFile } from 'fs/promises';
import { readJSONFile, getDateString } from '../lib/fileUtils.js';
import {
  getBodyHistory,
  addBodyEntry,
  removeBodyEntry,
  getBloodPressureHistory,
  addBloodPressureReading,
  removeBloodPressureReading,
  addWorkout,
  removeWorkout,
  getWorkouts,
  addBloodTest,
  getBloodTests,
  removeBloodTest,
  addEyeExam,
  getEyeExams,
  updateEyeExam,
  removeEyeExam,
  resolveEyeExamId
} from './meatspaceHealth.js';
import { isMortalLoomEnabled, mlArrayIfEnabled, mlRemoveById, mlClearHealthMetricFields } from './mortalLoomStore.js';

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
    expect(result).toEqual({ date: '2024-01-01', weightLbs: 160, updatedAt: expect.any(String) });
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('merges new fields into an existing body entry for the same date', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-01-01', body: { weightLbs: 160 } }],
      lastEntryDate: '2024-01-01'
    });
    const result = await addBodyEntry({ date: '2024-01-01', fatPct: 15 });
    expect(result).toEqual({ date: '2024-01-01', weightLbs: 160, fatPct: 15, updatedAt: expect.any(String) });
  });

  it('overwrites an existing field on a repeat entry for the same date', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-01-01', body: { weightLbs: 160, fatPct: 15 } }],
      lastEntryDate: '2024-01-01'
    });
    const result = await addBodyEntry({ date: '2024-01-01', weightLbs: 158 });
    expect(result).toEqual({ date: '2024-01-01', weightLbs: 158, fatPct: 15, updatedAt: expect.any(String) });
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

// =============================================================================
// EYE EXAMS — addressed by stable id, not array position (#9139)
// =============================================================================

describe('eye exams by id', () => {
  let disk;
  beforeEach(() => {
    disk = { exams: [] };
    readJSONFile.mockImplementation(async () => structuredClone(disk));
    writeFile.mockImplementation(async (_f, payload) => { disk = JSON.parse(payload); });
  });

  it('deletes the intended exam after an out-of-date-order add', async () => {
    const a = await addEyeExam({ date: '2026-03-01' });
    const b = await addEyeExam({ date: '2025-01-01' });
    expect(disk.exams.map(e => e.date)).toEqual(['2025-01-01', '2026-03-01']);
    await removeEyeExam(b.id);
    expect(disk.exams.map(e => e.id)).toEqual([a.id]);
  });

  it('keeps addressing the right exam after a date edit', async () => {
    const a = await addEyeExam({ date: '2025-01-01' });
    const b = await addEyeExam({ date: '2025-06-01' });
    const c = await addEyeExam({ date: '2025-09-01' });
    await updateEyeExam(a.id, { date: '2026-01-01' });
    await removeEyeExam(b.id);
    expect(disk.exams.map(e => e.id)).toEqual([c.id, a.id]);
  });

  it('stamps ids onto a legacy id-less file and resolves numeric legacy indexes', async () => {
    disk = { exams: [{ date: '2026-03-01' }, { date: '2025-01-01' }] };
    const { exams } = await getEyeExams();
    expect(exams.every(e => e.id)).toBe(true);
    expect(disk.exams.map(e => e.date)).toEqual(['2025-01-01', '2026-03-01']);
    expect(disk.exams.every(e => e.id)).toBe(true);
    expect(await resolveEyeExamId('0')).toBe(exams[0].id);
    expect(await resolveEyeExamId('9')).toBeNull();
    const removedId = await resolveEyeExamId('0');
    await removeEyeExam(removedId);
    expect(disk.exams.map(e => e.date)).toEqual(['2026-03-01']);
    // The delete leaves a marker for peers; readers never see it.
    expect(disk.rowTombstones.map(t => t.id)).toEqual([removedId]);
    expect(await getEyeExams()).not.toHaveProperty('rowTombstones');
  });

  it('gives the same legacy exam the same id on every machine (#12432)', async () => {
    const legacy = { date: '2025-01-01', leftSphere: -1.5 };
    disk = { exams: [{ ...legacy }] };
    const first = (await getEyeExams()).exams[0].id;
    // A second machine stamping its own copy of the same row lands on the same id.
    disk = { exams: [{ ...legacy }] };
    const second = (await getEyeExams()).exams[0].id;
    expect(first).toMatch(/^legacy-/);
    expect(second).toBe(first);
  });

  it('tombstones a legacy exam under its content key too, so a peer copy with another id stays deleted', async () => {
    disk = { exams: [{ id: 'random-stamp-a', date: '2025-01-01', leftSphere: -1 }] };
    await removeEyeExam('random-stamp-a');
    expect(disk.rowTombstones.map(t => t.id).sort()).toEqual(
      ['random-stamp-a', expect.stringMatching(/^legacy-/)].sort(),
    );
  });

  it('edits and deletes an exam addressed by an id a sync retired into aliasIds', async () => {
    disk = { exams: [{ id: 'stamp-b', aliasIds: ['stamp-z'], createdAt: '2025-01-01T00:00:00.000Z', date: '2025-01-01', leftSphere: -1 }] };
    expect((await updateEyeExam('stamp-z', { leftSphere: -2 })).id).toBe('stamp-b');
    expect(disk.exams[0].leftSphere).toBe(-2);
    expect((await removeEyeExam('stamp-z')).id).toBe('stamp-b');
    expect(disk.exams).toEqual([]);
  });

  it('stamps createdAt on a new exam and updatedAt on an edit, so peers resolve copies by clock', async () => {
    const exam = await addEyeExam({ date: '2025-01-01' });
    expect(exam.createdAt).toEqual(expect.any(String));
    // A minted exam keeps its id through the legacy re-keying read.
    expect((await getEyeExams()).exams[0].id).toBe(exam.id);
    const updated = await updateEyeExam(exam.id, { leftSphere: -2 });
    expect(updated.updatedAt).toEqual(expect.any(String));
  });
});

// =============================================================================
// LOG PRIVACY (#14157): the log stream is forwarded to every logs:line subscriber
// and outlives the record, so health values must never be interpolated into it.
// =============================================================================

describe('health write logging', () => {
  const captureConsole = () => {
    const lines = [];
    const sink = (...args) => { lines.push(args.join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(sink);
    vi.spyOn(console, 'error').mockImplementation(sink);
    vi.spyOn(console, 'warn').mockImplementation(sink);
    return lines;
  };

  it('keeps blood-pressure numbers out of the log on save', async () => {
    const lines = captureConsole();
    readJSONFile.mockResolvedValue({ entries: [] });
    await addBloodPressureReading({ date: '2024-02-01', systolic: 173, diastolic: 107 });
    const out = lines.join('\n');
    expect(out).toContain('Blood pressure reading logged for 2024-02-01');
    expect(out).not.toMatch(/173|107/);
    vi.restoreAllMocks();
  });

  it('keeps the workout type text out of the log on save', async () => {
    const lines = captureConsole();
    readJSONFile.mockResolvedValue({ workouts: [] });
    await addWorkout({ date: '2024-02-01', type: 'zz-synthetic-workout-marker', durationMinutes: 30 });
    const out = lines.join('\n');
    expect(out).toContain('Workout logged for 2024-02-01');
    expect(out).not.toContain('zz-synthetic-workout-marker');
    vi.restoreAllMocks();
  });

  it('keeps blood-pressure numbers out of the log on delete', async () => {
    const lines = captureConsole();
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-02-01', bloodPressureSystolic: 173, bloodPressureDiastolic: 107, heartRate: 60 }]
    });
    await removeBloodPressureReading('2024-02-01');
    const out = lines.join('\n');
    expect(out).toContain('Blood pressure reading removed for 2024-02-01');
    expect(out).not.toMatch(/173|107/);
    const written = JSON.parse(writeFile.mock.calls[0][1]);
    expect(written.entries[0]).toEqual({ date: '2024-02-01', heartRate: 60 });
    vi.restoreAllMocks();
  });
});

describe('health record erasure', () => {
  let files;
  const bloodFile = join('/mock/data/meatspace', 'blood-tests.json');
  const logFile = join('/mock/data/meatspace', 'daily-log.json');
  const workoutFile = join('/mock/data/meatspace', 'workouts.json');
  beforeEach(() => {
    files = {};
    readJSONFile.mockImplementation(async (file, fallback) => structuredClone(files[file] ?? fallback));
    writeFile.mockImplementation(async (file, payload) => { files[file] = JSON.parse(payload); });
  });
  afterEach(() => {
    isMortalLoomEnabled.mockResolvedValue(false);
    mlArrayIfEnabled.mockResolvedValue(null);
  });

  it('stamps a blood panel and tombstones the legacy content key', async () => {
    files[bloodFile] = { tests: [{ date: '2026-04-02', homocysteine: 7 }], referenceRanges: {} };
    const listed = await getBloodTests();
    expect(listed.tests[0].id).toMatch(/^legacy-/);
    expect(listed).not.toHaveProperty('rowTombstones');
    const removed = await removeBloodTest(listed.tests[0].id);
    expect(removed.date).toBe('2026-04-02');
    expect(files[bloodFile].tests).toEqual([]);
    expect(files[bloodFile].rowTombstones.map(t => t.id)).toContain(listed.tests[0].id);
    expect((await getBloodTests()).tests).toEqual([]);
  });

  it('removes a MortalLoom blood test by the id the read model keeps', async () => {
    isMortalLoomEnabled.mockResolvedValue(true);
    mlArrayIfEnabled.mockImplementation(async (key) => (
      key === 'bloodTests' ? [{ id: 'BLOOD1', date: '2026-04-02', markers: { homocysteine: 7 } }] : null
    ));
    readJSONFile.mockResolvedValue({ tests: [], referenceRanges: {} });
    mlRemoveById.mockResolvedValue({ id: 'BLOOD1', date: '2026-04-02', markers: { homocysteine: 7 } });
    const removed = await removeBloodTest('BLOOD1');
    expect(mlRemoveById).toHaveBeenCalledWith('bloodTests', 'BLOOD1');
    expect(removed).toMatchObject({ id: 'BLOOD1', date: '2026-04-02', homocysteine: 7 });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('clears a MortalLoom blood-pressure reading through the field clear, not a null upsert', async () => {
    isMortalLoomEnabled.mockResolvedValue(true);
    mlClearHealthMetricFields.mockResolvedValue({
      date: '2026-04-02', bloodPressureSystolic: 118, bloodPressureDiastolic: 76
    });
    const removed = await removeBloodPressureReading('2026-04-02');
    expect(mlClearHealthMetricFields).toHaveBeenCalledWith(
      '2026-04-02',
      ['bloodPressureSystolic', 'bloodPressureDiastolic']
    );
    expect(removed).toEqual({ date: '2026-04-02', systolic: 118, diastolic: 76 });
  });

  it('hides a body entry whose deletion is newer than its clock and clears that marker on re-log', async () => {
    files[logFile] = {
      entries: [{ date: '2026-04-02', body: { weightLbs: 180 }, bodyDeletedAt: '2026-05-01T00:00:00.000Z' }],
      lastEntryDate: '2026-04-02'
    };
    expect(await getBodyHistory()).toEqual([]);
    const again = await addBodyEntry({ date: '2026-04-02', weightLbs: 170 });
    expect(again.weightLbs).toBe(170);
    expect(files[logFile].entries[0].bodyDeletedAt).toBeUndefined();
    expect(files[logFile].entries[0].body.weightLbs).toBe(170);
    expect(Date.parse(files[logFile].entries[0].body.updatedAt)).toBeGreaterThan(Date.parse('2026-05-01T00:00:00.000Z'));
  });

  it('removes a workout by id and leaves the type out of the log', async () => {
    const lines = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
    files[workoutFile] = { workouts: [] };
    const entry = await addWorkout({ date: '2026-04-02', type: 'Example walk', durationMinutes: 20 });
    await removeWorkout(entry.id);
    expect(await getWorkouts()).toEqual([]);
    expect(lines.join('\n')).not.toContain('Example walk');
    expect(lines.join('\n')).toContain(entry.id);
    vi.restoreAllMocks();
  });
});
