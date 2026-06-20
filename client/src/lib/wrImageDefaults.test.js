import { describe, it, expect } from 'vitest';
import { buildSceneRenderPayload, WR_IMAGE_DEFAULTS } from './wrImageDefaults';

describe('buildSceneRenderPayload', () => {
  it('folds prompt + imageCfg into the generate payload, dropping empty steps/seed', () => {
    const payload = buildSceneRenderPayload({ prompt: 'a quiet alley', negativePrompt: 'blurry' });
    expect(payload).toEqual({
      prompt: 'a quiet alley',
      negativePrompt: 'blurry',
      modelId: WR_IMAGE_DEFAULTS.modelId,
      mode: WR_IMAGE_DEFAULTS.mode,
      width: WR_IMAGE_DEFAULTS.width,
      height: WR_IMAGE_DEFAULTS.height,
    });
    expect(payload).not.toHaveProperty('writersRoom');
  });

  it('parses string steps/seed to numbers', () => {
    const payload = buildSceneRenderPayload({
      prompt: 'p',
      imageCfg: { ...WR_IMAGE_DEFAULTS, steps: '20', seed: '7' },
    });
    expect(payload.steps).toBe(20);
    expect(payload.seed).toBe(7);
  });

  it('includes the writersRoom destination tag when provided', () => {
    const writersRoom = { workId: 'w1', analysisId: 'script', sceneId: 's1' };
    const payload = buildSceneRenderPayload({ prompt: 'p', writersRoom });
    expect(payload.writersRoom).toEqual(writersRoom);
  });

  it('omits the writersRoom tag when null (synchronous lane / missing ids)', () => {
    const payload = buildSceneRenderPayload({ prompt: 'p', writersRoom: null });
    expect(payload).not.toHaveProperty('writersRoom');
  });
});
