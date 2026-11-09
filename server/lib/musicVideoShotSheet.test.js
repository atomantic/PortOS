import { describe, expect, it } from 'vitest';
import { normalizeShotSheet, shotCameraRuleText, shotOmitsOwnedCameraDetail, shotSheetBulkEdits, shotSheetCast, shotSheetMapRows, shotSheetMediaEdits, shotSheetOptions, SHOT_SHEET_MAP_BARS, shotSheetProblems, shotSheetRows, shotSheetStretches } from './musicVideoShotSheet.js';
import { musicVideoSceneUpdateSchema, musicVideoProjectUpdateSchema } from './musicVideoValidation.js';
import { applySceneUpdate, applyProjectPatch, replaceScenes } from '../services/musicVideo/projectsLogic.js';

const selectedFrameOutdated = (shot) => shotSheetRows({ scenes: [shot] })[0].frameOutdated;
const scene = (over = {}) => ({ sceneId: 's1', framePrompt: 'Ada rides away at dusk', referenceImageId: 'a.png', takes: [], ...over });
const take = (prompt) => ({ kind: 'image', assetId: 'a.png', prompt });

describe('selectedFrameOutdated', () => {
  // Catches the check missing a frame rendered before the prompt was rewritten.
  it('flags a frame whose recorded prompt no longer holds the shot\'s frame prompt', () => {
    expect(selectedFrameOutdated(scene({ takes: [take('Ada and Ben stop at the curb')] }))).toBe(true);
  });
  // Catches an edit late in a long prompt going unnoticed.
  it('flags a change after the prompt\u2019s opening', () => {
    const opening = 'Ada and Ben ride down a long curved suburban street at dusk past lawns, sprinklers and porch lights just clicking on one by one. ';
    expect(selectedFrameOutdated(scene({ framePrompt: `${opening}Ben holds the camera.`, takes: [take(`${opening}Ada holds the camera.`)] }))).toBe(true);
  });
  // Catches a false alarm when the render composed extra text around the shot's own prompt.
  it('reads as current when the composed prompt contains the shot\'s text', () => {
    expect(selectedFrameOutdated(scene({ takes: [take('Style. Ada rides away at dusk, grain.')] }))).toBe(false);
  });
  // Catches an edited shot detail going unnoticed on a still built from the sheet.
  it('flags a sheet-built frame whose details changed since', () => {
    const built = scene({ shotSheet: { promptFromSheet: true, emotion: 'Scared' } });
    expect(selectedFrameOutdated({ ...built, takes: [take('Ada rides away at dusk\nEmotion: Scared.')] })).toBe(false);
    expect(selectedFrameOutdated({ ...built, takes: [take('Ada rides away at dusk\nEmotion: Playful.')] })).toBe(true);
    // A snapshot that still matches camera and place must not hide an edited sheet line.
    expect(selectedFrameOutdated({ ...built, takes: [{ ...take('Ada rides away at dusk\nEmotion: Playful.'), dependencyState: { status: 'current', reasons: [] } }] })).toBe(true);
  });
  // Catches an imported frame with no recorded prompt being reported as outdated.
  it('can\'t judge a frame with no recorded prompt', () => {
    expect(selectedFrameOutdated(scene({ takes: [take(null)] }))).toBe(false);
  });
  it('shows a recorded camera change even when the composed prompt still contains the shot text', () => {
    const recorded = scene({ takes: [{ ...take('Style. Ada rides away at dusk, grain.'), dependencyState: { status: 'stale', reasons: ['Camera changed'] } }] });
    const row = shotSheetRows({ scenes: [recorded] })[0];
    expect(row.frameOutdated).toBe(true);
    expect(row.frameOutdatedReasons).toEqual(['Camera changed']);
  });
  // Catches a camera-rule edit leaving a frame looking current.
  it('flags a frame rendered before its camera rule', () => {
    const project = { cameras: [{ id: 'eye', name: 'Observer', kind: 'observer', rule: 'Nobody looks at it' }] };
    const withCamera = (prompt) => shotSheetRows({ ...project, scenes: [scene({ shotSheet: { cameraId: 'eye' }, takes: [take(prompt)] })] })[0].frameOutdated;
    expect(withCamera('Ada rides away at dusk')).toBe(true);
    expect(withCamera('Ada rides away at dusk\nCamera: Observer, an observer camera. Nobody looks at it.')).toBe(false);
  });
  // Catches a sheet-built frame staying current after the rule moves into its Camera line.
  it('judges a sheet-built frame by the Camera line that carries the rule', () => {
    const project = { cameras: [{ id: 'snap', name: 'Snapshot camera', kind: 'in-world', owner: 'Ada', rule: 'Facing back' }] };
    const shot = (prompt) => shotSheetRows({ ...project, scenes: [scene({ shotSheet: { promptFromSheet: true, cameraId: 'snap', holder: 'Ada' }, takes: [take(prompt)] })] })[0].frameOutdated;
    expect(shot('Ada rides away at dusk\nCamera: Snapshot camera, held by Ada.')).toBe(true);
    expect(shot('Ada rides away at dusk\nCamera: Snapshot camera, held by Ada. This camera is the one taking the picture, so it is not in the frame. Facing back.')).toBe(false);
  });
});

