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
import { isPlainObject } from '../lib/objects.js';
import { parseTsMs } from '../lib/lwwTimestamp.js';
import { readLocalDailyLog, mutateDailyLog } from './meatspaceDailyLog.js';
import { queueHealthWrite } from './meatspaceWriteQueues.js';
import {
  normalizeLegacyRows,
  retainContentKey,
  rowAnswersTo,
  rowIdentityKeys,
  ROW_TOMBSTONES_KEY,
} from '../lib/meatspaceRowIdentity.js';
import { recordTombstone, supersedingTimestamp } from '../lib/tombstones.js';
import {
  isMortalLoomEnabled,
  mlArrayIfEnabled,
  mlPush,
  mlPatchById,
  mlRemoveById,
  mlRemoveWhere,
  mlUpsertHealthMetricByDate,
  mlClearHealthMetricFields,
  mlMergeClinicalBloodTests,
} from './mortalLoomStore.js';

const MEATSPACE_DIR = PATHS.meatspace;
const BLOOD_TESTS_FILE = join(MEATSPACE_DIR, 'blood-tests.json');
const EPIGENETIC_TESTS_FILE = join(MEATSPACE_DIR, 'epigenetic-tests.json');
const EYES_FILE = join(MEATSPACE_DIR, 'eyes.json');
const HEALTH_METRICS_FILE = join(MEATSPACE_DIR, 'health-metrics.json');
const WORKOUTS_FILE = join(MEATSPACE_DIR, 'workouts.json');

const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');

// Every read-modify-write of the local health files runs inside `queueHealthWrite`
// — the queue the federation snapshot apply (`dataSync.js`) also uses — so a peer
// snapshot cannot overwrite a record added between its read and its write.
// `writeLocal` itself is NOT queued: callers already hold the queue.
async function writeLocal(file, data) {
  await ensureDir(MEATSPACE_DIR);
  await atomicWrite(file, data);
  const resource = { [BLOOD_TESTS_FILE]: 'blood', [EPIGENETIC_TESTS_FILE]: 'epigenetic', [EYES_FILE]: 'eyes' }[file];
  if (resource) invalidateMeatspace([resource]);
}

// Deletion markers are sync metadata, not part of the lists callers read.
const withoutTombstones = ({ [ROW_TOMBSTONES_KEY]: _tombstones, ...rest }) => rest;

// Id-less rows take the content key every peer already computes, and no
// `createdAt` — a random id plus a clock would no longer match that copy.
// A non-array payload is left untouched (a malformed file must not be rewritten).
async function loadLocalRowUnionQueued(file, arrayKey) {
  // Strict: a present-but-unreadable file must throw, not become the empty
  // default that writeLocal would persist. An absent file still returns the default.
  const data = await readJSONFile(file, { [arrayKey]: [] }, { strict: true });
  if (!Array.isArray(data?.[arrayKey])) return data;
  const normalized = normalizeLegacyRows(data[arrayKey]);
  if (!normalized.changed) return data;
  normalized.rows.sort(byDate);
  const next = { ...data, [arrayKey]: normalized.rows };
  await writeLocal(file, next);
  return next;
}

async function readNormalizedRowUnion(file, arrayKey) {
  const data = await readJSONFile(file, { [arrayKey]: [] }, { strict: true });
  if (!Array.isArray(data?.[arrayKey])) return data;
  if (normalizeLegacyRows(data[arrayKey]).changed) {
    return withoutTombstones(await queueHealthWrite(() => loadLocalRowUnionQueued(file, arrayKey)));
  }
  return withoutTombstones(data);
}

const stampNewRow = (row) => ({
  ...row,
  id: row.id || randomUUID(),
  createdAt: row.createdAt || new Date().toISOString(),
});

const flattenBloodRow = ({ id, markers, ...rest }) => ({
  ...rest,
  ...(markers || {}),
  ...(id ? { id } : {}),
});

async function removeLocalRow(file, arrayKey, id) {
  return queueHealthWrite(async () => {
    const data = await loadLocalRowUnionQueued(file, arrayKey);
    if (!Array.isArray(data?.[arrayKey])) return null;
    const found = data[arrayKey].find(row => rowAnswersTo(row, id));
    if (!found) return null;
    data[arrayKey] = data[arrayKey].filter(row => row !== found);
    const deletedAt = new Date().toISOString();
    for (const key of rowIdentityKeys(found)) {
      data[ROW_TOMBSTONES_KEY] = recordTombstone(data[ROW_TOMBSTONES_KEY], key, { keyField: 'id', deletedAt });
    }
    await writeLocal(file, data);
    return found;
  });
}

