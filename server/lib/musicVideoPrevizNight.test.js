import { describe, expect, it } from 'vitest';
import { draftNightFromShots, nightActorsAt, nightBeatProblems, nightClockAt, nightMinuteOfClock, previzNight } from './musicVideoPrevizNight.js';
import { musicVideoPrevizSchema } from './musicVideoValidation.js';
import { placePrevizCutsOnNight, previzFrameAt } from './musicVideoPreviz.js';
import { musicVideoPrevizForActiveCast } from './musicVideoCastSelection.js';

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

describe('shots on the night', () => {
  const night = {
    startClock: 1200, lengthMin: 120,
    beats: [
      { id: 'a', kind: 'stay', subjectIds: ['c-a', 'c-b'], startMin: 0, endMin: 30, setId: 'home', toSetId: null, pace: null },
      { id: 'b', kind: 'travel', subjectIds: ['c-a', 'c-b'], startMin: 30, endMin: 40, setId: 'home', toSetId: 'mall', pace: 'ride' },
      { id: 'c', kind: 'stay', subjectIds: ['c-a', 'c-b'], startMin: 40, endMin: 120, setId: 'mall', toSetId: null, pace: null },
    ],
  };
  const cut = (id, startSec, placeSubjectId, extra = {}) => ({ id, startSec, endSec: startSec + 4, placeSubjectId, ...extra });
  const base = {
    concept: { subjects },
    previz: { cuts: [cut('k1', 0, 'p-home'), cut('k2', 4, 'p-home'), cut('k3', 8, 'p-mall'), cut('k4', 12, 'p-home')], tracks: [], night },
  };
  const nightWorld = { world, places: {} };

  // Catches shots landing on the wrong stay, or a later return home reusing the first visit.
  it('spreads each run of shots across its next stay in order, and skips shots with no stay left', () => {
    const { previz, placed } = placePrevizCutsOnNight(base, world);
    expect(placed).toBe(3);
    expect(previz.cuts.map((entry) => entry.storyMin)).toEqual([0, 15, 40, undefined]);
    expect(musicVideoPrevizSchema.safeParse(previz).success).toBe(true);
    const kept = { ...base, previz: { ...base.previz, cuts: base.previz.cuts.map((entry) => (entry.id === 'k1' ? { ...entry, storyMin: 5 } : entry)) } };
    expect(placePrevizCutsOnNight(kept, world, { onlyUnplaced: true }).previz.cuts[0].storyMin).toBe(5);
  });

  // Catches the night playing sped up, or a held camera not riding its holder.
  it('plays a cut on the night at real speed from its holder, or from an observer spot on a long lens', () => {
    const riding = { ...base, previz: { ...base.previz, cuts: [cut('k1', 0, 'p-home', { storyMin: 35, holderSubjectId: 'c-b' })] } };
    const first = previzFrameAt(riding, {}, 0, nightWorld);
    const later = previzFrameAt(riding, {}, 3, nightWorld);
    expect(first).toMatchObject({ greybox: null, world, clockMinutes: 1235 });
    const bo = first.actors.find((actor) => actor.subjectId === 'c-b');
    expect(bo).toMatchObject({ holder: true, visible: false, pose: 'ride' });
    expect(first.camera.position[0]).toBeCloseTo(bo.position[0]);
    // Three song seconds are three story seconds: this 300 m, 10 min ride covers about 1.5 m in them.
    const moved = Math.hypot(later.camera.position[0] - first.camera.position[0], later.camera.position[2] - first.camera.position[2]);
    expect(moved).toBeGreaterThan(1);
    expect(moved).toBeLessThan(3);
    const observed = { ...base, previz: { ...base.previz, cuts: [cut('k1', 0, 'p-home', { storyMin: 50, cameraSpot: [260, 0] })] } };
    const frame = previzFrameAt(observed, {}, 1, nightWorld);
    expect(frame.camera).toMatchObject({ position: [260, 1.6, 0], focalLengthMm: 85 });
    expect(frame.actors.every((actor) => actor.visible)).toBe(true);
    // Riding east side by side, Ana (first in the cast) is on the right, south of Bo.
    expect(first.actors.find((actor) => actor.subjectId === 'c-a').position[2]).toBeGreaterThan(bo.position[2]);
    // Without the world loaded the cut falls back to its set's own blocking.
    expect(previzFrameAt(observed, {}, 1).world).toBeUndefined();
  });

  // Catches a held camera that never swings to the person it should turn to (Hold Still shot 1).
  it('swings a held camera from straight ahead to its keep-in-frame person when it turns to them', () => {
    const turning = { ...base, previz: { ...base.previz, cuts: [cut('k1', 0, 'p-home', { storyMin: 35, holderSubjectId: 'c-b', aimSubjectId: 'c-a', turnToAim: true })] } };
    const look = (sec) => {
      const { camera } = previzFrameAt(turning, {}, sec, nightWorld);
      return Math.atan2(camera.target[0] - camera.position[0], camera.target[2] - camera.position[2]) * 180 / Math.PI;
    };
    // Riding east (facing 90°), then turned toward Ana on the right (south, +Z, facing 0°).
    expect(look(0)).toBeCloseTo(90, 0);
    expect(Math.abs(look(3.9))).toBeLessThan(5);
    expect(look(2)).toBeLessThan(look(0));
    expect(look(2)).toBeGreaterThan(look(3.9));
    expect(musicVideoPrevizSchema.safeParse(turning.previz).success).toBe(true);
  });
});

// Catches the previz drawing both alternates of one character, or losing blocking when the pick changes.
describe('alternates of one character', () => {
  it('shows only the chosen alternate, reading the other one\'s beats, camera and colors as its own', () => {
    const cast = [...subjects, { id: 'c-b2', kind: 'character', name: 'Bo', active: true }];
    const night = { startClock: 1200, lengthMin: 60, beats: [{ id: 'a', kind: 'stay', subjectIds: ['c-a', 'c-b'], startMin: 0, endMin: 60, setId: 'home', toSetId: null, pace: null }] };
    const project = {
      concept: { subjects: cast },
      previz: { cuts: [{ id: 'k1', startSec: 0, endSec: 4, placeSubjectId: 'p-home', storyMin: 10, holderSubjectId: 'c-b' }], tracks: [], night, pawnColors: { 'c-b': { figure: 'teal' } } },
    };
    expect(nightActorsAt(project, world, {}, 10).map((actor) => actor.subjectId)).toEqual(['c-a', 'c-b2']);
    const frame = previzFrameAt(project, {}, 1, { world, places: {} });
    expect(frame.actors.find((actor) => actor.holder)).toMatchObject({ subjectId: 'c-b2', color: '#2fa59a' });
    expect(nightBeatProblems(project, world, previzNight(project).beats[0])).toEqual([]);
  });
  // Catches an unused nameless character being read as an unrelated nameless one.
  it('never joins two nameless characters', () => {
    const cast = [...subjects, { id: 'x1', kind: 'character', name: '' }, { id: 'x2', kind: 'character', name: '', active: false }];
    const project = { concept: { subjects: cast }, previz: { cuts: [{ id: 'k1', startSec: 0, endSec: 4, placeSubjectId: 'p-home', holderSubjectId: 'x2' }], tracks: [] } };
    expect(musicVideoPrevizForActiveCast(project).cuts[0].holderSubjectId).toBe('x2');
  });
});

