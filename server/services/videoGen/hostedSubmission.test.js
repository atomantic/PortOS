import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { probeVideoDuration } from '../../lib/ffmpeg.js';
import { FAL_AUDIO_VIDEO_MODEL } from '../../lib/falVideoModels.js';
import { HOSTED_VIDEO_SUBMISSIONS, hostedVideoRetryValidator } from './hostedSubmission.js';
import { validateRunwayVideoInput } from './runwayVideoInputs.js';

vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveGalleryImage: vi.fn((name) => name === 'missing.png' ? null : `/gallery/${name}`),
}));

vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...await importOriginal(),
  probeVideoDuration: vi.fn(),
}));

vi.mock('./runwayVideoInputs.js', () => ({
  validateRunwayVideoInput: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(probeVideoDuration).mockReset();
  vi.mocked(validateRunwayVideoInput).mockReset();
});

const startFrame = '/gallery/start.png';
const endUpload = { path: '/upload/end.png' };
const audioUpload = { path: '/upload/audio.wav' };
const referenceFiles = (count) => Array.from({ length: count }, (_, i) => `reference-${i + 1}.png`);
const validationError = (message, code = 'VALIDATION_ERROR') => ({
  status: 400, code, message: expect.stringMatching(message),
});

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
    stageUploadDurable: vi.fn(async () => '/staged/end.png'),
    ...overrides,
  };
}

describe.each([
  { backend: 'google', modelId: 'veo-3.1-generate-001', audioError: /takes no source audio/ },
  { backend: 'higgsfield', modelId: 'bytedance/seedance-2.5', audioError: /Song audio control/ },
])('$backend hosted submission', ({ backend, modelId, audioError }) => {
  const adapter = HOSTED_VIDEO_SUBMISSIONS[backend];

  it('refuses unsupported source audio before staging', async () => {
    const ctx = stagingContext({ uploads: { audioFile: { path: '/upload/audio.wav' } } });
    await expect(adapter.stageInputs(ctx)).rejects.toMatchObject({
      status: 400, code: 'VALIDATION_ERROR', message: expect.stringMatching(audioError),
    });
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
  });

  it('refuses missing gallery references before staging', async () => {
    const ctx = stagingContext({
      body: { prompt: 'A test shot', [`${backend}ModelId`]: modelId, referenceImageFiles: ['present.png', 'missing.png'] },
    });
    await expect(adapter.stageInputs(ctx)).rejects.toMatchObject({
      status: 400, code: 'VALIDATION_ERROR', message: expect.stringContaining('missing.png'),
    });
    expect(resolveGalleryImage).toHaveBeenCalledWith('present.png');
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

    expect(adapter.buildParams(ctx.body, { ...preparation.extras, ...staged, settings: ctx.settings })).toStrictEqual({
      modelId, lastImagePath, ...ownership, aspectRatio: undefined, width: 1920, height: 1080,
      duration: 8, resolution: '1080p', generateAudio: true, seed: 0,
    });
  });
});

it('preserves the Higgsfield catalog error code for rejected inputs', async () => {
  const ctx = stagingContext({ body: { prompt: 'A test shot', lastImageFile: 'end.png' } });

  await expect(HOSTED_VIDEO_SUBMISSIONS.higgsfield.stageInputs(ctx))
    .rejects.toMatchObject({ status: 400, code: 'HIGGSFIELD_VIDEO_INPUT_INVALID' });
});

