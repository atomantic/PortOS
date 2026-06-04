import { describe, it, expect } from 'vitest';
import {
  NEUTRAL_ENERGY,
  NEUTRAL_MODIFIERS,
  ENERGY_RANGE,
  parseHour,
  computeEnergy,
  energyModifiers,
  computeChronotypeEnergy,
} from './cityChronotype';

// A representative "intermediate" chronotype profile (mirrors the shape returned by
// GET /api/digital-twin/identity/chronotype — only the recommendations the overlay
// reads are included).
const PROFILE = {
  type: 'intermediate',
  recommendations: {
    wakeTime: '07:00',
    sleepTime: '23:00',
    peakFocusStart: '09:30',
    peakFocusEnd: '13:00',
    windDownStart: '21:30',
  },
};
// Peak focus center is (9.5 + 13) / 2 = 11.25.
const PEAK_HOUR = 11.25;

describe('parseHour', () => {
  it('parses HH:MM to fractional hours', () => {
    expect(parseHour('09:30')).toBeCloseTo(9.5);
    expect(parseHour('00:00')).toBe(0);
    expect(parseHour('23:45')).toBeCloseTo(23.75);
  });

  it('returns NaN for non-strings or out-of-range values', () => {
    expect(parseHour(null)).toBeNaN();
    expect(parseHour(undefined)).toBeNaN();
    expect(parseHour('not-a-time')).toBeNaN();
    expect(parseHour('24:00')).toBeNaN();
  });
});

describe('computeEnergy', () => {
  it('is highest at the peak focus center', () => {
    const atPeak = computeEnergy(PROFILE, PEAK_HOUR);
    const atWake = computeEnergy(PROFILE, 7);
    const atSleep = computeEnergy(PROFILE, 23);
    expect(atPeak).toBeGreaterThan(atWake);
    expect(atPeak).toBeGreaterThan(atSleep);
    expect(atPeak).toBeCloseTo(1.0, 5);
  });

  it('is lowest during recovery (sleep) hours', () => {
    const atSleep = computeEnergy(PROFILE, 23);
    const atPeak = computeEnergy(PROFILE, PEAK_HOUR);
    expect(atSleep).toBeLessThan(atPeak);
    expect(atSleep).toBeLessThan(0.5);
  });

  it('returns null (sentinel) for a missing or partial profile (no crash)', () => {
    expect(computeEnergy(null, 12)).toBeNull();
    expect(computeEnergy({}, 12)).toBeNull();
    expect(computeEnergy({ recommendations: {} }, 12)).toBeNull();
    // peak window missing → can't anchor → null
    expect(computeEnergy({ recommendations: { wakeTime: '07:00' } }, 12)).toBeNull();
  });

  it('returns null when the hour is not finite', () => {
    expect(computeEnergy(PROFILE, NaN)).toBeNull();
    expect(computeEnergy(PROFILE, undefined)).toBeNull();
  });

  it('stays within [0,1] across the whole day', () => {
    for (let h = 0; h < 24; h += 0.5) {
      const e = computeEnergy(PROFILE, h);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(1);
    }
  });

  it('handles wrap-around midnight for an evening chronotype with after-midnight sleep', () => {
    const evening = {
      recommendations: {
        wakeTime: '08:30',
        sleepTime: '00:30', // 12:30 AM — wraps past midnight
        peakFocusStart: '11:00',
        peakFocusEnd: '15:00',
        windDownStart: '23:00',
      },
    };
    // The post-midnight small hours should read as low energy (close to the 00:30 sleep anchor).
    const at1am = computeEnergy(evening, 1);
    const atPeak = computeEnergy(evening, 13); // peak center
    expect(at1am).toBeLessThan(atPeak);
    expect(at1am).toBeLessThan(0.5);
  });
});

describe('energyModifiers', () => {
  it('maps energy 1 to the top of each clamped range', () => {
    const m = energyModifiers(1);
    expect(m.brightness).toBeCloseTo(ENERGY_RANGE.brightnessMax);
    expect(m.tempo).toBeCloseTo(ENERGY_RANGE.tempoMax);
    expect(m.energy).toBe(1);
  });

  it('maps energy 0 to the bottom of each clamped range', () => {
    const m = energyModifiers(0);
    expect(m.brightness).toBeCloseTo(ENERGY_RANGE.brightnessMin);
    expect(m.tempo).toBeCloseTo(ENERGY_RANGE.tempoMin);
  });

  it('clamps out-of-range energy and treats null/non-finite as a neutral no-op', () => {
    expect(energyModifiers(5).brightness).toBeCloseTo(ENERGY_RANGE.brightnessMax);
    expect(energyModifiers(-3).brightness).toBeCloseTo(ENERGY_RANGE.brightnessMin);
    // null/NaN energy (no usable profile) → neutral no-op, brightness 1.0 (untouched scene).
    expect(energyModifiers(null)).toEqual(NEUTRAL_MODIFIERS);
    expect(energyModifiers(NaN)).toEqual(NEUTRAL_MODIFIERS);
  });

  it('keeps brightness and tempo strictly inside the tasteful bounds', () => {
    for (let e = 0; e <= 1; e += 0.1) {
      const m = energyModifiers(e);
      expect(m.brightness).toBeGreaterThanOrEqual(ENERGY_RANGE.brightnessMin);
      expect(m.brightness).toBeLessThanOrEqual(ENERGY_RANGE.brightnessMax);
      expect(m.tempo).toBeGreaterThanOrEqual(ENERGY_RANGE.tempoMin);
      expect(m.tempo).toBeLessThanOrEqual(ENERGY_RANGE.tempoMax);
    }
  });
});

describe('computeChronotypeEnergy', () => {
  it('peak hour → high brightness, recovery hour → low brightness', () => {
    const peak = computeChronotypeEnergy(PROFILE, PEAK_HOUR);
    const recovery = computeChronotypeEnergy(PROFILE, 23);
    expect(peak.brightness).toBeGreaterThan(recovery.brightness);
    expect(peak.tempo).toBeGreaterThan(recovery.tempo);
  });

  it('missing profile → neutral no-op modifiers (brightness 1.0), no crash', () => {
    const m = computeChronotypeEnergy(null, 12);
    expect(m).toEqual(NEUTRAL_MODIFIERS);
    expect(m.energy).toBe(NEUTRAL_ENERGY);
    expect(m.brightness).toBe(1.0);
  });

  it('peak focus center (real energy 1.0) maps to peak brightness, not the neutral no-op', () => {
    const m = computeChronotypeEnergy(PROFILE, PEAK_HOUR);
    expect(m.brightness).toBeCloseTo(ENERGY_RANGE.brightnessMax);
    expect(m.brightness).not.toBe(1.0);
  });
});
