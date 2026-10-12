import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { buildMusicVideoFfmpegArgs } from './render.js';

const ffmpeg = await findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'portos-mv-frame-fit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 });
const FPS = 12;

// One RGB pixel of the output's first frame.
function pixel(path, width, x, y) {
  const raw = run(['-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const at = (y * width + x) * 3;
  return [raw[at], raw[at + 1], raw[at + 2]];
}
const near = (rgb, target, tolerance = 40) => rgb.every((value, i) => Math.abs(value - target[i]) <= tolerance);

// Uniquely catches a 3:2 local clip setting a 3:2 video, and each frame fit's
// filter graph failing in ffmpeg or covering the side gaps with the wrong thing.
describe.skipIf(!ffmpeg)('a 3:2 clip in a 16:9 music video', () => {
  const clipPath = join(dir, 'clip.mp4');
  const stillPath = join(dir, 'still.png');
  const song = join(dir, 'song.wav');
  const render = (frameFit) => {
    const output = join(dir, `${frameFit}.mp4`);
    const clip = { sceneId: 's1', videoPath: clipPath, width: 96, height: 64, fps: FPS, duration: 1, sourceSec: 1,
      loop: false, inSec: 0, outSec: 1, frameFit, ...(frameFit === 'still' ? { stillPath } : {}) };
    const plan = buildMusicVideoFfmpegArgs([clip], song, output, { audioDurationSec: 1, frameGrid: true, aspect: '16:9' });
    run(plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress')));
    return { output, plan };
  };

  it('renders 16:9 and fills, covers or bars the side gaps as picked', () => {
    run(['-f', 'lavfi', '-i', `color=0x00ff00:s=96x64:r=${FPS}:d=1`, '-pix_fmt', 'yuv420p', '-y', clipPath]);
    run(['-f', 'lavfi', '-i', 'color=0xff0000:s=160x90', '-frames:v', '1', '-y', stillPath]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-y', song]);
    const green = [0, 255, 0];
    const edges = {};
    for (const fit of ['fill', 'still', 'vhs', 'black']) {
      const { output, plan } = render(fit);
      expect([plan.canonW, plan.canonH]).toEqual([114, 64]);
      expect(near(pixel(output, 114, 57, 32), green)).toBe(true);
      edges[fit] = pixel(output, 114, 2, 32);
    }
    expect(near(edges.fill, green)).toBe(true);
    expect(near(edges.still, [255, 0, 0])).toBe(true);
    expect(near(edges.black, [0, 0, 0], 24)).toBe(true);
    // A dimmed, faded blur of the clip: green-tinted, never the clip itself or a bar.
    expect(near(edges.vhs, green)).toBe(false);
    expect(near(edges.vhs, [0, 0, 0], 24)).toBe(false);
    expect(edges.vhs[1]).toBeGreaterThan(edges.vhs[0]);
  });
});
