// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildBackendClipRequestFields, buildSceneClipRequest, resolveLtxClipReferences } from './musicVideoSceneClipRequest.js';

const scene = {
  sceneId: 's1', shotMode: 'cutaway', prompt: 'A rider turns', referenceImageId: 'start.png',
  startSec: 0, endSec: 4, takes: [],
};
const project = { id: 'p1', scenes: [scene] };
const videoSettings = { settings: {} };

const request = (backend, extra = {}) => buildSceneClipRequest({
  scene, project, videoSettings: { settings: { backend, ...extra } },
});

describe('buildBackendClipRequestFields', () => {
  const ctx = { scene, project, target: null, disableAudio: true, useLtxReferences: false };

  it('names each of the seven video backends once', () => {
    expect(buildBackendClipRequestFields({ backend: 'grok', grokDuration: 6 }, ctx)).toMatchObject({ grokDuration: 6 });
    expect(buildBackendClipRequestFields({ backend: 'fal', falModelId: 'bytedance/seedance-2.5/image-to-video' }, ctx)).toHaveProperty('falModelId');
    expect(buildBackendClipRequestFields({ backend: 'runway' }, ctx)).toHaveProperty('runwayModelId');
    expect(buildBackendClipRequestFields({ backend: 'higgsfield' }, ctx)).toHaveProperty('higgsfieldModelId');
    expect(buildBackendClipRequestFields({ backend: 'google' }, ctx)).toHaveProperty('googleModelId');
    expect(buildBackendClipRequestFields({ backend: 'gemini' }, ctx)).toEqual({});
    expect(buildBackendClipRequestFields({ backend: 'local', modelId: 'ltx25_mlx_q8' }, ctx)).toMatchObject({
      modelId: 'ltx25_mlx_q8', disableAudio: true,
    });
  });

  it('keeps the shared Grok duration pin for an unnamed backend', () => {
    expect(buildBackendClipRequestFields({ grokDuration: 10 }, ctx)).toEqual({ grokDuration: 10, disableAudio: true });
  });
});

describe('buildSceneClipRequest', () => {
  it('returns a validation error before any backend fields', () => {
    expect(buildSceneClipRequest({ scene: { ...scene, referenceImageId: null }, project, videoSettings }).error)
      .toMatch(/reference frame/i);
    expect(buildSceneClipRequest({
      scene: { ...scene, prompt: '' }, project, card: null, videoSettings: { settings: { backend: 'grok' } },
    }).error).toBeTruthy();
    expect(buildSceneClipRequest({
      scene, project, card: { prompt: '' }, videoSettings: { settings: { backend: 'grok' } },
    }).error).toMatch(/shot prompt/i);
  });

  it.each([
    ['grok', 'grokDuration'],
    ['fal', 'falModelId'],
    ['runway', 'runwayModelId'],
    ['higgsfield', 'higgsfieldModelId'],
    ['google', 'googleModelId'],
  ])('spreads %s fields once into the clip body', (backend, field) => {
    const built = request(backend, backend === 'fal' ? { falModelId: 'bytedance/seedance-2.5/image-to-video' } : {});
    expect(built.error).toBeUndefined();
    expect(built.body).toMatchObject({ backend, mode: 'image', sourceImageFile: 'start.png', [field]: expect.anything() });
    expect(built.label).toBe(backend);
  });

  it('sends a gemini clip with no length or audio control', () => {
    const built = request('gemini');
    expect(built.body).toMatchObject({ backend: 'gemini', mode: 'image', sourceImageFile: 'start.png' });
    expect(built.body).not.toHaveProperty('grokDuration');
    expect(built.body).not.toHaveProperty('disableAudio');
    expect(built.body).not.toHaveProperty('modelId');
  });

  it('sends a local clip with the saved model and clip-sound flag', () => {
    const built = request('local', { modelId: 'ltx23_example' });
    expect(built.body).toMatchObject({ backend: 'local', modelId: 'ltx23_example', mode: 'image', disableAudio: true });
  });

  it('sends a card LTX 2.5 reference clip with frames and no end frame', () => {
    const built = buildSceneClipRequest({
      scene, project,
      target: { numFrames: 123 },
      card: {
        prompt: 'Reference sheet: Ada.\n\nGenerated video: A rider turns',
        ltxReferences: true, songAudio: false, endFrame: false,
        expectedClipReferenceFiles: ['ada.png'], expectedClipReferenceLabels: ['Ada'],
      },
      videoSettings: { settings: { backend: 'local', modelId: 'ltx25_mlx_q8' } },
    });
    expect(built.body).toMatchObject({
      mode: 'ic-ingredients-25', modelId: 'ltx25_mlx_q8', numFrames: 129,
      icReferenceImageFiles: ['ada.png'], sourceImageFile: 'start.png',
    });
    expect(built.body).not.toHaveProperty('lastImageFile');
    expect(JSON.parse(built.body.musicVideo)).toMatchObject({
      expectedClipReferenceFiles: ['ada.png'], expectedClipReferenceLabels: ['Ada'],
    });
  });

  it('refuses a project-default LTX clip with no references, and a clip past the frame limit', () => {
    const models = [{ id: 'ltx25_mlx_q8', runtime: 'ltx25' }];
    const settings = { backend: 'local', modelId: 'ltx25_mlx_q8', generationMode: 'ltxReferences' };
    const empty = buildSceneClipRequest({
      scene: { ...scene, clipReferenceIds: [] }, project, videoSettings: { settings, models, defaultModel: 'ltx25_mlx_q8' }, castMedia: {},
    });
    expect(empty.error).toMatch(/at least one clip reference/i);

    const longShot = { ...scene, preMusic: { durationSec: 45 }, referenceImageId: 'start.png' };
    const resolved = resolveLtxClipReferences({
      scene: longShot, project: { ...project, scenes: [longShot] },
      card: { ltxReferences: true, expectedClipReferenceFiles: ['ada.png'] },
      settings, target: null, videoSettings: { settings, models },
      performance: false, audioReactiveSelected: false,
    });
    expect(resolved.error).toMatch(/shorter clip length/i);
  });
});
