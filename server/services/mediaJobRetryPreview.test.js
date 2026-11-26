import { expect, it, vi } from 'vitest';
import { previewRetryModelInput } from './mediaJobRetryPreview.js';
import { googleVideoSentPrompt } from './videoGen/google.js';
import { higgsfieldVideoSentPrompt } from './videoGen/higgsfield.js';

vi.mock('./loras.js', async (importOriginal) => ({
  ...await importOriginal(),
  readTriggerWordsByFilename: vi.fn(async () => ({ 'example.safetensors': 'example trigger' })),
}));

it.each(['image', 'video'])('refuses editable retry previews for remote %s jobs', async (kind) => {
  await expect(previewRetryModelInput(kind, {
    prompt: 'A local edit', remoteMedia: { peerId: 'example-peer' },
  })).rejects.toMatchObject({ status: 400, code: 'JOB_RETRY_PREVIEW_UNSUPPORTED' });
});

it.each([
  { mode: 'google', modelId: 'veo-3.1-generate-001', builder: googleVideoSentPrompt },
  { mode: 'higgsfield', modelId: 'bytedance/seedance-2.5', builder: higgsfieldVideoSentPrompt, sourceImagePath: '/gallery/start.png' },
])('shows the $mode retry prompt and reference image names from prepared inputs', async ({ mode, modelId, builder, sourceImagePath }) => {
  const style = { id: 'style-preset', label: 'Style preset', text: 'film grain' };
  const params = {
    mode, modelId, sourceImagePath, prompt: 'A fox runs through film grain', negativePrompt: 'motion blur',
    duration: 8, frameAspect: '16:9', generateAudio: true, promptAdditions: [style],
    referenceImagePaths: ['/gallery/fox.png', '/gallery/forest.png'],
  };
  const { record } = builder({
    modelId, prompt: params.prompt, negativePrompt: params.negativePrompt, seconds: 8, aspectRatio: '16:9',
    generateAudio: true, promptAdditions: [style], hasImage: !!sourceImagePath, referenceCount: 2,
  });

  expect(await previewRetryModelInput('video', params)).toEqual({
    ...record,
    referenceImages: [
      ...(sourceImagePath ? [{ filename: 'start.png', status: 'included', source: 'Start frame' }] : []),
      { filename: 'fox.png', status: 'included', source: 'Reference image' },
      { filename: 'forest.png', status: 'included', source: 'Reference image' },
    ],
  });
});

it('shows retry reference basenames grouped by role and omits absent inputs', async () => {
  expect(await previewRetryModelInput('video', {
    mode: 'gemini', prompt: 'A fox runs', lastImagePath: '/gallery/end.png',
    castReferences: [{ path: '/gallery/cast.png' }, { label: 'Without an image' }],
    sourceVideoPath: '/staged/source.mp4', audioFilePath: '/staged/song.wav',
  })).toMatchObject({
    referenceImages: [
      { filename: 'end.png', status: 'included', source: 'End frame' },
      { filename: 'cast.png', status: 'included', source: 'Cast reference' },
      { filename: 'source.mp4', status: 'included', source: 'Reference video' },
      { filename: 'song.wav', status: 'included', source: 'Source audio' },
    ],
  });
});

it('shows each local chunk with LoRA triggers and falls back to the main prompt for empty or missing beats', async () => {
  const preview = await previewRetryModelInput('video', {
    mode: 'image', prompt: 'A fox waits', negativePrompt: 'blur',
    chunks: 4, chunkPrompts: ['A fox runs', ' ', 'A fox jumps'], loras: [{ filename: 'example.safetensors' }],
  });
  expect(preview).toMatchObject({
    sentPrompt: 'A fox waits, example trigger',
    sentNegativePrompt: 'blur',
    segmentPrompts: [
      'A fox runs, example trigger',
      'A fox waits, example trigger',
      'A fox jumps, example trigger',
      'A fox waits, example trigger',
    ],
  });
  expect(preview).not.toHaveProperty('referenceImages');
});
