import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const { execFileMock, findFfmpegMock, routesToWindowsHelperMock } = vi.hoisted(() => ({
  execFileMock: vi.fn((...args) => {
    const callback = args.at(-1);
    callback(null, { stdout: '', stderr: '' });
  }),
  findFfmpegMock: vi.fn(async () => '/mock/ffmpeg'),
  routesToWindowsHelperMock: vi.fn(),
}));

vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: execFileMock,
}));

vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findFfmpeg: findFfmpegMock,
}));

vi.mock('./runtimes.js', async (importOriginal) => ({
  ...(await importOriginal()),
  routesToWindowsHelper: routesToWindowsHelperMock,
}));

import { prepareVideoConditioningMedia } from './conditioningMedia.js';

describe('prepareVideoConditioningMedia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Exercise both runner contracts on every host; runtimes.test.js covers
    // the actual platform-dependent routing decision.
    routesToWindowsHelperMock.mockReturnValue(false);
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

  it('only resizes an mlx_video model routed to the Windows helper', async () => {
    routesToWindowsHelperMock.mockReturnValue(true);
    await prepareVideoConditioningMedia(imageInput('mlx_video'));
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(crfCalls()).toHaveLength(0);
  });

  it('combines LTX 2.5 stills into one ordered sheet and a clip as long as the output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ltx-sheet-test-'));
    const first = join(dir, 'first.png');
    const second = join(dir, 'second.png');
    const jobId = 'sheet-' + Date.now();
    const sheet = join(tmpdir(), 'ic-sheet-' + jobId + '.png');
    let result;
    try {
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toFile(first);
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0000ff' } }).png().toFile(second);
      result = await prepareVideoConditioningMedia({
        model: { runtime: 'ltx25' }, mode: 'ic-ingredients-25',
        icReferencePaths: [first, second], w: 64, h: 64, parsedFps: 24,
        parsedNumFrames: 129, jobId, uploadedTempPaths: [],
      });
      expect(result.resolvedIcReferencePaths).toEqual([join(tmpdir(), 'ic-sheet-' + jobId + '.mp4')]);
      const [, args] = execFileMock.mock.calls.find(([, argv]) => argv.includes('-loop'));
      expect(args[args.indexOf('-frames:v') + 1]).toBe('129');
      const { data, info } = await sharp(sheet).raw().toBuffer({ resolveWithObject: true });
      const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
      expect(pixel(16, 32)).toEqual([255, 0, 0]);
      expect(pixel(48, 32)).toEqual([0, 0, 255]);
    } finally {
      await result?.cleanupTempFiles();
      await rm(dir, { recursive: true, force: true });
      await rm(sheet, { force: true });
    }
  });
});