describe('shotCameraRuleText', () => {
  const project = { cameras: [
    { id: 'snap', name: 'Snapshot camera', kind: 'in-world', owner: 'Ada', rule: 'Facing back.' },
    { id: 'eye', name: 'Observer', kind: 'observer', rule: 'Subjects do not look at it.' },
  ] };
  it('names the camera and says an owned in-world camera is not in the frame', () => {
    expect(shotCameraRuleText(project, { shotSheet: { cameraId: 'snap', holder: 'Ada' } })).toBe('Camera: Snapshot camera, an in-world camera. This camera is the one taking the picture, so it is not in the frame. Facing back.');
    expect(shotCameraRuleText(project, { shotSheet: { cameraId: 'eye' } })).toBe('Camera: Observer, an observer camera. Subjects do not look at it.');
    expect(shotCameraRuleText(project, { shotSheet: {} })).toBe('');
  });
  it('drops that camera from the owner and from the person holding it', () => {
    const selfie = { shotSheet: { cameraId: 'snap', holder: 'Ada' } };
    expect(shotOmitsOwnedCameraDetail(project, selfie, 'Ada', 'Camera on a wrist strap')).toBe(true);
    expect(shotOmitsOwnedCameraDetail(project, selfie, 'Ada', 'Red watch on the left wrist')).toBe(false);
    expect(shotOmitsOwnedCameraDetail(project, selfie, 'Bo', 'Pocket camera')).toBe(false);
    const borrowed = { shotSheet: { cameraId: 'snap', holder: 'Bo' } };
    expect(shotOmitsOwnedCameraDetail(project, borrowed, 'Bo', 'Pocket camera')).toBe(true);
    expect(shotOmitsOwnedCameraDetail(project, borrowed, 'Ada', 'Snapshot camera on a strap')).toBe(true);
    expect(shotOmitsOwnedCameraDetail(project, { shotSheet: { cameraId: 'eye', holder: 'Ada' } }, 'Ada', 'Camera on a wrist strap')).toBe(false);
  });
});

describe('shotSheetRows', () => {
  // Catches rows following stored order, a lyric from the wrong shot, or a lost camera link.
  it('lists shots in song order with the lyric sung over each and its camera', () => {
    const project = {
      cameras: [{ id: 'vhs', name: 'VHS', kind: 'in-world' }],
      lyricCues: [{ id: 'c', text: 'Stay a while', startSec: 5, endSec: 7 }],
      scenes: [
        { sceneId: 'late', startSec: 5, endSec: 8, shotSheet: { cameraId: 'vhs' } },
        { sceneId: 'early', startSec: 0, endSec: 5, lyricText: 'stale text' },
        { sceneId: 'untimed' },
      ],
    };
    const rows = shotSheetRows(project);
    expect(rows.map((row) => row.scene.sceneId)).toEqual(['early', 'late', 'untimed']);
    expect(rows[1].lyric).toBe('Stay a while');
    expect(rows[1].camera.name).toBe('VHS');
    expect(rows[0].camera).toBeNull();
  });
});

