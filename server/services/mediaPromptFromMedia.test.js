import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./providers.js', () => ({
  getProviderById: vi.fn(),
}));

vi.mock('../lib/promptRunner.js', () => ({
  resolveEffectiveModel: vi.fn((_provider, model) => model || 'default-model'),
  runPromptThroughProvider: vi.fn(),
  assertVisionRunUsedImages: vi.fn((_result, provider) => provider),
}));

vi.mock('./visionCli.js', () => ({
  describeImagesFromPaths: vi.fn(),
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveGalleryImage: vi.fn(),
    PATHS: {
      ...actual.PATHS,
      images: '/mock/images',
      videos: '/mock/videos',
      uploads: '/mock/uploads',
      videoThumbnails: '/mock/video-thumbnails',
    },
  };
});

vi.mock('../lib/ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    extractEvaluationFrames: vi.fn(),
    safeUnder: vi.fn((root, name) => (name && !String(name).includes('..') ? `${root}/${name}` : null)),
  };
});

vi.mock('./videoGen/history.js', () => ({
  loadHistory: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

const providers = await import('./providers.js');
const promptRunner = await import('../lib/promptRunner.js');
const visionCli = await import('./visionCli.js');
const fileUtils = await import('../lib/fileUtils.js');
const ffmpeg = await import('../lib/ffmpeg.js');
const history = await import('./videoGen/history.js');
const {
  buildPromptFromMediaPrompt,
  parsePromptFromMediaJson,
  promptFromMedia,
} = await import('./mediaPromptFromMedia.js');

const API_PROVIDER = {
  id: 'openai',
  name: 'OpenAI',
  type: 'api',
  enabled: true,
  defaultModel: 'gpt-4o',
};

const CLI_PROVIDER = {
  id: 'codex',
  name: 'Codex',
  type: 'cli',
  command: 'codex',
  enabled: true,
  defaultModel: 'gpt-5',
};

const JSON_BOTH = JSON.stringify({
  imagePrompt: 'a painted wizard in moonlight',
  imageNegativePrompt: 'blurry',
  videoPrompt: 'the wizard turns as the camera dollies in',
  videoNegativePrompt: 'jitter',
  rationale: 'Moonlit painted look with a slow push-in.',
});

beforeEach(() => {
  vi.clearAllMocks();
  fileUtils.resolveGalleryImage.mockReturnValue('/mock/images/still.png');
  ffmpeg.extractEvaluationFrames.mockResolvedValue(['pfm-vid-f1.jpg', 'pfm-vid-f2.jpg']);
  history.loadHistory.mockResolvedValue([
    { id: '11111111-1111-4111-8111-111111111111', filename: 'clip.mp4' },
  ]);
});

describe('buildPromptFromMediaPrompt', () => {
  it('asks only for image fields when that is the target', () => {
    const prompt = buildPromptFromMediaPrompt({ targets: ['image'], mediaKind: 'image', frameCount: 1 });
    expect(prompt).toContain('imagePrompt');
    expect(prompt).not.toContain('videoPrompt');
    expect(prompt).toContain('still image');
    expect(prompt).toContain('No motion language');
  });

  it('asks for motion language and names the frame count for a video', () => {
    const prompt = buildPromptFromMediaPrompt({ targets: ['video'], mediaKind: 'video', frameCount: 5 });
    expect(prompt).toContain('videoPrompt');
    expect(prompt).not.toContain('imagePrompt');
    expect(prompt).toContain('5 frames');
    expect(prompt).toContain('chronological');
  });
});

describe('parsePromptFromMediaJson', () => {
  it('extracts both prompts and skips a placeholder echo', () => {
    const raw = `here you go\n${JSON_BOTH}`;
    const parsed = parsePromptFromMediaJson(raw, ['image', 'video']);
    expect(parsed.imagePrompt).toBe('a painted wizard in moonlight');
    expect(parsed.videoPrompt).toContain('dollies');
    expect(parsed.rationale).toMatch(/Moonlit/);
  });

  it('rejects a schema-placeholder image prompt', () => {
    expect(() => parsePromptFromMediaJson(JSON.stringify({
      imagePrompt: '<full ready-to-render image-generation prompt>',
    }), ['image'])).toThrow(/Invalid JSON|empty/i);
  });
});

describe('promptFromMedia', () => {
  it('sends a gallery still through the API vision runner with effort', async () => {
    providers.getProviderById.mockResolvedValue(API_PROVIDER);
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: JSON_BOTH,
      model: 'gpt-4o',
      provider: API_PROVIDER,
    });

    const result = await promptFromMedia({
      sourceKind: 'image',
      filename: 'still.png',
      targets: ['image', 'video'],
      providerId: 'openai',
      model: 'gpt-4o',
      effort: 'high',
    });

    expect(fileUtils.resolveGalleryImage).toHaveBeenCalledWith('still.png');
    expect(promptRunner.runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: API_PROVIDER,
      model: 'gpt-4o',
      effort: 'high',
      screenshots: ['/mock/images/still.png'],
      source: 'media-prompt-from-media',
    }));
    expect(result.imagePrompt).toContain('wizard');
    expect(result.videoPrompt).toContain('dollies');
    expect(result.mediaKind).toBe('image');
    expect(result.providerId).toBe('openai');
  });

  it('samples gallery-video frames and uses the CLI vision path for Codex', async () => {
    providers.getProviderById.mockResolvedValue(CLI_PROVIDER);
    visionCli.describeImagesFromPaths.mockResolvedValue({ text: JSON_BOTH });

    const result = await promptFromMedia({
      sourceKind: 'video',
      videoId: '11111111-1111-4111-8111-111111111111',
      targets: ['video'],
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'medium',
    });

    expect(ffmpeg.extractEvaluationFrames).toHaveBeenCalled();
    expect(visionCli.describeImagesFromPaths).toHaveBeenCalledWith(expect.objectContaining({
      provider: CLI_PROVIDER,
      model: 'gpt-5',
      effort: 'medium',
      imagePaths: [
        join('/mock/video-thumbnails', 'pfm-vid-f1.jpg'),
        join('/mock/video-thumbnails', 'pfm-vid-f2.jpg'),
      ],
    }));
    expect(promptRunner.runPromptThroughProvider).not.toHaveBeenCalled();
    expect(result.videoPrompt).toContain('dollies');
    expect(result.imagePrompt).toBeUndefined();
    expect(result.mediaKind).toBe('video');
    expect(result.frameCount).toBe(2);
  });

  it('resolves a gallery video by FILENAME when no videoId is given (mood-board item — #4188)', async () => {
    providers.getProviderById.mockResolvedValue(CLI_PROVIDER);
    visionCli.describeImagesFromPaths.mockResolvedValue({ text: JSON_BOTH });

    const result = await promptFromMedia({
      sourceKind: 'video',
      filename: 'clip.webm',
      targets: ['video'],
      providerId: 'codex',
    });

    expect(history.loadHistory).not.toHaveBeenCalled();
    expect(ffmpeg.extractEvaluationFrames).toHaveBeenCalledWith(
      '/mock/videos/clip.webm',
      expect.stringMatching(/^pfm-vf-/),
      expect.any(Number),
    );
    expect(result.mediaKind).toBe('video');
    expect(result.videoPrompt).toContain('dollies');
  });

  it('rejects an extension-less video filename (a bare id is not an on-disk clip name)', async () => {
    providers.getProviderById.mockResolvedValue(CLI_PROVIDER);
    await expect(promptFromMedia({
      sourceKind: 'video',
      filename: 'job-123',
      targets: ['video'],
      providerId: 'codex',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(ffmpeg.extractEvaluationFrames).not.toHaveBeenCalled();
  });

  it('rejects a text-only CLI that cannot see images', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'opencode',
      name: 'OpenCode',
      type: 'cli',
      command: 'opencode',
      enabled: true,
    });

    await expect(promptFromMedia({
      sourceKind: 'image',
      filename: 'still.png',
      targets: ['image'],
      providerId: 'opencode',
    })).rejects.toMatchObject({ code: 'NOT_VISION_CAPABLE', status: 400 });
  });

  it('404s a missing provider instead of silently swapping', async () => {
    providers.getProviderById.mockResolvedValue(null);
    await expect(promptFromMedia({
      sourceKind: 'image',
      filename: 'still.png',
      targets: ['image'],
      providerId: 'missing',
    })).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND', status: 404 });
  });
});
