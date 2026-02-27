import {
  Skull,
  Beer,
  Dna,
  HeartPulse,
  ClipboardList,
  Activity,
  Stethoscope,
  Upload
} from 'lucide-react';

export const TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'alcohol', label: 'Alcohol', icon: Beer },
  { id: 'blood', label: 'Blood & Body', icon: HeartPulse },
  { id: 'genome', label: 'Genome', icon: Dna },
  { id: 'health', label: 'Health', icon: Stethoscope },
  { id: 'import', label: 'Import', icon: Upload },
  { id: 'lifestyle', label: 'Lifestyle', icon: ClipboardList }
];

// Lifestyle adjustment table for death clock
export const LIFESTYLE_ADJUSTMENTS = {
  smoking: { never: 0, former: -2, current: -10 },
  alcohol: { none: 0, moderate: 0.5, heavy: -5 },
  exercise: { high: 2, moderate: 0.5, low: -2 },
  sleep: { optimal: 1, fair: 0, poor: -1.5 },
  diet: { excellent: 2, good: 0.5, fair: 0, poor: -3 },
  stress: { low: 1, moderate: 0, high: -2 },
  bmi: { normal: 0.5, overweight: -0.5, obese: -3 }
};

// NIAAA alcohol thresholds
export const ALCOHOL_THRESHOLDS = {
  male: { dailyMax: 2, weeklyMax: 14 },
  female: { dailyMax: 1, weeklyMax: 7 }
};

// Blood test reference ranges (common panels)
export const REFERENCE_RANGES = {
  // Metabolic Panel
  apoB: { min: 40, max: 100, unit: 'mg/dL', label: 'ApoB' },
  bun: { min: 7, max: 20, unit: 'mg/dL', label: 'BUN' },
  creatinine: { min: 0.7, max: 1.3, unit: 'mg/dL', label: 'Creatinine' },
  egfr: { min: 90, max: 120, unit: 'mL/min', label: 'eGFR' },
  glucose: { min: 70, max: 99, unit: 'mg/dL', label: 'Glucose' },
  // Lipids
  cholesterol: { min: 0, max: 200, unit: 'mg/dL', label: 'Total Cholesterol' },
  hdl: { min: 40, max: 100, unit: 'mg/dL', label: 'HDL' },
  ldl: { min: 0, max: 100, unit: 'mg/dL', label: 'LDL' },
  triglycerides: { min: 0, max: 150, unit: 'mg/dL', label: 'Triglycerides' },
  // CBC
  wbc: { min: 4.5, max: 11.0, unit: 'K/uL', label: 'WBC' },
  rbc: { min: 4.5, max: 5.5, unit: 'M/uL', label: 'RBC' },
  hemoglobin: { min: 13.5, max: 17.5, unit: 'g/dL', label: 'Hemoglobin' },
  hematocrit: { min: 38.3, max: 48.6, unit: '%', label: 'Hematocrit' },
  platelets: { min: 150, max: 400, unit: 'K/uL', label: 'Platelets' },
  // Thyroid
  tsh: { min: 0.4, max: 4.0, unit: 'mIU/L', label: 'TSH' },
  // Metabolic Panel (extended)
  na: { min: 136, max: 144, unit: 'mmol/L', label: 'Sodium' },
  k: { min: 3.5, max: 5.2, unit: 'mmol/L', label: 'Potassium' },
  ci: { min: 98, max: 106, unit: 'mmol/L', label: 'Chloride' },
  co2: { min: 22, max: 32, unit: 'mmol/L', label: 'CO2' },
  calcium: { min: 8.6, max: 10.3, unit: 'mg/dL', label: 'Calcium' },
  protein: { min: 6.0, max: 8.3, unit: 'g/dL', label: 'Total Protein' },
  albumin: { min: 3.5, max: 5.5, unit: 'g/dL', label: 'Albumin' },
  globulin: { min: 1.5, max: 4.5, unit: 'g/dL', label: 'Globulin' },
  a_g_ratio: { min: 1.0, max: 2.5, unit: '', label: 'A/G Ratio' },
  bilirubin: { min: 0.1, max: 1.2, unit: 'mg/dL', label: 'Bilirubin' },
  bili_direct: { min: 0.0, max: 0.5, unit: 'mg/dL', label: 'Bilirubin Direct' },
  alk_phos: { min: 36, max: 130, unit: 'U/L', label: 'Alkaline Phosphatase' },
  sgot_ast: { min: 10, max: 40, unit: 'U/L', label: 'AST (SGOT)' },
  alt: { min: 7, max: 56, unit: 'U/L', label: 'ALT (SGPT)' },
  hba1c: { min: 4.0, max: 5.6, unit: '%', label: 'HbA1c' },
  anion_gap: { min: 3, max: 12, unit: 'mmol/L', label: 'Anion Gap' },
  // Lipids (extended)
  chol_hdl_ratio: { min: 0, max: 5.0, unit: '', label: 'Chol/HDL Ratio' },
  non_hdl_col: { min: 0, max: 130, unit: 'mg/dL', label: 'Non-HDL Cholesterol' },
  // CBC (extended)
  mcv: { min: 80, max: 100, unit: 'fL', label: 'MCV' },
  mch: { min: 27, max: 33, unit: 'pg', label: 'MCH' },
  mchc: { min: 32, max: 36, unit: 'g/dL', label: 'MCHC' },
  rdw: { min: 11.0, max: 15.0, unit: '%', label: 'RDW' },
  mpv: { min: 7.5, max: 12.5, unit: 'fL', label: 'MPV' },
  // Other
  homocysteine: { min: 5, max: 15, unit: 'umol/L', label: 'Homocysteine' }
};

// Status colors for blood test values
export const getBloodValueStatus = (value, range) => {
  if (value == null || !range) return 'unknown';
  if (value < range.min) return 'low';
  if (value > range.max) return 'high';
  return 'normal';
};

export const STATUS_COLORS = {
  normal: 'text-port-success',
  low: 'text-port-warning',
  high: 'text-port-error',
  unknown: 'text-gray-500'
};

// LEV 2045 constants
export const LEV_TARGET_YEAR = 2045;
export const LEV_BIRTH_YEAR = 1979;
export const LEV_START_YEAR = 2000; // Research timeline start
