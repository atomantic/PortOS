import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import SceneRenderTarget, { lastRenderTarget, rememberRenderTarget, renderTargetOverrides } from './SceneRenderTarget.jsx';
import { FAL_IMAGE_VIDEO_MODELS, falVideoResolutions } from '../../lib/falVideoModels.js';

const models = [
  { id: 'ltx25_example', name: 'LTX-2.5 Example', runtime: 'ltx25', supportedModes: ['text', 'image', 'fflf', 'a2v'] },
  { id: 'ref2va_example', name: 'Ref2VA Example', runtime: 'minimax_h3_ref2va', supportedModes: ['a2v'] },
  { id: 'wan_example', name: 'Wan Example', runtime: 'wan22', supportedModes: ['text', 'image'] },
];
const modelNames = (performance) => {
  const { unmount } = render(<SceneRenderTarget id="pick" value="local" performance={performance} saved={{}} models={models}
    scene={{ sceneId: 's1', startSec: 0, endSec: 4 }} onChange={() => {}} onOptionsChange={() => {}} />);
  const names = within(screen.getByLabelText('Model')).getAllByRole('option').map((option) => option.textContent);
  unmount();
  return names;
};

// Uniquely catches the shot card offering a model its kind of shot cannot
// render: an audio-only model for a cutaway, an image-only one for lip-sync.
describe('the shot card local model picker', () => {
  it('offers image models for a cutaway and audio-to-video models for a performance shot', () => {
    expect(modelNames(false)).toEqual(['LTX-2.5 Example', 'Wan Example']);
    expect(modelNames(true)).toEqual(['LTX-2.5 Example', 'Ref2VA Example']);
  });
});

describe('a remembered Render on pick', () => {
  beforeEach(() => localStorage.clear());

  // Uniquely catches a remembered non-lip-sync local model reaching a lip-synced render, or a fal size the model lacks.
  it('renders a lip-synced shot on the default lip-sync model, and carries a fal size only to a model that has it', () => {
    rememberRenderTarget('local', { modelId: 'wan_example' });
    const { pick, options } = lastRenderTarget({ performance: true, saved: {} });
    expect(renderTargetOverrides(pick, {}, options, { models, performance: true })).toMatchObject({ backend: 'local', modelId: 'ltx25_example' });
    expect(renderTargetOverrides(pick, {}, options, { models, performance: false })).toMatchObject({ modelId: 'wan_example' });

    const sized = FAL_IMAGE_VIDEO_MODELS.find((model) => falVideoResolutions(model).length > 1);
    const size = falVideoResolutions(sized).at(-1);
    rememberRenderTarget(`fal:${sized.id}`, { falResolution: size });
    expect(lastRenderTarget({ performance: false, saved: {} })).toEqual({ pick: `fal:${sized.id}`, options: { falResolution: size } });
    rememberRenderTarget(`fal:${sized.id}`, { falResolution: '9999p' });
    expect(lastRenderTarget({ performance: false, saved: {} }).options).toEqual({});
  });
});
