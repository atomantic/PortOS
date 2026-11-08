import { describe, expect, it } from 'vitest';
import { draftNightFromShots, nightActorsAt, nightBeatProblems, nightClockAt, nightMinuteOfClock } from './musicVideoPrevizNight.js';
import { musicVideoPrevizSchema } from './musicVideoValidation.js';

const idMaker = () => { let n = 0; return () => `b${++n}`; };

// Home at the origin, the mall 200 m east; the only road dog-legs 50 m south between them.
const world = {
  version: 1, seed: 1,
  sets: [
    { id: 'home', ingredientId: 'cat-home', position: [0, 0], rotationDegrees: 0 },
    { id: 'mall', ingredientId: 'cat-mall', position: [200, 0], rotationDegrees: 90 },
    { id: 'pond', ingredientId: 'cat-pond', position: [0, 400], rotationDegrees: 0 },
  ],
  paths: [{ id: 'r1', kind: 'road', sides: 'buildings', width: 9, points: [[0, 5], [0, 50], [200, 50], [200, 5]] }],
};

const subjects = [
  { id: 'p-home', kind: 'place', name: 'Home', ingredientId: 'cat-home' },
  { id: 'p-mall', kind: 'place', name: 'Mall', ingredientId: 'cat-mall' },
  { id: 'c-a', kind: 'character', name: 'Ana' },
  { id: 'c-b', kind: 'character', name: 'Bo' },
];

const scene = (id, startSec, placeId, action = '') => ({ id, startSec, endSec: startSec + 4, placeId, shotSheet: { action } });

describe('draftNightFromShots', () => {
  const project = {
    concept: { subjects },
    scenes: [scene('s1', 0, 'p-home', 'They grab their bikes'), scene('s2', 4, 'p-home'), scene('s3', 8, 'p-mall'), scene('s4', 12, 'p-home')],
  };
  const placeOfShot = (shot) => shot.placeId;

  it('turns the places shots visit into stays joined by travels that fill the night', () => {
    const { night, visits } = draftNightFromShots(project, world, { placeOfShot, newId: idMaker(), startClock: 1200, lengthMin: 480 });
    expect(visits).toBe(3);
    expect(night.beats.map((beat) => `${beat.kind}:${beat.setId}`)).toEqual(['stay:home', 'travel:home', 'stay:mall', 'travel:mall', 'stay:home']);
    const travel = night.beats[1];
    expect(travel).toMatchObject({ toSetId: 'mall', pace: 'ride', subjectIds: ['c-a', 'c-b'] });
    // ~300 m of road at a ride pace, never under two minutes.
    expect(travel.endMin - travel.startMin).toBe(2);
    night.beats.slice(1).forEach((beat, i) => expect(beat.startMin).toBe(night.beats[i].endMin));
    expect(night.beats.at(-1).endMin).toBe(480);
    expect(musicVideoPrevizSchema.safeParse({ cuts: [], tracks: [], night }).success).toBe(true);
  });
});

describe('nightActorsAt', () => {
  const night = {
    startClock: 1200, lengthMin: 120,
    beats: [
      { id: 'a', kind: 'stay', subjectIds: ['c-a', 'c-b'], startMin: 10, endMin: 30, setId: 'home', toSetId: null, pace: null },
      { id: 'b', kind: 'travel', subjectIds: ['c-a', 'c-b'], startMin: 30, endMin: 40, setId: 'home', toSetId: 'mall', pace: 'ride' },
    ],
  };
  const project = { concept: { subjects }, previz: { cuts: [], tracks: [], night } };
  const places = {
    'cat-home': { ingredient: { payload: { greybox: { anchors: [{ kind: 'figure', position: [3, 0, 0], facingDegrees: 0 }] } } } },
  };

  const pose = (who, storyMin, p = project, w = world) => nightActorsAt(p, w, places, storyMin).find((actor) => actor.subjectId === who);

  it('waits at the first beat before it, stays near the set, rides the route, and holds at the destination', () => {
    const before = pose('c-a', 0);
    expect(before.beatId).toBe('a');
    const stay = pose('c-a', 20);
    expect(Math.hypot(stay.position[0] - 3, stay.position[2])).toBeLessThan(2);
    expect(stay.pose).toBe('stand');
    const riding = pose('c-a', 35);
    expect(riding).toMatchObject({ pose: 'ride', beatId: 'b', setId: null });
    // Halfway along the 300 m road (not the 200 m straight line) is the middle of its southern leg, heading east.
    expect(Math.abs(riding.position[2] - 50)).toBeLessThan(1);
    expect(riding.facingDegrees).toBe(90);
    const bo = pose('c-b', 35);
    expect(Math.hypot(bo.position[0] - riding.position[0], bo.position[2] - riding.position[2])).toBeCloseTo(1.2, 1);
    const after = pose('c-a', 90);
    expect(after).toMatchObject({ pose: 'stand', setId: 'mall' });
    expect(Math.hypot(after.position[0] - 200, after.position[2])).toBeLessThan(4);
  });

  it('goes straight across when no path joins the sets', () => {
    const riding = pose('c-a', 35, project, { ...world, paths: [] });
    expect(riding.position[0]).toBeCloseTo(100, 0);
    expect(Math.abs(riding.position[2])).toBeLessThan(1);
  });

  it('lists only people the night names', () => {
    const solo = { ...project, previz: { ...project.previz, night: { ...night, beats: [{ ...night.beats[0], subjectIds: ['c-b'] }] } } };
    expect(nightActorsAt(solo, world, places, 15).map((actor) => actor.name)).toEqual(['Bo']);
  });

  it('names what is wrong with a beat', () => {
    expect(nightBeatProblems(project, world, { kind: 'travel', setId: 'home', toSetId: 'home', subjectIds: ['c-z'] }))
      .toEqual(['It travels to where it starts', 'Names someone no longer in the video']);
    expect(nightBeatProblems(project, world, { ...night.beats[1], id: 'c', startMin: 25 })).toEqual(['Overlaps another beat for the same person']);
  });
});

describe('night clock', () => {
  it('runs past midnight both ways', () => {
    const night = { startClock: 1200 };
    expect(nightClockAt(night, 300)).toBe(60);
    expect(nightMinuteOfClock(night, 60)).toBe(300);
  });
});
