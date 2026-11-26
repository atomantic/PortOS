// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { effectTimeAt, effectTrimAt, glitchesWithEdit, timelineShotEffects } from './musicVideoTimelineEffects.js';

const shotOf = (scene) => ({ scene, sceneId: scene.sceneId, startSec: scene.startSec, endSec: scene.endSec, number: 1 });

describe('timelineShotEffects', () => {
  // Uniquely catches a marker drawn off its saved moment, losing its index into the saved list, or a repeat drawn past the shot.
  it('places in-shot effects on the song clock, keeping their saved index', () => {
    const shot = shotOf({
      sceneId: 's1', startSec: 10, endSec: 14, transitionIn: 'light-leak',
      glitches: [
        { atSec: 1, style: 'not-a-style' },
        { atSec: 1.5, style: 'gate-jump', count: 8, everySec: 1 },
        { atSec: 9, style: 'color-block', lengthSec: 0.5, strength: 0 },
      ],
    });
    const { transitions, cut, image, markers } = timelineShotEffects(shot);
    expect(transitions).toEqual([{ side: 'in', label: expect.any(String), lengthSec: null }]);
    expect([cut, image]).toEqual([null, null]);
    expect(markers.map((m) => [m.index, m.t, m.lengthSec, m.off])).toEqual([[1, 11.5, null, false], [2, 14, 0.5, true]]);
    expect(markers[0].repeats).toEqual([12.5, 13.5]);
  });

  // Uniquely catches a wipe or a hand-over drawn without its length, or on the wrong side of the cut.
  it('gives a wipe its length and a hand-over its span against the cut', () => {
    const shot = shotOf({ sceneId: 's1', startSec: 10, endSec: 14, wipeOut: { style: 'iris', lengthSec: 0.5 }, cutEffect: { style: 'dissolve', overlapSec: 1 } });
    const { transitions, cut } = timelineShotEffects(shot);
    expect(transitions).toEqual([{ side: 'out', label: expect.any(String), lengthSec: 0.5 }]);
    expect([cut.startSec, cut.endSec]).toEqual([13, 14]);
    const fade = timelineShotEffects(shotOf({ ...shot.scene, cutEffect: { style: 'fade-black', overlapSec: 1 } })).cut;
    expect([fade.startSec, fade.endSec]).toEqual([13.5, 14.5]);
    expect(timelineShotEffects(shotOf({ ...shot.scene, cutEffect: { style: 'dissolve', enabled: false } })).cut).toBeNull();
  });
});

describe('effectTimeAt', () => {
  const shot = shotOf({ sceneId: 's1', startSec: 10, endSec: 14 });
  // Uniquely catches a dragged effect saved in song seconds instead of shot seconds, or dropped outside its shot.
  it('lands on a frame of the shot, inside it, and snaps to a nearby point', () => {
    expect(effectTimeAt(shot, 11.26)).toEqual({ atSec: 1.25, snapped: false });
    expect(effectTimeAt(shot, 3)).toEqual({ atSec: 0, snapped: false });
    expect(effectTimeAt(shot, 99)).toEqual({ atSec: 3.958, snapped: false });
    expect(effectTimeAt(shot, 12.05, [12.1, 30], 0.1)).toEqual({ atSec: 2.1, snapped: true });
  });

  it('changes one effect and leaves the others as saved', () => {
    const glitches = [{ atSec: 1, style: 'gate-jump' }, { atSec: 2, style: 'color-block', strength: 0.5 }];
    expect(glitchesWithEdit(glitches, 1, { atSec: 3, style: 'flash' })).toEqual([glitches[0], { atSec: 3, style: 'flash', strength: 0.5 }]);
  });
});

describe('effectTrimAt', () => {
  const shot = shotOf({ sceneId: 's1', startSec: 10, endSec: 14 });
  const marker = { atSec: 1, playSec: 0.5 };
  // Uniquely catches a trim that moves the end it should hold, runs past its shot or the server's 4 s bound, or shrinks to nothing.
  it('moves one end on a frame and holds the other, within a frame and four seconds, inside the shot', () => {
    expect(effectTrimAt(shot, marker, 'end', 12.01)).toEqual({ atSec: 1, lengthSec: 1, snapped: false });
    expect(effectTrimAt(shot, marker, 'end', 10.5)).toEqual({ atSec: 1, lengthSec: 0.042, snapped: false });
    expect(effectTrimAt(shot, marker, 'end', 30).lengthSec).toBe(3);
    expect(effectTrimAt(shot, marker, 'start', 10.5)).toEqual({ atSec: 0.5, lengthSec: 1, snapped: false });
    expect(effectTrimAt(shot, marker, 'start', 9)).toEqual({ atSec: 0, lengthSec: 1.5, snapped: false });
    expect(effectTrimAt(shot, marker, 'end', 11.9, [12], 0.2)).toEqual({ atSec: 1, lengthSec: 1, snapped: true });
    const long = { atSec: 0, playSec: 1 };
    expect(effectTrimAt(shotOf({ sceneId: 's2', startSec: 0, endSec: 10 }), long, 'end', 9).lengthSec).toBe(4);
  });
});
