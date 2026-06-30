import { describe, it, expect } from 'vitest';
import { buildBeatGridPoints, snapTimeToGrid, computeSceneSpans } from './beatGrid.js';

describe('buildBeatGridPoints', () => {
  it('returns an empty list with no analysis', () => {
    expect(buildBeatGridPoints(null)).toEqual([]);
  });

  it('merges beats, downbeats, and section edges, sorted by time', () => {
    const points = buildBeatGridPoints({
      beats: [0, 0.5, 1],
      downbeats: [0],
      sections: [{ label: 'Section 1', startSec: 0, endSec: 1 }],
    });
    expect(points.map((p) => p.t)).toEqual([0, 0.5, 1]);
  });

  it('collapses near-identical timestamps to the strongest kind', () => {
    // A downbeat at 1.0 and a section edge at 1.005 are the "same" landmark.
    const points = buildBeatGridPoints({
      beats: [1.0],
      downbeats: [1.0],
      sections: [{ label: 'Section 1', startSec: 0, endSec: 1.005 }],
    });
    expect(points).toHaveLength(2); // 0 and the merged ~1.0 point
    const merged = points.find((p) => Math.abs(p.t - 1.0) < 0.02);
    expect(merged.kind).toBe('section'); // section outranks downbeat outranks beat
  });

  it('ignores malformed entries', () => {
    const points = buildBeatGridPoints({ beats: [null, undefined, 'x', 1], downbeats: [], sections: [] });
    expect(points).toEqual([{ t: 1, kind: 'beat' }]);
  });
});

describe('snapTimeToGrid', () => {
  const grid = [{ t: 1, kind: 'beat' }, { t: 2, kind: 'downbeat' }, { t: 4, kind: 'section' }];

  it('returns null with no grid points', () => {
    expect(snapTimeToGrid(1, [])).toBeNull();
    expect(snapTimeToGrid(1, null)).toBeNull();
  });

  it('snaps to the nearest point within tolerance', () => {
    expect(snapTimeToGrid(1.05, grid, 0.15)).toEqual({ t: 1, kind: 'beat' });
  });

  it('returns null when nothing is within tolerance', () => {
    expect(snapTimeToGrid(2.6, grid, 0.15)).toBeNull();
  });

  it('picks the closer of two candidates', () => {
    expect(snapTimeToGrid(1.6, grid, 1)).toEqual({ t: 2, kind: 'downbeat' });
  });
});

describe('computeSceneSpans', () => {
  it('returns an empty array with no scenes', () => {
    expect(computeSceneSpans(null)).toEqual([]);
    expect(computeSceneSpans([])).toEqual([]);
  });

  it('keeps an explicit, valid startSec/endSec untouched', () => {
    const spans = computeSceneSpans([{ sceneId: 's1', order: 0, startSec: 2, endSec: 5 }]);
    expect(spans).toEqual([{ sceneId: 's1', startSec: 2, endSec: 5, persisted: true }]);
  });

  it('lays out scenes without a position contiguously in order', () => {
    const spans = computeSceneSpans([
      { sceneId: 's2', order: 1 },
      { sceneId: 's1', order: 0 },
    ]);
    expect(spans).toEqual([
      { sceneId: 's1', startSec: 0, endSec: 3, persisted: false },
      { sceneId: 's2', startSec: 3, endSec: 6, persisted: false },
    ]);
  });

  it('resumes the fallback cursor after a persisted scene', () => {
    const spans = computeSceneSpans([
      { sceneId: 's1', order: 0, startSec: 0, endSec: 10 },
      { sceneId: 's2', order: 1 },
    ]);
    expect(spans[1]).toEqual({ sceneId: 's2', startSec: 10, endSec: 13, persisted: false });
  });

  it('clamps a fallback span to the track duration when known', () => {
    const spans = computeSceneSpans([{ sceneId: 's1', order: 0 }], 1.5);
    expect(spans[0]).toEqual({ sceneId: 's1', startSec: 0, endSec: 1.5, persisted: false });
  });

  it('treats a non-positive endSec<=startSec pair as not persisted', () => {
    const spans = computeSceneSpans([{ sceneId: 's1', order: 0, startSec: 5, endSec: 5 }]);
    expect(spans[0]).toEqual({ sceneId: 's1', startSec: 0, endSec: 3, persisted: false });
  });
});
