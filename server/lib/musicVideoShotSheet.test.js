import { describe, expect, it } from 'vitest';
import { normalizeShotSheet, selectedFrameOutdated, shotSheetCast, shotSheetOptions, SHOT_SHEET_MAP_BARS, shotSheetProblems, shotSheetRows, shotSheetStretches } from './musicVideoShotSheet.js';
import { musicVideoSceneUpdateSchema, musicVideoProjectUpdateSchema } from './musicVideoValidation.js';
import { applySceneUpdate, applyProjectPatch } from '../services/musicVideo/projectsLogic.js';

const scene = (over = {}) => ({ sceneId: 's1', framePrompt: 'Renee rides away at dusk', referenceImageId: 'a.png', takes: [], ...over });
const take = (prompt) => ({ kind: 'image', assetId: 'a.png', prompt });

describe('selectedFrameOutdated', () => {
  // Catches the check missing a frame rendered before the prompt was rewritten.
  it('flags a frame whose recorded prompt no longer holds the shot\'s frame prompt', () => {
    expect(selectedFrameOutdated(scene({ takes: [take('Renee and Kevin stop at the curb')] }))).toBe(true);
  });
  // Catches a false alarm when the render composed extra text around the shot's own prompt.
  it('reads as current when the composed prompt contains the shot\'s text', () => {
    expect(selectedFrameOutdated(scene({ takes: [take('Style. Renee rides away at dusk, grain.')] }))).toBe(false);
  });
  // Catches an imported frame with no recorded prompt being reported as outdated.
  it('can\'t judge a frame with no recorded prompt', () => {
    expect(selectedFrameOutdated(scene({ takes: [take(null)] }))).toBe(false);
  });
});

describe('shotSheetRows', () => {
  // Catches rows following stored order, a lyric from the wrong shot, or a lost camera link.
  it('lists shots in song order with the lyric sung over each and its camera', () => {
    const project = {
      cameras: [{ id: 'vhs', name: 'VHS', kind: 'in-world' }],
      lyricCues: [{ id: 'c', text: 'Hold still', startSec: 5, endSec: 7 }],
      scenes: [
        { sceneId: 'late', startSec: 5, endSec: 8, shotSheet: { cameraId: 'vhs' } },
        { sceneId: 'early', startSec: 0, endSec: 5, lyricText: 'stale text' },
        { sceneId: 'untimed' },
      ],
    };
    const rows = shotSheetRows(project);
    expect(rows.map((row) => row.scene.sceneId)).toEqual(['early', 'late', 'untimed']);
    expect(rows[1].lyric).toBe('Hold still');
    expect(rows[1].camera.name).toBe('VHS');
    expect(rows[0].camera).toBeNull();
  });
});

describe('shot sheet storage', () => {
  // Catches an emptied sheet being kept as a planned shot.
  it('stores a sheet with nothing filled in as null', () => {
    expect(normalizeShotSheet({ view: '  ', characters: [], cameraId: null, checked: false })).toBeNull();
    expect(normalizeShotSheet({ view: 'Low', characters: ['Renee'] })).toEqual({ view: 'Low', characters: ['Renee'] });
  });
  // Catches the sheet being dropped by the update schema, or a sheet edit losing the storyboard approval.
  it('saves a shot\'s sheet through a scene update without touching its prompts', () => {
    const project = { id: 'p', scenes: [{ sceneId: 's1', startSec: 0, endSec: 2, prompt: 'keep me', framePrompt: 'keep me too' }] };
    const { updated } = applySceneUpdate(project, 's1', { shotSheet: { emotion: 'Scared', cameraId: 'vhs', holder: 'Renee' } });
    expect(updated.shotSheet).toEqual({ emotion: 'Scared', cameraId: 'vhs', holder: 'Renee' });
    expect(updated.prompt).toBe('keep me');
    expect(updated.framePrompt).toBe('keep me too');
    expect(musicVideoSceneUpdateSchema.safeParse({ shotSheet: { unknown: 'x' } }).success).toBe(false);
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
  const full = { cameraId: 'vhs', holder: 'Kevin', location: 'Street', light: 'Dusk', emotion: 'Joy', action: 'Rides', characters: ['Renee'] };
  const vhs = { id: 'vhs', name: 'VHS', kind: 'in-world' };
  // Catches a complete plan being nagged about.
  it('has nothing to say about a complete plan', () => {
    expect(shotSheetProblems({ sheet: full, camera: vhs })).toEqual([]);
  });
  // Catches the empty columns not being named.
  it('names the empty columns', () => {
    expect(shotSheetProblems({ sheet: {}, camera: null })).toEqual(['Missing camera, location, time and light, emotion, action, who']);
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
    const project = { concept: { subjects: [{ kind: 'place', name: 'Mall' }, { kind: 'character', name: 'Renee' }] }, scenes: [{ shotSheet: { location: 'Mall' } }, { shotSheet: { location: 'Field' } }, { shotSheet: { emotion: 'Scared' } }] };
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
  it('shows who has each camera and reads time of day from the light column', () => {
    const vhs = { name: 'VHS' };
    const observer = { name: 'Observer' };
    const rows = [row(0, 1, { holder: 'Kevin', light: 'Dusk' }, vhs), row(1, 2, { holder: 'Renee', light: 'Dusk' }, vhs), row(2, 3, { light: 'Night' }, observer)];
    expect(shotSheetStretches(rows, bar('camera')).map((stretch) => stretch.value)).toEqual(['VHS · Kevin', 'VHS · Renee', 'Observer']);
    expect(shotSheetStretches(rows, bar('light')).map((stretch) => stretch.value)).toEqual(['Dusk', 'Night']);
  });
});

describe('shotSheetCast', () => {
  // Catches sets and props being offered as people in a shot.
  it('offers only character subjects', () => {
    expect(shotSheetCast({ concept: { subjects: [{ kind: 'character', name: 'Renee' }, { kind: 'place', name: 'Mall' }] } })).toEqual(['Renee']);
  });
});
