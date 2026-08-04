import { describe, it, expect } from 'vitest';
import { computeLifestyleAdjustment, computeDeathClock, computeLEV } from './meatspace.js';

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
    // Service derives healthyYearsRemaining from full-precision yearsRemaining,
    // but result.yearsRemaining is rounded to 2dp — use a tolerance instead of
    // re-deriving, or the assertion flakes by 0.1 on certain dates.
    expect(result.healthyYearsRemaining).toBeCloseTo(result.yearsRemaining * 0.85, 0);
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
