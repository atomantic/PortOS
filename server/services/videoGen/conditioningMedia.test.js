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
});