// === Blood Tests ===
// Shape reconciliation: MortalLoom nests markers under `markers`; PortOS's
// BloodTestCard iterates top-level numeric fields, so we flatten on read
// and re-nest on write. The id stays on the read model so a delete can address
// the iCloud row.

export async function getBloodTests() {
  const ml = await mlArrayIfEnabled('bloodTests');
  if (ml) {
    const local = await readJSONFile(BLOOD_TESTS_FILE, { tests: [], referenceRanges: {} });
    return {
      tests: ml.map(flattenBloodRow).sort(byDate),
      referenceRanges: local.referenceRanges || {},
    };
  }
  return readNormalizedRowUnion(BLOOD_TESTS_FILE, 'tests');
}

export async function addBloodTest(test) {
  if (await isMortalLoomEnabled()) {
    const { date, id, markers, createdAt, updatedAt: _updatedAt, aliasIds: _aliasIds, ...flat } = test;
    const stored = await mlPush('bloodTests', {
      ...(id ? { id } : {}),
      createdAt: createdAt || new Date().toISOString(),
      date,
      markers: { ...(isPlainObject(markers) ? markers : {}), ...flat },
    });
    console.log(`🩸 Blood test added for ${stored.date}`);
    return flattenBloodRow(stored);
  }
  const stored = stampNewRow(test);
  await queueHealthWrite(async () => {
    const data = await loadLocalRowUnionQueued(BLOOD_TESTS_FILE, 'tests');
    if (!Array.isArray(data.tests)) throw new Error('Blood tests malformed');
    data.tests.push(stored);
    data.tests.sort(byDate);
    await writeLocal(BLOOD_TESTS_FILE, data);
  });
  console.log(`🩸 Blood test added for ${stored.date}`);
  return stored;
}

export async function removeBloodTest(id) {
  if (await isMortalLoomEnabled()) {
    const target = (await getBloodTests()).tests.find(row => row.id === id);
    if (!target) return null;
    const removed = await mlRemoveById('bloodTests', target.id);
    if (removed) console.log(`🩸 Blood test removed: ${removed.date} ${removed.id}`);
    return removed ? flattenBloodRow(removed) : null;
  }
  const target = await removeLocalRow(BLOOD_TESTS_FILE, 'tests', id);
  if (target) console.log(`🩸 Blood test removed: ${target.date} ${target.id}`);
  return target;
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
  if (ml) return [...ml].sort(byDate);
  const log = await readLocalDailyLog({ strict, label: 'Health' });
  return (log.entries || [])
    .filter(bodyIsLive)
    .map(e => ({ date: e.date, ...e.body }))
    .sort(byDate);
}

// A deletion newer than the weigh-in (or a weigh-in with no clock) stays hidden
// even if a peer merge has not dropped the object yet.
function bodyIsLive(entry) {
  if (!entry?.body || Object.keys(entry.body).length === 0) return false;
  const deletedMs = parseTsMs(entry.bodyDeletedAt);
  if (deletedMs === null) return true;
  const updatedMs = parseTsMs(entry.body.updatedAt);
  return updatedMs !== null && deletedMs <= updatedMs;
}

export async function addBodyEntry({ date, ...body }) {
  const targetDate = date || getDateString(); // local calendar day (matches alcohol/nicotine + dashboard streak)

  if (await isMortalLoomEnabled()) {
    const stored = await mlPush('bodyEntries', {
      date: targetDate,
      ...body,
      updatedAt: new Date().toISOString(),
    });
    console.log(`⚖️ Body entry added for ${targetDate} (MortalLoom)`);
    return stored;
  }

  const result = await mutateDailyLog((log) => {
    let entry = log.entries.find(e => e.date === targetDate);
    if (!entry) { entry = { date: targetDate }; log.entries.push(entry); }
    // updatedAt has to beat bodyDeletedAt even when both land in the same
    // millisecond, or the next sync would treat the re-log as the deleted copy.
    entry.body = { ...(entry.body || {}), ...body, updatedAt: supersedingTimestamp(entry.bodyDeletedAt) };
    delete entry.bodyDeletedAt;
    return { date: targetDate, ...entry.body };
  }, { label: 'Health' });

  console.log(`⚖️ Body entry added for ${targetDate}`);
  return result;
}

