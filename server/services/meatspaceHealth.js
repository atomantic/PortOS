/**
 * MeatSpace Health Service
 *
 * Blood tests, body composition, epigenetic tests, and eyes CRUD.
 * When MortalLoom iCloud sync is enabled, reads and writes are mirrored
 * to the shared MortalLoom.json; otherwise local PortOS data files are used.
 */

import { invalidateMeatspace } from './meatspaceEvents.js';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWrite, PATHS, ensureDir, readJSONFile, getDateString } from '../lib/fileUtils.js';
import { readLocalDailyLog, mutateDailyLog } from './meatspaceDailyLog.js';
import { queueHealthWrite } from './meatspaceWriteQueues.js';
import {
  isMortalLoomEnabled,
  mlArrayIfEnabled,
  mlPush,
  mlPatchById,
  mlRemoveById,
  mlUpsertHealthMetricByDate
} from './mortalLoomStore.js';

const MEATSPACE_DIR = PATHS.meatspace;
const BLOOD_TESTS_FILE = join(MEATSPACE_DIR, 'blood-tests.json');
const EPIGENETIC_TESTS_FILE = join(MEATSPACE_DIR, 'epigenetic-tests.json');
const EYES_FILE = join(MEATSPACE_DIR, 'eyes.json');
const HEALTH_METRICS_FILE = join(MEATSPACE_DIR, 'health-metrics.json');
const WORKOUTS_FILE = join(MEATSPACE_DIR, 'workouts.json');

const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');

// Every read-modify-write of the three files below runs inside `queueHealthWrite`
// — the queue the federation snapshot apply (`dataSync.js`) also uses — so a peer
// snapshot cannot overwrite a record added between its read and its write.
// `writeLocal` itself is NOT queued: callers already hold the queue.
async function writeLocal(file, data) {
  await ensureDir(MEATSPACE_DIR);
  await atomicWrite(file, data);
  const resource = { [BLOOD_TESTS_FILE]: 'blood', [EPIGENETIC_TESTS_FILE]: 'epigenetic', [EYES_FILE]: 'eyes' }[file];
  if (resource) invalidateMeatspace([resource]);
}

// === Blood Tests ===
// Shape reconciliation: MortalLoom nests markers under `markers`; PortOS's
// BloodTestCard iterates top-level numeric fields, so we flatten on read
// and re-nest on write.

export async function getBloodTests() {
  const local = await readJSONFile(BLOOD_TESTS_FILE, { tests: [], referenceRanges: {} });
  const ml = await mlArrayIfEnabled('bloodTests');
  if (!ml) return local;
  const tests = ml
    .map(({ id, markers, ...rest }) => ({ ...rest, ...(markers || {}) }))
    .sort(byDate);
  return { tests, referenceRanges: local.referenceRanges || {} };
}

export async function addBloodTest(test) {
  if (await isMortalLoomEnabled()) {
    const { date, id, markers, ...flat } = test;
    const stored = await mlPush('bloodTests', { date, markers: { ...(markers || {}), ...flat } });
    return { date: stored.date, ...(stored.markers || {}) };
  }
  await queueHealthWrite(async () => {
    const data = await getBloodTests();
    data.tests.push(test);
    data.tests.sort(byDate);
    await writeLocal(BLOOD_TESTS_FILE, data);
  });
  console.log(`🩸 Blood test added for ${test.date}`);
  return test;
}

// === Body Composition ===

/**
 * @param {{ strict?: boolean }} [options] - `strict: true` throws when the daily log
 *   is present-but-unreadable/corrupt rather than reporting zero body entries
 *   (#2726). Off by default — existing callers keep the empty fallback.
 */
export async function getBodyHistory({ strict = false } = {}) {
  // Body entries come from MortalLoom's own `bodyEntries` array, NOT the composed
  // daily log the alcohol/nicotine services probe — so this reads the local mirror
  // directly rather than going through `loadMeatspaceDailyLog`. Routing it through
  // the composed view would turn "MortalLoom is on but has no bodyEntries key" into
  // a non-null empty log and stop the fall-through to the local file entirely.
  const ml = await mlArrayIfEnabled('bodyEntries', { strict });
  if (ml) return ml.map(({ id, ...rest }) => rest).sort(byDate);
  const log = await readLocalDailyLog({ strict, label: 'Health' });
  return (log.entries || [])
    .filter(e => e.body && Object.keys(e.body).length > 0)
    .map(e => ({ date: e.date, ...e.body }))
    .sort(byDate);
}