describe('shot sheet storage', () => {
  // Catches an emptied sheet being kept as a planned shot.
  it('stores a sheet with nothing filled in as null', () => {
    expect(normalizeShotSheet({ view: '  ', characters: [], cameraId: null, checked: false })).toBeNull();
    expect(normalizeShotSheet({ view: 'Low', characters: ['Ada'] })).toEqual({ view: 'Low', characters: ['Ada'] });
  });
  // Catches the sheet being dropped by the update schema, or a sheet edit losing the storyboard approval.
  it('saves a shot\'s sheet through a scene update without touching its prompts', () => {
    const project = { id: 'p', scenes: [{ sceneId: 's1', startSec: 0, endSec: 2, prompt: 'keep me', framePrompt: 'keep me too' }] };
    const { updated } = applySceneUpdate(project, 's1', { shotSheet: { emotion: 'Scared', cameraId: 'vhs', holder: 'Ada' } });
    expect(updated.shotSheet).toEqual({ emotion: 'Scared', cameraId: 'vhs', holder: 'Ada' });
    expect(updated.prompt).toBe('keep me');
    expect(updated.framePrompt).toBe('keep me too');
    expect(musicVideoSceneUpdateSchema.safeParse({ shotSheet: { unknown: 'x' } }).success).toBe(false);
  });
  // Catches a re-plan silently erasing the director's plan on a shot it keeps.
  it('keeps a saved sheet when a re-plan reuses the shot', () => {
    const start = { id: 'p', scenes: [{ sceneId: 's1', startSec: 0, endSec: 6, prompt: 'old' }] };
    const { project } = applySceneUpdate(start, 's1', { shotSheet: { emotion: 'Scared', checked: true } });
    const { project: replanned } = replaceScenes(project, [{ startSec: 0, endSec: 6, prompt: 'new' }]);
    expect(replanned.scenes[0].sceneId).toBe('s1');
    expect(replanned.scenes[0].prompt).toBe('new');
    expect(replanned.scenes[0].shotSheet).toEqual({ emotion: 'Scared', checked: true });
  });
  // Catches a re-plan or sheet rewrite leaving the previous direction clauses in the prompt.
  it('marks a reused direction stale when the prompt or sheet changes, and not when the carry-over is unchanged', () => {
    const direction = { focalSubject: 'Ada', frameClause: 'focal subject: Ada', framing: 'close-up' };
    const start = { id: 'p', scenes: [{ sceneId: 's1', startSec: 0, endSec: 6, prompt: 'same', direction, shotSheet: { characters: ['Ada'] } }] };
    const { project: kept } = replaceScenes(start, [{ startSec: 0, endSec: 6, prompt: 'same' }]);
    expect(kept.scenes[0].direction.stale).toBeUndefined();
    expect(kept.scenes[0].shotSheet).toEqual({ characters: ['Ada'] });
    const { project: rewritten } = replaceScenes(start, [{ startSec: 0, endSec: 6, prompt: 'an empty wide of the fence' }]);
    expect(rewritten.scenes[0].direction.stale).toBe(true);
    expect(rewritten.scenes[0].prompt).toBe('an empty wide of the fence');
    expect(rewritten.scenes[0].shotSheet).toEqual({ characters: ['Ada'] });
    const { updated } = applySceneUpdate(start, 's1', { shotSheet: { characters: ['Ben'], view: 'Wide' } });
    expect(updated.direction.stale).toBe(true);
    expect(updated.shotSheet).toEqual({ characters: ['Ben'], view: 'Wide' });
    expect(updated.prompt).toBe('same');
  });
  // Catches the project patch dropping the camera list.
  it('saves the project\'s cameras', () => {
    const cameras = [{ id: 'obs', name: 'Observer', kind: 'observer', rule: 'Nobody looks at it' }];
    expect(musicVideoProjectUpdateSchema.safeParse({ cameras }).success).toBe(true);
    expect(musicVideoProjectUpdateSchema.safeParse({ cameras: [{ id: 'x', name: 'X', kind: 'drone' }] }).success).toBe(false);
    expect(applyProjectPatch({ id: 'p', scenes: [] }, { cameras }).cameras).toEqual(cameras);
  });
});

