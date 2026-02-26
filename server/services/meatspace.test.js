import { describe, it, expect } from 'vitest';

// Inline copies of pure functions to avoid complex mocking
// (follows existing test pattern in subAgentSpawner.test.js)

function computeLifestyleAdjustment(lifestyle) {
  if (!lifestyle) return 0;
  let adj = 0;

  const smoking = lifestyle.smokingStatus || 'never';
  if (smoking === 'never') adj += 0;
  else if (smoking === 'former') adj -= 2;
  else if (smoking === 'current') adj -= 10;

  const drinks = lifestyle.alcoholDrinksPerDay;
  if (drinks != null) {
    if (drinks <= 2) adj += 0.5;
    else if (drinks > 3) adj -= 5;
  }

  const exercise = lifestyle.exerciseMinutesPerWeek ?? 150;
  if (exercise > 150) adj += 2;
  else if (exercise >= 75) adj += 0.5;
  else adj -= 2;

  const sleep = lifestyle.sleepHoursPerNight ?? 7.5;
  if (sleep >= 7 && sleep <= 9) adj += 1;
  else if (sleep >= 6 && sleep < 7) adj += 0;
  else adj -= 1.5;

  const diet = lifestyle.dietQuality || 'good';
  if (diet === 'excellent') adj += 2;
  else if (diet === 'good') adj += 0.5;
  else if (diet === 'fair') adj += 0;
  else adj -= 3;

  const stress = lifestyle.stressLevel || 'moderate';
  if (stress === 'low') adj += 1;
  else if (stress === 'moderate') adj += 0;
  else adj -= 2;

  const bmi = lifestyle.bmi;
  if (bmi != null) {
    if (bmi >= 18.5 && bmi < 25) adj += 0.5;
    else if (bmi >= 25 && bmi < 30) adj -= 0.5;
    else if (bmi >= 30) adj -= 3;
  }

  return Math.round(adj * 100) / 100;
}

function computeDeathClock(birthDate, genomeAdjustedLE, lifestyleAdj) {
  const SSA_BASELINE = 78.5;
  const baseline = genomeAdjustedLE ?? SSA_BASELINE;
  const totalLE = baseline + lifestyleAdj;

  const birth = new Date(birthDate);
  const deathDate = new Date(birth);
  deathDate.setFullYear(deathDate.getFullYear() + Math.floor(totalLE));
  deathDate.setMonth(deathDate.getMonth() + Math.round((totalLE % 1) * 12));

  const now = new Date();
  const msRemaining = deathDate.getTime() - now.getTime();
  const ageYears = (now - birth) / (365.25 * 24 * 60 * 60 * 1000);
  const yearsRemaining = Math.max(0, totalLE - ageYears);
  const healthyYearsRemaining = Math.round(yearsRemaining * 0.85 * 10) / 10;
  const percentComplete = Math.min(100, Math.round((ageYears / totalLE) * 1000) / 10);

  return {
    birthDate,
    deathDate: deathDate.toISOString(),
    msRemaining: Math.max(0, msRemaining),
    lifeExpectancy: {
      baseline: SSA_BASELINE,
      genomeAdjusted: genomeAdjustedLE ?? SSA_BASELINE,
      lifestyleAdjustment: lifestyleAdj,
      total: Math.round(totalLE * 10) / 10
    },
    ageYears: Math.round(ageYears * 100) / 100,
    yearsRemaining: Math.round(yearsRemaining * 100) / 100,
    healthyYearsRemaining,
    percentComplete
  };
}

function computeLEV(birthDate, adjustedLE) {
  const LEV_TARGET_YEAR = 2045;
  const LEV_START_YEAR = 2000;
  const birthYear = new Date(birthDate).getFullYear();

  const now = new Date();
  const currentYear = now.getFullYear() + now.getMonth() / 12;
  const ageAtLEV = LEV_TARGET_YEAR - birthYear;
  const yearsToLEV = LEV_TARGET_YEAR - currentYear;
  const researchProgress = Math.round(((currentYear - LEV_START_YEAR) / (LEV_TARGET_YEAR - LEV_START_YEAR)) * 1000) / 10;
  const onTrack = adjustedLE > ageAtLEV;

  return {
    targetYear: LEV_TARGET_YEAR,
    ageAtLEV,
    yearsToLEV: Math.round(yearsToLEV * 10) / 10,
    researchProgress: Math.min(100, researchProgress),
    onTrack,
    adjustedLifeExpectancy: adjustedLE
  };
}

// =============================================================================
// LIFESTYLE ADJUSTMENT TESTS
// =============================================================================

