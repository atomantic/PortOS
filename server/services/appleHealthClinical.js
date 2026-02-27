/**
 * Apple Health Clinical Records Service
 *
 * Parses FHIR R4 JSON files from Apple Health export's clinical_records/ directory,
 * extracts lab observations, maps LOINC codes to standardized keys, and merges
 * into blood-tests.json.
 */

import { safeJSONParse } from '../lib/fileUtils.js';
import { getBloodTests } from './meatspaceHealth.js';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir } from '../lib/fileUtils.js';

const BLOOD_TESTS_FILE = join(PATHS.meatspace, 'blood-tests.json');

// === LOINC Code → Key Mapping ===

export const LOINC_TO_KEY = {
  // Metabolic Panel
  '2345-7': 'glucose',
  '2339-0': 'glucose',             // Glucose [Mass/volume] in Blood
  '3094-0': 'bun',
  '2160-0': 'creatinine',
  '48642-3': 'egfr',
  '33914-3': 'egfr',
  '62238-1': 'egfr',
  '77147-7': 'egfr',
  '88293-6': 'egfr',
  '2951-2': 'na',
  '2823-3': 'k',
  '2075-0': 'ci',
  '2028-9': 'co2',
  '17861-6': 'calcium',
  '2885-2': 'protein',
  '1751-7': 'albumin',
  '10834-0': 'globulin',
  '1759-0': 'a_g_ratio',
  '1975-2': 'bilirubin',
  '1968-7': 'bili_direct',
  '6768-6': 'alk_phos',
  '1920-8': 'sgot_ast',
  '1742-6': 'alt',
  '4548-4': 'hba1c',
  '17856-6': 'hba1c',
  '33037-3': 'anion_gap',
  '41653-7': 'glucose',            // Glucose [Mass/volume] in Capillary blood

  // Lipids
  '2093-3': 'cholesterol',
  '2085-9': 'hdl',
  '2089-1': 'ldl',
  '13457-7': 'ldl',
  '18262-6': 'ldl',                // LDL Cholesterol (calculated)
  '2571-8': 'triglycerides',
  '9830-1': 'chol_hdl_ratio',
  '43396-1': 'non_hdl_col',

  // CBC
  '6690-2': 'wbc',
  '789-8': 'rbc',
  '718-7': 'hemoglobin',
  '4544-3': 'hematocrit',
  '777-3': 'platelets',
  '787-2': 'mcv',
  '785-6': 'mch',
  '786-4': 'mchc',
  '788-0': 'rdw',
  '32623-1': 'mpv',
  '770-8': 'neutrophils_pct',
  '736-9': 'lymphocytes_pct',
  '5905-5': 'monocytes_pct',
  '713-8': 'eosinophils_pct',
  '706-2': 'basophils_pct',
  '751-8': 'abs_neutrophils',
  '731-0': 'abs_lymphocytes',
  '742-7': 'abs_monocytes',
  '711-2': 'abs_eosinophils',
  '704-7': 'abs_basophils',

  // Thyroid
  '3016-3': 'tsh',
  '3024-7': 'free_t4',
  '3053-6': 'free_t3',

  // Other common labs
  '1884-6': 'apoB',
  '13965-9': 'homocysteine',
  '2532-0': 'ldh',
  '2276-4': 'ferritin',
  '2498-4': 'iron',
  '2502-3': 'iron_sat',
  '2000-8': 'calcium_ionized',
  '14879-1': 'phosphorus',
  '19123-9': 'magnesium',
  '2157-6': 'ck',
  '14804-9': 'uric_acid',
  '30239-8': 'vitamin_d',
  '2132-9': 'vitamin_b12',
  '2284-8': 'folate',
  '4548-4': 'hba1c',
  '1558-6': 'glucose_fasting',
  '2947-0': 'sodium_urine',
};

// === Pure Functions ===

/**
 * Convert a display name to a snake_case key.
 * Strips bracketed content (e.g. "[Mass/volume]") and common suffixes
 * like "in Blood" or "in Serum" before converting.
 */
export function toSnakeCase(str) {
  if (!str) return '';
  return str
    .replace(/\[.*?\]/g, '')                    // strip [bracketed content]
    .replace(/\s+in\s+(Blood|Serum|Plasma).*$/i, '') // strip "in Blood/Serum/Plasma..."
    .replace(/\s+by\s+.+$/i, '')                // strip "by <method>"
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')                // non-alphanumeric → underscore
    .replace(/^_|_$/g, '')                       // trim leading/trailing underscores
    .replace(/_+/g, '_');                        // collapse multiple underscores
}

/**
 * Parse a single FHIR JSON string into a lab result.
 * Returns { date, key, value, unit, refLow, refHigh, label } or null.
 */
