import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { cutEffectCuts, plannedCutEffect, plannedTransitions, sceneCutEffect } from '../../lib/musicVideoCutEffects.js';
import { buildMusicVideoFfmpegArgs } from './render.js';
import { applySceneUpdate } from './projectsLogic.js';

const ffmpeg = await findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'portos-mv-cut-effects-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 });
const FPS = 12;
const W = 64;
const H = 48;
const toggle = (extra = {}) => sceneCutEffect({ cutEffect: { style: 'beat-toggle', overlapSec: 0.5, ...extra } });

// Uniquely catches where a beat toggle flips: which beats (or half beats) in the
// overlap, the even fallback with no beat grid, and which cuts carry one.
describe('cutEffectCuts', () => {
  const piece = (sceneId, startFrame, endFrame, extra = {}) => ({ sceneId, startFrame, endFrame, ...extra });

  it('flips to the incoming shot on each beat in the overlap before the cut, incoming first', () => {
    const [cut] = cutEffectCuts([piece('a', 0, 24, { cutEffect: toggle() }), piece('b', 24, 48)], { fps: 24, beats: [0.25, 0.5, 0.75, 1] });
    expect(cut).toEqual({ style: 'beat-toggle', index: 0, cutFrame: 24, windowFrames: 12, incoming: [[12, 18]] });
    const [half] = cutEffectCuts([piece('a', 0, 24, { cutEffect: toggle({ rate: 'half' }) }), piece('b', 24, 48)], { fps: 24, beats: [0.25, 0.5, 0.75, 1] });
    expect(half).toMatchObject({ incoming: [[12, 15], [18, 21]] });
    const [even] = cutEffectCuts([piece('a', 0, 24, { cutEffect: toggle() }), piece('b', 24, 48)], { fps: 24 });
    expect(even.incoming).toEqual([[12, 15], [18, 21]]);
  });

  it('plays only when switched on, and never on an intercut partner or inside a split shot', () => {
    expect(cutEffectCuts([piece('a', 0, 24, { cutEffect: toggle({ enabled: false }) }), piece('b', 24, 48)], { fps: 24 })).toEqual([]);
    expect(cutEffectCuts([piece('a', 0, 24, { cutEffect: toggle() }), piece('b', 24, 48, { partner: true })], { fps: 24 })).toEqual([]);
    expect(cutEffectCuts([piece('a', 0, 24, { cutEffect: toggle() }), piece('b', 24, 36), piece('a', 36, 48, { cutEffect: toggle() })], { fps: 24 })).toEqual([]);
  });

  // Uniquely catches a dissolve or fade landing off the cut, overrunning a short shot, or a fade missing the video's end.
  it('fades a dissolve in before the cut, and a fade through black half each side of it or out at the end', () => {
    const effect = (style, overlapSec) => sceneCutEffect({ cutEffect: { style, overlapSec } });
    expect(cutEffectCuts([piece('a', 0, 24, { cutEffect: effect('dissolve', 0.5) }), piece('b', 24, 48)], { fps: 24 }))
      .toEqual([{ style: 'dissolve', index: 0, cutFrame: 24, windowFrames: 12, incoming: [[12, 24]] }]);
    // A dissolve longer than its shot starts after the shot's first frame.
    expect(cutEffectCuts([piece('a', 0, 6, { cutEffect: effect('dissolve', 2) }), piece('b', 6, 48)], { fps: 24 })[0]).toMatchObject({ windowFrames: 5 });
    expect(cutEffectCuts([piece('a', 0, 24, { cutEffect: effect('fade-black', 1) }), piece('b', 24, 48)], { fps: 24 }))
      .toEqual([{ style: 'fade-black', index: 0, cutFrame: 24, outFrames: 12, inFrames: 12 }]);
    expect(cutEffectCuts([piece('a', 0, 24), piece('b', 24, 48, { cutEffect: effect('fade-black', 1) })], { fps: 24 }))
      .toEqual([{ style: 'fade-black', index: 1, cutFrame: 48, outFrames: 24, inFrames: 0 }]);
    // Only a fade has anything to do on the last shot.
    expect(cutEffectCuts([piece('a', 0, 24, { cutEffect: effect('dissolve', 1) })], { fps: 24 })).toEqual([]);
  });
});

