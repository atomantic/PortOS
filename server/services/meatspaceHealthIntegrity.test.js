import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const hooks = vi.hoisted(() => ({ afterRead: null }));
vi.mock('../lib/fileUtils.js', async (original) => {
  const actual = await original();
  return makePathsProxy(actual, {
    dataRoot: () => lazyTempDataRoot('portos-mortalloom-import-'),
    overrides: {
      dataPath: (...parts) => join(lazyTempDataRoot('portos-mortalloom-import-'), ...parts),
      readJSONFile: async (...args) => {
        const value = await actual.readJSONFile(...args);
        await hooks.afterRead?.(args[0]);
        return value;
      },
    },
  });
});
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-mortalloom-import-'),
}));
vi.mock('./settings.js', async () => {
  const { EventEmitter } = await import('events');
  return { settingsEvents: new EventEmitter(), getSettings: async () => ({
    mortalloom: { enabled: false, path: join(lazyTempDataRoot('portos-mortalloom-import-'), 'source.json') },
  }) };
});

import { PATHS } from '../lib/fileUtils.js';
import { importToPortOS } from './mortalLoomStore.js';
import { addBloodTest, addBloodPressureReading, addWorkout, getBloodTests, getEpigeneticTests, getEyeExams, getBloodPressureHistory, getWorkouts } from './meatspaceHealth.js';

