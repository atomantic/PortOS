// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  TIMELINE_MAX_PX_PER_SEC, clampPxPerSec, fitPxPerSec, lyricSpans, reorderedSceneIds, rulerStepSec, rulerTicks, shotsWithCutAt, snapCutTime,
  timelineCuts, timelineDurationSec, timelineShotAt, timelineShots, timelineSplitAt, waveformPath,
} from './musicVideoTimeline.js';

const project = {
  audioAnalysis: { durationSec: 20 },
  scenes: [
    { sceneId: 'b', order: 1, startSec: 4, endSec: 12 },
    { sceneId: 'a', order: 0, startSec: 0, endSec: 4 },
    { sceneId: 'untimed', order: 2, startSec: null, endSec: null },
    { sceneId: 'cold', order: 3, startSec: 0, endSec: 3, preMusic: { durationSec: 3 } },
    { sceneId: 'empty', order: 4, startSec: 5, endSec: 5 },
  ],
};

describe('timelineShots', () => {
  it('places timed song shots in song order and keeps cold-open and untimed shots off the clock', () => {
    const { shots, off } = timelineShots(project);
    expect(shots.map((shot) => [shot.sceneId, shot.number, shot.startSec, shot.endSec])).toEqual([['a', 1, 0, 4], ['b', 2, 4, 12]]);
    expect(off.map((scene) => scene.sceneId)).toEqual(['untimed', 'cold', 'empty']);
  });

  it('runs as long as the song, or the last shot when that ends later', () => {
    expect(timelineDurationSec(project)).toBe(20);
    expect(timelineDurationSec({ scenes: project.scenes })).toBe(12);
    expect(timelineDurationSec({ audioAnalysis: { durationSec: 8 }, scenes: project.scenes })).toBe(12);
    expect(timelineDurationSec({})).toBe(1);
  });

  it('names the shot on screen at a time', () => {
    const { shots } = timelineShots(project);
    expect(timelineShotAt(shots, -1)).toBeNull();
    expect(timelineShotAt(shots, 0).sceneId).toBe('a');
    expect(timelineShotAt(shots, 3.99).sceneId).toBe('a');
    expect(timelineShotAt(shots, 4).sceneId).toBe('b');
  });
});

describe('zoom', () => {
  it('fits the whole song in the view and never zooms out past it or in past a frame per 10 px', () => {
    const fit = fitPxPerSec(400, 200);
    expect(fit).toBe(2);
    expect(clampPxPerSec(1, fit)).toBe(2);
    expect(clampPxPerSec(50, fit)).toBe(50);
    expect(clampPxPerSec(9999, fit)).toBe(TIMELINE_MAX_PX_PER_SEC);
    // A song short enough to fit closer than the closest zoom is shown at the closest zoom.
    expect(fitPxPerSec(4000, 2)).toBe(TIMELINE_MAX_PX_PER_SEC);
  });

  it('labels the ruler on round steps that never crowd', () => {
    expect(rulerStepSec(2)).toBe(60);
    expect(rulerStepSec(20)).toBe(5);
    expect(rulerStepSec(240)).toBe(0.5);
    expect(rulerStepSec(0.01)).toBe(600);
    expect(rulerTicks(20, 5)).toEqual([0, 5, 10, 15, 20]);
    expect(rulerTicks(1.2, 0.5)).toEqual([0, 0.5, 1]);
  });
});

describe('lyricSpans', () => {
  it('runs an open cue to the next one, capped, and keeps an explicit end', () => {
    expect(lyricSpans([
      { id: 'c2', text: 'two', startSec: 5 },
      { id: 'c1', text: 'one', startSec: 1, endSec: 2 },
      { text: 'three', startSec: 30 },
      { text: '', startSec: 40 },
    ])).toEqual([
      { id: 'c1', text: 'one', startSec: 1, endSec: 2 },
      { id: 'c2', text: 'two', startSec: 5, endSec: 13 },
      { id: 'cue-2', text: 'three', startSec: 30, endSec: 38 },
    ]);
  });
});