// Uniquely catches a storyboard row's planned transition being misread, or
// overriding a shot that already picked its own (a plain cut included).
describe('a transition the storyboard plans', () => {
  it.each([
    ['Dissolve', 'dissolve'],
    ['Slow dissolve into the bedroom', 'dissolve'],
    ['Crossfade to the band', 'dissolve'],
    ['Fade to her dreaming', 'dissolve'],
    ['Fade to black', 'fade-black'],
    ['Slow fade out', 'fade-black'],
    ['Entry: dissolve from the car. Exit: hard cut', null],
    ['Entry: match cut. Exit: dissolve to the bed', 'dissolve'],
    ['Fade in from black', null],
    ['Cut', null],
    ['Whip pan to the drummer', null],
  ])('reads "%s" as %s', (text, style) => {
    expect(plannedCutEffect(text)?.style ?? null).toBe(style);
  });

  it('stands in only until the shot picks an effect of its own', () => {
    const planned = plannedTransitions([{ sceneId: 's1', transition: 'Dissolve' }]).get('s1');
    expect(sceneCutEffect({ sceneId: 's1' }, planned)).toMatchObject({ style: 'dissolve', enabled: true, overlapSec: 1 });
    expect(sceneCutEffect({ sceneId: 's1', cutEffect: { style: 'dissolve', enabled: false } }, planned)).toMatchObject({ enabled: false });
    expect(sceneCutEffect({ sceneId: 's1', cutEffect: null }, planned)).toBeNull();
  });
});

