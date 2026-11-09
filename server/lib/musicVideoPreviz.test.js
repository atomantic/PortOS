import { describe, expect, it } from 'vitest';
import {
  applyPrevizGreybox,
  backfillPrevizFromShots,
  previzCutProblems,
  previzFrameAt,
  previzPawnColors,
  previzSetGreyboxDraftInstruction,
  updatePrevizCut,
} from './musicVideoPreviz.js';
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

describe('previz poses from shot actions', () => {
  // Catches crouched, seated and running shots all drawing a standing pawn, and a plain walk or "stands" shot picking up a pose it never described.
  it('seeds crouch, sit and run from the action and keeps everything else standing', () => {
    const posed = (action) => backfillPrevizFromShots(project([scene('s1', 0, 4, { characters: ['Ana'], action })]), places).previz.tracks[0].keys[0].pose;
    expect(posed('Ana crouches behind the hedge')).toBe('crouch');
    expect(posed('Ana runs past')).toBe('run');
    expect(posed('Bo sits on the fountain rim')).toBe('sit');
    expect(posed('Ana walks home')).toBe('stand');
    expect(posed('Ana at the gate')).toBe('stand');
  });

  it('accepts every pose in a saved track and rejects an unknown one', () => {
    const key = (pose) => ({ subjectId: 'c-ana', placeSubjectId: 'p-street', keys: [{ timeSec: 0, position: [0, 0, 0], facingDegrees: 0, pose }] });
    for (const pose of ['stand', 'walk', 'run', 'crouch', 'sit', 'ride']) expect(musicVideoPrevizSchema.safeParse({ cuts: [], tracks: [key(pose)] }).success).toBe(true);
    expect(musicVideoPrevizSchema.safeParse({ cuts: [], tracks: [key('fly')] }).success).toBe(false);
  });
});

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

