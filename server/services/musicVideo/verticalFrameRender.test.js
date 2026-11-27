import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findFfmpeg, probeVideoStreamInfo, AAC_ENCODE_ARGS } from '../../lib/ffmpeg.js';
import { SOCIAL_VIDEO_ARGS } from './socialCuts.js';
import { renderVerticalFramedVideo } from './verticalFrameRender.js';

let ffmpeg = null;
let dir = null;

beforeAll(async () => {
  ffmpeg = await findFfmpeg();
  if (ffmpeg) dir = mkdtempSync(join(tmpdir(), 'mv-vertical-frame-'));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Uniquely catches the framed 9:16 sharp+ffmpeg pipeline failing to composite a 16:9 master into 1080x1920.
describe('renderVerticalFramedVideo', () => {
  it('encodes a 16:9 master into a 1080x1920 framed vertical video with header, synced footer, and audio', async () => {
    if (!ffmpeg) return;
    const master = join(dir, 'master.mp4');
    const out = join(dir, 'vertical-framed.mp4');
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x224466:s=1280x720:r=24:d=1.2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', master,
    ]);

    const seenProgress = [];
    await renderVerticalFramedVideo({
      ffmpeg,
      masterPath: master,
      outputPath: out,
      startSec: 0,
      endSec: 1.2,
      frameOptions: {
        theme: 'analog-16mm',
        title: 'Example Track',
        subtitle: 'Example Artist · Official Music Video',
        footerNote: 'Full story',
        showLyrics: true,
        showWaveform: true,
      },
      lyrics: [{ text: 'Hold the light still', startSec: 0.1, endSec: 1.1 }],
      beats: [0.25, 0.75],
      videoArgs: SOCIAL_VIDEO_ARGS,
      audioArgs: [...AAC_ENCODE_ARGS, '-movflags', '+faststart'],
      fade: false,
      onProgress: (p) => seenProgress.push(p),
    });

    const info = await probeVideoStreamInfo(out);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(seenProgress.length).toBeGreaterThan(0);
    expect(seenProgress.at(-1)).toBeCloseTo(1, 2);
  }, 30000);
});
