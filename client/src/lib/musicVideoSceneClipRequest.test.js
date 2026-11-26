// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildSceneClipRequest } from './musicVideoSceneClipRequest.js';

const scene = {
  sceneId: 's1', shotMode: 'cutaway', prompt: 'A rider turns', referenceImageId: 'start.png',
  startSec: 0, endSec: 4, takes: [],
};
const project = { id: 'p1', scenes: [scene] };
const model = { id: 'example-ltx', runtime: 'ltx25' };
const ltxSettings = { settings: { backend: 'local', modelId: model.id, generationMode: 'ltxReferences' }, models: [model] };

const request = (input = {}) => buildSceneClipRequest({ scene, project, videoSettings: { settings: {} }, ...input });

describe('buildSceneClipRequest', () => {
  it('surfaces shared prerequisite refusals and uses the authored prompt when the card is empty', () => {
    expect(request({ scene: { ...scene, referenceImageId: null } }).error).toMatch(/reference frame/i);
    expect(request({ scene: { ...scene, prompt: '' } }).error).toMatch(/shot prompt/i);
    const { body } = request({ card: { prompt: '' } });
    expect(body.prompt).toBe('A rider turns');
    expect(JSON.parse(body.musicVideo)).not.toHaveProperty('promptAsTyped');
  });

  it('uses the readiness of the one-take override when provided', () => {
    const { error } = request({
      target: { backend: 'runway' },
      videoSettings: { settings: { backend: 'grok' }, blockedReasonFor: (settings) => `Blocked ${settings.backend}` },
    });
    expect(error).toBe('Blocked runway');
  });

  it('blocks an LTX clip while its cast guides are loading or failed', () => {
    const shot = { ...scene, characterVariant: { ingredientId: 'cat-lead' } };
    const linked = { ...project, scenes: [shot], concept: { subjects: [{ ingredientId: 'cat-lead', kind: 'character', name: 'Rider' }] } };
    const input = { scene: shot, project: linked, videoSettings: ltxSettings };
    expect(request({ ...input, castMedia: {} }).error).toMatch(/still loading/);
    expect(request({ ...input, castMedia: { 'cat-lead': null } }).error).toMatch(/could not be loaded for Rider/);
  });

  it('surfaces the shared refusal when the pinned frame count cannot cover the shot', () => {
    const shot = { ...scene, clipLengthSec: 8 };
    const { error } = request({
      scene: shot, project: { ...project, scenes: [shot] }, videoSettings: ltxSettings,
      card: { ltxReferences: true, expectedClipReferenceFiles: ['lead.png'] }, target: { numFrames: 121 },
    });
    expect(error).toMatch(/too long for one LTX reference clip/);
  });

  it.each([['peers', 'peer'], ['both', null], ['local', 'grok']])('keeps the %s lane label and prepared body format', (mode, label) => {
    const built = request({ videoSettings: { settings: { backend: 'grok', renderPool: { mode } } }, tier: 'final', revisionId: 'rev-1' });
    expect(built.label).toBe(label);
    expect(built.body).toMatchObject({ tier: 'final', backend: 'grok' });
    expect(JSON.parse(built.body.musicVideo)).toMatchObject({ tier: 'final', revisionId: 'rev-1' });
  });
});