export async function removeBodyEntry(ref) {
  if (await isMortalLoomEnabled()) {
    const removed = await mlRemoveWhere('bodyEntries', row => row?.id === ref || row?.date === ref);
    if (removed.length === 0) return null;
    console.log(`⚖️ Body entry removed: ${removed.map(row => `${row.date} ${row.id}`).join(', ')}`);
    return removed[0];
  }

  const target = await mutateDailyLog((log) => {
    const entry = (log.entries || []).find(e => e.date === ref || e.body?.id === ref);
    if (!entry?.body || Object.keys(entry.body).length === 0) return null;
    const removed = { date: entry.date, ...entry.body };
    delete entry.body;
    entry.bodyDeletedAt = new Date().toISOString();
    return removed;
  }, { label: 'Health' });
  if (target) console.log(`⚖️ Body entry removed: ${target.date}`);
  return target;
}

// === Epigenetic Tests ===

export async function getEpigeneticTests() {
  const ml = await mlArrayIfEnabled('epigeneticTests');
  if (ml) return { tests: [...ml].sort(byDate) };
  return readNormalizedRowUnion(EPIGENETIC_TESTS_FILE, 'tests');
}

export async function addEpigeneticTest(test) {
  if (await isMortalLoomEnabled()) {
    const stored = await mlPush('epigeneticTests', {
      ...test,
      createdAt: test.createdAt || new Date().toISOString(),
    });
    console.log(`🧬 Epigenetic test added for ${stored.date} (MortalLoom)`);
    return stored;
  }
  const stored = stampNewRow(test);
  await queueHealthWrite(async () => {
    const data = await loadLocalRowUnionQueued(EPIGENETIC_TESTS_FILE, 'tests');
    if (!Array.isArray(data.tests)) throw new Error('Epigenetic tests malformed');
    data.tests.push(stored);
    data.tests.sort(byDate);
    await writeLocal(EPIGENETIC_TESTS_FILE, data);
  });
  console.log(`🧬 Epigenetic test added for ${stored.date}`);
  return stored;
}

export async function removeEpigeneticTest(id) {
  if (await isMortalLoomEnabled()) {
    const target = (await getEpigeneticTests()).tests.find(row => row.id === id);
    if (!target) return null;
    const removed = await mlRemoveById('epigeneticTests', target.id);
    if (removed) console.log(`🧬 Epigenetic test removed: ${removed.date} ${removed.id}`);
    return removed;
  }
  const target = await removeLocalRow(EPIGENETIC_TESTS_FILE, 'tests', id);
  if (target) console.log(`🧬 Epigenetic test removed: ${target.date} ${target.id}`);
  return target;
}

// === Eyes ===

const readLocalEyes = async () => {
  const data = await readJSONFile(EYES_FILE, { exams: [] });
  return { data, exams: Array.isArray(data?.exams) ? data.exams : [] };
};

/**
 * Local eyes.json with every row id-stamped. MUST run inside `queueHealthWrite`:
 * an id-less legacy row gets its content-derived id (the one every peer computes
 * for the same row) and the file is persisted once, so the ids the client reads
 * back are the ones later edits/deletes resolve.
 */
async function loadLocalEyeExamsQueued() {
  const { data, exams } = await readLocalEyes();
  const normalized = normalizeLegacyRows(exams);
  if (!normalized.changed) return { ...data, exams };
  normalized.rows.sort(byDate);
  const next = { ...data, exams: normalized.rows };
  await writeLocal(EYES_FILE, next);
  return next;
}

