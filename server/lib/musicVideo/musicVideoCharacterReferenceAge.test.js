import { describe, it, expect } from 'vitest';
import { clipCastInputs, musicVideoTakeCharacterReferenceState } from './musicVideoCharacterReferenceAge.js';

// A Cast & Sets project: Ada's full sheet and, for close-ups, her expressions sheet.
const ADA = { id: 'cs-protagonist', kind: 'character', role: 'protagonist', name: 'Ada' };
const ref = (id, imageId) => ({ id, imageId, role: 'character', label: `Ada ${id}`, condition: id === 'mvr-cs-character', use: 'reference' });
const projectWith = (references, scene) => ({
  id: 'mv-1',
  concept: { subjects: [ADA] },
  castAndSets: { status: 'approved', direction: { protagonist: { name: 'Ada' } }, images: {} },
  visualSpec: { references },
  scenes: [scene],
});
const closeUp = (take) => ({ sceneId: 's1', framePrompt: 'Close-up of Ada at the window', referenceImageId: 'frame.png', takes: [take] });
const frameTake = (castInputs) => ({ takeId: 't1', kind: 'image', assetId: 'frame.png', source: 'generated', createdAt: '2026-06-01T00:00:00.000Z', castInputs });
const sent = (...entries) => ({ ingredientId: null, guides: [], sheets: entries.filter(([id]) => id.startsWith('mvr-cs-')).map(([id, imageId]) => ({ id, imageId })),
  characters: entries.map(([id, imageId]) => ({ id, imageId })) });
const stateFor = (references, scene) => {
  const project = projectWith(references, scene);
  return musicVideoTakeCharacterReferenceState(project, project.scenes[0], project.scenes[0].takes[0]);
};

describe('a take rendered from an older character reference (#16473)', () => {
  // Uniquely catches a replaced sheet going unflagged while another of the character's references is still current.
  it('flags a reference the take was sent that now holds another image, even when another of its references still matches', () => {
    const take = frameTake(sent(['mvr-cs-character', 'ada-v1.png'], ['mvr-cs-expressions', 'faces-v1.png']));
    expect(stateFor([ref('mvr-cs-character', 'ada-v1.png'), ref('mvr-cs-expressions', 'faces-v1.png')], closeUp(take))).toBeNull();
    expect(stateFor([ref('mvr-cs-character', 'ada-v2.png'), ref('mvr-cs-expressions', 'faces-v1.png')], closeUp(take)))
      .toMatchObject({ code: 'character-reference-changed', characters: [{ subjectId: 'cs-protagonist', name: 'Ada' }] });
  });

  // Uniquely catches a take from before `characters` existed being judged on references it never recorded.
  it('compares a take that recorded only its Cast & Sets sheets against sheets alone', () => {
    const legacy = frameTake({ ingredientId: null, guides: [], sheets: [] });
    // Ada's own upload is sent, but a sheets-only record never listed uploads, so it cannot prove she went without it.
    expect(stateFor([{ ...ref('mvr-upload-ada', 'own.png'), condition: true, subjectId: 'cs-protagonist' }], closeUp(legacy))).toBeNull();
    expect(stateFor([{ ...ref('mvr-upload-ada', 'own.png'), condition: true, subjectId: 'cs-protagonist' }], closeUp(frameTake(sent()))))
      .toMatchObject({ code: 'character-reference-changed' });
    expect(stateFor([ref('mvr-cs-character', 'ada-v1.png')], closeUp(legacy))).toMatchObject({ code: 'character-reference-changed' });
  });

  // Uniquely catches a guide-driven shot (catalog media the record does not hold) being flagged for an absence it cannot prove.
  it('flags only a replaced reference on a shot whose look comes from catalog guides', () => {
    const scene = (take) => ({ ...closeUp(take), characterVariant: { ingredientId: 'cat-ada' } });
    expect(stateFor([ref('mvr-cs-character', 'ada-v1.png')], scene(frameTake(sent(['mvr-guide-a', 'guide.png']))))).toBeNull();
    expect(stateFor([ref('mvr-cs-character', 'ada-v2.png')], scene(frameTake(sent(['mvr-cs-character', 'ada-v1.png'])))))
      .toMatchObject({ code: 'character-reference-changed' });
  });

  // Uniquely catches an imported frame with no recorded inputs being judged by date.
  it('never dates an imported frame', () => {
    const references = [ref('mvr-cs-character', 'ada-v1.png')];
    const images = { character: { status: 'done', imageId: 'ada-v1.png', updatedAt: '2026-07-01T00:00:00.000Z' } };
    const project = (source) => ({ ...projectWith(references, closeUp({ ...frameTake(undefined), source })), castAndSets: { status: 'approved', direction: { protagonist: { name: 'Ada' } }, images } });
    const state = (source) => { const p = project(source); return musicVideoTakeCharacterReferenceState(p, p.scenes[0], p.scenes[0].takes[0]); };
    expect(state('generated')).toMatchObject({ code: 'character-reference-changed' });
    expect(state('imported')).toBeNull();
  });

  // Uniquely catches a reference-driven clip losing the references it was sent, or a clip sent none being judged on its own.
  it('records and checks the character references a clip was sent', () => {
    const scene = { sceneId: 's1', prompt: 'Ada walks', referenceImageId: 'frame.png', videoHistoryId: 'clip-1', takes: [] };
    const project = projectWith([ref('mvr-cs-character', 'ada-v1.png')], scene);
    expect(clipCastInputs(project, scene, [])).toBeNull();
    const castInputs = clipCastInputs(project, scene, ['ada-v1.png', 'frame.png']);
    expect(castInputs.characters).toEqual([{ id: 'mvr-cs-character', imageId: 'ada-v1.png' }]);
    const clip = { takeId: 'c1', kind: 'video', assetId: 'clip-1', source: 'generated', castInputs };
    const replaced = projectWith([ref('mvr-cs-character', 'ada-v2.png')], { ...scene, takes: [clip] });
    expect(musicVideoTakeCharacterReferenceState(replaced, replaced.scenes[0], clip)).toMatchObject({ code: 'character-reference-changed' });
    expect(musicVideoTakeCharacterReferenceState(replaced, replaced.scenes[0], { ...clip, castInputs: undefined })).toBeNull();
  });
});
