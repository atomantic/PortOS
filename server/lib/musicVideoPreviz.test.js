import { describe, expect, it } from 'vitest';
import { backfillPrevizFromShots, previzCutProblems, previzFrameAt, previzPawnColors } from './musicVideoPreviz.js';
import { musicVideoProjectUpdateSchema } from './musicVideoValidation.js';

const subjects = [
  { id: 'c-ana', kind: 'character', name: 'Ana' },
  { id: 'c-bo', kind: 'character', name: 'Bo' },
  { id: 'p-street', kind: 'place', name: 'Example Street', ingredientId: 'cat-street' },
];
const greybox = {
  anchors: [{ id: 'mark', label: 'Mark', kind: 'figure', position: [1, 0, 2], facingDegrees: 90 }],
  shots: [{ id: 'wide', label: 'Wide', position: [0, 3, 10], target: [0, 1, 0], focalLengthMm: 28, aspect: '16:9', figures: [{ anchorId: 'mark' }] }],
};
const places = { 'cat-street': { ingredient: { type: 'place', payload: { greybox } }, media: [] } };
const scene = (sceneId, startSec, endSec, sheet = {}) => ({ sceneId, startSec, endSec, setReference: { subjectId: 'p-street', greyboxShotId: 'wide' }, shotSheet: sheet });
const project = (scenes, extra = {}) => ({ concept: { subjects }, cameras: [{ id: 'cam-vhs', name: 'VHS camera', kind: 'in-world' }], scenes, ...extra });

describe('greybox previz backfill', () => {
  // Catches a backfill that loses who holds the camera, whom the shot shows, or the riding pose.
  it('builds one linked cut per timed shot with the sheet holder, cast and saved camera, seeding marks', () => {
    const p = project([
      scene('s1', 0, 4, { cameraId: 'cam-vhs', holder: 'Bo', characters: ['Ana', 'Bo'], action: 'Ana rides her bike past' }),
      { sceneId: 'untimed', startSec: null, endSec: null },
    ]);
    const { previz, added } = backfillPrevizFromShots(p, places);
    expect(added).toBe(1);
    expect(previz.cuts).toEqual([expect.objectContaining({ sceneId: 's1', placeSubjectId: 'p-street', viewShotId: 'wide', holderSubjectId: 'c-bo', visibleSubjectIds: ['c-ana'], aimSubjectId: null })]);
    const ana = previz.tracks.find((t) => t.subjectId === 'c-ana');
    expect(ana.keys[0]).toMatchObject({ timeSec: 0, position: [1, 0, 2], facingDegrees: 90, pose: 'ride' });
    const bo = previz.tracks.find((t) => t.subjectId === 'c-bo');
    expect(bo.keys[0].position).toEqual([0, 0, 10]);
    expect(musicVideoProjectUpdateSchema.safeParse({ previz }).success).toBe(true);
  });

  // Catches a refresh wiping the director's picks and blocking, or keeping cuts for deleted shots.
  it('keeps existing cuts and tracks on refresh, follows retimed shots, and drops cuts whose shot is gone', () => {
    const first = backfillPrevizFromShots(project([scene('s1', 0, 4, { characters: ['Ana'] }), scene('s2', 4, 8)]), places).previz;
    const edited = { ...first, cuts: first.cuts.map((cut) => (cut.sceneId === 's1' ? { ...cut, aimSubjectId: 'c-ana', visibleSubjectIds: ['c-ana', 'c-bo'] } : cut)) };
    const moved = { ...edited, tracks: edited.tracks.map((t) => ({ ...t, keys: [{ timeSec: 0, position: [5, 0, 5], facingDegrees: 0, pose: 'stand' }] })) };
    const { previz, removed } = backfillPrevizFromShots(project([scene('s1', 1, 5), scene('s3', 8, 9, { characters: ['Ana'] })], { previz: moved }), places);
    expect(removed).toBe(1);
    expect(previz.cuts.map((c) => c.sceneId)).toEqual(['s1', 's3']);
    expect(previz.cuts[0]).toMatchObject({ startSec: 1, endSec: 5, aimSubjectId: 'c-ana', visibleSubjectIds: ['c-ana', 'c-bo'] });
    expect(previz.tracks.find((t) => t.subjectId === 'c-ana').keys).toEqual([{ timeSec: 0, position: [5, 0, 5], facingDegrees: 0, pose: 'stand' }]);
  });
});

