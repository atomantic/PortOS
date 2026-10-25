/**
 * Native Extend keeps the ORIGINAL source in the delivered file (#11171).
 *
 * Runs real ffmpeg on tiny synthetic clips: a black "source" and a white
 * "render" whose opening frames stand in for the model's re-decode of the
 * source. The splice must put source pixels before the seam and render pixels
 * after it, at the render's exact length, and must leave the render untouched
 * whenever the layout doesn't verify.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findFfmpeg, runFfmpegProcess, probeFrameCount, hasAudioStream, probeVideoDuration, videoFrameHashes } from '../../lib/ffmpeg.js';
import { spliceExtendSource } from './extendSplice.js';
import { extendMasterPath } from './extendMaster.js';

const execFileAsync = promisify(execFile);

let tmpDir;
let ffmpeg;

const makeClip = (name, { color, frames, tone, x264 = [] }) => runFfmpegProcess({
  bin: ffmpeg,
  args: [
    '-f', 'lavfi', '-i', `color=c=${color}:size=64x48:rate=24`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=48000`,
    '-frames:v', String(frames), '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...x264, '-c:a', 'aac', '-y', join(tmpDir, name),
  ],
  stderrTailBytes: 0,
}).then((r) => (r.ok ? join(tmpDir, name) : null));

// Mean luma (0–255) of every decoded frame, in order. `select=eq(n,…)` on a
// stream-copied join mis-indexes frames after the seam; per-frame stats do not.
const frameLumas = async (path) => {
  const { stdout } = await execFileAsync(ffmpeg, [
    '-v', 'error', '-i', path, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-',
  ], { maxBuffer: 1 << 20 });
  return [...stdout.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'portos-extend-splice-'));
  ffmpeg = await findFfmpeg();
});
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

describe('spliceExtendSource', () => {
  it('preserves the source, render and existing audio master when runtime timing is unverified', async () => {
    const source = join(tmpDir, 'unverified-source.mp4');
    const output = join(tmpDir, 'unverified-render.mp4');
    writeFileSync(source, 'original source');
    writeFileSync(output, 'completed render');
    const master = extendMasterPath(output);
    writeFileSync(master, 'existing master');
    const originals = [source, output, master].map((path) => readFileSync(path));
    const result = await spliceExtendSource({ runtime: 'minimax_h3_cuda', sourcePath: source, outputPath: output, extendLatents: 2 });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('H3 CUDA') });
    expect([source, output, master].map((path) => readFileSync(path))).toEqual(originals);
  });

  it.each(['ltx2', 'ltx25'])('delivers source frames before the seam and new frames after it for %s', async (runtime) => {
    if (!ffmpeg) return;
    // 17 source frames (1 + 8*2) extended by 2 latents → a 33-frame render.
    const source = await makeClip('source.mp4', { color: 'black', frames: 17, tone: 440 });
    const output = await makeClip('render.mp4', { color: 'white', frames: 33, tone: 880 });
    if (!source || !output) return;

    const result = await spliceExtendSource({ runtime, sourcePath: source, outputPath: output, extendLatents: 2 });

    expect(result).toMatchObject({ applied: true, keptFrames: 17, droppedSourceFrames: 0 });
    expect(await probeFrameCount(output)).toBe(33);
    const lumas = await frameLumas(output);
    expect(lumas).toHaveLength(33);
    expect(lumas.slice(0, 17).every((v) => v < 60)).toBe(true);   // source region: original black
    expect(lumas.slice(17).every((v) => v > 190)).toBe(true);     // new region: the render
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

    const result = await spliceExtendSource({ runtime: 'ltx2', sourcePath: source, outputPath: output, extendLatents: 2 });

    expect(result.applied).toBe(false);
    expect(readFileSync(output).equals(before)).toBe(true);
  });

  it('declines without touching anything when the source file is gone', async () => {
    const result = await spliceExtendSource({ runtime: 'ltx2',
      sourcePath: join(tmpDir, 'missing.mp4'), outputPath: join(tmpDir, 'render.mp4'), extendLatents: 2,
    });
    expect(result).toEqual({ applied: false, reason: 'source file missing' });
  });

  it('stream-copies the source so its frames stay bit-identical, and keeps a lossless audio master', async () => {
    if (!ffmpeg) return;
    const source = await makeClip('copy-source.mp4', { color: 'black', frames: 17, tone: 440 });
    const output = await makeClip('copy-render.mp4', { color: 'white', frames: 33, tone: 880 });
    if (!source || !output) return;
    const sourceHashes = await videoFrameHashes(source);

    const result = await spliceExtendSource({ runtime: 'ltx2', sourcePath: source, outputPath: output, extendLatents: 2 });

    expect(result).toMatchObject({ applied: true, streamCopied: true });
    expect((await videoFrameHashes(output)).slice(0, 17)).toEqual(sourceHashes);
    const master = extendMasterPath(output);
    expect(existsSync(master)).toBe(true);
    // The master carries the whole mix: as long as the delivered clip, not just one span.
    expect(Math.abs((await probeVideoDuration(master)) - (await probeVideoDuration(output)))).toBeLessThan(0.1);
    expect(existsSync(`${master.replace(/\.flac$/, '.part.flac')}`)).toBe(false);
  });

  it('re-encodes when the source and render do not share codec parameters', async () => {
    if (!ffmpeg) return;
    const source = await makeClip('baseline-source.mp4', { color: 'black', frames: 17, tone: 440, x264: ['-profile:v', 'baseline'] });
    const output = await makeClip('main-render.mp4', { color: 'white', frames: 33, tone: 880 });
    if (!source || !output) return;

    const result = await spliceExtendSource({ runtime: 'ltx2', sourcePath: source, outputPath: output, extendLatents: 2 });

    expect(result).toMatchObject({ applied: true, streamCopied: false });
    expect(await probeFrameCount(output)).toBe(33);
    const lumas = await frameLumas(output);
    expect(lumas.slice(0, 17).every((v) => v < 60)).toBe(true);
    expect(lumas.slice(17).every((v) => v > 190)).toBe(true);
  });

  it('chains: a second round reads its source audio from the first round\'s master and leaves its own', async () => {
    if (!ffmpeg) return;
    const source = await makeClip('round1-source.mp4', { color: 'black', frames: 17, tone: 440 });
    const roundOne = await makeClip('round1-render.mp4', { color: 'white', frames: 33, tone: 880 });
    if (!source || !roundOne) return;
    expect((await spliceExtendSource({ runtime: 'ltx2', sourcePath: source, outputPath: roundOne, extendLatents: 2 })).applied).toBe(true);
    // 33 frames extended by 2 latents → 49.
    const roundTwo = await makeClip('round2-render.mp4', { color: 'gray', frames: 49, tone: 660 });
    if (!roundTwo) return;
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => logs.push(String(line)));

    const result = await spliceExtendSource({ runtime: 'ltx2', sourcePath: roundOne, outputPath: roundTwo, extendLatents: 2 });
    spy.mockRestore();

    expect(result.applied).toBe(true);
    expect(logs.some((line) => line.includes('lossless master'))).toBe(true);
    expect(existsSync(extendMasterPath(roundTwo))).toBe(true);
    expect(await probeFrameCount(roundTwo)).toBe(49);
  });

  it('ignores a master once the clip\'s soundtrack was replaced in place, even at the same length', async () => {
    if (!ffmpeg) return;
    const source = await makeClip('swap-source.mp4', { color: 'black', frames: 17, tone: 440 });
    const roundOne = await makeClip('swap-render.mp4', { color: 'white', frames: 33, tone: 880 });
    const roundTwo = await makeClip('swap-render-2.mp4', { color: 'gray', frames: 49, tone: 660 });
    if (!source || !roundOne || !roundTwo) return;
    expect((await spliceExtendSource({ runtime: 'ltx2', sourcePath: source, outputPath: roundOne, extendLatents: 2 })).applied).toBe(true);
    const master = extendMasterPath(roundOne);
    expect(existsSync(master)).toBe(true);
    // Swap the soundtrack, keeping the picture and the length.
    const swapped = join(tmpDir, 'swap-render.swapped.mp4');
    const remux = await runFfmpegProcess({
      bin: ffmpeg,
      args: ['-i', roundOne, '-f', 'lavfi', '-i', 'sine=frequency=1500:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-y', swapped],
      stderrTailBytes: 0,
    });
    if (!remux.ok) return;
    renameSync(swapped, roundOne);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await spliceExtendSource({ runtime: 'ltx2', sourcePath: roundOne, outputPath: roundTwo, extendLatents: 2 });
    const warned = warn.mock.calls.some(([line]) => String(line).includes('does not match'));
    warn.mockRestore();

    expect(result.applied).toBe(true);
    expect(warned).toBe(true);
  });

  it('ignores a stale master and honors keepMaster:false', async () => {
    if (!ffmpeg) return;
    const source = await makeClip('stale-source.mp4', { color: 'black', frames: 17, tone: 440 });
    const output = await makeClip('stale-render.mp4', { color: 'white', frames: 33, tone: 880 });
    const other = await makeClip('stale-other.mp4', { color: 'white', frames: 33, tone: 880 });
    if (!source || !output || !other) return;
    // A master whose length no longer matches its clip (audio was replaced in place).
    const staleMaster = extendMasterPath(source);
    const made = await runFfmpegProcess({
      bin: ffmpeg,
      args: ['-f', 'lavfi', '-i', 'sine=frequency=100:sample_rate=48000', '-t', '5', '-c:a', 'flac', '-y', staleMaster],
      stderrTailBytes: 0,
    });
    if (!made.ok) return;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await spliceExtendSource({ runtime: 'ltx2', sourcePath: source, outputPath: output, extendLatents: 2, keepMaster: false });
    const warned = warn.mock.calls.some(([line]) => String(line).includes('does not match'));
    warn.mockRestore();

    expect(result.applied).toBe(true);
    expect(warned).toBe(true);
    expect(existsSync(extendMasterPath(output))).toBe(false);
    expect(await probeFrameCount(output)).toBe(33);
  });
});