export async function addBodyEntry({ date, ...body }) {
  const targetDate = date || getDateString(); // local calendar day (matches alcohol/nicotine + dashboard streak)

  if (await isMortalLoomEnabled()) {
    const stored = await mlPush('bodyEntries', { date: targetDate, ...body });
    console.log(`⚖️ Body entry added for ${targetDate} (MortalLoom)`);
    const { id, ...rest } = stored;
    return rest;
  }

  const result = await mutateDailyLog((log) => {
    let entry = log.entries.find(e => e.date === targetDate);
    if (!entry) { entry = { date: targetDate }; log.entries.push(entry); }
    entry.body = { ...(entry.body || {}), ...body };
    return { date: targetDate, ...entry.body };
  }, { label: 'Health' });

  console.log(`⚖️ Body entry added for ${targetDate}`);
  return result;
}

// === Epigenetic Tests ===

export async function getEpigeneticTests() {
  const ml = await mlArrayIfEnabled('epigeneticTests');
  if (ml) return { tests: [...ml].sort(byDate) };
  return readJSONFile(EPIGENETIC_TESTS_FILE, { tests: [] });
}

export async function addEpigeneticTest(test) {
  if (await isMortalLoomEnabled()) {
    const stored = await mlPush('epigeneticTests', test);
    console.log(`🧬 Epigenetic test added for ${stored.date} (MortalLoom)`);
    return stored;
  }
  await queueHealthWrite(async () => {
    const data = await getEpigeneticTests();
    data.tests.push(test);
    data.tests.sort(byDate);
    await writeLocal(EPIGENETIC_TESTS_FILE, data);
  });
  console.log(`🧬 Epigenetic test added for ${test.date}`);
  return test;
}

// === Eyes ===

const readLocalEyes = async () => {
  const data = await readJSONFile(EYES_FILE, { exams: [] });
  return { data, exams: Array.isArray(data?.exams) ? data.exams : [] };
};

/**
 * Local eyes.json with every row id-stamped. MUST run inside `queueHealthWrite`:
 * legacy rows have no id, so stamping rewrites the file.
 */
async function loadLocalEyeExamsQueued() {
  const { data, exams } = await readLocalEyes();
  // Legacy eyes.json rows have no id. Stamp and persist them once so the ids
  // the client reads back are the ones later edits/deletes resolve.
  if (exams.some(e => !e.id)) {
    for (const e of exams) e.id ||= randomUUID();
    exams.sort(byDate);
    await writeLocal(EYES_FILE, { ...data, exams });
  }
  return { ...data, exams };
}

export async function getEyeExams() {
  const ml = await mlArrayIfEnabled('eyeExams');
  if (ml) return { exams: [...ml].sort(byDate) };
  const { data, exams } = await readLocalEyes();
  // Only a legacy file needs the (queued) stamping write; the common read stays lock-free.
  if (exams.some(e => !e.id)) return queueHealthWrite(loadLocalEyeExamsQueued);
  return { ...data, exams };
}

/** Resolve an eye exam id, or a legacy numeric index into the date-sorted list, to an id. */
export async function resolveEyeExamId(ref) {
  if (typeof ref === 'string' && /^\d+$/.test(ref)) {
    const { exams } = await getEyeExams();
    return exams[Number(ref)]?.id ?? null;
  }
  return ref;
}

export async function addEyeExam(exam) {
  if (await isMortalLoomEnabled()) {
    const stored = await mlPush('eyeExams', exam);
    console.log(`👁️ Eye exam added for ${stored.date} (MortalLoom)`);
    return stored;
  }
  const stored = { ...exam, id: exam.id || randomUUID() };
  await queueHealthWrite(async () => {
    const data = await loadLocalEyeExamsQueued();
    data.exams.push(stored);
    data.exams.sort(byDate);
    await writeLocal(EYES_FILE, data);
  });
  console.log(`👁️ Eye exam added for ${stored.date}`);
  return stored;
}

const EYE_FIELDS = ['date', 'leftSphere', 'leftCylinder', 'leftAxis', 'rightSphere', 'rightCylinder', 'rightAxis'];

export async function updateEyeExam(id, updates) {
  const patch = Object.fromEntries(EYE_FIELDS.filter(k => updates[k] !== undefined).map(k => [k, updates[k]]));

  if (await isMortalLoomEnabled()) {
    const exam = (await getEyeExams()).exams.find(e => e.id === id);
    if (!exam) return null;
    const updated = await mlPatchById('eyeExams', exam.id, patch);
    console.log(`👁️ Eye exam updated: ${updated?.date} (MortalLoom)`);
    return updated;
  }

  const exam = await queueHealthWrite(async () => {
    const data = await loadLocalEyeExamsQueued();
    const target = data.exams.find(e => e.id === id);
    if (!target) return null;
    Object.assign(target, patch);
    data.exams.sort(byDate);
    await writeLocal(EYES_FILE, data);
    return target;
  });
  if (exam) console.log(`👁️ Eye exam updated ${id}: ${exam.date}`);
  return exam;
}

