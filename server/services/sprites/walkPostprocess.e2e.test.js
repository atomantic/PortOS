/**
 * Walk postprocess end-to-end + parity fixture (#2897).
 *
 * Synthesizes a deterministic keyed walk video with ffmpeg (an oscillating
 * "character" over the solid key), runs the full postprocess, and asserts
 * the packed geometry contract (8 phases, 3072×384 strip, pivot/baseline)
 * plus bit-level determinism (two runs → identical artifacts). Skipped when
 * ffmpeg is unavailable (CI runners without it still cover all the pixel
 * math in walkPostprocess.test.js).
 *
 * Parity against a real imported ElsewhereAcres production run is opt-in —
 * production sprite data is never committed (see the repo's privacy rules):
 *   SPRITE_WALK_PARITY_RUN=<abs path to an imported grok/walk-* run dir> \
 *     npx vitest run services/sprites/walkPostprocess.e2e.test.js
 * re-runs the postprocess on that run's source video and asserts the same
 * packed geometry + frame count as its imported manifest.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { mkdir, readFile } from 'fs/promises';
import { findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { runWalkPostprocess, WALK_PHASES, WALK_CELL_SIZE } from './walkPostprocess.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-walk-e2e-'));
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

const ffmpegBin = await findFfmpeg();
const KEY = '#FF00FF';

// A 256×256 "character": dark body + two legs that scissor with a 12-frame
// period, over the solid magenta key. yuv420p smears the key exactly like a
// real codec, so the measured-key un-key path is exercised for real.
async function writeSourceFrame(dir, index) {
  const w = 256; const h = 256;
  const buf = Buffer.alloc(w * h * 3);
  for (let p = 0; p < w * h; p++) buf.set([255, 0, 255], p * 3);
  const phase = Math.sin((2 * Math.PI * index) / 12);
  const spread = Math.round(28 * phase);
  const bob = Math.round(5 * Math.cos((2 * Math.PI * index) / 12));
  const paint = (x0, y0, x1, y1, rgb) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buf.set(rgb, (y * w + x) * 3);
  };
  // Bright, saturated body parts so the 48×48 signatures register the motion.
  paint(96, 40 + bob, 160, 150 + bob, [235, 225, 205]);       // torso
  paint(112, 20 + bob, 144, 40 + bob, [220, 190, 160]);       // head
  paint(112 - spread, 150, 128 - spread, 220, [190, 40, 50]); // left leg
  paint(128 + spread, 150, 144 + spread, 220, [50, 40, 190]); // right leg
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(join(dir, `frame-${String(index).padStart(3, '0')}.png`));
}

async function synthesizeVideo(dest) {
  const framesDir = join(TEST_ROOT, 'synth-frames');
  await mkdir(framesDir, { recursive: true });
  for (let i = 0; i < 30; i++) await writeSourceFrame(framesDir, i);
  const result = await runFfmpegProcess({
    bin: ffmpegBin,
    args: [
      '-y', '-framerate', '12', '-i', join(framesDir, 'frame-%03d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', dest,
    ],
  });
  expect(result.ok).toBe(true);
}

async function writeAnchor(dest) {
  const w = 128; const h = 128;
  const buf = Buffer.alloc(w * h * 3);
  for (let p = 0; p < w * h; p++) buf.set([255, 0, 255], p * 3);
  for (let y = 20; y < 110; y++) for (let x = 48; x < 80; x++) buf.set([40, 60, 90], (y * w + x) * 3);
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(dest);
}

async function runOnce(label, videoAbs, anchorAbs) {
  const runRel = 'grok/walk-east-fixture0';
  const runAbs = join(TEST_ROOT, label, runRel);
  await mkdir(join(runAbs, 'generated'), { recursive: true });
  return {
    runAbs,
    result: await runWalkPostprocess({
      recordId: 'fixture-hero',
      direction: 'east',
      chromaKey: KEY,
      runAbs,
      runRel,
      anchorRel: 'reference/fixture-hero-walk-east-v1.png',
      anchorAbs,
      videoAbs,
    }),
  };
}

describe.skipIf(!ffmpegBin)('runWalkPostprocess e2e (synthetic keyed walk video)', () => {
  it('packages the canonical strip geometry deterministically', async () => {
    const videoAbs = join(TEST_ROOT, 'walk.mp4');
    const anchorAbs = join(TEST_ROOT, 'anchor.png');
    await synthesizeVideo(videoAbs);
    await writeAnchor(anchorAbs);

    const { runAbs, result } = await runOnce('run-a', videoAbs, anchorAbs);
    const { manifest } = result;

    // Geometry contract.
    expect(manifest.kind).toBe('deterministically-packaged-grok-walk-video');
    expect(manifest.frameCount).toBe(8);
    expect(manifest.frameRate).toBe(12);
    expect(manifest.frames.map((f) => f.phase)).toEqual(WALK_PHASES);
    expect(manifest.alignment.cellSize).toBe(WALK_CELL_SIZE);
    expect(manifest.alignment.targetPivot).toEqual([192, 352]);
    expect(manifest.alignment.translations).toHaveLength(8);
    expect(manifest.chromaKey).toBe(KEY);
    expect(manifest.validation.keyDominantPixels).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(manifest.cycleSelection.windowLength).toBeGreaterThanOrEqual(8);

    const stripMeta = await sharp(join(runAbs, 'generated', 'fixture-hero-walk-east-strip.png')).metadata();
    expect(stripMeta.width).toBe(WALK_CELL_SIZE * 8);
    expect(stripMeta.height).toBe(WALK_CELL_SIZE);
    const sheetMeta = await sharp(join(runAbs, 'generated', 'review', 'fixture-hero-walk-east-contrast-review.png')).metadata();
    expect(sheetMeta.width).toBe(1024);
    expect(sheetMeta.height).toBe(384);
    const preview = JSON.parse(await readFile(join(runAbs, 'generated', 'review-preview.json'), 'utf8'));
    expect(preview).toEqual({
      stripPath: 'grok/walk-east-fixture0/generated/fixture-hero-walk-east-strip.png',
      frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0,
    });

    // Determinism: same video, second run → byte-identical manifest & strip.
    const second = await runOnce('run-b', videoAbs, anchorAbs);
    expect(second.result.manifest).toEqual(manifest);
    expect(second.result.manifest.stripSha256).toBe(manifest.stripSha256);
  }, 120000);
});

const parityRun = process.env.SPRITE_WALK_PARITY_RUN;

describe.skipIf(!ffmpegBin || !parityRun)('parity vs an imported production run', () => {
  it('reproduces the imported manifest geometry from the same source video', async () => {
    const importedManifestName = (await import('fs/promises'))
      .readdir(join(parityRun, 'generated'));
    const names = await importedManifestName;
    const manifestFile = names.find((n) => /-walk-.+-manifest\.json$/.test(n));
    expect(manifestFile).toBeTruthy();
    const imported = JSON.parse(await readFile(join(parityRun, 'generated', manifestFile), 'utf8'));
    const videoAbs = join(parityRun, 'generated', 'source-video.mp4');

    const runRel = 'grok/walk-parity-check00';
    const runAbs = join(TEST_ROOT, 'parity', runRel);
    await mkdir(join(runAbs, 'generated'), { recursive: true });
    const anchorAbs = join(TEST_ROOT, 'parity-anchor.png');
    await writeAnchor(anchorAbs);
    const { manifest } = await runWalkPostprocess({
      recordId: imported.characterId,
      direction: imported.direction,
      chromaKey: imported.chromaKey || '#FF00FF',
      runAbs,
      runRel,
      anchorRel: imported.anchorPath,
      anchorAbs,
      videoAbs,
    });
    expect(manifest.frameCount).toBe(imported.frameCount);
    expect(manifest.frameRate).toBe(imported.frameRate);
    expect(manifest.alignment.cellSize).toBe(imported.alignment.cellSize);
    expect(manifest.alignment.targetPivot).toEqual(imported.alignment.targetPivot);
    expect(manifest.frames.map((f) => f.phase)).toEqual(imported.frames.map((f) => f.phase));
    const stripMeta = await sharp(join(runAbs, 'generated', `${imported.characterId}-walk-${imported.direction}-strip.png`)).metadata();
    const importedStrip = await sharp(join(parityRun, 'generated', imported.stripPath.split('/').pop())).metadata();
    expect(stripMeta.width).toBe(importedStrip.width);
    expect(stripMeta.height).toBe(importedStrip.height);
  }, 240000);
});
