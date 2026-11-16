import { describe, it, expect } from 'vitest';
import {
  TIMELINE_MAX_PX_PER_SEC, clampPxPerSec, fitPxPerSec, lyricSpans, rulerStepSec, rulerTicks, timelineDurationSec, timelineShotAt, timelineShots,
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
