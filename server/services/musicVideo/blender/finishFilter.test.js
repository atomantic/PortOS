import { describe, expect, it } from 'vitest';
import { blenderFinishFilter } from './finishFilter.js';

const frame = { width: 1920, height: 1080, fps: 24 };
// The Board as a synced film leaves it: one scene per shot, on the shot's times.
const scenes = [
  { sceneId: 'mvs-a', startSec: 0, endSec: 2 },
  { sceneId: 'mvs-b', startSec: 2, endSec: 4 },
  { sceneId: 'mvs-c', startSec: 4, endSec: 6 },
];
const film = (project, window = { startSec: 0, endSec: 6 }) => blenderFinishFilter(project, { ...frame, ...window });
const framesIn = (filter) => [...filter.matchAll(/between\(n,(\d+),(\d+)\)/g)].flatMap(([, from, to]) => [Number(from), Number(to)]);

describe('blenderFinishFilter', () => {
  it('is null without a grade or a timed effect, so finished shots join by stream copy untouched', () => {
    expect(film({ scenes })).toBeNull();
    expect(film({ scenes, composition: { mode: 'blender', grade: { preset: 'neutral' } } })).toBeNull();
    expect(film({ scenes: [] })).toBeNull();
  });

  it('paints a mirrored scene\'s cut effect on its cut, and on the same song frames inside an excerpt window', () => {
    const project = { scenes: [{ ...scenes[0], transitionOut: 'gate-jump' }, scenes[1], scenes[2]] };
    const whole = framesIn(film(project));
    // A gate jump straddles the cut at 2 s (frame 48).
    expect(Math.min(...whole)).toBeLessThan(48);
    expect(Math.max(...whole)).toBeGreaterThanOrEqual(48);
    expect(Math.max(...whole) - Math.min(...whole)).toBeLessThan(12);
    // A window starting at 1 s counts its frames from 0: every painted frame moves back 24.
    expect(framesIn(film(project, { startSec: 1, endSec: 3 }))).toEqual(whole.map((n) => n - 24));
    // A window that does not hold the cut is left alone.
    expect(film(project, { startSec: 3, endSec: 5 })).toBeNull();
  });

  it('paints a glitch a scene sets at a moment inside it, and the project grade per scene', () => {
    const glitched = film({ scenes: [scenes[0], { ...scenes[1], glitches: [{ atSec: 0.5, style: 'shutter' }] }, scenes[2]] });
    // Half a second into the second shot: song frame 60.
    expect(framesIn(glitched)[0]).toBe(60);
    const graded = film({ scenes, composition: { mode: 'blender', grade: { preset: 'neutral', grain: 0, sections: [{ sceneId: 'mvs-b', preset: 'monochrome' }] } } });
    expect(graded).toContain("enable='gte(t,2)*lt(t,4)'");
    expect(film({ scenes, composition: { grade: { preset: 'neutral', grain: 0, sections: [{ sceneId: 'mvs-b', preset: 'monochrome' }] } } }, { startSec: 3, endSec: 5 }))
      .toContain("enable='gte(t,0)*lt(t,1)'");
  });
});
