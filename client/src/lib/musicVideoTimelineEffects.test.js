import { describe, it, expect } from 'vitest';
import { effectTimeAt, glitchesWithMove, timelineShotEffects } from './musicVideoTimelineEffects.js';

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
    const { start, end, image, markers } = timelineShotEffects(shot);
    expect(start).toHaveLength(1);
    expect([end, image]).toEqual([[], null]);
    expect(markers.map((m) => [m.index, m.t, m.lengthSec, m.off])).toEqual([[1, 11.5, null, false], [2, 14, 0.5, true]]);
    expect(markers[0].repeats).toEqual([12.5, 13.5]);
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

  it('moves one effect and leaves the others as saved', () => {
    const glitches = [{ atSec: 1, style: 'gate-jump' }, { atSec: 2, style: 'color-block', strength: 0.5 }];
    expect(glitchesWithMove(glitches, 1, 3)).toEqual([glitches[0], { atSec: 3, style: 'color-block', strength: 0.5 }]);
  });
});
