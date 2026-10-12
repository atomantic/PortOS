import { beforeEach, describe, expect, it } from 'vitest';
import { FAL_IMAGE_VIDEO_MODELS, falVideoResolutions } from '../../lib/falVideoModels.js';
import { lastRenderTarget, rememberRenderTarget, renderTargetOverrides } from './SceneRenderTarget.jsx';

const models = [{ id: 'ltx25_example', runtime: 'ltx25' }, { id: 'fast_example', runtime: 'fastmetal' }];
beforeEach(() => localStorage.clear());

describe('a remembered Render on pick on a shot that cannot use it', () => {
  // Uniquely catches a remembered non-lip-sync local model reaching a lip-synced render, or a fal size the model lacks.
  it('renders a lip-synced shot on the default lip-sync model, and carries a fal size only to a model that has it', () => {
    rememberRenderTarget('local', { modelId: 'fast_example' });
    const { pick, options } = lastRenderTarget({ performance: true, saved: {} });
    expect(renderTargetOverrides(pick, {}, options, { models, performance: true })).toMatchObject({ backend: 'local', modelId: 'ltx25_example' });
    expect(renderTargetOverrides(pick, {}, options, { models, performance: false })).toMatchObject({ modelId: 'fast_example' });

    const sized = FAL_IMAGE_VIDEO_MODELS.find((model) => falVideoResolutions(model).length > 1);
    const size = falVideoResolutions(sized).at(-1);
    rememberRenderTarget(`fal:${sized.id}`, { falResolution: size });
    expect(lastRenderTarget({ performance: false, saved: {} })).toEqual({ pick: `fal:${sized.id}`, options: { falResolution: size } });
    rememberRenderTarget(`fal:${sized.id}`, { falResolution: '9999p' });
    expect(lastRenderTarget({ performance: false, saved: {} }).options).toEqual({});
  });
});