const localPath = (name) => join(PATHS.meatspace, name);
async function seed(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
const source = (value) => seed(join(PATHS.data, 'source.json'), value);
const read = async (name) => JSON.parse(await readFile(localPath(name), 'utf8'));

beforeEach(async () => {
  hooks.afterRead = null;
  await rm(PATHS.data, { recursive: true, force: true });
  await mkdir(PATHS.data, { recursive: true });
});
afterAll(cleanupTempDataRoots);

it('imports into the health reader contracts while preserving local rows and wrapper metadata', async () => {
  await source({
    bloodTests: [{ id: 'incoming-blood', date: '2026-01-02', markers: { homocysteine: 8 } }],
    epigeneticTests: [{ id: 'incoming-epigenetic', date: '2026-01-02', biologicalAge: 30 }],
    eyeExams: [{ id: 'incoming-eye', date: '2026-01-02', notes: 'Example exam' }],
    healthMetrics: [{ id: 'incoming-metric', date: '2026-01-02', bloodPressureSystolic: 120, bloodPressureDiastolic: 80 }],
  });
  await seed(localPath('blood-tests.json'), { tests: [{ id: 'local-blood', date: '2026-01-01' }], referenceRanges: { homocysteine: [5, 15] } });
  await seed(localPath('epigenetic-tests.json'), { tests: [{ id: 'local-epigenetic', date: '2026-01-01' }] });
  await seed(localPath('eyes.json'), { exams: [{ id: 'local-eye', date: '2026-01-01' }], rowTombstones: [{ id: 'deleted-eye', deletedAt: '2026-01-01' }] });
  await seed(localPath('health-metrics.json'), { entries: [{ date: '2026-01-01', bloodPressureSystolic: 110, bloodPressureDiastolic: 70 }] });

  expect(await importToPortOS()).toMatchObject({ ok: true, added: { bloodTests: 1, epigeneticTests: 1, eyeExams: 1, healthMetrics: 1 } });
  expect(await getBloodTests()).toEqual({ tests: [{ id: 'local-blood', date: '2026-01-01' }, { id: 'incoming-blood', date: '2026-01-02', homocysteine: 8 }], referenceRanges: { homocysteine: [5, 15] } });
  expect((await getEpigeneticTests()).tests.map(row => row.id)).toEqual(['local-epigenetic', 'incoming-epigenetic']);
  expect((await getEyeExams()).exams.map(row => row.id)).toEqual(['local-eye', 'incoming-eye']);
  expect((await read('eyes.json')).rowTombstones).toEqual([{ id: 'deleted-eye', deletedAt: '2026-01-01' }]);
  expect(await getBloodPressureHistory()).toEqual([{ date: '2026-01-01', systolic: 110, diastolic: 70 }, { date: '2026-01-02', systolic: 120, diastolic: 80 }]);
});

it('initializes absent health stores and coalesces overlapping imports', async () => {
  await source({
    bloodTests: [{ id: 'incoming-blood', date: '2026-01-02', markers: { homocysteine: 8 } }],
    healthMetrics: [{ id: 'incoming-metric', date: '2026-01-02', bloodPressureSystolic: 120, bloodPressureDiastolic: 80 }],
  });
  const reports = await Promise.all([importToPortOS(), importToPortOS()]);
  expect(reports.reduce((sum, report) => sum + report.added.bloodTests, 0)).toBe(1);
  expect((await getBloodTests()).tests).toEqual([{ id: 'incoming-blood', date: '2026-01-02', homocysteine: 8 }]);
  expect(await getBloodPressureHistory()).toEqual([{ date: '2026-01-02', systolic: 120, diastolic: 80 }]);
});

it('deduplicates within a batch and on retry without replacing local edits or reviving deletions', async () => {
  const incoming = { id: 'incoming-eye', date: '2026-01-02', notes: 'Original' };
  await source({ eyeExams: [incoming, incoming, { id: 'deleted-eye', date: '2026-01-01' }] });
  await seed(localPath('eyes.json'), { exams: [], rowTombstones: [{ id: 'deleted-eye', deletedAt: '2026-01-03' }] });
  expect(await importToPortOS()).toMatchObject({ added: { eyeExams: 1 }, skipped: { eyeExams: 2 } });
  const data = await read('eyes.json');
  data.exams[0].notes = 'Local edit';
  await seed(localPath('eyes.json'), data);
  expect(await importToPortOS()).toMatchObject({ added: { eyeExams: 0 }, skipped: { eyeExams: 3 } });
  expect((await getEyeExams()).exams).toEqual([{ ...incoming, notes: 'Local edit' }]);
});

it('merges against a local health write committed after import preflight', async () => {
  await source({ bloodTests: [{ id: 'imported', date: '2026-01-03', markers: {} }] });
  await seed(localPath('blood-tests.json'), { tests: [{ id: 'retained', date: '2026-01-01' }] });
  hooks.afterRead = async (path) => {
    if (path !== localPath('blood-tests.json')) return;
    hooks.afterRead = null;
    await addBloodTest({ id: 'concurrent', date: '2026-01-02' });
  };
  await importToPortOS();
  expect((await getBloodTests()).tests.map(row => row.id)).toEqual(['retained', 'concurrent', 'imported']);
});

it('retains all concurrently submitted local blood-pressure readings', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, index) => addBloodPressureReading({
    date: `2026-01-0${index + 1}`, systolic: 120 + index, diastolic: 80,
  })));
  expect(await getBloodPressureHistory()).toHaveLength(8);
});

it('retains all concurrently submitted local workouts', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, index) => addWorkout({
    date: `2026-01-0${index + 1}`, type: 'Example exercise', durationMinutes: 30,
  })));
  expect(await getWorkouts()).toHaveLength(8);
});

it.each([
  ['source collection', { bloodTests: {} }, { tests: [] }],
  ['destination wrapper', { bloodTests: [{ id: 'incoming', date: '2026-01-02' }] }, { tests: 'invalid' }],
])('refuses a malformed %s before importing any goals or health records', async (_label, incoming, local) => {
  const goals = { goals: [{ id: 'retained-goal' }] };
  await source({ ...incoming, goals: [{ id: 'incoming-goal' }] });
  await seed(join(PATHS.digitalTwin, 'goals.json'), goals);
  await seed(localPath('blood-tests.json'), local);
  await expect(importToPortOS()).rejects.toThrow(/malformed/i);
  expect(JSON.parse(await readFile(join(PATHS.digitalTwin, 'goals.json'), 'utf8'))).toEqual(goals);
  expect(await read('blood-tests.json')).toEqual(local);
});
