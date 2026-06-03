/**
 * clinicianReport.js — pure builders for the MeatSpace clinician-export view.
 *
 * Turns raw blood-test history + lifestyle config into a structured,
 * doctor-friendly report model and a copy-paste markdown rendering. No React,
 * no I/O — fully unit-testable. Reuses the blood reference ranges and status
 * classifier that the Blood tab already uses, so the printed flags match the UI.
 */

import { REFERENCE_RANGES, getBloodValueStatus } from '../components/meatspace/constants.js';

// Blood-marker category grouping — canonical source for the marker→category map.
// BloodTestCard imports getCategoryForKey from here so the on-screen tab grouping
// and the printed report stay in sync.
const CATEGORY_KEYS = {
  'Metabolic Panel': [
    'glucose', 'bun', 'creatinine', 'egfr', 'na', 'k', 'ci', 'co2',
    'calcium', 'protein', 'albumin', 'globulin', 'a_g_ratio', 'bilirubin',
    'bili_direct', 'alk_phos', 'sgot_ast', 'alt', 'hba1c', 'anion_gap', 'apoB'
  ],
  Lipids: ['cholesterol', 'hdl', 'ldl', 'triglycerides', 'chol_hdl_ratio', 'non_hdl_col'],
  CBC: [
    'wbc', 'rbc', 'hemoglobin', 'hematocrit', 'platelets',
    'mcv', 'mch', 'mchc', 'rdw', 'mpv',
    'neutrophils_pct', 'lymphocytes_pct', 'monocytes_pct', 'eosinophils_pct', 'basophils_pct',
    'abs_neutrophils', 'abs_lymphocytes', 'abs_monocytes', 'abs_eosinophils', 'abs_basophils'
  ],
  Thyroid: ['tsh', 'free_t4', 'free_t3'],
};

const CATEGORY_ORDER = ['Metabolic Panel', 'Lipids', 'CBC', 'Thyroid', 'Other'];

export function getCategoryForKey(key) {
  for (const [category, keys] of Object.entries(CATEGORY_KEYS)) {
    if (keys.includes(key)) return category;
  }
  return 'Other';
}

export const STATUS_LABELS = { normal: 'Normal', low: 'Low', high: 'High', unknown: '' };

export function formatRange(range) {
  if (!range) return '';
  const unit = range.unit ? ` ${range.unit}` : '';
  return `${range.min}–${range.max}${unit}`;
}

/**
 * Build the structured model for a single blood test record. Returns the date
 * plus markers grouped by category, each carrying value/range/status/flag.
 */
export function buildBloodTestModel(test) {
  if (!test || typeof test !== 'object') return null;
  const { date, ...values } = test;
  const grouped = {};
  for (const [key, value] of Object.entries(values)) {
    if (value == null || typeof value !== 'number') continue;
    const range = REFERENCE_RANGES[key];
    const status = getBloodValueStatus(value, range);
    const category = range ? getCategoryForKey(key) : 'Other';
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push({
      key,
      label: range?.label || key,
      value,
      unit: range?.unit || '',
      range,
      status,
      outOfRange: status === 'low' || status === 'high',
    });
  }
  const categories = CATEGORY_ORDER
    .filter(cat => grouped[cat]?.length)
    .map(cat => ({ category: cat, markers: grouped[cat] }));
  const outOfRange = categories.flatMap(c => c.markers).filter(m => m.outOfRange);
  return { date: date || 'Undated', categories, outOfRange };
}

const SMOKING_LABELS = { never: 'Never', former: 'Former', current: 'Current' };
const DIET_LABELS = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor' };
const STRESS_LABELS = { low: 'Low', moderate: 'Moderate', high: 'High' };

function bmiCategory(bmi) {
  if (bmi == null) return '';
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Normal';
  if (bmi < 30) return 'Overweight';
  return 'Obese';
}

/**
 * Build the lifestyle section as a list of `{ label, value, note }` rows.
 * `LIFESTYLE_ADJUSTMENTS` keys define which factors the clinician summary covers.
 */
