/**
 * MeatSpace Health Service
 *
 * Blood tests, body composition, epigenetic tests, and eyes CRUD.
 * When MortalLoom iCloud sync is enabled, reads and writes are mirrored
 * to the shared MortalLoom.json; otherwise local PortOS data files are used.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import {
  isMortalLoomEnabled,
  mlArrayIfEnabled,
  mlPush,
  mlPatchById,
  mlRemoveById
} from './mortalLoomStore.js';

const MEATSPACE_DIR = PATHS.meatspace;
const DAILY_LOG_FILE = join(MEATSPACE_DIR, 'daily-log.json');
const BLOOD_TESTS_FILE = join(MEATSPACE_DIR, 'blood-tests.json');
const EPIGENETIC_TESTS_FILE = join(MEATSPACE_DIR, 'epigenetic-tests.json');
const EYES_FILE = join(MEATSPACE_DIR, 'eyes.json');

const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');

async function writeLocal(file, data) {
  await ensureDir(MEATSPACE_DIR);
  await writeFile(file, JSON.stringify(data, null, 2));
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
  const data = await getBloodTests();
  data.tests.push(test);
  data.tests.sort(byDate);
  await writeLocal(BLOOD_TESTS_FILE, data);
  console.log(`🩸 Blood test added for ${test.date}`);
  return test;
}

export async function saveBloodTests(data) {
  await writeLocal(BLOOD_TESTS_FILE, data);
}

// === Body Composition ===

export async function getBodyHistory() {
  const ml = await mlArrayIfEnabled('bodyEntries');
  if (ml) return ml.map(({ id, ...rest }) => rest).sort(byDate);
  const log = await readJSONFile(DAILY_LOG_FILE, { entries: [] });
  return (log.entries || [])
    .filter(e => e.body && Object.keys(e.body).length > 0)
    .map(e => ({ date: e.date, ...e.body }))
    .sort(byDate);
}

export async function addBodyEntry({ date, ...body }) {
  const targetDate = date || new Date().toISOString().split('T')[0];

  if (await isMortalLoomEnabled()) {
    const stored = await mlPush('bodyEntries', { date: targetDate, ...body });
    console.log(`⚖️ Body entry added for ${targetDate} (MortalLoom)`);
    const { id, ...rest } = stored;
    return rest;
  }

  const log = await readJSONFile(DAILY_LOG_FILE, { entries: [], lastEntryDate: null });
  let entry = log.entries.find(e => e.date === targetDate);
  if (!entry) { entry = { date: targetDate }; log.entries.push(entry); }
  entry.body = { ...(entry.body || {}), ...body };
  log.entries.sort(byDate);
  log.lastEntryDate = log.entries.at(-1).date;
  await writeLocal(DAILY_LOG_FILE, log);
  console.log(`⚖️ Body entry added for ${targetDate}`);
  return { date: targetDate, ...entry.body };
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
  const data = await getEpigeneticTests();
  data.tests.push(test);
  data.tests.sort(byDate);
  await writeLocal(EPIGENETIC_TESTS_FILE, data);
  console.log(`🧬 Epigenetic test added for ${test.date}`);
  return test;
}

// === Eyes ===

export async function getEyeExams() {
  const ml = await mlArrayIfEnabled('eyeExams');
  if (ml) return { exams: [...ml].sort(byDate) };
  return readJSONFile(EYES_FILE, { exams: [] });
}

export async function addEyeExam(exam) {
  if (await isMortalLoomEnabled()) {
    const stored = await mlPush('eyeExams', exam);
    console.log(`👁️ Eye exam added for ${stored.date} (MortalLoom)`);
    return stored;
  }
  const data = await getEyeExams();
  data.exams.push(exam);
  data.exams.sort(byDate);
  await writeLocal(EYES_FILE, data);
  console.log(`👁️ Eye exam added for ${exam.date}`);
  return exam;
}

const EYE_FIELDS = ['date', 'leftSphere', 'leftCylinder', 'leftAxis', 'rightSphere', 'rightCylinder', 'rightAxis'];

export async function updateEyeExam(index, updates) {
  const data = await getEyeExams();
  if (index < 0 || index >= data.exams.length) return null;
  const exam = data.exams[index];
  const patch = Object.fromEntries(EYE_FIELDS.filter(k => updates[k] !== undefined).map(k => [k, updates[k]]));

  if (await isMortalLoomEnabled() && exam.id) {
    const updated = await mlPatchById('eyeExams', exam.id, patch);
    console.log(`👁️ Eye exam updated: ${updated?.date} (MortalLoom)`);
    return updated;
  }

  Object.assign(exam, patch);
  data.exams.sort(byDate);
  await writeLocal(EYES_FILE, data);
  console.log(`👁️ Eye exam updated at index ${index}: ${exam.date}`);
  return exam;
}

export async function removeEyeExam(index) {
  const data = await getEyeExams();
  if (index < 0 || index >= data.exams.length) return null;
  const target = data.exams[index];

  if (await isMortalLoomEnabled() && target.id) {
    const removed = await mlRemoveById('eyeExams', target.id);
    console.log(`👁️ Eye exam removed: ${removed?.date} (MortalLoom)`);
    return removed;
  }

  const [removed] = data.exams.splice(index, 1);
  await writeLocal(EYES_FILE, data);
  console.log(`👁️ Eye exam removed: ${removed.date}`);
  return removed;
}
