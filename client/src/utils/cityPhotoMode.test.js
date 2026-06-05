import { describe, it, expect } from 'vitest';
import {
  PHOTO_PRESETS,
  DEFAULT_PRESET_ID,
  getPreset,
  cyclePreset,
  stepFly,
  FLY_DURATION,
  MAX_FLY_DELTA,
  buildPostcardStats,
  screenshotFilename,
  DOF_DEFAULTS,
  presetFocusDistance,
  getDofParams,
} from './cityPhotoMode';
import { smoothstep } from './easing';

describe('PHOTO_PRESETS', () => {
  it('has unique ids and a position + target each', () => {
    const ids = PHOTO_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PHOTO_PRESETS) {
      expect(p.position).toHaveLength(3);
      expect(p.target).toHaveLength(3);
      expect(typeof p.label).toBe('string');
    }
  });
  it('includes the default preset id', () => {
    expect(PHOTO_PRESETS.some(p => p.id === DEFAULT_PRESET_ID)).toBe(true);
  });
});

describe('getPreset', () => {
  it('resolves a known id', () => {
    expect(getPreset('downtown').id).toBe('downtown');
  });
  it('falls back to the default for an unknown id', () => {
    expect(getPreset('nope').id).toBe(DEFAULT_PRESET_ID);
    expect(getPreset(undefined).id).toBe(DEFAULT_PRESET_ID);
  });
});

describe('cyclePreset', () => {
  it('advances forward and wraps', () => {
    const first = PHOTO_PRESETS[0].id;
    const last = PHOTO_PRESETS[PHOTO_PRESETS.length - 1].id;
    expect(cyclePreset(last, 1)).toBe(first);
  });
  it('advances backward and wraps', () => {
    const first = PHOTO_PRESETS[0].id;
    const last = PHOTO_PRESETS[PHOTO_PRESETS.length - 1].id;
    expect(cyclePreset(first, -1)).toBe(last);
  });
  it('treats an unknown current id as the first preset', () => {
    expect(cyclePreset('bogus', 1)).toBe(PHOTO_PRESETS[1].id);
  });
});

describe('stepFly', () => {
  it('advances progress by delta/duration and eases t for a frame-sized delta', () => {
    const { progress, t, done } = stepFly(0, MAX_FLY_DELTA);
    expect(progress).toBeCloseTo(MAX_FLY_DELTA / FLY_DURATION, 5);
    expect(t).toBeCloseTo(smoothstep(progress), 5);
    expect(done).toBe(false);
  });
  it('clamps a huge idle delta to one frame so a fly never snaps in a single step', () => {
    // In demand mode the first frame after a freeze carries the whole idle gap as delta. The fly
    // must still advance only one frame's worth, not jump straight to settled.
    const { progress, done } = stepFly(0, 9999);
    expect(progress).toBeCloseTo(MAX_FLY_DELTA / FLY_DURATION, 5);
    expect(done).toBe(false);
  });
  it('clamps progress to 1 and reports done once enough frames accumulate', () => {
    const { progress, t, done } = stepFly(0.999, MAX_FLY_DELTA);
    expect(progress).toBe(1);
    expect(t).toBe(1);
    expect(done).toBe(true);
  });
  it('reports done when already settled (no negative drift)', () => {
    expect(stepFly(1, 0.016).done).toBe(true);
    expect(stepFly(1, 0.016).progress).toBe(1);
  });
  it('treats a non-positive or non-finite delta as no advance', () => {
    expect(stepFly(0.3, 0).progress).toBeCloseTo(0.3, 5);
    expect(stepFly(0.3, -1).progress).toBeCloseTo(0.3, 5);
    expect(stepFly(0.3, NaN).progress).toBeCloseTo(0.3, 5);
  });
  it('treats a non-finite progress as settled', () => {
    expect(stepFly(undefined, 0.016).progress).toBe(1);
    expect(stepFly(NaN, 0.016).done).toBe(true);
  });
});

