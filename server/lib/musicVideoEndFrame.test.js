import { describe, expect, it } from 'vitest';
import { sceneEndFramePlan, sceneEndFrameRequestFields } from './musicVideoEndFrame.js';

// The board's note and the production dispatcher both read this plan, so each
// lane that ignores an end frame must say so, and only an end-image fal model sends it.
describe('sceneEndFramePlan (#11173)', () => {
  const scene = { sceneId: 's1', endImageId: 'end.png' };
  const kling = { backend: 'fal', falModelId: 'fal-ai/kling-video/v3/pro/image-to-video' };

  it.each([
    ['a performance shot', { ...scene, shotMode: 'performance' }, kling],
    ['a song-driven clip', scene, { ...kling, mode: 'a2v' }],
    ['a non-fal renderer', scene, { backend: 'local' }],
    ['a fal model with no end image', scene, { backend: 'fal', falModelId: 'fal-ai/veo3.1/fast/image-to-video' }],
  ])('ignores the end frame for %s and says why', (_label, s, options) => {
    const plan = sceneEndFramePlan(s, options);
    expect(plan).toMatchObject({ endImageId: 'end.png', used: false });
    expect(plan.reason).toEqual(expect.any(String));
    expect(sceneEndFrameRequestFields(s, options)).toEqual({});
  });

  it('sends it to an end-image fal model, including the default when none is named', () => {
    expect(sceneEndFrameRequestFields(scene, kling)).toEqual({ lastImageFile: 'end.png' });
    expect(sceneEndFramePlan(scene, { backend: 'fal' })).toEqual({ endImageId: 'end.png', used: true, reason: null });
  });

  it('reports nothing for a scene without an end frame', () => {
    expect(sceneEndFramePlan({ sceneId: 's1', endImageId: '  ' }, kling)).toEqual({ endImageId: null, used: false, reason: null });
  });
});
