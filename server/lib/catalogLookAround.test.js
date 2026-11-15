import { describe, expect, it } from 'vitest';
import {
  analyzeLookAroundFrames, composeLookAroundPrompt, estimateHorizontalShift, LOOK_AROUND_MOTION_IDS,
  lookAroundAngleLabel, normalizeLookAroundAngle, pickLookAroundStrip,
} from './catalogLookAround.js';

// A deterministic, non-repeating brightness pattern a pan slides across.
const panorama = (length) => Float64Array.from({ length }, (_, x) => 128 + 60 * Math.sin(x / 7) + 40 * Math.sin(x / 23 + 1) + ((x * 37) % 11));
const windowAt = (strip, offset, width) => strip.slice(offset, offset + width);

describe('composeLookAroundPrompt', () => {
  // Catches a motion whose prompt drops the tripod move or the empty-place / constant-light rules.
  it('writes the move for each motion and the same steadiness, emptiness and light rules', () => {
    const prompts = Object.fromEntries(LOOK_AROUND_MOTION_IDS.map((id) => [id, composeLookAroundPrompt(id)]));
    expect(prompts['full-turn']).toMatch(/to the right through one full 360-degree turn/);
    expect(prompts['half-right']).toMatch(/to the right through a half turn of 180 degrees/);
    expect(prompts['half-left']).toMatch(/to the left through a half turn of 180 degrees/);
    expect(prompts['push-forward']).toMatch(/straight forward .* without turning/);
    for (const text of Object.values(prompts)) {
      expect(text).toMatch(/Locked-off tripod/);
      expect(text).toMatch(/Steady, even speed/);
      expect(text).toMatch(/horizon stays level/);
      expect(text).toMatch(/no people, no animals, no moving vehicles/);
      expect(text).toMatch(/keep the sun or glow where the opening frame has it/);
      expect(text.length).toBeLessThan(2000);
    }
    expect(() => composeLookAroundPrompt('spin')).toThrow(/Unknown/);
  });
});

describe('frame analysis', () => {
  // Catches a sign error: content sliding left means the camera turned right.
  it('reads the pan direction and distance from column profiles', () => {
    const strip = panorama(400);
    expect(estimateHorizontalShift(windowAt(strip, 0, 200), windowAt(strip, 18, 200)).shift).toBe(18);
    expect(estimateHorizontalShift(windowAt(strip, 30, 200), windowAt(strip, 0, 200)).shift).toBe(-30);
    expect(estimateHorizontalShift(new Float64Array(200).fill(9), new Float64Array(200).fill(9))).toEqual({ shift: 0, correlation: 0 });
  });

  // Catches labelling from the prompt: the model turned right although a left half turn was asked for.
  it('places frames in the sweep from the frames themselves, including a turn opposite to the prompt', () => {
    const strip = panorama(1200);
    const frames = Array.from({ length: 11 }, (_, i) => ({ atSec: i, sharpness: 0.6, profile: windowAt(strip, i * 40, 200) }));
    const result = analyzeLookAroundFrames(frames, { motion: 'half-left', durationSec: 10, width: 200 });
    expect(result).toMatchObject({ direction: 'right', directionSource: 'frames', requestedDirection: 'left' });
    expect(result.frames.map((f) => f.bearingDeg)).toEqual([0, 18, 36, 54, 72, 90, 108, 126, 144, 162, 180]);
    expect(result.frames[5]).toMatchObject({ label: '90° right', progress: 0.5 });
    expect(result.frames[0]).not.toHaveProperty('profile');
  });

  // Catches inventing a direction from noise: a clip that barely moved is placed by time and the asked-for turn.
  it('falls back to time and the requested direction when the clip did not visibly turn', () => {
    const strip = panorama(300);
    const frames = Array.from({ length: 5 }, (_, i) => ({ atSec: i * 2, sharpness: 0.5, profile: windowAt(strip, i % 2, 200) }));
    const result = analyzeLookAroundFrames(frames, { motion: 'full-turn', durationSec: 8, width: 200 });
    expect(result).toMatchObject({ direction: 'right', directionSource: 'prompt' });
    expect(result.frames.map((f) => f.label)).toEqual(['Main plate view', '90° right', '180° behind', '90° left', 'Main plate view']);
  });

  // Catches suggestions clustering where the turn was slow, or a blurred frame beating a sharp one in its slice.
  it('suggests the sharpest usable frame in each slice of the sweep, in clip order', () => {
    const frames = [
      { atSec: 0, progress: 0, sharpness: 0.5 }, { atSec: 1, progress: 0.1, sharpness: 0.8 },
      { atSec: 2, progress: 0.3, sharpness: 0.05 }, { atSec: 3, progress: 0.55, sharpness: 0.4 },
      { atSec: 4, progress: 0.6, sharpness: 0.7 }, { atSec: 5, progress: 1, sharpness: 0.6 },
    ];
    expect(pickLookAroundStrip(frames, { count: 4, minSharpness: 0.2 }).map((f) => f.atSec)).toEqual([1, 4, 5]);
  });

  it('names angles by bearing and push progress', () => {
    expect([0, 45, 92, 180, 270, 359].map((bearingDeg) => lookAroundAngleLabel({ motion: 'full-turn', bearingDeg })))
      .toEqual(['Main plate view', '45° right', '90° right', '180° behind', '90° left', 'Main plate view']);
    expect(lookAroundAngleLabel({ motion: 'push-forward', progress: 0.42 })).toBe('Pushed in 42%');
  });
});

describe('normalizeLookAroundAngle', () => {
  // Catches a malformed peer value being stored as lineage.
  it('keeps the lineage fields and drops anything malformed', () => {
    expect(normalizeLookAroundAngle({ clipId: 'clip-1', sourceMediaKey: 'plate.png', atSec: 3.14159, bearingDeg: 450, motion: 'full-turn', extra: 1 }))
      .toEqual({ clipId: 'clip-1', sourceMediaKey: 'plate.png', atSec: 3.142, bearingDeg: 90, motion: 'full-turn' });
    expect(normalizeLookAroundAngle({ clipId: 'clip-1', atSec: 1 })).toBeNull();
    expect(normalizeLookAroundAngle({ clipId: 'clip-1', sourceMediaKey: 'plate.png', atSec: -1 })).toBeNull();
    expect(normalizeLookAroundAngle('clip-1')).toBeNull();
  });
});
