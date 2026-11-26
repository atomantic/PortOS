import { describe, expect, it } from 'vitest';
import { buildSceneClipRequest } from './musicVideoClipRequest.js';

const scene = {
  sceneId: 's1', shotMode: 'cutaway', prompt: 'A rider turns', referenceImageId: 'start.png',
  startSec: 0, endSec: 4, takes: [],
};
const project = { id: 'p1', scenes: [scene] };
const model = { id: 'example-ltx', runtime: 'ltx25' };
const ltxSettings = { backend: 'local', modelId: model.id, generationMode: 'ltxReferences' };

const request = (settings, input = {}) => buildSceneClipRequest({ scene, project, settings, ...input });

describe('buildSceneClipRequest', () => {
  it.each([
    ['grok', 'grokDuration'],
    ['fal', 'falModelId'],
    ['runway', 'runwayModelId'],
    ['higgsfield', 'higgsfieldModelId'],
    ['google', 'googleModelId'],
  ])('includes %s fields in the clip body', (backend, field) => {
    const { body } = request({ backend });
    expect(body).toMatchObject({ backend, mode: 'image', sourceImageFile: 'start.png', [field]: expect.anything() });
  });

  it('sends a Gemini clip with no length or audio control', () => {
    const { body } = request({ backend: 'gemini' });
    expect(body).toMatchObject({ backend: 'gemini', mode: 'image', sourceImageFile: 'start.png' });
    for (const field of ['grokDuration', 'disableAudio', 'modelId']) expect(body).not.toHaveProperty(field);
  });

  it('sends a local clip with the saved model and clip-sound flag', () => {
    const { body } = request({ backend: 'local', modelId: 'ltx23_example' });
    expect(body).toMatchObject({ backend: 'local', modelId: 'ltx23_example', mode: 'image', disableAudio: true });
  });

  it('keeps the Grok duration pin for an unnamed backend', () => {
    expect(request({ grokDuration: 10 }).body).toMatchObject({ grokDuration: 10, disableAudio: true });
  });

  it('falls back to the authored prompt and tags only a supplied card prompt as typed', () => {
    const settings = { backend: 'higgsfield' };
    const fallback = request(settings, { card: { prompt: '' } });
    expect(fallback.body.prompt).toBe('A rider turns');
    expect(fallback.body.musicVideo).not.toHaveProperty('promptAsTyped');

    const typed = request(settings, { card: { prompt: '  A rider turns slowly.  ', frameRoute: 'image', expectedClipReferenceFiles: [] } });
    expect(typed.body.prompt).toBe('  A rider turns slowly.  ');
    expect(typed.body.musicVideo).toMatchObject({ promptAsTyped: true, frameRoute: 'image', expectedClipReferenceFiles: [] });
  });

  it('uses project-default LTX references when the saved greybox set is omitted', () => {
    const shot = { ...scene, setReference: { subjectId: 'pier', greyboxShotId: 'wide' }, omittedCatalogSubjectIds: ['pier'] };
    const withReferences = { ...project, scenes: [shot], visualSpec: {
      references: [{ id: 'lead', imageId: 'lead.png', role: 'character', condition: true }],
    } };
    const { body } = request(ltxSettings, { scene: shot, project: withReferences, model });
    expect(body).toMatchObject({
      mode: 'ic-ingredients-25', icReferenceImageFiles: ['lead.png'], numFrames: 121,
      musicVideo: { expectedClipReferenceFiles: ['lead.png'] },
    });
    expect(body.musicVideo).not.toHaveProperty('promptAsTyped');
    expect(request(ltxSettings, { scene: { ...shot, omittedCatalogSubjectIds: [] }, project: withReferences, model }).body.mode)
      .toBe('image');
  });

  it('sends a card LTX reference clip with snapped frames and no end frame', () => {
    const { body } = request(ltxSettings, {
      scene: { ...scene, endImageId: 'end.png' },
      target: { numFrames: 123 },
      card: {
        prompt: 'Reference sheet: Rider.\n\nGenerated video: A rider turns',
        ltxReferences: true, songAudio: false, endFrame: false,
        expectedClipReferenceFiles: ['lead.png'], expectedClipReferenceLabels: ['Rider'],
      },
      model,
    });
    expect(body).toMatchObject({
      mode: 'ic-ingredients-25', modelId: model.id, numFrames: 129,
      icReferenceImageFiles: ['lead.png'], sourceImageFile: 'start.png',
      musicVideo: { expectedClipReferenceFiles: ['lead.png'], expectedClipReferenceLabels: ['Rider'] },
    });
    expect(body).not.toHaveProperty('lastImageFile');
  });

  it('refuses missing references, too few requested frames, and a shot past the frame limit', () => {
    expect(request(ltxSettings, { model }).error).toMatchObject({ code: 'MUSIC_VIDEO_CLIP_REFERENCE_MISSING', status: 422 });
    const card = { ltxReferences: true, expectedClipReferenceFiles: ['lead.png'] };
    expect(request(ltxSettings, { model, card, scene: { ...scene, clipLengthSec: 8 }, target: { numFrames: 121 } }).error)
      .toMatchObject({ code: 'MUSIC_VIDEO_CLIP_TOO_LONG', status: 422, message: expect.stringMatching(/too long for one LTX reference clip/) });
    expect(request(ltxSettings, { model, card, scene: { ...scene, preMusic: { durationSec: 45 } } }).error)
      .toMatchObject({ code: 'MUSIC_VIDEO_CLIP_TOO_LONG' });
  });
});
