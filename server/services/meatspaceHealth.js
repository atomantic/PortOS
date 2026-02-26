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

// === Nutrition ===

export async function getNutritionSummary() {
  const log = await readJSONFile(DAILY_LOG_FILE, { entries: [] });
  const entries = (log.entries || []).filter(e => e.nutrition && Object.keys(e.nutrition).length > 0);

  if (entries.length === 0) {
    return { entries: [], averages: null, totalEntries: 0 };
  }

  // Compute averages
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

  // Last 7 days of nutrition
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];

  const recentEntries = entries
    .filter(e => e.date >= weekAgoStr && e.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    totalEntries: entries.length,
    averages,
    recentEntries
  };
}

export async function getDailyNutrition(from, to) {
  const log = await readJSONFile(DAILY_LOG_FILE, { entries: [] });
  let entries = (log.entries || []).filter(e => e.nutrition && Object.keys(e.nutrition).length > 0);

  if (from) entries = entries.filter(e => e.date >= from);
  if (to) entries = entries.filter(e => e.date <= to);

  return entries.map(e => ({ date: e.date, ...e.nutrition }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
