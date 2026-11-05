import { describe, expect, it } from 'vitest';
import { normalizeShotSheet, selectedFrameOutdated, shotSheetCast, shotSheetRows } from './musicVideoShotSheet.js';
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
    expect(normalizeShotSheet({ view: '  ', characters: [], cameraId: null })).toBeNull();
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

describe('shotSheetCast', () => {
  // Catches sets and props being offered as people in a shot.
  it('offers only character subjects', () => {
    expect(shotSheetCast({ concept: { subjects: [{ kind: 'character', name: 'Renee' }, { kind: 'place', name: 'Mall' }] } })).toEqual(['Renee']);
  });
});
