import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from './mockPathsDataRoot.js';

const state = vi.hoisted(() => ({ history: [], candidates: [], picked: null }));
vi.mock('./fileUtils.js', async original => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-frame-sync-'),
}));
vi.mock('../services/videoGen/history.js', () => ({ loadHistory: async () => state.history }));
vi.mock('./frameQuality.js', async original => {
  const actual = await original();
  const { default: image } = await import('sharp');
  return { ...actual, pickBestFrame: async paths => {
    // Observe the real decoded candidates before the service removes its temp
    // directory; ranking itself remains the production implementation.
    state.candidates = await Promise.all(paths.map(async path => (await image(path).stats()).channels[0].mean));
    state.picked = await actual.pickBestFrame(paths);
    return state.picked;
  } };
});

import { PATHS } from './fileUtils.js';
import { findFfmpeg, findFfprobe, runFfmpegProcess, extractEvaluationFrames, probeFrameCount } from './ffmpeg.js';
import { encodeFileContactSheetAtTimes } from '../services/htmlComposition/encode.js';
import { extractLastFrame } from '../services/videoGen/frameExtraction.js';

const ffmpeg = await findFfmpeg();
const ffprobe = await findFfprobe();
const level = index => 24 + index * 3;
const frameIndex = mean => (mean - 24) / 3;

describe.skipIf(!ffmpeg || !ffprobe)('frame extraction over native FFmpeg and synthetic media', () => {
  let video;
  beforeAll(async () => {
    await mkdir(PATHS.videos, { recursive: true });
    const frames = join(PATHS.videos, 'source');
    await mkdir(frames);
    // A lossless, 30 fps, two-second clip. Each frame's gray level names its
    // index; the checkerboard gives the real anchor scorer usable detail.
    await Promise.all(Array.from({ length: 60 }, async (_, index) => {
      const pixels = Buffer.alloc(32 * 32 * 3);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const value = level(index) + ((x + y) % 2 ? 12 : -12);
        pixels.fill(value, (y * 32 + x) * 3, (y * 32 + x + 1) * 3);
      }
      await sharp(pixels, { raw: { width: 32, height: 32, channels: 3 } }).png()
        .toFile(join(frames, `${String(index + 1).padStart(3, '0')}.png`));
    }));
    video = join(PATHS.videos, 'synthetic.mkv');
    const made = await runFfmpegProcess({ bin: ffmpeg, args: ['-hide_banner', '-loglevel', 'error',
      '-framerate', '30', '-i', join(frames, '%03d.png'), '-c:v', 'ffv1', '-pix_fmt', 'bgr0', '-y', video] });
    expect(made).toMatchObject({ ok: true });
    expect(await probeFrameCount(video)).toBe(60);
  }, 30000);
  afterAll(cleanupTempDataRoots);

  it('tiles exact sparse boundary frames once and leaves a duplicate-time cell padded', async () => {
    const output = join(PATHS.videos, 'sheet.png');
    expect(await encodeFileContactSheetAtTimes(video, output, [0, 1 / 30, 0.034, 0.5, 59 / 30], { fps: 30 }))
      .toEqual({ columns: 5, rows: 1 });
    const image = sharp(output);
    expect(await image.metadata()).toMatchObject({ width: 1816, height: 360 });
    for (const [cell, index] of [0, 1, 15, 59].entries()) {
      const pixels = await image.clone().extract({ left: cell * 364, top: 0, width: 360, height: 360 }).toBuffer();
      const mean = (await sharp(pixels).stats()).channels[0].mean;
      expect(mean).toBeCloseTo(level(index), 0);
    }
    const padded = await sharp(await image.clone().extract({ left: 4 * 364, top: 0, width: 360, height: 360 }).toBuffer()).stats();
    expect(padded.channels[0].max).toBe(0);
  });

  it('extracts five ordered quartile frames without padding and only three from a tiny clip', async () => {
    const names = await extractEvaluationFrames(video, 'quartile', 5);
    expect(names).toHaveLength(5);
    expect((await readdir(PATHS.videoThumbnails)).filter(name => name.startsWith('quartile-'))).toHaveLength(5);
    for (const [i, index] of [0, 15, 30, 44, 59].entries()) {
      const mean = (await sharp(join(PATHS.videoThumbnails, names[i])).stats()).channels[0].mean;
      expect(Math.abs(frameIndex(mean) - index)).toBeLessThan(0.5);
    }
    const tiny = join(PATHS.videos, 'tiny.mkv');
    expect(await runFfmpegProcess({ bin: ffmpeg, args: ['-i', video, '-frames:v', '3', '-c:v', 'copy', '-y', tiny] }))
      .toMatchObject({ ok: true });
    const short = await extractEvaluationFrames(tiny, 'tiny', 5);
    expect(short).toHaveLength(3);
    expect((await readdir(PATHS.videoThumbnails)).filter(name => name.startsWith('tiny-'))).toHaveLength(3);
  });

  it('decodes the twelve tail candidates at the original sampling times and records the selected offset', async () => {
    const id = randomUUID();
    state.history = [{ id, filename: 'synthetic.mkv', prompt: 'Synthetic frame grid' }];
    const anchor = await extractLastFrame(id);
    expect(state.candidates).toHaveLength(12);
    for (const [i, mean] of state.candidates.entries()) {
      expect(Math.abs(frameIndex(mean) - (30 + i * 30 / 12))).toBeLessThanOrEqual(1);
    }
    expect(state.picked).not.toBeNull();
    const installed = (await sharp(join(PATHS.images, anchor.filename)).stats()).channels[0].mean;
    expect(installed).toBeCloseTo(state.candidates[state.picked.index], 5);
    const metadata = JSON.parse(await readFile(join(PATHS.images, anchor.filename.replace('.png', '.metadata.json')), 'utf8'));
    expect(metadata.extractedAt).toBe(`-${((12 - state.picked.index) / 12).toFixed(2)}s`);
  });
});