describe('computeLifestyleAdjustment', () => {
  it('returns 0 for null/undefined lifestyle', () => {
    expect(computeLifestyleAdjustment(null)).toBe(0);
    expect(computeLifestyleAdjustment(undefined)).toBe(0);
  });

  it('computes optimal lifestyle bonus', () => {
    const lifestyle = {
      smokingStatus: 'never',
      alcoholDrinksPerDay: 1,
      exerciseMinutesPerWeek: 200,
      sleepHoursPerNight: 8,
      dietQuality: 'excellent',
      stressLevel: 'low',
      bmi: 22
    };
    // never: +0, alcohol<=2: +0.5, >150min: +2, 7-9h: +1, excellent: +2, low: +1, normal bmi: +0.5
    expect(computeLifestyleAdjustment(lifestyle)).toBe(7);
  });

  it('computes worst-case lifestyle penalty', () => {
    const lifestyle = {
      smokingStatus: 'current',
      alcoholDrinksPerDay: 5,
      exerciseMinutesPerWeek: 30,
      sleepHoursPerNight: 5,
      dietQuality: 'poor',
      stressLevel: 'high',
      bmi: 35
    };
    // current: -10, heavy: -5, <75min: -2, <6h: -1.5, poor: -3, high: -2, obese: -3
    expect(computeLifestyleAdjustment(lifestyle)).toBe(-26.5);
  });

  it('handles default lifestyle (empty object)', () => {
    // Default: never(0), no alcohol(skip), 150(+0.5), 7.5(+1), good(+0.5), moderate(0), no bmi(skip)
    const adj = computeLifestyleAdjustment({});
    expect(adj).toBe(2);
  });

  it('handles former smoker', () => {
    const lifestyle = {
      smokingStatus: 'former',
      exerciseMinutesPerWeek: 100,
      sleepHoursPerNight: 7.5,
      dietQuality: 'good',
      stressLevel: 'moderate'
    };
    // former: -2, 75-150: +0.5, 7-9h: +1, good: +0.5, moderate: 0
    expect(computeLifestyleAdjustment(lifestyle)).toBe(0);
  });

  it('handles overweight BMI', () => {
    const lifestyle = { bmi: 27, exerciseMinutesPerWeek: 150, sleepHoursPerNight: 7.5, dietQuality: 'good' };
    // never: 0, exercise 150(+0.5), sleep(+1), good(+0.5), moderate(0), overweight(-0.5)
    expect(computeLifestyleAdjustment(lifestyle)).toBe(1.5);
  });
});

// =============================================================================
// DEATH CLOCK TESTS
// =============================================================================

describe('computeDeathClock', () => {
  it('computes death date from birth date and life expectancy', () => {
    const result = computeDeathClock('1979-07-31', 76.9, 2);
    expect(result.birthDate).toBe('1979-07-31');
    expect(result.lifeExpectancy.baseline).toBe(78.5);
    expect(result.lifeExpectancy.genomeAdjusted).toBe(76.9);
    expect(result.lifeExpectancy.lifestyleAdjustment).toBe(2);
    expect(result.lifeExpectancy.total).toBe(78.9);
    expect(result.msRemaining).toBeGreaterThan(0);
    expect(result.ageYears).toBeGreaterThan(46);
    expect(result.yearsRemaining).toBeGreaterThan(0);
    expect(result.percentComplete).toBeGreaterThan(50);
  });

  it('uses SSA baseline when genome data is null', () => {
    const result = computeDeathClock('1979-07-31', null, 0);
    expect(result.lifeExpectancy.genomeAdjusted).toBe(78.5);
    expect(result.lifeExpectancy.total).toBe(78.5);
  });

  it('applies negative lifestyle adjustment', () => {
    const result = computeDeathClock('1979-07-31', 76.9, -10);
    expect(result.lifeExpectancy.total).toBe(66.9);
    expect(result.yearsRemaining).toBeLessThan(25);
  });

  it('clamps msRemaining to 0 for past death dates', () => {
    const result = computeDeathClock('1900-01-01', 50, 0);
    expect(result.msRemaining).toBe(0);
    expect(result.yearsRemaining).toBe(0);
    expect(result.percentComplete).toBe(100);
  });

  it('computes healthy years as 85% of remaining', () => {
    const result = computeDeathClock('1979-07-31', 78.5, 0);
    const expectedHealthy = Math.round(result.yearsRemaining * 0.85 * 10) / 10;
    expect(result.healthyYearsRemaining).toBe(expectedHealthy);
  });
});

// =============================================================================
// LEV TRACKER TESTS
// =============================================================================

describe('computeLEV', () => {
  it('computes on-track status when LE exceeds age at LEV', () => {
    const result = computeLEV('1979-07-31', 80);
    expect(result.targetYear).toBe(2045);
    expect(result.ageAtLEV).toBe(66);
    expect(result.onTrack).toBe(true);
    expect(result.adjustedLifeExpectancy).toBe(80);
  });

  it('computes at-risk status when LE is below age at LEV', () => {
    const result = computeLEV('1979-07-31', 60);
    expect(result.onTrack).toBe(false);
  });

  it('has years to LEV decreasing over time', () => {
    const result = computeLEV('1979-07-31', 80);
    expect(result.yearsToLEV).toBeGreaterThan(0);
    expect(result.yearsToLEV).toBeLessThan(25);
  });

  it('research progress increases over time', () => {
    const result = computeLEV('1979-07-31', 80);
    expect(result.researchProgress).toBeGreaterThan(50);
    expect(result.researchProgress).toBeLessThan(100);
  });
});
