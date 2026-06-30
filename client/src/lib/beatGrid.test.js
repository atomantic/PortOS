import { describe, it, expect } from 'vitest';
import { buildBeatGridPoints, snapTimeToGrid, computeSceneSpans, computeDragSpan, shouldMarkBeatAligned, autoArrangeScenes } from './beatGrid.js';

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

describe('autoArrangeScenes', () => {
  const scenes = (n) => Array.from({ length: n }, (_, i) => ({ sceneId: `s${i + 1}`, order: i }));

  it('returns an empty arrangement with no scenes', () => {
    expect(autoArrangeScenes([], { sections: [{ startSec: 0, endSec: 10 }], durationSec: 10 })).toEqual([]);
    expect(autoArrangeScenes(null, null)).toEqual([]);
  });

  it('returns [] when there is nothing to arrange against (no sections, no duration)', () => {
    expect(autoArrangeScenes(scenes(3), { sections: [] })).toEqual([]);
    expect(autoArrangeScenes(scenes(3), null)).toEqual([]);
  });

  it('covers a single section contiguously, in scene order, with no gaps', () => {
    const out = autoArrangeScenes(scenes(3), { sections: [{ startSec: 0, endSec: 9, energy: 1 }], durationSec: 9 });
    expect(out.map((a) => a.sceneId)).toEqual(['s1', 's2', 's3']);
    expect(out[0].startSec).toBe(0);
    expect(out[out.length - 1].endSec).toBe(9);
    for (let i = 1; i < out.length; i++) expect(out[i].startSec).toBeCloseTo(out[i - 1].endSec, 3);
  });

  it('falls back to a single track-spanning section when sections are absent', () => {
    const out = autoArrangeScenes(scenes(2), { durationSec: 8 });
    expect(out).toHaveLength(2);
    expect(out[0].startSec).toBe(0);
    expect(out[1].endSec).toBe(8);
  });

  it('gives the higher-energy section more (shorter) cuts than the lower-energy one', () => {
    const analysis = {
      durationSec: 20,
      sections: [
        { startSec: 0, endSec: 10, energy: 0.2 }, // calm
        { startSec: 10, endSec: 20, energy: 1.0 }, // loud
      ],
    };
    const out = autoArrangeScenes(scenes(6), analysis);
    const loud = out.filter((a) => a.startSec >= 10);
    const calm = out.filter((a) => a.endSec <= 10);
    expect(loud.length).toBeGreaterThan(calm.length);
    // Loud-section cuts are on average shorter than calm-section cuts.
    const avg = (arr) => arr.reduce((s, a) => s + (a.endSec - a.startSec), 0) / arr.length;
    expect(avg(loud)).toBeLessThan(avg(calm));
  });

  it('spreads scenes evenly when no section carries energy (legacy analysis)', () => {
    const analysis = {
      durationSec: 20,
      sections: [
        { startSec: 0, endSec: 10 },
        { startSec: 10, endSec: 20 },
      ],
    };
    const out = autoArrangeScenes(scenes(4), analysis);
    expect(out.filter((a) => a.endSec <= 10)).toHaveLength(2);
    expect(out.filter((a) => a.startSec >= 10)).toHaveLength(2);
  });

  it('assigns exactly one span per scene even with more sections than scenes', () => {
    const analysis = {
      durationSec: 30,
      sections: [
        { startSec: 0, endSec: 10, energy: 1 },
        { startSec: 10, endSec: 20, energy: 0.1 },
        { startSec: 20, endSec: 30, energy: 0.1 },
      ],
    };
    const out = autoArrangeScenes(scenes(2), analysis);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((a) => a.sceneId)).size).toBe(2);
  });

  it('covers every section (no gap) when scenes >= sections, even a near-silent one', () => {
    const analysis = {
      durationSec: 30,
      sections: [
        { startSec: 0, endSec: 10, energy: 1 },
        { startSec: 10, endSec: 20, energy: 0.001 }, // near-silent breakdown
        { startSec: 20, endSec: 30, energy: 1 },
      ],
    };
    const out = autoArrangeScenes(scenes(3), analysis);
    // Each section gets at least one scene → the arrangement spans the whole track.
    expect(out.some((a) => a.endSec <= 10)).toBe(true);
    expect(out.some((a) => a.startSec >= 10 && a.endSec <= 20)).toBe(true);
    expect(out.some((a) => a.startSec >= 20)).toBe(true);
    expect(out[0].startSec).toBe(0);
    expect(out[out.length - 1].endSec).toBe(30);
  });

  it('weights a longer section more than a shorter equal-energy one (density tracks energy)', () => {
    const analysis = {
      durationSec: 25,
      sections: [
        { startSec: 0, endSec: 5, energy: 1 }, // short
        { startSec: 5, endSec: 25, energy: 1 }, // 4x longer, same energy
      ],
    };
    const out = autoArrangeScenes(scenes(5), analysis);
    expect(out.filter((a) => a.startSec >= 5).length)
      .toBeGreaterThan(out.filter((a) => a.endSec <= 5).length);
  });

  it('snaps interior cuts to the beat grid and marks them beatAligned', () => {
    const analysis = {
      durationSec: 8,
      beats: [0, 2, 4, 6, 8],
      sections: [{ startSec: 0, endSec: 8, energy: 1 }],
    };
    const out = autoArrangeScenes(scenes(2), analysis);
    expect(out.every((a) => a.beatAligned)).toBe(true);
    // The single interior cut (raw 4.0) lands on the beat at 4.
    expect(out[0].endSec).toBe(4);
    expect(out[1].startSec).toBe(4);
  });

  it('marks every auto-arranged span beatAligned so the render honors the durations', () => {
    // Even the synthetic single-section fallback (no real sections) is honored.
    const out = autoArrangeScenes(scenes(2), { durationSec: 6 });
    expect(out.every((a) => a.beatAligned === true)).toBe(true);
    expect(out.map((a) => [a.startSec, a.endSec])).toEqual([[0, 3], [3, 6]]);
  });

  it('divides a section with no interior beats evenly instead of collapsing to its edges', () => {
    // The section's own outer edges are grid points; with a finite snap tolerance
    // the interior cuts must NOT collapse onto them — they stay at even thirds.
    const analysis = {
      durationSec: 30,
      beats: [], // no interior beats
      sections: [{ startSec: 0, endSec: 30, energy: 1 }],
    };
    const out = autoArrangeScenes(scenes(3), analysis);
    for (const a of out) expect(a.endSec - a.startSec).toBeCloseTo(10, 3);
  });

  it('keeps every span at least minSceneSec long rather than snapping them away', () => {
    const analysis = {
      durationSec: 6,
      beats: [0, 0.1, 5.9, 6], // a beat clings to each section edge
      sections: [{ startSec: 0, endSec: 6, energy: 1 }],
    };
    const out = autoArrangeScenes(scenes(2), analysis, { minSceneSec: 1 });
    for (const a of out) expect(a.endSec - a.startSec).toBeGreaterThanOrEqual(1);
  });

  it('orders the arrangement by scene order, not input order', () => {
    const unordered = [
      { sceneId: 's2', order: 1 },
      { sceneId: 's1', order: 0 },
    ];
    const out = autoArrangeScenes(unordered, { sections: [{ startSec: 0, endSec: 4, energy: 1 }], durationSec: 4 });
    expect(out.map((a) => a.sceneId)).toEqual(['s1', 's2']);
  });
});