export function buildLifestyleModel(config) {
  const lifestyle = config?.lifestyle || {};
  const sex = config?.sex;
  const rows = [];
  rows.push({ label: 'Biological sex', value: sex ? capitalize(sex) : 'Not specified' });
  rows.push({
    label: 'Smoking',
    value: SMOKING_LABELS[lifestyle.smokingStatus] || 'Not specified',
  });
  if (lifestyle.alcoholDrinksPerDay != null) {
    rows.push({ label: 'Alcohol', value: `${lifestyle.alcoholDrinksPerDay} drinks/day (self-reported)` });
  }
  rows.push({
    label: 'Exercise',
    value: lifestyle.exerciseMinutesPerWeek != null
      ? `${lifestyle.exerciseMinutesPerWeek} min/week`
      : 'Not specified',
    note: 'WHO target: 150+ min/week moderate activity',
  });
  rows.push({
    label: 'Sleep',
    value: lifestyle.sleepHoursPerNight != null
      ? `${lifestyle.sleepHoursPerNight} hrs/night`
      : 'Not specified',
    note: 'Optimal range: 7–9 hrs',
  });
  rows.push({ label: 'Diet quality', value: DIET_LABELS[lifestyle.dietQuality] || 'Not specified' });
  rows.push({ label: 'Stress level', value: STRESS_LABELS[lifestyle.stressLevel] || 'Not specified' });
  rows.push({
    label: 'BMI',
    value: lifestyle.bmi != null ? `${lifestyle.bmi}` : 'Not specified',
    note: bmiCategory(lifestyle.bmi) || undefined,
  });
  const conditions = Array.isArray(lifestyle.chronicConditions) ? lifestyle.chronicConditions : [];
  if (conditions.length) {
    rows.push({ label: 'Chronic conditions', value: conditions.join(', ') });
  }
  return rows;
}

function capitalize(s) {
  return typeof s === 'string' && s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Build the full clinician report model from blood tests + lifestyle config.
 * `tests` is the raw array from the Blood tab (oldest-first); the report shows
 * newest-first. `generatedAt` is injected for testability.
 */
export function buildClinicianReport({ tests = [], config = null, generatedAt = new Date() } = {}) {
  const bloodTests = (Array.isArray(tests) ? tests : [])
    .map(buildBloodTestModel)
    .filter(Boolean)
    .reverse();
  return {
    generatedAt: generatedAt instanceof Date ? generatedAt : new Date(generatedAt),
    bloodTests,
    lifestyle: buildLifestyleModel(config),
  };
}

// Escape values for a markdown table cell so free-text fields (e.g. a chronic
// condition containing `|` or a newline) can't break the table layout.
function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Serialize a report model to clipboard-friendly markdown. */
export function reportToMarkdown(report) {
  if (!report) return '';
  const lines = [];
  lines.push('# Clinician Summary — Blood & Lifestyle');
  lines.push('');
  lines.push(`_Generated ${report.generatedAt.toLocaleString()}_`);
  lines.push('');
  lines.push('> Self-tracked data exported from PortOS MeatSpace. Reference ranges are general adult ranges and not a diagnosis.');
  lines.push('');

  lines.push('## Lifestyle');
  lines.push('');
  lines.push('| Factor | Value | Note |');
  lines.push('| --- | --- | --- |');
  for (const row of report.lifestyle) {
    lines.push(`| ${mdCell(row.label)} | ${mdCell(row.value)} | ${mdCell(row.note || '')} |`);
  }
  lines.push('');

  lines.push('## Blood Panels');
  lines.push('');
  if (!report.bloodTests.length) {
    lines.push('_No blood test data on record._');
    lines.push('');
  }
  for (const test of report.bloodTests) {
    lines.push(`### ${test.date}`);
    lines.push('');
    if (test.outOfRange.length) {
      const flags = test.outOfRange
        .map(m => `${m.label} ${m.value}${m.unit ? ` ${m.unit}` : ''} (${STATUS_LABELS[m.status]})`)
        .join(', ');
      lines.push(`**Out of range:** ${flags}`);
      lines.push('');
    }
    for (const { category, markers } of test.categories) {
      lines.push(`#### ${category}`);
      lines.push('');
      lines.push('| Marker | Value | Reference | Flag |');
      lines.push('| --- | --- | --- | --- |');
      for (const m of markers) {
        const value = `${m.value}${m.unit ? ` ${m.unit}` : ''}`;
        // Flag column matches the HTML view: blank for in-range markers, the
        // status label only when out of range.
        const flag = m.outOfRange ? STATUS_LABELS[m.status] : '';
        lines.push(`| ${mdCell(m.label)} | ${mdCell(value)} | ${formatRange(m.range) || '—'} | ${flag} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}