describe('greybox previz playback', () => {
  // Catches a held camera that ignores its holder's movement, or an aim target that leaves the frame.
  it('rides a held camera on its holder and turns it to the aim target; an unheld camera stays on its saved view', () => {
    const tracks = [
      { subjectId: 'c-bo', placeSubjectId: 'p-street', keys: [{ timeSec: 0, position: [0, 0, 10], facingDegrees: 180, pose: 'stand' }, { timeSec: 4, position: [0, 0, 6], facingDegrees: 180, pose: 'stand' }] },
      { subjectId: 'c-ana', placeSubjectId: 'p-street', keys: [{ timeSec: 0, position: [1, 0, 2], facingDegrees: 0, pose: 'ride' }] },
    ];
    const cut = { id: 'cut-s1', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street', viewShotId: 'wide', holderSubjectId: 'c-bo', visibleSubjectIds: null, aimSubjectId: 'c-ana' };
    const p = project([scene('s1', 0, 4), scene('s2', 4, 8)], { previz: { cuts: [cut, { ...cut, id: 'cut-s2', sceneId: 's2', holderSubjectId: null, aimSubjectId: null }], tracks } });
    const frame = previzFrameAt(p, places, 2);
    expect(frame.camera.position).toEqual([0, 3, 8]);
    expect(frame.camera.target).toEqual([1, 1.4, 2]);
    expect(frame.camera.focalLengthMm).toBe(28);
    expect(frame.actors.find((a) => a.subjectId === 'c-bo')).toMatchObject({ holder: true, visible: false });
    expect(frame.actors.find((a) => a.subjectId === 'c-ana')).toMatchObject({ visible: true, pose: 'ride' });
    const observer = previzFrameAt(p, places, 5);
    expect(observer.camera).toMatchObject({ position: [0, 3, 10], target: [0, 1, 0] });
    expect(observer.actors.every((a) => a.visible)).toBe(true);
    expect(previzFrameAt(p, places, 9)).toBeNull();
  });

  it('names what keeps a cut from playing', () => {
    const p = project([scene('s1', 0, 4)]);
    expect(previzCutProblems(p, { id: 'c', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street', viewShotId: 'gone' }, places)).toEqual(['Its greybox camera was removed']);
    expect(previzCutProblems(p, { id: 'c', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street' }, { 'cat-street': { ingredient: { type: 'place', payload: {} }, media: [] } }))
      .toEqual(['Example Street has no greybox yet']);
  });
});

// Catches two people sharing a pawn color, so the director (and later a model) can't tell them apart.
it('gives every character a distinct named pawn color, keeps picks, and colors a bike like its rider unless picked', () => {
  const colors = previzPawnColors(project([], { previz: { cuts: [], tracks: [], pawnColors: { 'c-bo': { figure: 'red', bike: 'chrome' } } } }));
  expect(colors['c-bo']).toMatchObject({ figure: { id: 'red' }, bike: { id: 'chrome' } });
  expect(colors['c-ana'].figure.id).not.toBe('red');
  expect(colors['c-ana'].bike).toBe(colors['c-ana'].figure);
  expect(musicVideoProjectUpdateSchema.safeParse({ previz: { cuts: [], tracks: [], pawnColors: { 'c-bo': { figure: 'red' } } } }).success).toBe(true);
  expect(musicVideoProjectUpdateSchema.safeParse({ previz: { cuts: [], tracks: [], pawnColors: { 'c-bo': { figure: '#ff0000' } } } }).success).toBe(false);
});

// Catches a camera's previz style being ignored: a snapshot camera must hold one frame, a handheld one must shake.
it('moves each cut like its story camera: still holds the first frame, handheld shakes, steady does not', () => {
  const tracks = [{ subjectId: 'c-ana', placeSubjectId: 'p-street', keys: [{ timeSec: 0, position: [0, 0, 0], facingDegrees: 0, pose: 'stand' }, { timeSec: 4, position: [4, 0, 0], facingDegrees: 0, pose: 'stand' }] }];
  const cut = { id: 'cut-s1', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street', viewShotId: 'wide', holderSubjectId: null, visibleSubjectIds: null, aimSubjectId: 'c-ana' };
  const withStyle = (previzStyle) => ({ ...project([scene('s1', 0, 4, { cameraId: 'cam-vhs' })], { previz: { cuts: [cut], tracks } }), cameras: [{ id: 'cam-vhs', name: 'VHS camera', kind: 'in-world', previzStyle }] });
  const still = withStyle('still');
  expect(previzFrameAt(still, places, 3).actors[0].position).toEqual([0, 0, 0]);
  expect(previzFrameAt(still, places, 3).camera).toEqual(previzFrameAt(still, places, 0).camera);
  const steady = previzFrameAt(withStyle('steady'), places, 2).camera;
  const shaky = previzFrameAt(withStyle('handheld'), places, 2).camera;
  expect(steady.position).toEqual([0, 3, 10]);
  expect(shaky.position).not.toEqual(steady.position);
  expect(Math.max(...shaky.position.map((v, i) => Math.abs(v - steady.position[i])))).toBeLessThan(0.1);
  expect(previzFrameAt(withStyle('handheld'), places, 2).camera).toEqual(shaky);
  expect(musicVideoProjectUpdateSchema.safeParse({ cameras: [{ id: 'cam-vhs', name: 'VHS', kind: 'in-world', previzStyle: 'handheld' }] }).success).toBe(true);
});