export async function removeEyeExam(id) {
  if (await isMortalLoomEnabled()) {
    const target = (await getEyeExams()).exams.find(e => e.id === id);
    if (!target) return null;
    const removed = await mlRemoveById('eyeExams', target.id);
    console.log(`👁️ Eye exam removed: ${removed?.date} (MortalLoom)`);
    return removed;
  }

  const target = await queueHealthWrite(async () => {
    const data = await loadLocalEyeExamsQueued();
    const found = data.exams.find(e => e.id === id);
    if (!found) return null;
    data.exams = data.exams.filter(e => e.id !== id);
    await writeLocal(EYES_FILE, data);
    return found;
  });
  if (target) console.log(`👁️ Eye exam removed: ${target.date}`);
  return target;
}

// === Workouts ===
// Local PortOS store (not mirrored to MortalLoom — the iCloud store has no
// `workouts` array key, and adding one would need a coordinated MortalLoom
// schema change). Voice/CoS log workouts here via addWorkout().

/**
 * @param {{ strict?: boolean }} [options] - `strict: true` throws when workouts.json
 *   is present-but-unreadable/corrupt rather than reporting zero workouts (#2726).
 */
export async function getWorkouts({ strict = false } = {}) {
  const data = await readJSONFile(WORKOUTS_FILE, { workouts: [] }, { strict });
  if (strict && !Array.isArray(data?.workouts)) {
    throw new Error(`Workouts malformed: ${WORKOUTS_FILE}`);
  }
  return (data.workouts || []).slice().sort(byDate);
}

export async function addWorkout({ date, type, durationMinutes, intensity, notes } = {}) {
  const targetDate = date || getDateString(); // local calendar day (matches alcohol/nicotine + dashboard streak)
  const trimmedType = typeof type === 'string' ? type.trim() : '';
  if (!trimmedType) throw new Error('workout type is required');
  const entry = {
    date: targetDate,
    type: trimmedType,
    durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
    intensity: typeof intensity === 'string' && intensity.trim() ? intensity.trim() : null,
    notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
  };
  const data = await readJSONFile(WORKOUTS_FILE, { workouts: [] });
  if (!Array.isArray(data.workouts)) data.workouts = [];
  data.workouts.push(entry);
  data.workouts.sort(byDate);
  await writeLocal(WORKOUTS_FILE, data);
  console.log(`🏋️ Workout logged: ${trimmedType}${entry.durationMinutes ? ` (${entry.durationMinutes}min)` : ''} for ${targetDate}`);
  return entry;
}

// === Blood Pressure ===
// Matches MortalLoom's HealthMetricEntry.bloodPressureSystolic/Diastolic (mmHg),
// upserted by date so multiple readings on the same day (e.g. from Apple Health
// sync + manual entry) merge into one row.

/**
 * @param {{ strict?: boolean }} [options] - `strict: true` throws when the health
 *   metrics file is present-but-unreadable/corrupt rather than reporting zero blood
 *   pressure readings (#2726).
 */
export async function getBloodPressureHistory({ strict = false } = {}) {
  const ml = await mlArrayIfEnabled('healthMetrics', { strict });
  const source = ml ?? (await readJSONFile(HEALTH_METRICS_FILE, { entries: [] }, { strict })).entries;
  if (strict && !Array.isArray(source)) {
    throw new Error(`Health metrics malformed: ${HEALTH_METRICS_FILE}`);
  }
  return source
    .filter(m => m?.bloodPressureSystolic != null && m?.bloodPressureDiastolic != null)
    .map(m => ({
      date: m.date,
      systolic: m.bloodPressureSystolic,
      diastolic: m.bloodPressureDiastolic
    }))
    .sort(byDate);
}

export async function addBloodPressureReading({ date, systolic, diastolic }) {
  const targetDate = date || getDateString(); // local calendar day (matches alcohol/nicotine + dashboard streak)
  const patch = { bloodPressureSystolic: systolic, bloodPressureDiastolic: diastolic };

  if (await isMortalLoomEnabled()) {
    await mlUpsertHealthMetricByDate(targetDate, patch);
    console.log(`🩺 Blood pressure ${systolic}/${diastolic} logged for ${targetDate} (MortalLoom)`);
    return { date: targetDate, systolic, diastolic };
  }

  const log = await readJSONFile(HEALTH_METRICS_FILE, { entries: [] });
  let entry = log.entries.find(e => e.date === targetDate);
  if (!entry) { entry = { date: targetDate }; log.entries.push(entry); }
  Object.assign(entry, patch);
  log.entries.sort(byDate);
  await writeLocal(HEALTH_METRICS_FILE, log);
  console.log(`🩺 Blood pressure ${systolic}/${diastolic} logged for ${targetDate}`);
  return { date: targetDate, systolic, diastolic };
}