export function parseFhirLabResult(jsonStr) {
  const resource = safeJSONParse(jsonStr, null);
  if (!resource) return null;

  // Must be an Observation
  if (resource.resourceType !== 'Observation') return null;

  // Must be a laboratory category
  const categories = resource.category || [];
  const isLab = categories.some(cat =>
    cat.coding?.some(c => c.code === 'laboratory')
  );
  if (!isLab) return null;

  // Skip cancelled/entered-in-error
  if (resource.status === 'cancelled' || resource.status === 'entered-in-error') return null;

  // Must have a numeric valueQuantity
  const vq = resource.valueQuantity;
  if (!vq || typeof vq.value !== 'number') return null;

  // Extract date (effectiveDateTime or issued)
  const dateRaw = resource.effectiveDateTime || resource.issued;
  if (!dateRaw) return null;
  const date = dateRaw.substring(0, 10); // YYYY-MM-DD

  // Extract LOINC code and display name
  const coding = resource.code?.coding || [];
  const loincEntry = coding.find(c => c.system?.includes('loinc'));
  const loincCode = loincEntry?.code;
  const displayName = resource.code?.text || loincEntry?.display || '';

  // Map to key: LOINC lookup first, then fallback to snake_case of display name
  const key = (loincCode && LOINC_TO_KEY[loincCode]) || toSnakeCase(displayName);
  if (!key) return null;

  // Extract reference range if available
  const refRange = resource.referenceRange?.[0];
  const refLow = refRange?.low?.value ?? null;
  const refHigh = refRange?.high?.value ?? null;

  return {
    date,
    key,
    value: vq.value,
    unit: vq.unit || vq.code || '',
    refLow,
    refHigh,
    label: displayName || key
  };
}

/**
 * Process an array of FHIR JSON strings into grouped blood test data.
 * Returns { tests, referenceRanges, totalParsed, totalSkipped }.
 */
export function processClinicalRecords(jsonStrings) {
  const byDate = {};       // date → { key: value, ... }
  const refRanges = {};    // key → { min, max, unit, label }
  let totalParsed = 0;
  let totalSkipped = 0;

  for (const jsonStr of jsonStrings) {
    const result = parseFhirLabResult(jsonStr);
    if (!result) {
      totalSkipped++;
      continue;
    }

    totalParsed++;
    const { date, key, value, unit, refLow, refHigh, label } = result;

    if (!byDate[date]) byDate[date] = {};
    byDate[date][key] = value;

    // Collect reference ranges (first seen wins)
    if ((refLow != null || refHigh != null) && !refRanges[key]) {
      refRanges[key] = {
        ...(refLow != null && { min: refLow }),
        ...(refHigh != null && { max: refHigh }),
        unit,
        label
      };
    }
  }

  // Convert byDate map to sorted array of test entries
  const tests = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, ...values }));

  return { tests, referenceRanges: refRanges, totalParsed, totalSkipped };
}

/**
 * Pure merge: combine existing blood test data with FHIR-imported data.
 * For existing dates, add new keys only (don't overwrite manual entries).
 * For new dates, add the whole entry.
 * Merge reference ranges (don't overwrite existing).
 */
export function mergeBloodTests(existing, fhirData) {
  const existingTests = [...(existing.tests || [])];
  const existingRanges = { ...(existing.referenceRanges || {}) };

  const existingByDate = new Map(existingTests.map(t => [t.date, t]));

  for (const fhirTest of fhirData.tests) {
    const { date, ...fhirValues } = fhirTest;
    const existingEntry = existingByDate.get(date);

    if (existingEntry) {
      // Add new keys only — don't overwrite existing manual entries
      for (const [key, value] of Object.entries(fhirValues)) {
        if (existingEntry[key] === undefined) {
          existingEntry[key] = value;
        }
      }
    } else {
      existingTests.push(fhirTest);
      existingByDate.set(date, fhirTest);
    }
  }

  // Merge reference ranges — don't overwrite existing
  for (const [key, range] of Object.entries(fhirData.referenceRanges)) {
    if (!existingRanges[key]) {
      existingRanges[key] = range;
    }
  }

  // Sort by date
  existingTests.sort((a, b) => a.date.localeCompare(b.date));

  return { tests: existingTests, referenceRanges: existingRanges };
}

// === Orchestrator ===

/**
 * Import clinical records from FHIR JSON strings.
 * Reads existing blood-tests.json, merges FHIR data, writes back, emits progress.
 */
export async function importClinicalRecords(jsonStrings, io) {
  if (!jsonStrings?.length) return { clinicalRecords: 0, newDates: 0, newValues: 0 };

  io?.emit?.('health:import:progress', { stage: 'clinical', message: `Processing ${jsonStrings.length} clinical records...` });

  const fhirData = processClinicalRecords(jsonStrings);
  const existing = await getBloodTests();
  const existingDates = new Set(existing.tests.map(t => t.date));

  const merged = mergeBloodTests(existing, fhirData);

  // Count what changed
  const newDates = merged.tests.filter(t => !existingDates.has(t.date)).length;
  const newValues = fhirData.totalParsed;

  await ensureDir(PATHS.meatspace);
  await writeFile(BLOOD_TESTS_FILE, JSON.stringify(merged, null, 2));

  const summary = {
    clinicalRecords: jsonStrings.length,
    labsParsed: fhirData.totalParsed,
    labsSkipped: fhirData.totalSkipped,
    newDates,
    totalDates: merged.tests.length
  };

  console.log(`🧪 Clinical records imported: ${fhirData.totalParsed} labs from ${fhirData.tests.length} dates (${newDates} new)`);
  io?.emit?.('health:import:progress', { stage: 'clinical_done', ...summary });

  return summary;
}