describe('shotSheetProblems', () => {
  const full = { cameraId: 'vhs', holder: 'Ben', location: 'Street', timeOfDay: 'Dusk', emotion: 'Joy', action: 'Rides', characters: ['Ada'] };
  const vhs = { id: 'vhs', name: 'VHS', kind: 'in-world' };
  // Catches a complete plan being nagged about.
  it('has nothing to say about a complete plan', () => {
    expect(shotSheetProblems({ sheet: full, camera: vhs })).toEqual([]);
  });
  // Catches the empty columns not being named.
  it('names the empty columns', () => {
    expect(shotSheetProblems({ sheet: {}, camera: null })).toEqual(['Missing camera, location, time of day, emotion, action, who']);
  });
  // Catches an observer being asked for a holder, or an in-world camera escaping the rule.
  it('asks who holds an in-world camera but never an observer', () => {
    const { holder: _holder, ...noHolder } = full;
    expect(shotSheetProblems({ sheet: noHolder, camera: vhs })).toEqual(['Nobody holds the VHS']);
    expect(shotSheetProblems({ sheet: noHolder, camera: { id: 'vhs', name: 'Observer', kind: 'observer' } })).toEqual([]);
  });
  // Catches a deleted camera or a re-cut's copied action going unnoticed.
  it('flags a removed camera and an action copied from the shot before', () => {
    expect(shotSheetProblems({ sheet: full, camera: null })).toContain('Its camera was removed from this video');
    expect(shotSheetProblems({ sheet: full, camera: vhs }, { sheet: { action: ' Rides ' } })).toEqual(['Same action as the shot before']);
  });
});

describe('shotSheetOptions', () => {
  // Catches sets missing from the location list, or a typed value not coming back as a choice.
  it('offers places, the starting list and earlier wording without repeats', () => {
    const project = { concept: { subjects: [{ kind: 'place', name: 'Mall' }, { kind: 'character', name: 'Ada' }] }, scenes: [{ shotSheet: { location: 'Mall' } }, { shotSheet: { location: 'Field' } }, { shotSheet: { emotion: 'Scared' } }] };
    expect(shotSheetOptions(project, 'location')).toEqual(['Mall', 'Field']);
    expect(shotSheetOptions(project, 'emotion').filter((value) => value === 'Scared')).toHaveLength(1);
  });
});

describe('shotSheetStretches', () => {
  const bar = (id) => SHOT_SHEET_MAP_BARS.find(([key]) => key === id)[2];
  const row = (startSec, endSec, sheet = {}, camera = null) => ({ scene: { startSec, endSec }, sheet, camera });
  // Catches a return to an earlier place merging with its first visit, or an untimed shot stretching the map.
  it('joins consecutive shots by value and keeps a return as its own stretch', () => {
    const rows = [row(0, 2, { location: 'Street' }), row(2, 4, { location: ' Street ' }), row(4, 6, { location: 'Mall' }), row(6, 8), row(8, 9, { location: 'Street' }), { scene: {}, sheet: { location: 'Field' } }];
    expect(shotSheetStretches(rows, bar('location'))).toEqual([
      { value: 'Street', startSec: 0, endSec: 4, shots: 2 },
      { value: 'Mall', startSec: 4, endSec: 6, shots: 1 },
      { value: '', startSec: 6, endSec: 8, shots: 1 },
      { value: 'Street', startSec: 8, endSec: 9, shots: 1 },
    ]);
  });
  // Catches a borrowed camera reading as no change, an observer gaining a holder, or the light bar reading the wrong column.
  it('shows who has each camera and reads time of day from its own column', () => {
    const vhs = { name: 'VHS' };
    const observer = { name: 'Observer' };
    const rows = [row(0, 1, { holder: 'Ben', timeOfDay: 'Dusk', light: 'Flash' }, vhs), row(1, 2, { holder: 'Ada', timeOfDay: 'Dusk', light: 'Lamp' }, vhs), row(2, 3, { timeOfDay: 'Night' }, observer)];
    expect(shotSheetStretches(rows, bar('camera')).map((stretch) => stretch.value)).toEqual(['VHS · Ben', 'VHS · Ada', 'Observer']);
    expect(shotSheetStretches(rows, bar('timeOfDay')).map((stretch) => stretch.value)).toEqual(['Dusk', 'Night']);
  });
});