// Per-frame mean luma of a raw gray video.
function frameMeans(path) {
  const raw = run(['-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const size = W * H;
  return Array.from({ length: raw.length / size }, (_, f) => raw.subarray(f * size, (f + 1) * size).reduce((sum, v) => sum + v, 0) / size);
}

// Uniquely catches the toggle's filters failing in ffmpeg, flipping on the wrong
// frames, adding time, or the incoming clip leaving the song's clock: ignoring its
// in-point (a performance edit or hand-set offset) or speed, or moving the shot itself.
describe.skipIf(!ffmpeg)('a beat toggle across a cut in the final render', () => {
  const song = join(dir, 'song.wav');
  const outgoing = join(dir, 'outgoing.mp4');
  const incoming = join(dir, 'incoming.mp4');
  const render = (incomingTiming) => {
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-y', song]);
    run(['-f', 'lavfi', '-i', `color=white:s=${W}x${H}:r=${FPS}:d=1`, '-pix_fmt', 'yuv420p', '-y', outgoing]);
    // Its brightness climbs 4 levels a frame, so a frame's luma names its place in the clip.
    run(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:r=${FPS}:d=4,geq=lum='40+4*N':cb=128:cr=128`, '-pix_fmt', 'yuv420p', '-y', incoming]);
    const clip = (videoPath, i, extra = {}) => ({ sceneId: `s${i}`, videoPath, width: W, height: H, fps: FPS, duration: 1, sourceSec: 1, loop: false, inSec: 0, outSec: 1, frameFit: 'fill', ...extra });
    const output = join(dir, 'toggle.mp4');
    const plan = buildMusicVideoFfmpegArgs([clip(outgoing, 0, { cutEffect: toggle() }), clip(incoming, 1, incomingTiming)], song, output,
      { audioDurationSec: 2, frameGrid: true, beats: [0.5, 0.75, 1, 1.25] });
    run(plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress')));
    expect(plan.totalDuration).toBe(2);
    const means = frameMeans(output);
    expect(means).toHaveLength(2 * FPS);
    // Outgoing until the first beat (frame 6) and again on frames 9-11, between the flips.
    expect([0, 5, 9, 11].every((f) => means[f] > 200)).toBe(true);
    return means;
  };
  // The clip's Y levels read back as full-range gray.
  const showsClipFrame = (means, f, n) => expect(Math.abs(means[f] - ((40 + 4 * n - 16) * 255) / 219)).toBeLessThan(2.5);

  it('reads the footage before an in-point, so the shot still starts at its in-point', () => {
    // In 0.5 s: the half second before it plays under the flips.
    const means = render({ inSec: 0.5, outSec: 1.5, sourceSec: 3.5, duration: 1 });
    [6, 7, 8].forEach((f, k) => showsClipFrame(means, f, k));
    showsClipFrame(means, 12, 6);
    showsClipFrame(means, 23, 17);
  });

  it('plays on from the clip\'s first frame where it has less footage than the window before its in-point', () => {
    const means = render({ sourceSec: 4 });
    [6, 7, 8].forEach((f, k) => showsClipFrame(means, f, k));
    showsClipFrame(means, 12, 0);
    showsClipFrame(means, 23, 11);
    // A quarter second in, half the window's length: still moving from the first frame, never held.
    const short = render({ inSec: 0.25, outSec: 1.25, sourceSec: 3.75, duration: 1 });
    [6, 7, 8].forEach((f, k) => showsClipFrame(short, f, k));
    showsClipFrame(short, 12, 3);
    // A negative offset holds the shot's first frame, but its flips still move.
    const late = render({ leadSec: 0.25, outSec: 1, sourceSec: 4.25 });
    [6, 7, 8].forEach((f, k) => showsClipFrame(late, f, k));
    showsClipFrame(late, 12, 0);
    showsClipFrame(late, 15, 0);
  });

  it('plays the footage before the in-point at the shot\'s speed', () => {
    // Twice as fast from 1 s into the clip: on the output timebase it starts at 0.5 s.
    const means = render({ rate: 2, inSec: 0.5, outSec: 1.5, sourceSec: 1.5, duration: 1 });
    [6, 7, 8].forEach((f, k) => showsClipFrame(means, f, 2 * k));
    showsClipFrame(means, 12, 12);
    showsClipFrame(means, 23, 34);
  });
});

// Uniquely catches a dissolve or a fade through black failing in ffmpeg, landing
// off its frames, adding time, or a dissolve's incoming clip leaving the song's clock.
describe.skipIf(!ffmpeg)('a dissolve and a fade through black across a cut in the final render', () => {
  const song = join(dir, 'song.wav');
  const outgoing = join(dir, 'fx-outgoing.mp4');
  const incoming = join(dir, 'fx-incoming.mp4');
  const render = (style) => {
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-y', song]);
    run(['-f', 'lavfi', '-i', `color=white:s=${W}x${H}:r=${FPS}:d=1`, '-pix_fmt', 'yuv420p', '-y', outgoing]);
    run(['-f', 'lavfi', '-i', `color=gray:s=${W}x${H}:r=${FPS}:d=1`, '-pix_fmt', 'yuv420p', '-y', incoming]);
    const clip = (videoPath, i, extra = {}) => ({ sceneId: `s${i}`, videoPath, width: W, height: H, fps: FPS, duration: 1, sourceSec: 1, loop: false, inSec: 0, outSec: 1, frameFit: 'fill', ...extra });
    const output = join(dir, `${style}.mp4`);
    const cutEffect = sceneCutEffect({ cutEffect: { style, overlapSec: 0.5 } });
    const plan = buildMusicVideoFfmpegArgs([clip(outgoing, 0, { cutEffect }), clip(incoming, 1)], song, output, { audioDurationSec: 2, frameGrid: true });
    run(plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress')));
    expect(plan.totalDuration).toBe(2);
    const means = frameMeans(output);
    expect(means).toHaveLength(2 * FPS);
    return means;
  };

  it('fades the incoming shot in over the last half second, fully in on the cut', () => {
    const means = render('dissolve');
    const gray = means[23];
    // White until the window (frame 6), then stepping down toward the incoming gray, which holds from the cut.
    expect(means.slice(0, 6).every((m) => m > 250)).toBe(true);
    const window = means.slice(6, 12);
    window.forEach((m, k) => expect(m).toBeLessThan(k === 0 ? 256 : window[k - 1]));
    expect(window.every((m) => m > gray + 2)).toBe(true);
    expect(means.slice(12).every((m) => Math.abs(m - gray) < 2)).toBe(true);
  });

  it('darkens into the cut and lifts after it', () => {
    const means = render('fade-black');
    expect(means.slice(0, 9).every((m) => m > 250)).toBe(true);
    expect(means[11]).toBeLessThan(means[10]);
    expect(means[11]).toBeLessThan(100);
    expect(means[12]).toBeLessThan(20);
    expect(means[14]).toBeGreaterThan(means[13]);
    expect(Math.abs(means[15] - means[23])).toBeLessThan(2);
  });
});

// Uniquely catches the scene PATCH refusing the effect, losing its settings when switched off, or taking an unknown style.
describe('a shot\'s cut effect on the board', () => {
  const project = { id: 'mv-1', scenes: [{ sceneId: 's1', order: 0, startSec: 0, endSec: 4, takes: [] }] };
  it('saves a beat toggle, keeps its settings switched off, clears it with null and refuses an unknown style', () => {
    const cutEffect = { style: 'beat-toggle', enabled: true, overlapSec: 1, rate: 'half' };
    const { project: set } = applySceneUpdate(project, 's1', { cutEffect });
    expect(set.scenes[0].cutEffect).toEqual(cutEffect);
    const { project: off } = applySceneUpdate(set, 's1', { cutEffect: { ...cutEffect, enabled: false } });
    expect(sceneCutEffect(off.scenes[0])).toEqual({ ...cutEffect, enabled: false });
    expect(applySceneUpdate(off, 's1', { cutEffect: null }).project.scenes[0].cutEffect).toBeNull();
    expect(() => applySceneUpdate(project, 's1', { cutEffect: { style: 'wipe' } })).toThrow();
  });
});
