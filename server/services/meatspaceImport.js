/**
 * MeatSpace TSV Import Service
 *
 * Parses the user's health spreadsheet (3 header rows + 2 summary rows + data).
 * Hardcoded column mapping for the specific 257-column layout.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir } from '../lib/fileUtils.js';

const MEATSPACE_DIR = PATHS.meatspace;
const DAILY_LOG_FILE = join(MEATSPACE_DIR, 'daily-log.json');
const BLOOD_TESTS_FILE = join(MEATSPACE_DIR, 'blood-tests.json');
const EPIGENETIC_TESTS_FILE = join(MEATSPACE_DIR, 'epigenetic-tests.json');
const EYES_FILE = join(MEATSPACE_DIR, 'eyes.json');

// Column indices (0-based), verified against actual TSV headers
const COL = {
  DATE: 2,
  // Nutrition (3-11)
  CALORIES: 3,
  FAT: 4,
  SAT_FAT: 5,
  TRANS_FAT: 6,
  POLY_FAT: 7,
  MONO_FAT: 8,
  CARBS: 9,
  FIBER: 10,
  SUGAR: 11,
  // Alcohol summary
  ALCOHOL_GRAMS: 12,
  // Body composition (16-21)
  WEIGHT_LBS: 16,
  WEIGHT_KG: 17,
  MUSCLE_PCT: 18,
  FAT_PCT: 19,
  BONE_MASS: 20,
  TEMPERATURE: 21,
  // Protein columns (96-112)
  PROTEIN_START: 96,
  PROTEIN_END: 112,
  // Individual beverages (119-178) — names in row 0, ABV in row 1, serving oz in row 2
  BEVERAGE_START: 119,
  BEVERAGE_END: 178,
  // Elysium Index (179-190)
  EPIGENETIC_START: 179,
  EPIGENETIC_END: 190,
  // Blood tests (193-245)
  BLOOD_START: 193,
  BLOOD_END: 245,
  // Eye prescription (246-251)
  EYE_START: 246,
  EYE_END: 251
};

// Epigenetic field names (indices relative to EPIGENETIC_START)
const EPIGENETIC_FIELDS = [
  'chronologicalAge', 'biologicalAge', 'paceOfAging',
  'brain', 'liver', 'metabolic', 'immune', 'hormone',
  'kidney', 'heart', 'inflammation', 'blood'
];

// Eye field names (indices relative to EYE_START)
// TSV order: Left OD Sphere, Left Cylinder, Left Axis, Right OS Sphere, Right Cylinder, Right Axis
const EYE_FIELDS = [
  'leftSphere', 'leftCylinder', 'leftAxis',
  'rightSphere', 'rightCylinder', 'rightAxis'
];

// === Parsing Helpers ===

function parseNum(val) {
  if (val === undefined || val === null || val === '' || val === '-') return null;
  const cleaned = String(val).replace(/,/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function parseDate(val) {
  if (!val) return null;
  // Convert YYYY/MM/DD to YYYY-MM-DD
  const cleaned = String(val).trim().replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return null;
  return cleaned;
}

function isEmptyRow(cells) {
  return cells.every(c => !c || c.trim() === '' || c.trim() === '-');
}

// === Beverage Parsing ===

function parseBeverages(row, beverageNames, beverageABVs, beverageSizes) {
  const drinks = [];
  let totalStandardDrinks = 0;

  for (let i = COL.BEVERAGE_START; i <= COL.BEVERAGE_END; i++) {
    const count = parseNum(row[i]);
    if (!count || count <= 0) continue;

    const idx = i - COL.BEVERAGE_START;
    const rawAbv = parseNum(beverageABVs[idx]) || 5;
    const name = beverageNames[idx] || `${rawAbv}% ABV`;
    const abv = rawAbv;
    const servingOz = parseNum(beverageSizes[idx]) || 12;

    const oz = servingOz * count;
    const pureAlcoholOz = oz * (abv / 100);
    const standardDrinks = pureAlcoholOz / 0.6;

    drinks.push({ name, abv, oz, count });
    totalStandardDrinks += standardDrinks;
  }

  return { drinks, standardDrinks: Math.round(totalStandardDrinks * 100) / 100 };
}

// === Blood Test Parsing ===

function parseBloodTests(row, bloodHeaders) {
  const result = {};
  let hasAny = false;

  for (let i = COL.BLOOD_START; i <= COL.BLOOD_END; i++) {
    const val = parseNum(row[i]);
    if (val === null) continue;
    const idx = i - COL.BLOOD_START;
    const header = (bloodHeaders[idx] || `blood_${idx}`).toLowerCase().replace(/[^a-z0-9]/g, '_');
    result[header] = val;
    hasAny = true;
  }

  return hasAny ? result : null;
}

// === Epigenetic Parsing ===

function parseEpigenetic(row) {
  const result = {};

  for (let i = 0; i < EPIGENETIC_FIELDS.length; i++) {
    const val = parseNum(row[COL.EPIGENETIC_START + i]);
    if (val === null) continue;
    result[EPIGENETIC_FIELDS[i]] = val;
  }

  // Only count as a real epigenetic test if biologicalAge or paceOfAging is present
  // (chronologicalAge alone is just the user's age, populated on every row)
  if (result.biologicalAge == null && result.paceOfAging == null) return null;

  // Separate organ scores from top-level fields
  const organScores = {};
  const topLevel = {};
  const organFields = ['brain', 'liver', 'metabolic', 'immune', 'hormone', 'kidney', 'heart', 'inflammation', 'blood'];
  for (const [key, val] of Object.entries(result)) {
    if (organFields.includes(key)) {
      organScores[key] = val;
    } else {
      topLevel[key] = val;
    }
  }

  return { ...topLevel, organScores };
}

// === Eye Rx Parsing ===

function parseEyes(row) {
  const result = {};
  let hasAny = false;

  for (let i = 0; i < EYE_FIELDS.length; i++) {
    const val = parseNum(row[COL.EYE_START + i]);
    if (val === null) continue;
    result[EYE_FIELDS[i]] = val;
    hasAny = true;
  }

  return hasAny ? result : null;
}

// === Main Import Function ===

export async function importTSV(content) {
  await ensureDir(MEATSPACE_DIR);

  const lines = content.split('\n');
  if (lines.length < 6) {
    return { error: 'TSV file too short. Expected at least 6 rows (3 headers + 2 summaries + data).' };
  }

  // Parse header rows
  const headerRow1 = lines[0].split('\t'); // Category headers
  const headerRow2 = lines[1].split('\t'); // Item names (beverage names, blood test names)
  const headerRow3 = lines[2].split('\t'); // Serving sizes, reference ranges, units

  // Extract beverage metadata from headers
  // Row 0 has beverage names, Row 1 has ABV values (e.g. "5.4%"), Row 2 has serving sizes in oz
  const beverageNames = [];
  const beverageABVs = [];
  const beverageSizes = [];
  for (let i = COL.BEVERAGE_START; i <= COL.BEVERAGE_END; i++) {
    const idx = i - COL.BEVERAGE_START;
    beverageNames[idx] = headerRow1[i] || '';
    // ABV is in row 1 as "X.X%" format
    const abvMatch = String(headerRow2[i] || '').match(/(\d+\.?\d*)%/);
    beverageABVs[idx] = abvMatch ? abvMatch[1] : '5';
    beverageSizes[idx] = headerRow3[i] || '12';
  }

  // Extract blood test names from row 2
  const bloodHeaders = [];
  for (let i = COL.BLOOD_START; i <= COL.BLOOD_END; i++) {
    bloodHeaders[i - COL.BLOOD_START] = headerRow2[i] || '';
  }

  // Extract blood reference ranges from row 3
  const referenceRanges = {};
  for (let i = COL.BLOOD_START; i <= COL.BLOOD_END; i++) {
    const idx = i - COL.BLOOD_START;
    const header = (bloodHeaders[idx] || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const rangeStr = String(headerRow3[i] || '');
    const rangeMatch = rangeStr.match(/([\d.]+)\s*-\s*([\d.]+)/);
    if (rangeMatch && header) {
      referenceRanges[header] = {
        min: parseFloat(rangeMatch[1]),
        max: parseFloat(rangeMatch[2]),
        label: bloodHeaders[idx] || header
      };
    }
  }

  // Data starts at row 5 (0-indexed: rows 0-2 are headers, rows 3-4 are summaries)
  const dailyEntries = [];
  const bloodTests = [];
  const epigeneticTests = [];
  const eyeExams = [];

  for (let lineIdx = 5; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (!line.trim()) continue;

    const cells = line.split('\t');
    if (isEmptyRow(cells)) continue;

    const date = parseDate(cells[COL.DATE]);
    if (!date) continue;

    // Nutrition
    const nutrition = {};
    const cal = parseNum(cells[COL.CALORIES]);
    if (cal !== null) nutrition.calories = cal;
    const fat = parseNum(cells[COL.FAT]);
    if (fat !== null) nutrition.fatG = fat;
    const satFat = parseNum(cells[COL.SAT_FAT]);
    if (satFat !== null) nutrition.satFatG = satFat;
    const transFat = parseNum(cells[COL.TRANS_FAT]);
    if (transFat !== null) nutrition.transFatG = transFat;
    const polyFat = parseNum(cells[COL.POLY_FAT]);
    if (polyFat !== null) nutrition.polyFatG = polyFat;
    const monoFat = parseNum(cells[COL.MONO_FAT]);
    if (monoFat !== null) nutrition.monoFatG = monoFat;
    const carbs = parseNum(cells[COL.CARBS]);
    if (carbs !== null) nutrition.carbG = carbs;
    const fiber = parseNum(cells[COL.FIBER]);
    if (fiber !== null) nutrition.fiberG = fiber;
    const sugar = parseNum(cells[COL.SUGAR]);
    if (sugar !== null) nutrition.sugarG = sugar;

    // Body composition
    const body = {};
    const weightLbs = parseNum(cells[COL.WEIGHT_LBS]);
    if (weightLbs !== null) body.weightLbs = weightLbs;
    const weightKg = parseNum(cells[COL.WEIGHT_KG]);
    if (weightKg !== null) body.weightKg = weightKg;
    const musclePct = parseNum(cells[COL.MUSCLE_PCT]);
    if (musclePct !== null) body.musclePct = musclePct;
    const fatPct = parseNum(cells[COL.FAT_PCT]);
    if (fatPct !== null) body.fatPct = fatPct;
    const boneMass = parseNum(cells[COL.BONE_MASS]);
    if (boneMass !== null) body.boneMass = boneMass;
    const temp = parseNum(cells[COL.TEMPERATURE]);
    if (temp !== null) body.temperature = temp;

    // Alcohol
    const alcohol = parseBeverages(cells, beverageNames, beverageABVs, beverageSizes);

    // Build daily entry (only include populated sections)
    const entry = { date };
    if (Object.keys(nutrition).length > 0) entry.nutrition = nutrition;
    if (alcohol.drinks.length > 0) entry.alcohol = alcohol;
    if (Object.keys(body).length > 0) entry.body = body;

    // Only add if entry has data beyond just the date
    if (Object.keys(entry).length > 1) {
      dailyEntries.push(entry);
    }

    // Blood tests (sparse - check if any blood values exist)
    const bloodData = parseBloodTests(cells, bloodHeaders);
    if (bloodData) {
      bloodTests.push({ date, ...bloodData });
    }

    // Epigenetic (sparse)
    const epiData = parseEpigenetic(cells);
    if (epiData) {
      epigeneticTests.push({ date, ...epiData });
    }

    // Eyes (sparse)
    const eyeData = parseEyes(cells);
    if (eyeData) {
      eyeExams.push({ date, ...eyeData });
    }
  }

  // Sort entries by date
  dailyEntries.sort((a, b) => a.date.localeCompare(b.date));
  bloodTests.sort((a, b) => a.date.localeCompare(b.date));
  epigeneticTests.sort((a, b) => a.date.localeCompare(b.date));
  eyeExams.sort((a, b) => a.date.localeCompare(b.date));

  // Write all data files
  const lastEntryDate = dailyEntries.length > 0 ? dailyEntries[dailyEntries.length - 1].date : null;

  await Promise.all([
    writeFile(DAILY_LOG_FILE, JSON.stringify({ entries: dailyEntries, lastEntryDate }, null, 2)),
    writeFile(BLOOD_TESTS_FILE, JSON.stringify({ tests: bloodTests, referenceRanges }, null, 2)),
    writeFile(EPIGENETIC_TESTS_FILE, JSON.stringify({ tests: epigeneticTests }, null, 2)),
    writeFile(EYES_FILE, JSON.stringify({ exams: eyeExams }, null, 2))
  ]);

  const stats = {
    dailyEntries: dailyEntries.length,
    bloodTests: bloodTests.length,
    epigeneticTests: epigeneticTests.length,
    eyeExams: eyeExams.length,
    dateRange: dailyEntries.length > 0
      ? { from: dailyEntries[0].date, to: lastEntryDate }
      : null
  };

  console.log(`📊 MeatSpace import: ${stats.dailyEntries} daily entries, ${stats.bloodTests} blood tests, ${stats.epigeneticTests} epigenetic, ${stats.eyeExams} eye exams`);

  return stats;
}
