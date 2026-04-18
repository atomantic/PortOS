/**
 * AHA/ACC 2017 hypertension classification and longevity impact.
 * Ported from MortalLoom's CardioFitnessEngine so PortOS and the iOS/macOS
 * companion app report identical categories for the same reading.
 */

export const BP_CATEGORIES = {
  normal:      { label: 'Normal',              color: 'text-port-success', impactYears:  1.5 },
  elevated:    { label: 'Elevated',            color: 'text-port-warning', impactYears:  0.0 },
  highStage1:  { label: 'High – Stage 1',      color: 'text-orange-400',   impactYears: -1.5 },
  highStage2:  { label: 'High – Stage 2',      color: 'text-port-error',   impactYears: -3.0 },
  crisis:      { label: 'Hypertensive Crisis', color: 'text-port-error',   impactYears: -5.0 }
};

export function classifyBP(systolic, diastolic) {
  if (systolic > 180 || diastolic > 120) return 'crisis';
  if (systolic >= 140 || diastolic >= 90) return 'highStage2';
  if (systolic >= 130 || diastolic >= 80) return 'highStage1';
  if (systolic >= 120) return 'elevated';
  return 'normal';
}

export function bpLongevityImpact(systolic, diastolic) {
  return BP_CATEGORIES[classifyBP(systolic, diastolic)].impactYears;
}
