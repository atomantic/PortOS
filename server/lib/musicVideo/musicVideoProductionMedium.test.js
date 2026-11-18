import { describe, expect, it } from 'vitest';
import { normalizeProductionMedium, productionMediumAddition, rendersIntercut, steppedHoldPlan } from './musicVideoProductionMedium.js';

describe('production medium policy', () => {
  it('keeps an unrecognized or absent medium as today (null, no chip, scene cutting stays)', () => {
    expect(normalizeProductionMedium('claymation')).toBeNull();
    expect(productionMediumAddition({})).toBeNull();
    expect(productionMediumAddition({ productionMedium: 'stepped' })).toMatchObject({ id: 'production-medium', label: 'Production medium' });
    expect(rendersIntercut({ composition: { cutting: 'scene' } })).toBe(false);
    expect(rendersIntercut({})).toBe(false);
  });

  it('intercuts a beat-graphic project unless the director chose scene cutting', () => {
    expect(rendersIntercut({ productionMedium: 'beat-graphic' })).toBe(true);
    expect(rendersIntercut({ productionMedium: 'beat-graphic', composition: { cutting: 'scene' } })).toBe(false);
    expect(rendersIntercut({ productionMedium: 'stepped' })).toBe(false);
  });
});

// Uniquely catches the performance exemption and a gap in the tiling: the hold plan is
// what decides which delivered frames are paired.
describe('steppedHoldPlan', () => {
  const sections = [
    { sceneId: 'a', startSec: 0, endSec: 2 },
    { sceneId: 'perf', startSec: 2, endSec: 3 },
    { sceneId: 'b', startSec: 3, endSec: 4 },
    { sceneId: 'c', startSec: 4, endSec: 5 },
  ];

  it('holds every shot but a performance, merging neighbours, and tiles the file', () => {
    const { parts, exemptSceneIds } = steppedHoldPlan(sections, { performanceSceneIds: ['perf'], fps: 24, totalFrames: 120 });
    expect(parts).toEqual([
      { startFrame: 0, endFrame: 48, held: true },
      { startFrame: 48, endFrame: 72, held: false },
      { startFrame: 72, endFrame: 120, held: true },
    ]);
    expect(exemptSceneIds).toEqual(['perf']);
  });

  it('offsets the song by the cold open and leaves the open and any outro unheld', () => {
    const { parts } = steppedHoldPlan(sections, { performanceSceneIds: [], fps: 24, leadSec: 1, totalFrames: 168 });
    expect(parts).toEqual([
      { startFrame: 0, endFrame: 24, held: false },
      { startFrame: 24, endFrame: 144, held: true },
      { startFrame: 144, endFrame: 168, held: false },
    ]);
  });
});
