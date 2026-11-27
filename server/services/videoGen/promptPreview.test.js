import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FAL_STORYBOARD_GUIDANCE_MODEL } from '../../lib/storyboardGuidance.js';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { getSettings } from '../settings.js';
import { falVideoSentPrompt } from './fal.js';
import { grokVideoSentPrompt } from './grok.js';
import { previewVideoPrompt } from './promptPreview.js';

vi.mock('../settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()), resolveGalleryImage: vi.fn(),
}));
vi.mock('../musicVideo/renderPool.js', () => ({ applyProjectRenderPool: async (body) => body }));

const prompt = 'A figure walks through the hall';
const negativePrompt = 'Blurred faces';
const style = { id: 'style', label: 'Style', text: 'Soft lighting' };
const musicVideo = { projectId: 'project-1', sceneId: 'scene-1', compose: true, promptAsTyped: true };
const guidance = { guidanceImageFile: 'panel.png', referenceImageFiles: ['cast.png', 'set.png'] };

beforeEach(() => {
  vi.resetAllMocks();
  getSettings.mockResolvedValue({
    imageGen: { grok: { enabled: true, aspectRatio: '16:9' } },
    videoGen: { fal: { apiKey: 'example-key' } },
  });
  resolveGalleryImage.mockReturnValue(null);
});

describe('previewVideoPrompt', () => {
  it('shows the as-written remote handoff even when the requested local provider is disabled', async () => {
    getSettings.mockResolvedValueOnce({});
    expect(await previewVideoPrompt({
      backend: 'grok', mediaProviderPeerId: 'example-peer', prompt: `  ${prompt}  `, negativePrompt,
      promptAdditions: [style, { id: 'empty', label: 'Empty', text: '  ' }],
    })).toEqual({ backend: 'remote', remote: true, sentPrompt: `  ${prompt}  `, sentNegativePrompt: negativePrompt, promptAdditions: [style] });
    expect(resolveGalleryImage).not.toHaveBeenCalled();
  });

  it('gives held Grok uploads the same roles as staged render inputs', async () => {
    const result = await previewVideoPrompt({
      backend: 'grok', prompt, negativePrompt, promptAdditions: [style], grokDuration: 6, width: 720, height: 1280,
      previewUploads: ['sourceImage', 'referenceImage1'], referenceLabel1: 'the figure - profile',
    });
    const { record } = grokVideoSentPrompt({
      prompt, negativePrompt, promptAdditions: [style], duration: 6, aspectRatio: '16:9', width: 720, height: 1280,
      sourceImagePath: '/example/staged-first.png', castReferences: [{ path: '/example/staged-ref.png', label: 'the figure - profile' }],
    });
    expect(result).toEqual({ backend: 'grok', ...record });
    expect(result.sentPrompt).toContain('reference_to_video');
    expect(resolveGalleryImage).not.toHaveBeenCalled();
  });

  it('previews missing Grok gallery assets as storyboard guidance with render-equivalent roles', async () => {
    const result = await previewVideoPrompt({ backend: 'grok', prompt, ...guidance });
    const { record } = grokVideoSentPrompt({
      prompt, aspectRatio: '16:9', guidanceImagePath: '/example/panel.png', referenceImagePaths: ['/example/cast.png', '/example/set.png'],
    });
    expect(result).toEqual({ backend: 'grok', ...record });
    expect(result.promptAdditions).toContainEqual(expect.objectContaining({ id: 'storyboard-guidance' }));
    expect(result.sentPrompt).toContain('image_edit');
  });

  it('uses the default fal guidance model and passes the panel and reference count to the render builder', async () => {
    const result = await previewVideoPrompt({ backend: 'fal', prompt, negativePrompt, ...guidance, falDuration: 5, promptAdditions: [style] });
    const { record } = falVideoSentPrompt({
      modelId: FAL_STORYBOARD_GUIDANCE_MODEL, prompt, negativePrompt, guidanceReferences: 2, seconds: 5, promptAdditions: [style],
    });
    expect(result).toEqual({ backend: 'fal', ...record });
    expect(result.promptAdditions).toContainEqual(expect.objectContaining({ id: 'storyboard-guidance' }));
  });

  it('refuses a storyboard guidance panel alongside a held start frame', async () => {
    await expect(previewVideoPrompt({ backend: 'grok', prompt, ...guidance, previewUploads: ['sourceImage'] }))
      .rejects.toMatchObject({ status: 400, code: 'STORYBOARD_GUIDANCE_INVALID' });
  });

  it('refuses an explicitly disabled Grok backend', async () => {
    getSettings.mockResolvedValueOnce({});
    await expect(previewVideoPrompt({ backend: 'grok', prompt }))
      .rejects.toMatchObject({ status: 400, code: 'GROK_IMAGEGEN_DISABLED' });
  });

  it('returns the shot-card fallback when the project default resolves to a backend other than Grok', async () => {
    await expect(previewVideoPrompt({ prompt, musicVideo })).resolves.toEqual({ backend: 'local', shotPreviewUnavailable: true });
  });

  it('refuses to preview a typed Grok shot without a resolvable source', async () => {
    await expect(previewVideoPrompt({ backend: 'grok', prompt, musicVideo, sourceImageFile: 'missing.png' }))
      .rejects.toMatchObject({ status: 400, code: 'MUSIC_VIDEO_SOURCE_REQUIRED' });
  });
});
