import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { imageEffectState, sceneImageEffect } from '../../lib/musicVideoImageEffects.js';
import { buildMusicVideoFfmpegArgs } from './render.js';
import { applySceneUpdate, replaceScenes } from './projectsLogic.js';

const ffmpeg = await findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'portos-mv-image-effects-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 });
const W = 96;
const H = 64;

// Uniquely catches an effect playing outside a layered still shot, where the render would not draw it.
describe('sceneImageEffect', () => {
  const still = { visualLayer: 'still', imageEffect: 'flash-develop', imageEffectSec: 2 };
  it('plays only on a still shot in a layered composition, with its develop length or the default', () => {
    expect(sceneImageEffect(still, { layered: true })).toEqual({ effect: 'flash-develop', developSec: 2 });
    expect(sceneImageEffect({ ...still, imageEffectSec: null }, { layered: true }).developSec).toBe(3);
    expect(sceneImageEffect(still, { layered: false })).toBeNull();
    expect(sceneImageEffect({ ...still, visualLayer: 'footage' }, { layered: true })).toBeNull();
    expect(sceneImageEffect({ ...still, imageEffect: 'unknown' }, { layered: true })).toBeNull();
  });
});

// Per-frame mean luma and mean chroma distance from neutral, read back at W x H.
function frameStats(path) {
  const raw = run(['-i', path, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
  const size = W * H;
  const frameBytes = size * 1.5;
  return Array.from({ length: raw.length / frameBytes }, (_, f) => {
    const frame = raw.subarray(f * frameBytes, (f + 1) * frameBytes);
    const luma = frame.subarray(0, size).reduce((sum, v) => sum + v, 0) / size;
    const chroma = frame.subarray(size).reduce((sum, v) => sum + Math.abs(v - 128), 0) / (size / 2);
    return { luma, chroma };
  });
}

// Uniquely catches the effect's filter graph failing in ffmpeg, drifting from the
// curves the animatic paints, or adding time to the shot.
describe.skipIf(!ffmpeg)('camera flash develop in the final render', () => {
  it('opens white, develops through the grey-green emulsion and holds the still, in the shot\'s own frames', () => {
    const song = join(dir, 'song.wav');
    const imagePath = join(dir, 'still.png');
    run(['-f', 'lavfi', '-i', `color=0xd02020:s=${W}x${H}`, '-frames:v', '1', '-y', imagePath]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-y', song]);
    const effect = { effect: 'flash-develop', developSec: 1 };
    const clip = { sceneId: 's1', layer: 'still', imagePath, move: 'hold', inSec: 0, outSec: 3, duration: 3, sourceSec: 3, effect };
    const output = join(dir, 'develop.mp4');
    const plan = buildMusicVideoFfmpegArgs([clip], song, output, { audioDurationSec: 3 });
    run(plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress')));
    const stats = frameStats(output);
    expect(stats).toHaveLength(3 * 24); // a render with no footage runs at 24 fps
    const held = stats[stats.length - 1];
    // Frame 0 is the flash: near white, no colour.
    expect(stats[0].luma).toBeGreaterThan(230);
    expect(stats[0].chroma).toBeLessThan(6);
    // Just after the flash the emulsion hides the colour; it fills in as the photo develops.
    const early = stats[Math.round(0.35 * 24)];
    expect(early.luma).toBeLessThan(held.luma + 30);
    expect(early.chroma).toBeLessThan(held.chroma * 0.25);
    expect(stats[Math.round(0.7 * 24)].chroma).toBeGreaterThan(early.chroma);
    // From the end of the develop it holds the still exactly.
    expect(Math.abs(stats[24].chroma - held.chroma)).toBeLessThan(2);
    expect(Math.abs(stats[60].luma - held.luma)).toBeLessThan(1);
    // The animatic paints the same moments.
    expect(imageEffectState(effect, 0)).toMatchObject({ flash: 1, fog: 1, saturation: 0 });
    expect(imageEffectState(effect, 1)).toEqual({ flash: 0, fog: 0, contrast: 1, saturation: 1 });
  });

  it('picks up a shot cut into pieces where the piece before it left off', () => {
    const song = join(dir, 'song2.wav');
    const imagePath = join(dir, 'still2.png');
    run(['-f', 'lavfi', '-i', `color=0x2040d0:s=${W}x${H}`, '-frames:v', '1', '-y', imagePath]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-y', song]);
    const effect = { effect: 'flash-develop', developSec: 2 };
    const output = join(dir, 'piece.mp4');
    const plan = buildMusicVideoFfmpegArgs([{ sceneId: 's1', layer: 'still', imagePath, move: 'hold', inSec: 0, outSec: 1, duration: 1, sourceSec: 1, effect, effectAtSec: 1 }],
      song, output, { audioDurationSec: 1 });
    run(plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress')));
    const first = frameStats(output)[0];
    // A second in, the flash is long gone and the picture is part-developed.
    expect(first.luma).toBeLessThan(200);
    expect(first.chroma).toBeGreaterThan(2);
  });
});

// Uniquely catches the scene PATCH refusing the effect fields or an out-of-range develop.
describe('a shot\'s image effect on the board', () => {
  const project = { id: 'mv-1', scenes: [{ sceneId: 's1', order: 0, startSec: 0, endSec: 4, takes: [] }] };
  it('saves an effect on a still, clears it with null and refuses an unknown effect or develop length', () => {
    const { project: set } = applySceneUpdate(project, 's1', { visualLayer: 'still', imageEffect: 'flash-develop', imageEffectSec: 4 });
    expect(set.scenes[0]).toMatchObject({ visualLayer: 'still', imageEffect: 'flash-develop', imageEffectSec: 4 });
    expect(applySceneUpdate(set, 's1', { imageEffect: null }).project.scenes[0].imageEffect).toBeNull();
    expect(() => applySceneUpdate(project, 's1', { imageEffect: 'sparkle' })).toThrow();
    expect(() => applySceneUpdate(project, 's1', { imageEffectSec: 120 })).toThrow();
  });

  it('keeps a shot\'s image effect, and the still it plays on, through a re-plan of the same span', () => {
    const { project: set } = applySceneUpdate(project, 's1', { visualLayer: 'still', imageEffect: 'flash-develop', imageEffectSec: 4 });
    const { scenes } = replaceScenes(set, [{ startSec: 0, endSec: 4, prompt: 'Re-planned' }]);
    expect(scenes[0]).toMatchObject({ sceneId: 's1', visualLayer: 'still', imageEffect: 'flash-develop', imageEffectSec: 4 });
  });
});