export async function getEyeExams() {
  const ml = await mlArrayIfEnabled('eyeExams');
  if (ml) return { exams: [...ml].sort(byDate) };
  const { data, exams } = await readLocalEyes();
  // Only a legacy file needs the (queued) stamping write; the common read stays lock-free.
  if (normalizeLegacyRows(exams).changed) return withoutTombstones(await queueHealthWrite(loadLocalEyeExamsQueued));
  return withoutTombstones({ ...data, exams });
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
  // `createdAt` marks a minted id: without it the row also matches peers by content.
  const stored = { ...exam, id: exam.id || randomUUID(), createdAt: new Date().toISOString() };
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
    // A sync may have retired the id the client holds into `aliasIds`.
    const index = data.exams.findIndex(e => rowAnswersTo(e, id));
    if (index === -1) return null;
    const before = data.exams[index];
    // `updatedAt` is the per-row clock the federation merge resolves copies by.
    const target = retainContentKey(before, { ...before, ...patch, updatedAt: new Date().toISOString() });
    data.exams[index] = target;
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
    const found = data.exams.find(e => rowAnswersTo(e, id));
    if (!found) return null;
    data.exams = data.exams.filter(e => e !== found);
    // The markers keep a peer that still holds the row from syncing it back —
    // under its content key too, for a copy the peer stamped with another id.
    const deletedAt = new Date().toISOString();
    for (const key of rowIdentityKeys(found)) {
      data[ROW_TOMBSTONES_KEY] = recordTombstone(data[ROW_TOMBSTONES_KEY], key, { keyField: 'id', deletedAt });
    }
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
async function loadWorkoutsQueued() {
  const data = await readJSONFile(WORKOUTS_FILE, { workouts: [] }, { strict: true });
  if (!Array.isArray(data?.workouts)) throw new Error('Workouts malformed');
  let changed = false;
  const workouts = data.workouts.map(row => {
    if (row && typeof row === 'object' && !row.id) {
      changed = true;
      return { ...row, id: randomUUID() };
    }
    return row;
  });
  if (!changed) return data;
  workouts.sort(byDate);
  const next = { ...data, workouts };
  await writeLocal(WORKOUTS_FILE, next);
  return next;
}

export async function getWorkouts({ strict = false } = {}) {
  const data = await readJSONFile(WORKOUTS_FILE, { workouts: [] }, { strict });
  if (strict && !Array.isArray(data?.workouts)) {
    throw new Error(`Workouts malformed: ${WORKOUTS_FILE}`);
  }
  const workouts = Array.isArray(data?.workouts) ? data.workouts : [];
  // Not federated, so a random id is enough for a row logged before ids existed.
  if (workouts.some(row => row && typeof row === 'object' && !row.id)) {
    const loaded = await queueHealthWrite(loadWorkoutsQueued);
    return loaded.workouts.slice().sort(byDate);
  }
  return workouts.slice().sort(byDate);
}

export async function addWorkout({ date, type, durationMinutes, intensity, notes } = {}) {
  const targetDate = date || getDateString(); // local calendar day (matches alcohol/nicotine + dashboard streak)
  const trimmedType = typeof type === 'string' ? type.trim() : '';
  if (!trimmedType) throw new Error('workout type is required');
  const entry = {
    id: randomUUID(),
    date: targetDate,
    type: trimmedType,
    durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
    intensity: typeof intensity === 'string' && intensity.trim() ? intensity.trim() : null,
    notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
  };
  await queueHealthWrite(async () => {
    const data = await loadWorkoutsQueued();
    data.workouts.push(entry);
    data.workouts.sort(byDate);
    await writeLocal(WORKOUTS_FILE, data);
  });
  console.log(`🏋️ Workout logged for ${targetDate}`);
  return entry;
}

export async function removeWorkout(id) {
  const target = await queueHealthWrite(async () => {
    const data = await loadWorkoutsQueued();
    const found = data.workouts.find(row => row?.id === id);
    if (!found) return null;
    data.workouts = data.workouts.filter(row => row !== found);
    await writeLocal(WORKOUTS_FILE, data);
    return found;
  });
  if (target) console.log(`🏋️ Workout removed: ${target.date} ${target.id}`);
  return target;
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
    console.log(`🩺 Blood pressure reading logged for ${targetDate} (MortalLoom)`);
    return { date: targetDate, systolic, diastolic };
  }

  await queueHealthWrite(async () => {
    const log = await readJSONFile(HEALTH_METRICS_FILE, { entries: [] }, { strict: true });
    if (!Array.isArray(log.entries)) throw new Error('Health metrics malformed');
    let entry = log.entries.find(e => e.date === targetDate);
    if (!entry) { entry = { date: targetDate }; log.entries.push(entry); }
    Object.assign(entry, patch);
    log.entries.sort(byDate);
    await writeLocal(HEALTH_METRICS_FILE, log);
  });
  console.log(`🩺 Blood pressure reading logged for ${targetDate}`);
  return { date: targetDate, systolic, diastolic };
}

const BLOOD_PRESSURE_FIELDS = ['bloodPressureSystolic', 'bloodPressureDiastolic'];

