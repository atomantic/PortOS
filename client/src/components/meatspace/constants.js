import {
  Skull,
  Beer,
  HeartPulse,
  ClipboardList,
  Activity
} from 'lucide-react';

export const TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'alcohol', label: 'Alcohol', icon: Beer },
  { id: 'blood', label: 'Blood & Body', icon: HeartPulse },
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