describe('cuts', () => {
  const gapped = {
    scenes: [
      { sceneId: 'a', startSec: 0, endSec: 4 },
      { sceneId: 'b', startSec: 4, endSec: 12 },
      { sceneId: 'c', startSec: 14, endSec: 18 },
    ],
  };
  const { shots } = timelineShots(gapped);
  const cuts = timelineCuts(shots, 20);

  it('gives every shot an out-point, and an in-point only where nothing is joined before it', () => {
    expect(cuts.map((cut) => [cut.id, cut.t, cut.minSec, cut.maxSec])).toEqual([
      ['a:start', 0, 0, 3.9],
      ['a:end', 4, 0.1, 11.9],
      ['b:end', 12, 4.1, 17.9],
      ['c:start', 14, 4.1, 17.9],
      ['c:end', 18, 14.1, 20],
    ]);
  });

  it('lands a dragged cut on a frame, on a nearby snap point, and inside its range', () => {
    const cut = cuts[1];
    expect(snapCutTime(5.01, cut)).toEqual({ t: 5, snapped: false });
    expect(snapCutTime(5.03, cut)).toEqual({ t: 5.042, snapped: false });
    expect(snapCutTime(5.4, cut, [5.5, 9], 0.15)).toEqual({ t: 5.5, snapped: true });
    expect(snapCutTime(5.2, cut, [5.5], 0.15).snapped).toBe(false);
    expect(snapCutTime(-3, cut).t).toBe(0.1);
    expect(snapCutTime(99, cut).t).toBe(11.9);
    // A snap point outside the range is not a place the cut can go.
    expect(snapCutTime(11.85, cut, [12], 0.5)).toEqual({ t: 11.833, snapped: false });
  });

  it('previews a moved cut on the shot and the one joined across it', () => {
    const span = (list) => list.map((shot) => [shot.startSec, shot.endSec]);
    expect(span(shotsWithCutAt(shots, cuts[1], 6))).toEqual([[0, 6], [6, 12], [14, 18]]);
    expect(span(shotsWithCutAt(shots, cuts[3], 13))).toEqual([[0, 4], [4, 13], [13, 18]]);
    expect(shotsWithCutAt(shots, null, 6)).toBe(shots);
  });
});

describe('reorderedSceneIds', () => {
  it('moves a shot among the timeline shots and leaves shots off the clock in place', () => {
    const board = [
      { sceneId: 'cold', preMusic: { durationSec: 2 } },
      { sceneId: 'a', startSec: 0, endSec: 4 },
      { sceneId: 'b', startSec: 4, endSec: 8 },
      { sceneId: 'untimed' },
      { sceneId: 'c', startSec: 8, endSec: 12 },
    ];
    const { shots } = timelineShots({ scenes: board });
    expect(reorderedSceneIds(board, shots, 2, 0)).toEqual(['cold', 'c', 'a', 'untimed', 'b']);
    expect(reorderedSceneIds(board, shots, 0, 1)).toEqual(['cold', 'b', 'a', 'untimed', 'c']);
    expect(reorderedSceneIds(board, shots, 1, 1)).toBeNull();
    expect(reorderedSceneIds(board, shots, 0, 3)).toBeNull();
  });
});

describe('timelineSplitAt', () => {
  const { shots } = timelineShots({ scenes: [{ sceneId: 'a', startSec: 0, endSec: 4 }, { sceneId: 'b', startSec: 4, endSec: 6 }] });
  // Uniquely catches a split off a frame, or one leaving a sliver the server refuses.
  it('cuts the shot under the playhead on a frame, never within a tenth of a second of its ends', () => {
    expect(timelineSplitAt(shots, 1.01)).toEqual({ sceneId: 'a', atSec: 1 });
    expect(timelineSplitAt(shots, 4.5)).toEqual({ sceneId: 'b', atSec: 4.5 });
    expect(timelineSplitAt(shots, 3.95)).toBeNull();
    expect(timelineSplitAt(shots, 4.02)).toBeNull();
    expect(timelineSplitAt(shots, 7)).toBeNull();
  });
});

describe('waveformPath', () => {
  // Uniquely catches a waveform that drops quiet-to-loud peaks when columns merge, or draws one for an unanalyzed song.
  it('keeps each column\'s loudest sample, mirrored about the middle, and is null without a loudness track', () => {
    expect(waveformPath({ fps: 2, rms: [0.2, 1, 0, 0.4] }, 2)).toBe('M0 0.5L0 0L1 0.3L2 0.5L2 0.5L1 0.7L0 1Z');
    expect(waveformPath({ fps: 2, rms: [] })).toBeNull();
    expect(waveformPath(null)).toBeNull();
  });
});