export async function removeBloodPressureReading(date) {
  if (await isMortalLoomEnabled()) {
    const removed = await mlClearHealthMetricFields(date, BLOOD_PRESSURE_FIELDS);
    if (!removed) return null;
    console.log(`🩺 Blood pressure reading removed for ${date} (MortalLoom)`);
    return {
      date,
      systolic: removed.bloodPressureSystolic,
      diastolic: removed.bloodPressureDiastolic,
    };
  }

  const target = await queueHealthWrite(async () => {
    const log = await readJSONFile(HEALTH_METRICS_FILE, { entries: [] }, { strict: true });
    if (!Array.isArray(log.entries)) throw new Error('Health metrics malformed');
    const entry = log.entries.find(e => e.date === date);
    if (!entry || (entry.bloodPressureSystolic == null && entry.bloodPressureDiastolic == null)) return null;
    const removed = { date, systolic: entry.bloodPressureSystolic, diastolic: entry.bloodPressureDiastolic };
    delete entry.bloodPressureSystolic;
    delete entry.bloodPressureDiastolic;
    const leftover = Object.keys(entry).filter(key => key !== 'date' && key !== 'id');
    if (leftover.length === 0) log.entries = log.entries.filter(e => e !== entry);
    await writeLocal(HEALTH_METRICS_FILE, log);
    return removed;
  });
  if (target) console.log(`🩺 Blood pressure reading removed for ${date}`);
  return target;
}

function stampImportedBloodRow(row, snapshots, now) {
  if (!row?.id) return { ...row, id: randomUUID(), createdAt: now };
  const prior = snapshots.get(row.id);
  // An analyte added to a legacy row changes its content key. Keep the old
  // key as an alias so a peer that still holds the pre-import copy matches.
  return prior ? retainContentKey(prior, row) : row;
}

async function mergeLocalReferenceRanges(fhirRanges) {
  const data = await readJSONFile(BLOOD_TESTS_FILE, { tests: [], referenceRanges: {} });
  const existing = isPlainObject(data?.referenceRanges) ? data.referenceRanges : {};
  const referenceRanges = { ...existing };
  let changed = false;
  for (const [key, range] of Object.entries(fhirRanges)) {
    if (!referenceRanges[key]) {
      referenceRanges[key] = range;
      changed = true;
    }
  }
  if (changed) await writeLocal(BLOOD_TESTS_FILE, { ...data, referenceRanges });
  return referenceRanges;
}

/**
 * Merge FHIR labs into the blood store inside the health write queue.
 * `mergeBloodTests` stays in the clinical module (this file must not import
 * it — that module already imports here). Rows that already have an id keep
 * it and do not gain `createdAt`; only a brand-new date is minted. Tombstones
 * already on the file are preserved. MortalLoom, when on, is updated in place
 * and is never written back over the local file.
 */
export async function commitClinicalBloodImport(fhirData, mergeBloodTests) {
  const fhirTests = Array.isArray(fhirData?.tests) ? fhirData.tests : [];
  const fhirRanges = isPlainObject(fhirData?.referenceRanges) ? fhirData.referenceRanges : {};
  if (await isMortalLoomEnabled()) {
    const merged = await mlMergeClinicalBloodTests(fhirTests);
    const referenceRanges = await queueHealthWrite(() => mergeLocalReferenceRanges(fhirRanges));
    return { tests: merged.tests, referenceRanges, newDates: merged.newDates };
  }
  return queueHealthWrite(async () => {
    const data = await loadLocalRowUnionQueued(BLOOD_TESTS_FILE, 'tests');
    if (!Array.isArray(data.tests)) throw new Error('Blood tests malformed');
    const existingDates = new Set(data.tests.map(row => row?.date));
    const snapshots = new Map(data.tests.filter(row => row?.id).map(row => [row.id, { ...row }]));
    const merged = mergeBloodTests(data, { tests: fhirTests, referenceRanges: fhirRanges });
    const now = new Date().toISOString();
    const tests = merged.tests.map(row => stampImportedBloodRow(row, snapshots, now));
    const next = { ...data, tests, referenceRanges: merged.referenceRanges };
    await writeLocal(BLOOD_TESTS_FILE, next);
    return {
      tests,
      referenceRanges: next.referenceRanges,
      newDates: tests.filter(row => !existingDates.has(row.date)).length,
    };
  });
}
