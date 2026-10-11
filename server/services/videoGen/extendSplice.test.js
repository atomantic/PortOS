/**
 * Native Extend keeps the ORIGINAL source in the delivered file (#11171).
 *
 * Runs real ffmpeg on tiny synthetic clips: a black "source" and a white
 * "render" whose opening frames stand in for the model's re-decode of the
 * source. The splice must put source pixels before the seam and render pixels
 * after it, at the render's exact length, and must leave the render untouched
 * whenever the layout doesn't verify.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findFfmpeg, runFfmpegProcess, probeFrameCount, hasAudioStream } from '../../lib/ffmpeg.js';
import { spliceExtendSource } from './extendSplice.js';

const execFileAsync = promisify(execFile);

let tmpDir;
let ffmpeg;

const makeClip = (name, { color, frames, tone }) => runFfmpegProcess({
  bin: ffmpeg,
  args: [
    '-f', 'lavfi', '-i', `color=c=${color}:size=64x48:rate=24`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=48000`,
    '-frames:v', String(frames), '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', join(tmpDir, name),
  ],
  stderrTailBytes: 0,
}).then((r) => (r.ok ? join(tmpDir, name) : null));

// Mean luma of frame `n`, 0–255.
const frameLuma = async (path, n) => {
  const { stdout } = await execFileAsync(ffmpeg, [
    '-v', 'error', '-i', path, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { encoding: 'buffer', maxBuffer: 1 << 20 });
  return stdout.reduce((sum, v) => sum + v, 0) / stdout.length;
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'portos-extend-splice-'));
  ffmpeg = await findFfmpeg();
});
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

describe('spliceExtendSource', () => {
  it('delivers source frames before the seam and the render after it, at the render length', async () => {
    if (!ffmpeg) return;
    // 17 source frames (1 + 8*2) extended by 2 latents → a 33-frame render.
    const source = await makeClip('source.mp4', { color: 'black', frames: 17, tone: 440 });
    const output = await makeClip('render.mp4', { color: 'white', frames: 33, tone: 880 });
    if (!source || !output) return;

    const result = await spliceExtendSource({ sourcePath: source, outputPath: output, extendLatents: 2 });

    expect(result).toMatchObject({ applied: true, keptFrames: 17, droppedSourceFrames: 0 });
    expect(await probeFrameCount(output)).toBe(33);
    expect(await frameLuma(output, 0)).toBeLessThan(60);   // source region: original black
    expect(await frameLuma(output, 16)).toBeLessThan(60);
    expect(await frameLuma(output, 17)).toBeGreaterThan(190); // first new frame: the render
    expect(await frameLuma(output, 32)).toBeGreaterThan(190);
    expect(await hasAudioStream(output)).toBe(true);
    expect(existsSync(`${output}.splice.mp4`)).toBe(false);
  });

  it('keeps the render byte-for-byte when the frame layout does not match', async () => {
    if (!ffmpeg) return;
    // 40 source frames against a render that only echoes 17: the model truncated
    // its context, so there is no seam to trust.
    const source = await makeClip('long-source.mp4', { color: 'black', frames: 40, tone: 440 });
    const output = await makeClip('short-render.mp4', { color: 'white', frames: 33, tone: 880 });
    if (!source || !output) return;
    const before = readFileSync(output);

    const result = await spliceExtendSource({ sourcePath: source, outputPath: output, extendLatents: 2 });

    expect(result.applied).toBe(false);
    expect(readFileSync(output).equals(before)).toBe(true);
  });

  it('declines without touching anything when the source file is gone', async () => {
    const result = await spliceExtendSource({
      sourcePath: join(tmpDir, 'missing.mp4'), outputPath: join(tmpDir, 'render.mp4'), extendLatents: 2,
    });
    expect(result).toEqual({ applied: false, reason: 'source file missing' });
  });
});
