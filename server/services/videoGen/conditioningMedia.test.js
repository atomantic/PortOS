import { describe, expect, it, vi, beforeEach } from 'vitest';

const { execFileMock, findFfmpegMock } = vi.hoisted(() => ({
  execFileMock: vi.fn((...args) => {
    const callback = args.at(-1);
    callback(null, { stdout: '', stderr: '' });
  }),
  findFfmpegMock: vi.fn(async () => '/mock/ffmpeg'),
}));

vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: execFileMock,
}));

vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findFfmpeg: findFfmpegMock,
}));

import { prepareVideoConditioningMedia } from './conditioningMedia.js';

describe('prepareVideoConditioningMedia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects malformed keyframes before resizing any other conditioning input', async () => {
    await expect(prepareVideoConditioningMedia({
      model: { runtime: 'ltx2' },
      mode: 'image',
      sourceImagePath: '/tmp/source.png',
      keyframes: [{ path: '/tmp/first.png', index: 0 }, null],
      w: 704,
      h: 448,
      parsedFps: 24,
      jobId: 'malformed-keyframes',
      uploadedTempPath: null,
      uploadedTempPaths: [],
      audioFilePath: null,
    })).rejects.toMatchObject({ status: 400, code: 'KEYFRAME_INVALID_SHAPE' });

    expect(findFfmpegMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // Uniquely catches the LTX-2.3 "holds the reference for one frame, then cuts
  // away" regression: the mlx_video CLI skips Lightricks' CRF round trip, so
  // PortOS must do it, and only for that runtime (the others do their own).
  const imageInput = (runtime) => ({
    model: { runtime },
    mode: 'image',
    sourceImagePath: '/tmp/source.png',
    w: 704,
    h: 448,
    parsedFps: 24,
    jobId: `crf-${runtime}`,
    uploadedTempPath: null,
    uploadedTempPaths: [],
    audioFilePath: null,
  });
  const crfCalls = () => execFileMock.mock.calls.filter(([, args]) => args.includes('-crf'));

  it('re-compresses the conditioning still at CRF 33 on the mlx_video runtime', async () => {
    const result = await prepareVideoConditioningMedia(imageInput('mlx_video'));
    expect(crfCalls()).toHaveLength(1);
    const [, args] = crfCalls()[0];
    expect(args[args.indexOf('-crf') + 1]).toBe('33');
    expect(args[args.indexOf('-i') + 1]).toBe(result.resolvedSourceImage);
  });

  it('leaves the still alone on runtimes whose loader already does the round trip', async () => {
    await prepareVideoConditioningMedia(imageInput('ltx25'));
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(crfCalls()).toHaveLength(0);
  });
});