describe('camera output', () => {
  const project = (medium, visualLayer, output) => ({
    cameras: [{ id: 'c', name: 'Snapshot', kind: 'in-world', output }],
    treatment: { shotDirections: [{ sceneId: 's', medium }] },
    scenes: [{ sceneId: 's', startSec: 0, endSec: 1, visualLayer, shotSheet: { cameraId: 'c' } }],
  });
  // Catches the plan and the picture layer disagreeing unnoticed, which is how a photo shot renders as video.
  it('edits only what disagrees with the camera', () => {
    expect(shotSheetMediaEdits(shotSheetRows(project('still', 'footage', 'image')))).toEqual([{ sceneId: 's', visualLayer: 'still' }]);
    expect(shotSheetMediaEdits(shotSheetRows(project('generated-footage', 'footage', 'image')))).toEqual([{ sceneId: 's', medium: 'still', visualLayer: 'still' }]);
    expect(shotSheetMediaEdits(shotSheetRows(project('still', 'still', 'video')))).toEqual([{ sceneId: 's', medium: 'generated-footage', visualLayer: 'footage' }]);
  });
  // Catches a match failing outright on a shot the treatment doesn't know yet.
  it('only changes the layer of a shot with no compiled direction', () => {
    const noDirection = { ...project('still', 'footage', 'image'), treatment: null };
    expect(shotSheetMediaEdits(shotSheetRows(noDirection))).toEqual([{ sceneId: 's', visualLayer: 'still' }]);
  });
  // Catches existing footage being replanned, or a camera that shoots both being constrained.
  it('leaves agreeing shots and unconstrained cameras alone', () => {
    expect(shotSheetMediaEdits(shotSheetRows(project('existing-footage', 'footage', 'video')))).toEqual([]);
    expect(shotSheetMediaEdits(shotSheetRows(project('still', 'footage', undefined)))).toEqual([]);
  });
  // Catches a mismatch that the sheet's problems don't report.
  it('reports a mismatch as a problem', () => {
    const [row] = shotSheetRows(project('still', 'footage', 'image'));
    expect(shotSheetProblems(row)).toContain('Snapshot shoots photos, but this shot is set to video');
  });
});

describe('shotSheetMapRows', () => {
  const rows = [{ scene: {}, sheet: { location: 'Mall' } }, { scene: {}, sheet: {} }];
  // Catches the board and sheet disagreeing about a stretch, or "not set" matching everything.
  it('narrows to a stretch\u2019s value, including not set, and passes everything with no filter', () => {
    expect(shotSheetMapRows(rows, { bar: 'location', value: 'Mall' })).toEqual([rows[0]]);
    expect(shotSheetMapRows(rows, { bar: 'location', value: '' })).toEqual([rows[1]]);
    expect(shotSheetMapRows(rows, null)).toEqual(rows);
  });
});

describe('shotSheetBulkEdits', () => {
  const rows = [{ scene: { sceneId: 'a' }, sheet: { location: 'Mine', checked: true } }, { scene: { sceneId: 'b' }, sheet: {} }];
  // Catches a bulk set overwriting a director's value by default.
  it('fills only empty shots by default', () => {
    expect(shotSheetBulkEdits(rows, 'location', ' Mall ')).toEqual([{ sceneId: 'b', shotSheet: { location: 'Mall' } }]);
  });
  // Catches a deliberate overwrite skipping set shots, or a bulk edit unticking Checked.
  it('can overwrite, keeping Checked, and skips shots already at that value', () => {
    expect(shotSheetBulkEdits(rows, 'location', 'Mine', { onlyEmpty: false })).toEqual([{ sceneId: 'b', shotSheet: { location: 'Mine' } }]);
    expect(shotSheetBulkEdits(rows, 'location', 'Mall', { onlyEmpty: false })[0].shotSheet).toEqual({ location: 'Mall', checked: true });
  });
});

describe('shotSheetCast', () => {
  // Catches sets and props being offered as people in a shot.
  it('offers only character subjects', () => {
    expect(shotSheetCast({ concept: { subjects: [{ kind: 'character', name: 'Ada' }, { kind: 'place', name: 'Mall' }] } })).toEqual(['Ada']);
  });
});