describe('computeDragSpan', () => {
  const grid = [{ t: 5, kind: 'beat' }, { t: 10, kind: 'downbeat' }];

  it('repositions both edges on a move, preserving duration', () => {
    const result = computeDragSpan({ kind: 'move', startSpan: { startSec: 2, endSec: 4 }, deltaSec: 1, gridPoints: [] });
    expect(result).toEqual({ startSec: 3, endSec: 5, snapped: false });
  });

  it('snaps a move to the nearest grid point and shifts the end by the same offset', () => {
    const result = computeDragSpan({ kind: 'move', startSpan: { startSec: 2, endSec: 4 }, deltaSec: 2.9, gridPoints: grid, toleranceSec: 0.2 });
    // raw start = 4.9, snaps to the beat at 5; duration (2) is preserved.
    expect(result).toEqual({ startSec: 5, endSec: 7, snapped: true });
  });

  it('never moves a move-drag start below 0', () => {
    const result = computeDragSpan({ kind: 'move', startSpan: { startSec: 1, endSec: 3 }, deltaSec: -5, gridPoints: [] });
    expect(result.startSec).toBe(0);
    expect(result.endSec).toBe(2); // duration preserved
  });

  it('only moves the end on a right-edge drag, start untouched', () => {
    const result = computeDragSpan({ kind: 'right', startSpan: { startSec: 2, endSec: 4 }, deltaSec: 1, gridPoints: [] });
    expect(result).toEqual({ startSec: 2, endSec: 5, snapped: false });
  });

  it('snaps a right-edge drag to the nearest grid point', () => {
    const result = computeDragSpan({ kind: 'right', startSpan: { startSec: 2, endSec: 4.9 }, deltaSec: 0, gridPoints: grid, toleranceSec: 0.2 });
    expect(result).toEqual({ startSec: 2, endSec: 5, snapped: true });
  });

  it('clamps a right-edge drag to minSceneSec', () => {
    const result = computeDragSpan({ kind: 'right', startSpan: { startSec: 2, endSec: 4 }, deltaSec: -10, gridPoints: [], minSceneSec: 0.5 });
    expect(result.endSec).toBeCloseTo(2.5, 5);
  });
});

describe('shouldMarkBeatAligned', () => {
  it('is false when the drag did not snap, regardless of kind', () => {
    expect(shouldMarkBeatAligned({ kind: 'right', snapped: false, wasPersisted: true })).toBe(false);
    expect(shouldMarkBeatAligned({ kind: 'move', snapped: false, wasPersisted: true })).toBe(false);
  });

  it('a snapped right-edge (explicit duration-setting) drag is always beat-aligned', () => {
    expect(shouldMarkBeatAligned({ kind: 'right', snapped: true, wasPersisted: false })).toBe(true);
    expect(shouldMarkBeatAligned({ kind: 'right', snapped: true, wasPersisted: true })).toBe(true);
  });

  it('a snapped move on an unpersisted (fallback) span is NOT beat-aligned', () => {
    // Reposition-only drags never set a duration — confirming one on a scene
    // whose span is still the computeSceneSpans placeholder must not bake
    // that synthetic duration in as the render's "saved exactly" length.
    expect(shouldMarkBeatAligned({ kind: 'move', snapped: true, wasPersisted: false })).toBe(false);
  });

  it('a snapped move on an already-persisted span IS beat-aligned', () => {
    expect(shouldMarkBeatAligned({ kind: 'move', snapped: true, wasPersisted: true })).toBe(true);
  });
});
