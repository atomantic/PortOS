import { describe, it, expect } from 'vitest';
import { computeChronotypeEnergy } from './cityChronotype';

// The module's internals (parseHour / computeEnergy / energyModifiers and the range
// constants) are deliberately NOT exported — computeChronotypeEnergy is the sole
// public entry point, so every behavior below is exercised through it. The expected
// bounds are written as literals here rather than imported, so a change to the
// tasteful ranges has to be re-affirmed in the test instead of silently agreeing
// with itself.
const BRIGHTNESS_MIN = 0.7;
const BRIGHTNESS_MAX = 1.15;
const TEMPO_MIN = 0.8;
const TEMPO_MAX = 1.15;
// A missing/partial profile is a true no-op: brightness and tempo untouched.
const NEUTRAL = { energy: 1.0, brightness: 1.0, tempo: 1.0 };

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

describe('computeChronotypeEnergy — energy curve', () => {
  it('is highest at the peak focus center', () => {
    const atPeak = computeChronotypeEnergy(PROFILE, PEAK_HOUR);
    const atWake = computeChronotypeEnergy(PROFILE, 7);
    const atSleep = computeChronotypeEnergy(PROFILE, 23);
    expect(atPeak.energy).toBeGreaterThan(atWake.energy);
    expect(atPeak.energy).toBeGreaterThan(atSleep.energy);
    expect(atPeak.energy).toBeCloseTo(1.0, 5);
  });

  it('is lowest during recovery (sleep) hours', () => {
    const atSleep = computeChronotypeEnergy(PROFILE, 23);
    expect(atSleep.energy).toBeLessThan(computeChronotypeEnergy(PROFILE, PEAK_HOUR).energy);
    expect(atSleep.energy).toBeLessThan(0.5);
  });

  it('parses HH:MM recommendations into fractional hours (09:30 peak start ⇒ 11.25 center)', () => {
    // The peak center is the maximum of the curve, so an exact hit at 11.25 proves
    // the ":30" half-hour was parsed as 9.5 rather than truncated to 9 or 10.
    expect(computeChronotypeEnergy(PROFILE, 11.25).energy).toBeCloseTo(1.0, 5);
    expect(computeChronotypeEnergy(PROFILE, 11).energy).toBeLessThan(1.0);
    expect(computeChronotypeEnergy(PROFILE, 11.5).energy).toBeLessThan(1.0);
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
    const at1am = computeChronotypeEnergy(evening, 1);
    const atPeak = computeChronotypeEnergy(evening, 13); // peak center
    expect(at1am.energy).toBeLessThan(atPeak.energy);
    expect(at1am.energy).toBeLessThan(0.5);
  });
});

describe('computeChronotypeEnergy — neutral no-op fallbacks', () => {
  it('returns the neutral no-op for a missing or partial profile (no crash)', () => {
    expect(computeChronotypeEnergy(null, 12)).toEqual(NEUTRAL);
    expect(computeChronotypeEnergy({}, 12)).toEqual(NEUTRAL);
    expect(computeChronotypeEnergy({ recommendations: {} }, 12)).toEqual(NEUTRAL);
    // peak window missing → can't anchor → neutral
    expect(computeChronotypeEnergy({ recommendations: { wakeTime: '07:00' } }, 12)).toEqual(NEUTRAL);
  });

  it('returns the neutral no-op when the peak window is unparseable', () => {
    const bad = (peakFocusStart, peakFocusEnd) => ({
      recommendations: { ...PROFILE.recommendations, peakFocusStart, peakFocusEnd },
    });
    expect(computeChronotypeEnergy(bad('not-a-time', '13:00'), 12)).toEqual(NEUTRAL);
    expect(computeChronotypeEnergy(bad('09:30', '24:00'), 12)).toEqual(NEUTRAL);
    expect(computeChronotypeEnergy(bad(null, '13:00'), 12)).toEqual(NEUTRAL);
    expect(computeChronotypeEnergy(bad(undefined, undefined), 12)).toEqual(NEUTRAL);
  });

  it('returns the neutral no-op when the hour is not finite', () => {
    expect(computeChronotypeEnergy(PROFILE, NaN)).toEqual(NEUTRAL);
    expect(computeChronotypeEnergy(PROFILE, undefined)).toEqual(NEUTRAL);
  });

  it('ignores unparseable secondary anchors rather than falling back to neutral', () => {
    const partial = {
      recommendations: { peakFocusStart: '09:30', peakFocusEnd: '13:00', sleepTime: 'nope' },
    };
    const m = computeChronotypeEnergy(partial, PEAK_HOUR);
    expect(m).not.toEqual(NEUTRAL);
    expect(m.brightness).toBeCloseTo(BRIGHTNESS_MAX);
  });
});

describe('computeChronotypeEnergy — display modifiers', () => {
  it('maps the peak focus center to the top of each clamped range', () => {
    const m = computeChronotypeEnergy(PROFILE, PEAK_HOUR);
    expect(m.brightness).toBeCloseTo(BRIGHTNESS_MAX);
    expect(m.tempo).toBeCloseTo(TEMPO_MAX);
    // A real curve value of exactly 1.0 must map to peak brightness, NOT the neutral no-op.
    expect(m.brightness).not.toBe(1.0);
  });

  it('peak hour → higher brightness and tempo than a recovery hour', () => {
    const peak = computeChronotypeEnergy(PROFILE, PEAK_HOUR);
    const recovery = computeChronotypeEnergy(PROFILE, 23);
    expect(peak.brightness).toBeGreaterThan(recovery.brightness);
    expect(peak.tempo).toBeGreaterThan(recovery.tempo);
  });

  it('keeps energy, brightness and tempo inside the tasteful bounds across the whole day', () => {
    for (let h = 0; h < 24; h += 0.5) {
      const m = computeChronotypeEnergy(PROFILE, h);
      expect(m.energy).toBeGreaterThanOrEqual(0);
      expect(m.energy).toBeLessThanOrEqual(1);
      expect(m.brightness).toBeGreaterThanOrEqual(BRIGHTNESS_MIN);
      expect(m.brightness).toBeLessThanOrEqual(BRIGHTNESS_MAX);
      expect(m.tempo).toBeGreaterThanOrEqual(TEMPO_MIN);
      expect(m.tempo).toBeLessThanOrEqual(TEMPO_MAX);
    }
  });

  it('exposes only computeChronotypeEnergy as the module surface', async () => {
    const mod = await import('./cityChronotype');
    expect(Object.keys(mod)).toEqual(['computeChronotypeEnergy']);
  });
});
