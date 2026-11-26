import { describe, expect, it, vi } from 'vitest';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { HOSTED_VIDEO_SUBMISSIONS } from './hostedSubmission.js';

vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveGalleryImage: vi.fn((name) => name === 'missing.png' ? null : `/gallery/${name}`),
}));

const settings = {
  videoGen: {
    google: { apiKey: 'example-google-key', projectId: 'example-project' },
    higgsfield: { apiKey: 'example-higgsfield-key' },
  },
};

function stagingContext(overrides = {}) {
  return {
    body: { prompt: 'A test shot' },
    settings,
    uploads: {},
    sourceImagePath: null,
    cleanupStaged: vi.fn(async () => {}),
    stageUploadDurable: vi.fn(async () => '/staged/end.png'),
    ...overrides,
  };
}

describe.each([
  { backend: 'google', modelId: 'veo-3.1-generate-001', audioError: /takes no source audio/ },
  { backend: 'higgsfield', modelId: 'bytedance/seedance-2.5', audioError: /Song audio control/ },
])('$backend hosted submission', ({ backend, modelId, audioError }) => {
  const adapter = HOSTED_VIDEO_SUBMISSIONS[backend];

  it('cleans up staged inputs when a source audio upload is refused', async () => {
    const ctx = stagingContext({ uploads: { audioFile: { path: '/upload/audio.wav' } } });
    await expect(adapter.stageInputs(ctx)).rejects.toMatchObject({
      status: 400, code: 'VALIDATION_ERROR', message: expect.stringMatching(audioError),
    });
    expect(ctx.cleanupStaged).toHaveBeenCalledOnce();
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
  });

  it('cleans up staged inputs if a gallery reference is missing', async () => {
    const ctx = stagingContext({
      body: { prompt: 'A test shot', [`${backend}ModelId`]: modelId, referenceImageFiles: ['present.png', 'missing.png'] },
    });
    await expect(adapter.stageInputs(ctx)).rejects.toMatchObject({
      status: 400, code: 'VALIDATION_ERROR', message: expect.stringContaining('missing.png'),
    });
    expect(resolveGalleryImage).toHaveBeenCalledWith('present.png');
    expect(ctx.cleanupStaged).toHaveBeenCalledOnce();
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
  });

  it.each(['upload', 'gallery'])('preserves end frame ownership for a %s input through queue params', async (kind) => {
    const isUpload = kind === 'upload';
    const lastImage = { path: '/upload/end.png' };
    const lastImagePath = isUpload ? '/staged/end.png' : '/gallery/end.png';
    const ownership = isUpload ? { uploadedTempPaths: [lastImagePath] } : {};
    const ctx = stagingContext({
      body: {
        prompt: 'A test shot',
        [`${backend}ModelId`]: modelId,
        [`${backend}Duration`]: 8,
        [`${backend}Resolution`]: '1080p',
        [`${backend}GenerateAudio`]: true,
        [`${backend}Seed`]: 0,
        width: 1920,
        height: 1080,
        ...(isUpload ? {} : { lastImageFile: 'end.png' }),
      },
      sourceImagePath: '/gallery/start.png',
      uploads: isUpload ? { lastImage } : {},
    });

    const preparation = adapter.prepare(ctx.settings);
    expect(preparation).toStrictEqual({ usable: true, extras: {} });
    const staged = await adapter.stageInputs(ctx);
    expect(staged).toStrictEqual({ lastImagePath, ...ownership });
    if (isUpload) expect(ctx.stageUploadDurable).toHaveBeenCalledExactlyOnceWith(lastImage, 'last');
    else expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
    expect(ctx.cleanupStaged).not.toHaveBeenCalled();

    expect(adapter.buildParams(ctx.body, { ...preparation.extras, ...staged, settings: ctx.settings })).toStrictEqual({
      modelId, lastImagePath, ...ownership, aspectRatio: undefined, width: 1920, height: 1080,
      duration: 8, resolution: '1080p', generateAudio: true, seed: 0,
    });
  });
});

it('preserves the Higgsfield catalog error code and cleans up rejected inputs', async () => {
  const ctx = stagingContext({ body: { prompt: 'A test shot', lastImageFile: 'end.png' } });

  await expect(HOSTED_VIDEO_SUBMISSIONS.higgsfield.stageInputs(ctx))
    .rejects.toMatchObject({ status: 400, code: 'HIGGSFIELD_VIDEO_INPUT_INVALID' });
  expect(ctx.cleanupStaged).toHaveBeenCalledOnce();
});
