import { describe, expect, it } from 'vitest';
import { backfillPrevizFromShots, previzCutProblems, previzFrameAt, previzPawnColors, updatePrevizCut } from './musicVideoPreviz.js';
import { musicVideoPrevizSchema, musicVideoProjectUpdateSchema } from './musicVideoValidation.js';

const subjects = [
  { id: 'c-ana', kind: 'character', name: 'Ana' },
  { id: 'c-bo', kind: 'character', name: 'Bo' },
  { id: 'p-street', kind: 'place', name: 'Example Street', ingredientId: 'cat-street' },
  { id: 'o-cart', kind: 'object', name: 'Hand cart' },
];
const vehicles = [{ subjectId: 'o-cart', speedMetersPerMin: 120 }];
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
      scene('s1', 0, 4, { cameraId: 'cam-vhs', holder: 'Bo', characters: ['Ana', 'Bo'], action: 'Ana pulls the Hand cart past' }),
      { sceneId: 'untimed', startSec: null, endSec: null },
    ]);
    const { previz, added } = backfillPrevizFromShots({ ...p, previz: { cuts: [], tracks: [], vehicles } }, places);
    expect(added).toBe(1);
    expect(previz.cuts).toEqual([expect.objectContaining({ sceneId: 's1', placeSubjectId: 'p-street', viewShotId: 'wide', holderSubjectId: 'c-bo', visibleSubjectIds: ['c-ana'], aimSubjectId: null })]);
    const ana = previz.tracks.find((t) => t.subjectId === 'c-ana');
    expect(ana.keys[0]).toMatchObject({ timeSec: 0, position: [1, 0, 2], facingDegrees: 90, pose: 'ride', vehicleSubjectId: 'o-cart' });
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

  // Catches people seeded at y=0 and a held camera measured from y=0 on a hill, which leaves them floating above the road.
  it('stands seeded people on a sloped set and measures a held camera from the holder\'s feet', () => {
    const hill = {
      anchors: [
        { id: 'crest', kind: 'figure', position: [0, 0, 0], facingDegrees: 0 },
        { id: 'low', kind: 'figure', position: [1, -4.6, -100], facingDegrees: 0 },
      ],
      shots: [{ id: 'down', label: 'Down', position: [1, -7.72, -114], target: [1, -6.9, -100], focalLengthMm: 28, aspect: '16:9', figures: [{ anchorId: 'low' }] }],
    };
    const hillPlaces = { 'cat-street': { ingredient: { type: 'place', payload: { greybox: hill } }, media: [] } };
    const sc = { ...scene('s1', 0, 4, { holder: 'Bo', characters: ['Ana', 'Bo'] }), setReference: { subjectId: 'p-street', greyboxShotId: 'down' } };
    const { previz } = backfillPrevizFromShots(project([sc]), hillPlaces);
    const seeded = previz.tracks;
    const ana = seeded.find((t) => t.subjectId === 'c-ana').keys[0].position;
    const bo = seeded.find((t) => t.subjectId === 'c-bo').keys[0].position;
    expect(ana[1]).toBe(-4.6);
    expect(bo[1]).toBe(-4.6);
    const p = project([sc], { previz });
    const camera = previzFrameAt(p, hillPlaces, 2).camera;
    // The view sits 3.12 m above the nearest ground (-4.6), so it rides 3.12 m above the holder's feet.
    expect(camera.position[1]).toBeCloseTo(-4.6 + (-7.72 + 4.6), 5);
    expect(camera.target[1]).toBeCloseTo(-6.9 + 4.6 - 4.6, 5);
  });

  // Catches a cast that only walks being put on a vehicle because the shot's words happen to mention riding.
  it('keeps people on foot when no listed vehicle is named, and ignores an unlisted object', () => {
    const p = project([scene('s1', 0, 4, { characters: ['Ana'], action: 'Ana rides her bike past the Hand cart' })]);
    const walking = backfillPrevizFromShots(p, places).previz;
    expect(walking.tracks[0].keys[0].pose).toBe('stand');
    expect(walking.tracks[0].keys[0].vehicleSubjectId).toBeUndefined();
    const driving = backfillPrevizFromShots({ ...p, previz: { cuts: [], tracks: [], vehicles } }, places).previz;
    expect(driving.tracks[0].keys[0]).toMatchObject({ pose: 'ride', vehicleSubjectId: 'o-cart' });
  });

  it('names what keeps a cut from playing', () => {
    const p = project([scene('s1', 0, 4)]);
    expect(previzCutProblems(p, { id: 'c', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street', viewShotId: 'gone' }, places)).toEqual(['Its greybox camera was removed']);
    expect(previzCutProblems(p, { id: 'c', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street' }, { 'cat-street': { ingredient: { type: 'place', payload: {} }, media: [] } }))
      .toEqual(['Example Street has no greybox yet']);
  });
});

// Catches two people sharing a pawn color, so the director (and later a model) can't tell them apart.
it('gives every character and vehicle a distinct named pawn color and keeps picks', () => {
  const colors = previzPawnColors(project([], { previz: { cuts: [], tracks: [], vehicles, pawnColors: { 'c-bo': { figure: 'red' }, 'o-cart': { figure: 'chrome' } } } }));
  expect(colors['c-bo'].figure.id).toBe('red');
  expect(colors['o-cart'].figure.id).toBe('chrome');
  expect(colors['c-ana'].figure.id).not.toBe('red');
  expect(colors['c-ana'].figure.id).not.toBe('chrome');
  // A legacy bike color no longer validates (migration 459 converts it).
  expect(musicVideoProjectUpdateSchema.safeParse({ previz: { cuts: [], tracks: [], pawnColors: { 'c-bo': { bike: 'red' } } } }).success).toBe(false);
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

// Catches a picker edit that names someone with no mark on the set, so the player draws nobody (review on #15285).
it('seeds marks for anyone a picker edit adds, follows a set change with its cast, and never aims at the holder', () => {
  const places2 = { ...places, 'cat-park': { ingredient: { type: 'place', payload: { greybox } }, media: [] } };
  const p0 = project([scene('s1', 0, 4, { characters: ['Ana'] })]);
  const p = { ...p0, concept: { subjects: [...subjects, { id: 'p-park', kind: 'place', name: 'Example Park', ingredientId: 'cat-park' }] } };
  const built = { ...p, previz: backfillPrevizFromShots(p, places2).previz };
  const cut = built.previz.cuts[0];
  const shown = updatePrevizCut(built, { ...cut, visibleSubjectIds: ['c-ana', 'c-bo'] }, places2);
  expect(shown.tracks.map((t) => t.subjectId).sort()).toEqual(['c-ana', 'c-bo']);
  const held = updatePrevizCut(built, { ...cut, holderSubjectId: 'c-bo', aimSubjectId: 'c-bo' }, places2);
  expect(held.cuts[0].aimSubjectId).toBeNull();
  expect(previzFrameAt({ ...built, previz: held }, places2, 1).actors.find((a) => a.subjectId === 'c-bo')).toMatchObject({ holder: true });
  const moved = updatePrevizCut(built, { ...cut, placeSubjectId: 'p-park', visibleSubjectIds: null, viewShotId: null }, places2);
  expect(moved.tracks.some((t) => t.placeSubjectId === 'p-park' && t.subjectId === 'c-ana')).toBe(true);
  expect(previzFrameAt({ ...built, previz: moved }, places2, 1).actors.filter((a) => a.visible).map((a) => a.subjectId)).toEqual(['c-ana']);
  // Sync seeds an existing cut whose picks changed outside the pickers too.
  const edited = { ...built, previz: { ...built.previz, cuts: [{ ...cut, visibleSubjectIds: ['c-ana', 'c-bo'] }] } };
  expect(backfillPrevizFromShots(edited, places2).previz.tracks.some((t) => t.subjectId === 'c-bo')).toBe(true);
});

// Catches a selfie cut still hiding its holder, or a plain held cut showing them.
it('shows a selfie holder facing the camera 0.6 m away, and still hides the holder of a normal held cut', () => {
  const tracks = ['c-ana', 'c-bo'].map((subjectId, i) => ({ subjectId, placeSubjectId: 'p-street', keys: [{ timeSec: 0, position: [i * 2, 0, 0], facingDegrees: 90, pose: 'stand' }, { timeSec: 4, position: [i * 2, 0, 0], facingDegrees: 90, pose: 'stand' }] }));
  const cut = { id: 'cut-s1', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street', viewShotId: null, holderSubjectId: 'c-bo', visibleSubjectIds: null, aimSubjectId: null };
  const frameOf = (extra) => previzFrameAt(project([scene('s1', 0, 4)], { previz: { cuts: [{ ...cut, ...extra }], tracks } }), places, 1);
  expect(frameOf({}).actors.find((a) => a.subjectId === 'c-bo').visible).toBe(false);
  const selfie = frameOf({ selfie: true });
  expect(selfie.actors.map((a) => a.visible)).toEqual([true, true]);
  const { position, target } = selfie.camera;
  expect(Math.hypot(position[0] - target[0], position[2] - target[2])).toBeCloseTo(0.6, 1);
  expect(position[0]).toBeGreaterThan(target[0]);
  expect(musicVideoPrevizSchema.safeParse({ cuts: [{ ...cut, selfie: true }], tracks }).success).toBe(true);
});
