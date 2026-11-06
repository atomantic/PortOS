import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/apiRunwayCatalog.js', async (importOriginal) => ({ ...await importOriginal(), loadRunwayCatalog: vi.fn().mockResolvedValue(undefined) }));
import { render, screen, within } from '@testing-library/react';
import SceneRenderTarget, { lastRenderTarget, rememberRenderTarget, renderTargetOptions, renderTargetOverrides } from './SceneRenderTarget.jsx';
import { FAL_IMAGE_VIDEO_MODELS, falVideoResolutions } from '../../lib/falVideoModels.js';
import { RUNWAY_VIDEO_MODELS } from '../../lib/runwayVideoModels.js';

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

  it('automatically covers the final action interval while preserving a deliberate shorter pick', () => {
    const scene = { sceneId: 's1', startSec: 0, endSec: 8.01 };
    const context = { models, scene, performance: false };
    expect(renderTargetOverrides('local', {}, {}, context).numFrames).toBe(217);
    expect(renderTargetOverrides('local', {}, { numFrames: 193 }, context).numFrames).toBe(193);
    render(<SceneRenderTarget id="pick" value="local" performance={false} saved={{}} models={models} scene={scene}
      minFrames={121} onChange={() => {}} onOptionsChange={() => {}} />);
    expect(screen.getByLabelText('Clip length').value).toBe('217');
    expect(screen.getByRole('option', { name: /covers shot/ }).value).toBe('217');
  });

  it.each([
    { startSec: 0, endSec: 4 },
    { startSec: null, endSec: null },
  ])('uses the cold-open duration instead of song timing $startSec–$endSec', (songTiming) => {
    const scene = { sceneId: 's1', ...songTiming, preMusic: { durationSec: 8 } };
    expect(renderTargetOverrides('local', {}, {}, { models, scene, performance: false }).numFrames).toBe(193);
    render(<SceneRenderTarget id="pick" value="local" performance={false} saved={{}} models={models} scene={scene}
      minFrames={121} onChange={() => {}} onOptionsChange={() => {}} />);
    expect(screen.getByLabelText('Clip length').value).toBe('193');
  });
});

describe('hosted clip length labels', () => {
  it.each([
    ['grok', '6s'],
    [`fal:${FAL_IMAGE_VIDEO_MODELS.find((model) => model.duration)?.id}`, null],
    [`runway:${RUNWAY_VIDEO_MODELS[0].id}`, null],
  ])('shows %s lengths in seconds', (value, expected) => {
    render(<SceneRenderTarget id="pick" value={value} performance={false} saved={{}} models={models}
      scene={{ sceneId: 's1', startSec: 0, endSec: 4 }} onChange={() => {}} onOptionsChange={() => {}} />);
    const label = within(screen.getByLabelText('Clip length')).getByRole('option', { name: /covers shot/ }).textContent;
    expect(parseFloat(label)).toBeGreaterThanOrEqual(4);
    if (expected) expect(label).toContain(expected);
  });

  it('keeps a hosted cold-open default aligned with the priced song-timing request', () => {
    render(<SceneRenderTarget id="pick" value="fal:fal-ai/minimax/hailuo-02/standard/image-to-video" performance={false}
      saved={{}} models={models} scene={{ sceneId: 's1', startSec: 0, endSec: 10, preMusic: { durationSec: 3 } }}
      onChange={() => {}} onOptionsChange={() => {}} />);
    expect(within(screen.getByLabelText('Clip length')).getByRole('option', { name: /covers shot/ }).textContent).toBe('10s · covers shot');
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

// Uniquely catches a music-driven shot losing its per-shot choice of the models that hear the song.
describe('a music-driven shot on fal', () => {
  it('offers each music-driven model with its rate, and the pick becomes that take\'s music model', () => {
    const scene = { sceneId: 's1', shotMode: 'performance', performanceStyle: 'music', startSec: 0, endSec: 2 };
    const fal = renderTargetOptions({ performance: true, saved: { backend: 'fal' }, scene }).filter((option) => option.value.startsWith('fal'));
    expect(fal[0].label).toBe('fal.ai · MiniMax H3 Max (reference)');
    expect(fal.map((option) => option.value)).toEqual(expect.arrayContaining([
      'fal:minimax/h3-max/reference-to-video', 'fal:bytedance/seedance-2.5/reference-to-video',
    ]));
    expect(fal.find((option) => option.value === 'fal:minimax/h3-max/reference-to-video').label).toMatch(/\+ song audio · \$0\.08\/s at 768P/);
    // A lip-synced shot keeps its one lip-sync choice.
    expect(renderTargetOptions({ performance: true, saved: {}, scene: { ...scene, performanceStyle: null } })
      .filter((option) => option.value.startsWith('fal'))).toHaveLength(1);
    expect(renderTargetOverrides('fal:bytedance/seedance-2.5/reference-to-video', { falMusicResolution: '768P' }, {}, { performance: true, scene }))
      .toEqual({ backend: 'fal', falMusicModelId: 'bytedance/seedance-2.5/reference-to-video', falMusicResolution: null });
  });
});

describe('the Gemini Omni pick', () => {
  const gemini = (performance) => renderTargetOptions({ performance, saved: {} }).find((option) => option.value === 'gemini');

  it('renders cutaways only and asks the server for the Gemini backend', () => {
    expect(gemini(false).disabled).toBe(false);
    expect(gemini(true).disabled).toBe(true);
    expect(renderTargetOverrides('gemini', {})).toEqual({ backend: 'gemini' });
  });
});
