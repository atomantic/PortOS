/**
 * MeatSpace Health Service
 *
 * Blood tests, body composition, epigenetic tests, eyes, and nutrition CRUD.
 * Reads/writes to meatspace data files.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';

const MEATSPACE_DIR = PATHS.meatspace;
const DAILY_LOG_FILE = join(MEATSPACE_DIR, 'daily-log.json');
const BLOOD_TESTS_FILE = join(MEATSPACE_DIR, 'blood-tests.json');
const EPIGENETIC_TESTS_FILE = join(MEATSPACE_DIR, 'epigenetic-tests.json');
const EYES_FILE = join(MEATSPACE_DIR, 'eyes.json');

async function ensureMeatspaceDir() {
  await ensureDir(MEATSPACE_DIR);
}

// === Blood Tests ===

export async function getBloodTests() {
  return readJSONFile(BLOOD_TESTS_FILE, { tests: [], referenceRanges: {} });
}

export async function addBloodTest(test) {
  const data = await getBloodTests();
  data.tests.push(test);
  data.tests.sort((a, b) => a.date.localeCompare(b.date));
  await ensureMeatspaceDir();
  await writeFile(BLOOD_TESTS_FILE, JSON.stringify(data, null, 2));
  console.log(`🩸 Blood test added for ${test.date}`);
  return test;
}

// === Body Composition ===

export async function getBodyHistory() {
  const log = await readJSONFile(DAILY_LOG_FILE, { entries: [] });
  return (log.entries || [])
    .filter(e => e.body && Object.keys(e.body).length > 0)
    .map(e => ({ date: e.date, ...e.body }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function addBodyEntry({ date, ...body }) {
  const log = await readJSONFile(DAILY_LOG_FILE, { entries: [], lastEntryDate: null });
  const targetDate = date || new Date().toISOString().split('T')[0];

  let entry = log.entries.find(e => e.date === targetDate);
  if (!entry) {
    entry = { date: targetDate };
    log.entries.push(entry);
  }

  entry.body = { ...(entry.body || {}), ...body };

  log.entries.sort((a, b) => a.date.localeCompare(b.date));
  log.lastEntryDate = log.entries[log.entries.length - 1].date;

  await ensureMeatspaceDir();
  await writeFile(DAILY_LOG_FILE, JSON.stringify(log, null, 2));
  console.log(`⚖️ Body entry added for ${targetDate}`);
  return { date: targetDate, ...entry.body };
}

// === Epigenetic Tests ===

export async function getEpigeneticTests() {
  return readJSONFile(EPIGENETIC_TESTS_FILE, { tests: [] });
}

export async function addEpigeneticTest(test) {
  const data = await getEpigeneticTests();
  data.tests.push(test);
  data.tests.sort((a, b) => a.date.localeCompare(b.date));
  await ensureMeatspaceDir();
  await writeFile(EPIGENETIC_TESTS_FILE, JSON.stringify(data, null, 2));
  console.log(`🧬 Epigenetic test added for ${test.date}`);
  return test;
}

// === Eyes ===

export async function getEyeExams() {
  return readJSONFile(EYES_FILE, { exams: [] });
}

export async function addEyeExam(exam) {
  const data = await getEyeExams();
  data.exams.push(exam);
  data.exams.sort((a, b) => a.date.localeCompare(b.date));
  await ensureMeatspaceDir();
  await writeFile(EYES_FILE, JSON.stringify(data, null, 2));
  console.log(`👁️ Eye exam added for ${exam.date}`);
  return exam;
}

export async function updateEyeExam(index, updates) {
  const data = await getEyeExams();
  if (index < 0 || index >= data.exams.length) return null;

  const exam = data.exams[index];
  for (const key of ['date', 'leftSphere', 'leftCylinder', 'leftAxis', 'rightSphere', 'rightCylinder', 'rightAxis']) {
    if (updates[key] !== undefined) exam[key] = updates[key];
  }

  data.exams.sort((a, b) => a.date.localeCompare(b.date));
  await ensureMeatspaceDir();
  await writeFile(EYES_FILE, JSON.stringify(data, null, 2));
  console.log(`👁️ Eye exam updated at index ${index}: ${exam.date}`);
  return exam;
}

export async function removeEyeExam(index) {
  const data = await getEyeExams();
  if (index < 0 || index >= data.exams.length) return null;

  const [removed] = data.exams.splice(index, 1);
  await ensureMeatspaceDir();
  await writeFile(EYES_FILE, JSON.stringify(data, null, 2));
  console.log(`👁️ Eye exam removed: ${removed.date}`);
  return removed;
}