describe('fal hosted submission', () => {
  const { stageInputs } = HOSTED_VIDEO_SUBMISSIONS.fal;
  const referenceModel = 'bytedance/seedance-2.5/reference-to-video';

  it.each([
    ['a model without end-frame support', {}, /takes no end frame/],
    ['an uncatalogued model', { falModelId: 'unknown-model' }, /catalogued end-frame support/],
    ['a missing gallery end frame', { sourceImagePath: startFrame }, /end frame is missing/],
  ])('refuses %s without staging', async (_name, { sourceImagePath, falModelId }, message) => {
    const ctx = stagingContext({
      sourceImagePath,
      body: { falModelId, lastImageFile: 'missing.png' },
    });

    await expect(stageInputs(ctx)).rejects.toMatchObject(validationError(message));
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
  });

  it('uses a gallery end frame without transferring ownership', async () => {
    const ctx = stagingContext({ sourceImagePath: startFrame, body: { lastImageFile: 'end.png' } });

    await expect(stageInputs(ctx)).resolves.toStrictEqual({ lastImagePath: '/gallery/end.png' });
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
  });

  it('returns the uploaded end frame as a queue-owned path', async () => {
    const ctx = stagingContext({ sourceImagePath: startFrame, uploads: { lastImage: endUpload } });

    await expect(stageInputs(ctx)).resolves.toStrictEqual({
      lastImagePath: '/staged/end.png', uploadedTempPaths: ['/staged/end.png'],
    });
    expect(ctx.stageUploadDurable).toHaveBeenCalledExactlyOnceWith(endUpload, 'last');
  });

  it.each([
    ['no upload', { falSourceAudio: true }],
    ['source audio disabled', { uploads: { audioFile: audioUpload } }],
  ])('skips audio staging with %s', async (_name, overrides) => {
    const ctx = stagingContext(overrides);

    await expect(stageInputs(ctx)).resolves.toStrictEqual({});
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
    expect(probeVideoDuration).not.toHaveBeenCalled();
  });

  it('refuses source audio without a start frame before staging or probing', async () => {
    const ctx = stagingContext({ falSourceAudio: true, uploads: { audioFile: audioUpload } });

    await expect(stageInputs(ctx)).rejects.toMatchObject(validationError(/needs a reference frame/));
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
    expect(probeVideoDuration).not.toHaveBeenCalled();
  });

  describe('source audio duration', () => {
    const audioContext = () => stagingContext({
      body: { falModelId: FAL_AUDIO_VIDEO_MODEL },
      sourceImagePath: startFrame,
      falSourceAudio: true,
      uploads: { audioFile: audioUpload },
      stageUploadDurable: vi.fn(async () => '/staged/audio.wav'),
    });

    it.each([1, 30])('accepts the inclusive %s-second model boundary', async (duration) => {
      vi.mocked(probeVideoDuration).mockResolvedValue(duration);
      const ctx = audioContext();

      await expect(stageInputs(ctx)).resolves.toStrictEqual({
        audioFilePath: '/staged/audio.wav', uploadedTempPaths: ['/staged/audio.wav'],
      });
      expect(ctx.stageUploadDurable).toHaveBeenCalledExactlyOnceWith(audioUpload, 'audio');
      expect(probeVideoDuration).toHaveBeenCalledExactlyOnceWith('/staged/audio.wav');
    });

    it.each([0.99, 30.01])('refuses the out-of-window duration %s', async (duration) => {
      vi.mocked(probeVideoDuration).mockResolvedValue(duration);
      await expect(stageInputs(audioContext())).rejects.toMatchObject(validationError(/takes 1–30 s/, 'VIDEO_GEN_AUDIO_LENGTH'));
    });

    it.each(['missing duration', 'probe failure'])('refuses an unreadable audio clip on %s', async (reason) => {
      if (reason === 'probe failure') vi.mocked(probeVideoDuration).mockRejectedValue(new Error('Probe failed'));
      else vi.mocked(probeVideoDuration).mockResolvedValue(null);

      await expect(stageInputs(audioContext())).rejects
        .toMatchObject(validationError(/Could not read the voice clip/, 'VIDEO_GEN_AUDIO_DURATION_UNREADABLE'));
    });
  });

  it('preserves gallery reference order at the cap when the start frame uses a slot', async () => {
    const picks = referenceFiles(29).reverse();
    const ctx = stagingContext({
      body: { falModelId: referenceModel, prompt: 'A test shot', referenceImageFiles: picks },
      sourceImagePath: startFrame,
    });

    await expect(stageInputs(ctx)).resolves.toStrictEqual({ referenceImagePaths: picks.map((file) => `/gallery/${file}`) });
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
  });

  it.each([
    ['one more reference than the model can take with a start frame', referenceModel, referenceFiles(30), /at most 30 reference images/],
    ['a model without extra references', 'bytedance/seedance-2.5/image-to-video', ['present.png'], /takes no extra reference images/],
    ['a missing gallery reference', referenceModel, ['present.png', 'missing.png'], /missing.png.*could not be found/],
  ])('refuses %s before staging', async (_name, falModelId, referenceImageFiles, message) => {
    const ctx = stagingContext({
      body: { falModelId, prompt: 'A test shot', referenceImageFiles },
      sourceImagePath: startFrame,
      uploads: { lastImage: endUpload },
    });

    await expect(stageInputs(ctx)).rejects.toMatchObject(validationError(message));
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
  });

  it.each([{ guidanceImageFile: 'guide.png' }, { musicVideo: true }])('leaves gallery references to %j', async (override) => {
    const ctx = stagingContext({
      body: { ...override, falModelId: referenceModel, prompt: 'A test shot', referenceImageFiles: ['missing.png'] },
    });

    await expect(stageInputs(ctx)).resolves.toStrictEqual({});
    expect(resolveGalleryImage).not.toHaveBeenCalled();
  });
});