describe('greybox previz sync follows the sheet unless hand-edited', () => {
  const sheet = { cameraId: 'cam-vhs', holder: 'Bo', characters: ['Ana', 'Bo'] };
  const observer = { cameras: [{ id: 'cam-obs', name: 'Observer', kind: 'observer' }, { id: 'cam-vhs', name: 'VHS camera', kind: 'in-world' }] };
  // Catches a sync that keeps the old holder after the sheet camera became the Observer.
  it('clears the holder when the sheet camera becomes the Observer', () => {
    const first = backfillPrevizFromShots(project([scene('s1', 0, 4, sheet)]), places).previz;
    expect(first.cuts[0].holderSubjectId).toBe('c-bo');
    const again = backfillPrevizFromShots(project([scene('s1', 0, 4, { ...sheet, cameraId: 'cam-obs' })], { ...observer, previz: first }), places).previz;
    expect(again.cuts[0]).toMatchObject({ holderSubjectId: null, visibleSubjectIds: ['c-ana', 'c-bo'] });
    expect(musicVideoProjectUpdateSchema.safeParse({ previz: again }).success).toBe(true);
  });

  // Catches a sync that overwrites a holder the director set on the Previz step.
  it('keeps a hand-set holder and cast when the sheet changes', () => {
    const first = backfillPrevizFromShots(project([scene('s1', 0, 4, sheet)]), places).previz;
    const edited = { ...first, cuts: first.cuts.map((cut) => ({ ...cut, holderSubjectId: 'c-ana', visibleSubjectIds: ['c-bo'] })) };
    const again = backfillPrevizFromShots(project([scene('s1', 0, 4, { ...sheet, cameraId: 'cam-obs', characters: [] })], { ...observer, previz: edited }), places).previz;
    expect(again.cuts[0]).toMatchObject({ holderSubjectId: 'c-ana', visibleSubjectIds: ['c-bo'] });
  });

  // Catches a cut saved before sync tracking being overwritten when it can't be told apart from a hand edit.
  it('leaves a legacy cut with a differing holder alone', () => {
    const first = backfillPrevizFromShots(project([scene('s1', 0, 4, sheet)]), places).previz;
    const { synced, ...legacy } = first.cuts[0];
    const again = backfillPrevizFromShots(project([scene('s1', 0, 4, { ...sheet, cameraId: 'cam-obs' })], { ...observer, previz: { ...first, cuts: [legacy] } }), places).previz;
    expect(again.cuts[0].holderSubjectId).toBe('c-bo');
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

  // Catches riding shots standing because the object's full name ("Ana and Bo's bicycles") never appears in the actions, and a cast whose obvious vehicle was never listed.
  it('lists an obvious vehicle and rides it when the action describes riding without naming the object', () => {
    const bikes = { id: 'o-bikes', kind: 'object', name: "Ana and Bo's bicycles" };
    const p = project([
      scene('s1', 0, 4, { characters: ['Ana'], action: 'Ana pedals the red BMX through the gate' }),
      scene('s2', 4, 8, { characters: ['Ana'], action: 'Ana stands at the gate holding a coffee' }),
    ], { concept: { subjects: [...subjects, bikes] } });
    const { previz } = backfillPrevizFromShots(p, places);
    expect(previz.vehicles).toEqual([{ subjectId: 'o-bikes', speedMetersPerMin: 270 }]);
    const keys = previz.tracks.find((t) => t.subjectId === 'c-ana').keys;
    expect(keys[0]).toMatchObject({ pose: 'ride', vehicleSubjectId: 'o-bikes' });
    // A shot that never mentions riding stays on foot even with the bicycles listed.
    const walkOnly = backfillPrevizFromShots({ ...p, scenes: [p.scenes[1]] }, places).previz;
    expect(walkOnly.tracks[0].keys[0].pose).toBe('stand');
    // A cast with no vehicle-like object lists none, so a bare 'rides' puts nobody on one.
    expect(backfillPrevizFromShots(project([scene('s1', 0, 4, { characters: ['Ana'], action: 'Ana rides' })]), places).previz.vehicles).toBeUndefined();
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

describe('draft missing greyboxes and link cameras', () => {
  it('extracts shots on a set and drafts an instruction listing shots, cameras, holder and action', () => {
    const p = project([
      scene('s1', 0, 4, { cameraId: 'cam-vhs', holder: 'Bo', characters: ['Ana'], action: 'Ana runs' }),
      scene('s2', 4, 8, { view: 'Close-up', characters: ['Ana'], action: 'Ana turns around' }),
    ]);
    const instruction = previzSetGreyboxDraftInstruction(p, 'p-street');
    expect(instruction).toContain('Draft a 3D greybox layout for this set tailored to the following shots in order:');
    expect(instruction).toContain('- Shot 1: camera "VHS camera", held by "Bo", action: "Ana runs", people: Ana');
    expect(instruction).toContain('- Shot 2: camera "Close-up", observer camera, action: "Ana turns around", people: Ana');
    expect(instruction).toContain('Provide one saved camera per shot labeled "Shot N" (e.g. Shot 1, Shot 2)');
    expect(instruction).toContain('Place figure mark anchors (kind: "figure") on the floor');
  });

  it('applies a greybox to previz: links cameras, drops seeded tracks, and re-seeds marks from figure anchors', () => {
    const p = project([
      { sceneId: 's1', startSec: 0, endSec: 4, setReference: { subjectId: 'p-street', greyboxShotId: null }, shotSheet: { characters: ['Ana'] } },
      { sceneId: 's2', startSec: 4, endSec: 8, setReference: { subjectId: 'p-street', greyboxShotId: null }, shotSheet: { characters: ['Bo'] } },
    ]);
    // Previz built without greybox cameras initially
    const emptyPlaces = { 'cat-street': { ingredient: { id: 'cat-street', type: 'place', name: 'Example Street', payload: {} }, media: [] } };
    const initial = backfillPrevizFromShots(p, emptyPlaces).previz;
    expect(initial.cuts[0].viewShotId).toBeNull();
    // Tracks were seeded at default row positions
    const oldAnaTrack = initial.tracks.find((t) => t.subjectId === 'c-ana');
    expect(oldAnaTrack).toBeDefined();

    // Now a drafted greybox with specific figure anchors arrives
    const draftedGreybox = {
      anchors: [
        { id: 'ana-mark', label: 'Ana Mark', kind: 'figure', position: [5, 0, 8], facingDegrees: 45 },
        { id: 'bo-mark', label: 'Bo Mark', kind: 'figure', position: [-2, 0, 3], facingDegrees: 180 },
      ],
      shots: [
        { id: 'shot1-cam', label: 'Shot 1', position: [0, 2, 12], target: [5, 1, 8], figures: [{ anchorId: 'ana-mark' }] },
        { id: 'shot2-cam', label: 'Shot 2', position: [0, 2, 6], target: [-2, 1, 3], figures: [{ anchorId: 'bo-mark' }] },
      ],
      parts: [],
    };

    const { previz: applied, loadedPlaces } = applyPrevizGreybox(
      { ...p, previz: initial },
      'p-street',
      draftedGreybox,
      emptyPlaces,
    );

    // Cuts are now linked to their respective cameras
    expect(applied.cuts[0].viewShotId).toBe('shot1-cam');
    expect(applied.cuts[1].viewShotId).toBe('shot2-cam');

    // Tracks were re-seeded from the figure anchors!
    const newAnaTrack = applied.tracks.find((t) => t.subjectId === 'c-ana');
    expect(newAnaTrack.keys[0].position).toEqual([5, 0, 8]);
    expect(newAnaTrack.keys[0].facingDegrees).toBe(45);

    const newBoTrack = applied.tracks.find((t) => t.subjectId === 'c-bo');
    expect(newBoTrack.keys[0].position).toEqual([-2, 0, 3]);
    expect(newBoTrack.keys[0].facingDegrees).toBe(180);

    // Loaded places was updated with the greybox
    expect(loadedPlaces['cat-street'].ingredient.payload.greybox).toEqual(draftedGreybox);
    expect(musicVideoProjectUpdateSchema.safeParse({ previz: applied }).success).toBe(true);
  });
});

describe('in-set action paths and camera frustum seeding (#15493)', () => {
  // Catches frozen people during in-set action cuts: away, toward and pass, and circle.
  it('seeds in-set action movement for away, toward and pass, and circle (#15493)', () => {
    const p = project([
      scene('s16', 0, 4, { characters: ['Ana'], action: 'Renee pushes off and rolls downhill away' }),
      scene('s22', 4, 8, { characters: ['Ana', 'Bo'], action: 'ride side by side toward the viewpoint and pass on either side' }),
      scene('s66', 8, 12, { characters: ['Ana'], action: 'rides a wide counterclockwise circle under the lamp' }),
    ]);
    const { previz } = backfillPrevizFromShots(p, places);
    const pWithPreviz = { ...p, previz };

    // Shot 16: moving away from camera
    const frame16Start = previzFrameAt(pWithPreviz, places, 0);
    const frame16End = previzFrameAt(pWithPreviz, places, 3.9);
    const cam16 = frame16Start.camera.position;
    const a16Start = frame16Start.actors.find((a) => a.subjectId === 'c-ana').position;
    const a16End = frame16End.actors.find((a) => a.subjectId === 'c-ana').position;
    const dist16Start = Math.hypot(a16Start[0] - cam16[0], a16Start[2] - cam16[2]);
    const dist16End = Math.hypot(a16End[0] - cam16[0], a16End[2] - cam16[2]);
    expect(dist16End).toBeGreaterThan(dist16Start + 3);

    // Shot 22: two people moving toward viewpoint and passing on either side
    const frame22Start = previzFrameAt(pWithPreviz, places, 4);
    const frame22End = previzFrameAt(pWithPreviz, places, 7.9);
    const cam22 = frame22Start.camera.position;
    const ana22Start = frame22Start.actors.find((a) => a.subjectId === 'c-ana').position;
    const bo22Start = frame22Start.actors.find((a) => a.subjectId === 'c-bo').position;
    const ana22End = frame22End.actors.find((a) => a.subjectId === 'c-ana').position;
    const bo22End = frame22End.actors.find((a) => a.subjectId === 'c-bo').position;
    const distAnaStart = Math.hypot(ana22Start[0] - cam22[0], ana22Start[2] - cam22[2]);
    const distAnaEnd = Math.hypot(ana22End[0] - cam22[0], ana22End[2] - cam22[2]);
    const distBoStart = Math.hypot(bo22Start[0] - cam22[0], bo22Start[2] - cam22[2]);
    const distBoEnd = Math.hypot(bo22End[0] - cam22[0], bo22End[2] - cam22[2]);
    expect(distAnaEnd).toBeLessThan(distAnaStart);
    expect(distBoEnd).toBeLessThan(distBoStart);
    // They pass on either side of the camera: one on negative across, one on positive across
    expect(ana22End[0]).not.toEqual(bo22End[0]);
    expect((ana22End[0] < cam22[0] && bo22End[0] > cam22[0]) || (ana22End[0] > cam22[0] && bo22End[0] < cam22[0])).toBe(true);

    // Shot 66: counterclockwise circle
    const frame66Start = previzFrameAt(pWithPreviz, places, 8);
    const frame66Mid = previzFrameAt(pWithPreviz, places, 10);
    const frame66End = previzFrameAt(pWithPreviz, places, 11.99);
    const a66Start = frame66Start.actors.find((a) => a.subjectId === 'c-ana').position;
    const a66Mid = frame66Mid.actors.find((a) => a.subjectId === 'c-ana').position;
    const a66End = frame66End.actors.find((a) => a.subjectId === 'c-ana').position;
    // Mid point is displaced across the circle
    expect(Math.hypot(a66Mid[0] - a66Start[0], a66Mid[2] - a66Start[2])).toBeGreaterThan(4);
    // End point returns near the start mark (loop)
    expect(Math.hypot(a66End[0] - a66Start[0], a66End[2] - a66Start[2])).toBeLessThan(0.1);
  });

  // Catches auto-placed marks landing outside the cut camera view (shots 33, 60, 64, 69, 75, 79).
  it('guarantees seeded marks are always inside the camera frustum and frame is never empty (#15493)', () => {
    const wideHighAngleGreybox = {
      anchors: [{ id: 'f1', label: 'F1', kind: 'figure', position: [0, 0, 0], facingDegrees: 0 }],
      shots: [
        { id: 'high', label: 'High', position: [-2, 34, 12], target: [-2, 0, 1.5], focalLengthMm: 24, aspect: '16:9', figures: [] },
        { id: 'wide-rink', label: 'Wide', position: [26, 15, 14], target: [-5, 0, 2], focalLengthMm: 24, aspect: '16:9', figures: [{ anchorId: 'f1' }] },
      ],
    };
    const testPlaces = { 'cat-street': { ingredient: { type: 'place', payload: { greybox: wideHighAngleGreybox } }, media: [] } };
    const p = project([
      { ...scene('s_high', 0, 4, { characters: ['Ana', 'Bo'] }), setReference: { subjectId: 'p-street', greyboxShotId: 'high' } },
      { ...scene('s_rink', 4, 8, { characters: ['Ana', 'Bo'] }), setReference: { subjectId: 'p-street', greyboxShotId: 'wide-rink' } },
    ]);
    const { previz } = backfillPrevizFromShots(p, testPlaces);
    const pWithPreviz = { ...p, previz };

    const isFigureInFrustum = (pos, camera) => {
      const [cx, cy, cz] = camera.position;
      const [tx, ty, tz] = camera.target;
      const [dx, dy, dz] = [tx - cx, ty - cy, tz - cz];
      const dist = Math.hypot(dx, dy, dz) || 1;
      const fwd = [dx / dist, dy / dist, dz / dist];
      const rLen = Math.hypot(-fwd[2], fwd[0]);
      const right = rLen < 1e-6 ? [1, 0, 0] : [-fwd[2] / rLen, 0, fwd[0] / rLen];
      const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
      const [w, h] = String(camera.aspect || '16:9').split(':').map(Number);
      const aspect = w > 0 && h > 0 ? w / h : 16 / 9;
      const tanV = 12 / (camera.focalLengthMm || 35);
      const tanH = tanV * aspect;
      const vx = pos[0] - cx;
      const vyChest = pos[1] + 1.25 - cy;
      const vz = pos[2] - cz;
      const depth = vx * fwd[0] + vyChest * fwd[1] + vz * fwd[2];
      if (depth < 0.2 || depth > 2000) return false;
      const halfH = depth * tanV;
      const halfW = depth * tanH;
      const xCam = vx * right[0] + vyChest * right[1] + vz * right[2];
      const yCamFeet = vx * up[0] + (pos[1] - cy) * up[1] + vz * up[2];
      const yCamHead = vx * up[0] + (pos[1] + 1.7 - cy) * up[1] + vz * up[2];
      return Math.abs(xCam) <= halfW && Math.max(yCamFeet, yCamHead) >= -halfH && Math.min(yCamFeet, yCamHead) <= halfH;
    };

    // High shot: 0 figure marks, 2 people auto-placed
    const frameHigh = previzFrameAt(pWithPreviz, testPlaces, 1);
    const visibleHigh = frameHigh.actors.filter((a) => a.visible);
    expect(visibleHigh).toHaveLength(2);
    for (const actor of visibleHigh) {
      expect(isFigureInFrustum(actor.position, frameHigh.camera)).toBe(true);
    }

    // Wide rink shot: 1 figure mark, 2 people (person 2 auto-placed)
    const frameRink = previzFrameAt(pWithPreviz, testPlaces, 5);
    const visibleRink = frameRink.actors.filter((a) => a.visible);
    expect(visibleRink).toHaveLength(2);
    for (const actor of visibleRink) {
      expect(isFigureInFrustum(actor.position, frameRink.camera)).toBe(true);
    }
  });

  // Catches a cut carrying an explicit actionPath in schema
  it('allows a cut to carry an explicit actionPath in the previz schema (#15493)', () => {
    const cut = { id: 'cut-s1', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street', viewShotId: 'wide', actionPath: 'circle' };
    expect(musicVideoProjectUpdateSchema.safeParse({ previz: { cuts: [cut], tracks: [] } }).success).toBe(true);
  });
});

describe('previz night lighting and prop proxies (#15494)', () => {
  const propSubjects = [...subjects, { id: 'o-sedan', kind: 'object', name: 'Silver sedan' }, { id: 'o-bikes', kind: 'object', name: 'Bikes' }, { id: 'o-cam', kind: 'object', name: 'Camcorder' }];
  const propProject = (scenes, extra = {}) => ({ ...project(scenes, extra), concept: { subjects: propSubjects } });

  // Catches a set cut staying in flat daylight when its shot is at night, and "dusk into night" reading as night.
  it('lights a set cut from the timeline clock, else the shot sheet time of day, else daylight', () => {
    const scenes = [scene('s1', 0, 4, { characters: ['Ana'], timeOfDay: 'Dusk into night' }), scene('s2', 4, 8, { characters: ['Ana'], timeOfDay: 'around 9:30 pm' }), scene('s3', 8, 12, { characters: ['Ana'] })];
    const { previz } = backfillPrevizFromShots(project(scenes), places);
    const p = project(scenes, { previz });
    expect(previzFrameAt(p, places, 1).clockMinutes).toBe(1190);
    expect(previzFrameAt(p, places, 5).clockMinutes).toBe(21 * 60 + 30);
    expect(previzFrameAt(p, places, 9).clockMinutes).toBeNull();
    const onTimeline = project(scenes, {
      previz: { ...previz, timeline: { startClock: 1320, lengthMin: 60, beats: [] }, cuts: previz.cuts.map((cut) => ({ ...cut, storyMin: 30 })) },
    });
    // No world loaded: the cut plays on its set but keeps the story clock, 30 story minutes after 22:00 plus 2 s.
    expect(previzFrameAt(onTimeline, places, 2).clockMinutes).toBeCloseTo(1350 + 2 / 60, 5);
  });

  // Catches a passing car or a found camcorder never being drawn, and a car picking up a figure pose.
  it('seeds named cast objects as moving prop tracks drawn only in the cuts that name them', () => {
    const scenes = [
      scene('s1', 0, 4, { characters: ['Ana'], action: 'Ana crouches as the silver sedan passes toward the camera', light: 'Its headlights sweep the hedge' }),
      scene('s2', 4, 8, { characters: ['Ana'], action: 'Ana finds the camcorder in the grass' }),
    ];
    const { previz } = backfillPrevizFromShots(propProject(scenes), places);
    expect(musicVideoPrevizSchema.safeParse(previz).success).toBe(true);
    const sedan = previz.tracks.find((t) => t.subjectId === 'o-sedan');
    expect(sedan.keys.every((key) => !('pose' in key) && !('vehicleSubjectId' in key))).toBe(true);
    const p = propProject(scenes, { previz });
    const start = previzFrameAt(p, places, 0);
    const end = previzFrameAt(p, places, 3.9);
    expect(start.actors.map((a) => [a.subjectId, a.pose])).toEqual([['c-ana', 'crouch']]);
    expect(start.props).toEqual([expect.objectContaining({ subjectId: 'o-sedan', shape: 'car' })]);
    expect(end.props[0].position).not.toEqual(start.props[0].position);
    expect(previzFrameAt(p, places, 5).props.map((prop) => [prop.subjectId, prop.shape])).toEqual([['o-cam', 'small']]);
  });

  // Catches "bikes lying on the lawn" seating everyone on the bikes instead of laying the bikes down.
  it('treats a vehicle set down on the grass as a prop, not a ride', () => {
    const scenes = [scene('s1', 0, 4, { characters: ['Ana', 'Bo'], action: 'Ana and Bo sit, their bikes lying on the lawn' })];
    const withBikes = (extra) => propProject(scenes, extra);
    const { previz } = backfillPrevizFromShots(withBikes({ previz: { cuts: [], tracks: [], vehicles: [{ subjectId: 'o-bikes', speedMetersPerMin: 250 }] } }), places);
    const frame = previzFrameAt(withBikes({ previz }), places, 1);
    expect(frame.actors.map((a) => a.pose)).toEqual(['sit', 'sit']);
    expect(frame.props).toEqual([expect.objectContaining({ subjectId: 'o-bikes', shape: 'bike' })]);
  });
});