describe('buildPostcardStats', () => {
  it('renders the headline lines that have data', () => {
    const lines = buildPostcardStats({ online: 3, total: 5, agents: 2, peers: 1, level: 7, streak: 4 });
    expect(lines).toContain('3/5 SYSTEMS ONLINE');
    expect(lines).toContain('2 AGENTS ACTIVE');
    expect(lines).toContain('1 PEER LINKED');
    expect(lines).toContain('LEVEL 7');
    expect(lines).toContain('4-DAY STREAK');
  });
  it('omits zero/absent fields rather than printing 0', () => {
    const lines = buildPostcardStats({ online: 0, total: 2, agents: 0, peers: 0 });
    expect(lines).toEqual(['0/2 SYSTEMS ONLINE']);
  });
  it('singularizes agent/peer counts of one', () => {
    const lines = buildPostcardStats({ agents: 1, peers: 1, total: 1, online: 1 });
    expect(lines).toContain('1 AGENT ACTIVE');
    expect(lines).toContain('1 PEER LINKED');
  });
  it('handles an empty snapshot', () => {
    expect(buildPostcardStats()).toEqual([]);
    expect(buildPostcardStats({})).toEqual([]);
  });
  it('renders level 0', () => {
    expect(buildPostcardStats({ level: 0 })).toContain('LEVEL 0');
  });
});

describe('screenshotFilename', () => {
  it('formats a zero-padded timestamped name', () => {
    const d = new Date(2026, 5, 3, 9, 7, 5); // 2026-06-03 09:07:05 (month is 0-based)
    expect(screenshotFilename(d)).toBe('cybercity-20260603-090705.png');
  });
  it('is deterministic for the same date', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(screenshotFilename(d)).toBe(screenshotFilename(d));
  });
});

describe('presetFocusDistance', () => {
  it('is the euclidean distance from camera position to look-at target', () => {
    // position 3-4-0 from origin target → 5 (3-4-5 triangle)
    expect(presetFocusDistance({ position: [3, 4, 0], target: [0, 0, 0] })).toBe(5);
  });
  it('is always positive and finite for every shipped preset', () => {
    for (const p of PHOTO_PRESETS) {
      const d = presetFocusDistance(p);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(0);
    }
  });
  it('falls back to 1 for malformed presets (never zero focal plane)', () => {
    expect(presetFocusDistance(undefined)).toBe(1);
    expect(presetFocusDistance({})).toBe(1);
    expect(presetFocusDistance({ position: [0, 0, 0], target: [0, 0, 0] })).toBe(1); // distance 0 → fallback
  });
});

describe('getDofParams', () => {
  it('derives focus from the preset framing and applies the default aperture/maxblur', () => {
    const params = getDofParams('downtown');
    expect(params.focus).toBe(presetFocusDistance(getPreset('downtown')));
    expect(params.aperture).toBe(DOF_DEFAULTS.aperture);
    expect(params.maxblur).toBe(DOF_DEFAULTS.maxblur);
  });
  it('falls back to the default preset for an unknown id', () => {
    expect(getDofParams('nope').focus).toBe(getDofParams(DEFAULT_PRESET_ID).focus);
  });
  it('honors a per-preset aperture override while still defaulting unspecified fields', () => {
    // low-angle ships a wider aperture override but no maxblur override.
    const lowAngle = getPreset('low-angle');
    expect(lowAngle.dof?.aperture).toBe(0.09); // guards the shipped override against drift
    const params = getDofParams('low-angle');
    expect(params.aperture).toBe(0.09);
    expect(params.maxblur).toBe(DOF_DEFAULTS.maxblur); // unspecified → default
  });
  it('always returns positive finite aperture/maxblur and a positive focus', () => {
    for (const p of PHOTO_PRESETS) {
      const params = getDofParams(p.id);
      expect(params.focus).toBeGreaterThan(0);
      expect(params.aperture).toBeGreaterThan(0);
      expect(params.maxblur).toBeGreaterThan(0);
      expect(Number.isFinite(params.aperture)).toBe(true);
      expect(Number.isFinite(params.maxblur)).toBe(true);
    }
  });
});