describe('Runway hosted submission', () => {
  const { stageInputs } = HOSTED_VIDEO_SUBMISSIONS.runway;
  const runwayVideo = { path: '/upload/source.mp4' };
  const runwayCharacterVideo = { path: '/upload/character.mp4' };

  it.each([
    { name: 'Aleph 2', runwayModelId: 'aleph2', mode: 'video-edit', sourceImagePath: null, characterUpload: {} },
    { name: 'Act-Two with a character image', runwayModelId: 'act_two', mode: 'character-performance', sourceImagePath: startFrame, characterUpload: {} },
    { name: 'Act-Two with a character video', runwayModelId: 'act_two', mode: 'character-performance', sourceImagePath: null, characterUpload: { runwayCharacterVideo } },
  ])('stages and validates $name inputs', async ({ runwayModelId, mode, sourceImagePath, characterUpload }) => {
    const ctx = stagingContext({
      body: { runwayModelId, mode },
      sourceImagePath,
      uploads: { runwayVideo, ...characterUpload },
      stageUploadDurable: vi.fn(async (_file, kind) => `/staged/${kind}.mp4`),
    });
    const sourcePath = '/staged/runway-video.mp4';
    const characterPath = characterUpload.runwayCharacterVideo ? '/staged/runway-character.mp4' : null;
    const model = expect.objectContaining({ id: runwayModelId });

    await expect(stageInputs(ctx)).resolves.toStrictEqual({
      runwayVideoPath: sourcePath, runwayCharacterVideoPath: characterPath,
      uploadedTempPaths: characterPath ? [sourcePath, characterPath] : [sourcePath],
    });
    expect(ctx.stageUploadDurable.mock.calls).toStrictEqual([
      [runwayVideo, 'runway-video'],
      ...(characterPath ? [[runwayCharacterVideo, 'runway-character']] : []),
    ]);
    expect(vi.mocked(validateRunwayVideoInput).mock.calls).toStrictEqual([
      [sourcePath, model],
      ...(characterPath ? [[characterPath, model, { character: true }]] : []),
    ]);
  });

  it('stops before staging a character video when performance video validation fails', async () => {
    const error = Object.assign(new Error('Unreadable performance video'), { status: 400, code: 'RUNWAY_VIDEO_INPUT' });
    vi.mocked(validateRunwayVideoInput).mockRejectedValueOnce(error);
    const ctx = stagingContext({
      body: { runwayModelId: 'act_two', mode: 'character-performance' },
      uploads: { runwayVideo, runwayCharacterVideo },
    });

    await expect(stageInputs(ctx)).rejects.toBe(error);
    expect(ctx.stageUploadDurable).toHaveBeenCalledExactlyOnceWith(runwayVideo, 'runway-video');
  });

  it.each([
    ['source audio', {}, { audioFile: audioUpload }, null, /takes no source audio/],
    ['video on a standard model', {}, { runwayVideo }, null, /model matching these video inputs/],
    ['an unresolved Aleph guidance image', { runwayModelId: 'aleph2', sourceImageFile: 'missing.png' }, { runwayVideo }, null, /guidance or character image could not be resolved/],
    ['Aleph with no source clip', { runwayModelId: 'aleph2' }, {}, null, /needs a source video/, 'RUNWAY_MODEL_INPUT'],
    ['Act-Two with two character inputs', { runwayModelId: 'act_two' }, { runwayVideo, runwayCharacterVideo }, startFrame, /exactly one character/, 'RUNWAY_MODEL_INPUT'],
    ['an uncurated model', { runwayModelId: 'gen9' }, {}, null, /not a Runway model/],
    ['an image-only model without a start frame', { runwayModelId: 'gen4_turbo' }, {}, null, /renders from a start frame/],
    ['an end frame without a start frame', {}, { lastImage: endUpload }, null, /end frame needs a start frame/],
    ['an unsupported end frame', {}, { lastImage: endUpload }, startFrame, /takes no end frame/],
    ['unsupported extra references', { referenceImageFiles: ['present.png'] }, {}, startFrame, /takes no reference images/],
    ['references without a start frame', { runwayModelId: 'seedance2_5', referenceImageFiles: ['present.png'] }, {}, null, /Reference images need a start frame/],
    ['conflicting end frame and references', { runwayModelId: 'seedance2_5', referenceImageFiles: ['present.png'] }, { lastImage: endUpload }, startFrame, /cannot combine an end frame/],
    ['references that exceed the cap with both frames', { runwayModelId: 'klingO3_pro', referenceImageFiles: referenceFiles(6) }, { lastImage: endUpload }, startFrame, /at most 7 images/],
    ['a missing gallery reference', { runwayModelId: 'klingO3_pro', referenceImageFiles: ['missing.png'] }, { lastImage: endUpload }, startFrame, /missing.png.*could not be found/],
    ['a missing gallery end frame', { runwayModelId: 'klingO3_pro', lastImageFile: 'missing.png' }, {}, startFrame, /end frame is missing/],
  ])('refuses %s before staging', async (_name, body, uploads, sourceImagePath, message, code) => {
    const ctx = stagingContext({ body, uploads, sourceImagePath });

    await expect(stageInputs(ctx)).rejects.toMatchObject(validationError(message, code));
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
    expect(validateRunwayVideoInput).not.toHaveBeenCalled();
  });

  it('stages an end frame and ordered gallery references exactly at the frame-inclusive cap', async () => {
    const picks = referenceFiles(5).reverse();
    const ctx = stagingContext({
      body: { runwayModelId: 'klingO3_pro', referenceImageFiles: picks },
      uploads: { lastImage: endUpload },
      sourceImagePath: startFrame,
    });

    await expect(stageInputs(ctx)).resolves.toStrictEqual({
      lastImagePath: '/staged/end.png',
      referenceImagePaths: picks.map((file) => `/gallery/${file}`),
      uploadedTempPaths: ['/staged/end.png'],
    });
    expect(ctx.stageUploadDurable).toHaveBeenCalledExactlyOnceWith(endUpload, 'last');
  });

  it('preserves a gallery end frame and leaves Music Video references for queue time', async () => {
    const ctx = stagingContext({
      body: { runwayModelId: 'klingO3_pro', lastImageFile: 'end.png', musicVideo: true, referenceImageFiles: ['missing.png'] },
      sourceImagePath: startFrame,
    });

    await expect(stageInputs(ctx)).resolves.toStrictEqual({ lastImagePath: '/gallery/end.png' });
    expect(resolveGalleryImage).toHaveBeenCalledExactlyOnceWith('end.png');
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
  });

  it('permits text-to-video without extra staged inputs', async () => {
    const ctx = stagingContext({ body: { mode: 'text', prompt: 'A test shot' } });

    await expect(stageInputs(ctx)).resolves.toStrictEqual({});
    expect(ctx.stageUploadDurable).not.toHaveBeenCalled();
  });
});

describe('hostedVideoRetryValidator', () => {
  it.each(['local', 'unknown-mode', 'constructor', '__proto__', 'toString', null, undefined, ['fal']])(
    'returns no hosted validator for %j',
    (mode) => expect(hostedVideoRetryValidator(mode)).toBeNull(),
  );

  it.each(Object.keys(HOSTED_VIDEO_SUBMISSIONS))('validates persisted %s retry params', (mode) => {
    const validate = hostedVideoRetryValidator(mode);

    expect(() => validate({})).not.toThrow();
    expect(() => validate({ i2vReferenceMode: 'anchor', a2vLoraStageStrengths: [1, 1] })).not.toThrow();
    expect(() => validate({ a2vLoraStageStrengths: [1, 0.5] }))
      .toThrow(expect.objectContaining(validationError(/per-stage user LoRA strengths/, 'A2V_LORA_STAGES_UNSUPPORTED')));
    expect(() => validate({ i2vReferenceMode: 'inspire' }))
      .toThrow(expect.objectContaining(validationError(/anchors a reference image as frame one/, 'I2V_REFERENCE_MODE_UNSUPPORTED')));
  });
});
