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
    // Land exactly on the after-midnight sleep anchor (00:30 → hour 0.5). An exact
    // anchor hit returns that anchor's energy verbatim, so 0.12 proves the wrapped
    // "00:30" was parsed and anchored at 0.5 — a weaker "1 AM is below 0.5" check
    // would still pass if 00:30 were dropped entirely, since the 23:00 wind-down
    // anchor alone keeps the small hours low.
    const atSleepAnchor = computeChronotypeEnergy(evening, 0.5);
    expect(atSleepAnchor.energy).toBeCloseTo(0.12, 10);
    // ...and that low energy maps through the bottom of the display ranges:
    // brightness = 0.7 + 0.12 * (1.15 - 0.7), tempo = 0.8 + 0.12 * (1.15 - 0.8).
    expect(atSleepAnchor.brightness).toBeCloseTo(0.754, 10);
    expect(atSleepAnchor.tempo).toBeCloseTo(0.842, 10);

    // The post-midnight small hours read lower than the peak center.
    const at1am = computeChronotypeEnergy(evening, 1);
    const atPeak = computeChronotypeEnergy(evening, 13); // peak center
    expect(at1am.energy).toBeLessThan(atPeak.energy);
    expect(at1am.energy).toBeLessThan(0.5);
  });

  it('blends anchors across the midnight seam (circular distance, not absolute)', () => {
    // Only two anchors, and the low one sits exactly on midnight: peak center 12:00,
    // sleep 00:00. Hours 23:00 and 01:00 are one hour from the sleep anchor and
    // eleven from the peak in EITHER direction, so on a 24h clock they must produce
    // the same energy. With plain |a - b| the pre-midnight hour would read as 23
    // hours from sleep and fall to the peak anchor instead — the symmetry below is
    // what distinguishes the two.
    const midnightSleeper = {
      recommendations: { peakFocusStart: '11:00', peakFocusEnd: '13:00', sleepTime: '00:00' },
    };
    const before = computeChronotypeEnergy(midnightSleeper, 23);
    const after = computeChronotypeEnergy(midnightSleeper, 1);
    expect(before.energy).toBeCloseTo(after.energy, 10);
    // Both sit near the sleep anchor's 0.12, nowhere near the peak's 1.0.
    expect(before.energy).toBeLessThan(0.2);
    expect(after.energy).toBeLessThan(0.2);
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

  it('drops an unparseable secondary anchor rather than falling back to neutral', () => {
    const peak = { peakFocusStart: '09:30', peakFocusEnd: '13:00' };
    const withBadSleep = { recommendations: { ...peak, sleepTime: 'nope' } };
    const withNoSleep = { recommendations: { ...peak } };
    const withGoodSleep = { recommendations: { ...peak, sleepTime: '23:00' } };
    // Evaluate away from every anchor: an exact anchor hit short-circuits before the
    // other anchors are blended, which would hide whether the bad one was dropped.
    const OFF_ANCHOR = 20;

    const bad = computeChronotypeEnergy(withBadSleep, OFF_ANCHOR);
    expect(bad).not.toEqual(NEUTRAL);
    // An unparseable sleep time is dropped, leaving the same curve as omitting it...
    expect(bad.energy).toBeCloseTo(computeChronotypeEnergy(withNoSleep, OFF_ANCHOR).energy, 10);
    // ...and a parseable one genuinely changes the curve, so the equality above is
    // evidence the anchor was dropped rather than evidence anchors do nothing.
    expect(bad.energy).toBeGreaterThan(computeChronotypeEnergy(withGoodSleep, OFF_ANCHOR).energy);
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
