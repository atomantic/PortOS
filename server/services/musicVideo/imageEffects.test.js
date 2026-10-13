import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { imageEffectState, sceneImageEffect } from '../../lib/musicVideoImageEffects.js';
import { sceneImageEffectGlitchFrames } from '../../lib/musicVideoTransitions.js';
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
    expect(imageEffectState(effect, 1)).toEqual({ flash: 0, fog: 0, contrast: 1, saturation: 1, end: 0 });
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

// Uniquely catches an end-frame effect playing without its end frame, changing at the wrong time, or its glitch landing off its cut.
describe('end-frame effects on the storyboard', () => {
  const shot = { sceneId: 'e', startSec: 10, endSec: 13, visualLayer: 'still', imageEffect: 'end-glitch', endImageId: 'end.png' };
  it('changes in the middle by default or at its chosen time, and needs an end frame', () => {
    expect(sceneImageEffect(shot, { layered: true })).toEqual({ effect: 'end-glitch', changeSec: 1.5 });
    expect(sceneImageEffect({ ...shot, imageEffectSec: 1 }, { layered: true }).changeSec).toBe(1);
    expect(sceneImageEffect({ ...shot, imageEffectSec: 6 }, { layered: true }).changeSec).toBe(1.5);
    expect(sceneImageEffect({ ...shot, endImageId: null }, { layered: true })).toBeNull();
  });
  it('places the glitch on the cut to the end frame, inside the shot', () => {
    expect(sceneImageEffectGlitchFrames([shot], 24, { layered: true }).map((g) => g.frame)).toEqual([275, 276, 277]);
    expect(sceneImageEffectGlitchFrames([shot], 24, { layered: false })).toEqual([]);
  });
});

const renderStill = (name, clip, sec) => {
  const song = join(dir, `${name}.wav`);
  run(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-y', song]);
  const output = join(dir, `${name}.mp4`);
  const plan = buildMusicVideoFfmpegArgs([clip], song, output, { audioDurationSec: sec });
  run(plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress')));
  return frameStats(output);
};

// Uniquely catches an end-frame effect's filter graph failing in ffmpeg or changing on the wrong frame.
describe.skipIf(!ffmpeg)('end-frame effects in the final render', () => {
  const still = (name, color) => {
    const path = join(dir, `${name}.png`);
    run(['-f', 'lavfi', '-i', `color=${color}:s=${W}x${H}`, '-frames:v', '1', '-y', path]);
    return path;
  };
  const clipFor = (effect) => ({ sceneId: 's1', layer: 'still', imagePath: still('red', '0xd02020'), endImagePath: still('blue', '0x2040d0'), move: 'hold',
    inSec: 0, outSec: 2, duration: 2, sourceSec: 2, effect: { effect, changeSec: 1 } });
  const isRed = (f) => f.chroma > 40 && f.luma < 120 && f.luma > 50;
  it.each([['end-fade'], ['end-flash'], ['end-glitch']])('%s plays the start frame, then the end frame from the change on', (effect) => {
    const stats = renderStill(effect, clipFor(effect), 2);
    expect(stats).toHaveLength(48);
    const start = stats[10];
    const end = stats[47];
    expect(Math.abs(start.luma - end.luma) + Math.abs(start.chroma - end.chroma)).toBeGreaterThan(10);
    if (effect === 'end-fade') expect(stats[31].luma).not.toBeCloseTo(start.luma, 0);
    // The flash peaks white on the cut.
    if (effect === 'end-flash') expect(stats[24].luma).toBeGreaterThan(230);
    expect(isRed(stats[20]) || stats[20].chroma === start.chroma).toBe(true);
  });
  // Uniquely catches an intercut piece restarting the fade or flash instead of continuing it.
  it('picks a fade or flash up mid-way when a piece starts just after the change', () => {
    const solid = renderStill('fade-whole', clipFor('end-fade'), 2);
    const fade = renderStill('fade-piece', { ...clipFor('end-fade'), effectAtSec: 1.3 }, 1);
    const red = solid[10];
    const blue = solid[47];
    // Half-way through the dissolve, between the two frames, not back on the start frame.
    expect(fade[0].luma).toBeGreaterThan(Math.min(red.luma, blue.luma) + 3);
    expect(fade[0].luma).toBeLessThan(Math.max(red.luma, blue.luma) - 3);
    const flash = renderStill('flash-piece', { ...clipFor('end-flash'), effectAtSec: 1.1 }, 1);
    // Two frames into its fade the flash is fading, not a full white frame again.
    expect(flash[0].luma).toBeLessThan(220);
    expect(flash[0].luma).toBeGreaterThan(blue.luma + 30);
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
