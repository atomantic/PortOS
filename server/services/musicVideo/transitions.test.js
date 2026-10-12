import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { transitionGlitchFrames } from '../../lib/musicVideoTransitions.js';
import { buildMusicVideoFfmpegArgs } from './render.js';
import { applySceneUpdate } from './projectsLogic.js';

const ffmpeg = await findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'portos-mv-transitions-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 });
const FPS = 12;
const W = 96;
const H = 64;

// Uniquely catches where a glitch lands: which cut a shot's in/out names, an
// intercut partner or a split shot glitching mid-shot, and the video's ends.
describe('transitionGlitchFrames', () => {
  const piece = (sceneId, startFrame, endFrame, extra = {}) => ({ sceneId, startFrame, endFrame, ...extra });
  const framesOf = (sections) => transitionGlitchFrames(sections).map((g) => `${g.frame}:${g.style}`);

  it('puts a shot\'s glitch out on its cut to the next shot, and the outgoing choice wins over the next shot\'s in', () => {
    expect(framesOf([piece('a', 0, 24, { transitionOut: 'vhs-glitch' }), piece('b', 24, 48, { transitionIn: 'vhs-dropout' })]))
      .toEqual(['23:vhs-glitch', '24:vhs-glitch', '25:vhs-glitch']);
    expect(framesOf([piece('a', 0, 24), piece('b', 24, 48, { transitionIn: 'vhs-dropout' })])).toEqual(['23:vhs-dropout', '24:vhs-dropout']);
  });

  it('glitches the opening and closing frames for the first shot\'s in and the last shot\'s out', () => {
    expect(framesOf([piece('a', 0, 24, { transitionIn: 'vhs-dropout', transitionOut: 'vhs-dropout' })])).toEqual(['0:vhs-dropout', '1:vhs-dropout', '22:vhs-dropout', '23:vhs-dropout']);
  });

  it('skips intercut partners and glitches a split shot only around the whole shot', () => {
    const sections = [
      piece('a', 0, 10, { transitionIn: 'vhs-dropout', transitionOut: 'vhs-glitch' }),
      piece('b', 10, 20, { partner: true, transitionOut: 'vhs-tracking' }),
      piece('a', 20, 30, { transitionIn: 'vhs-dropout', transitionOut: 'vhs-glitch' }),
      piece('c', 30, 40),
    ];
    expect(framesOf(sections)).toEqual(['0:vhs-dropout', '1:vhs-dropout', '29:vhs-glitch', '30:vhs-glitch', '31:vhs-glitch']);
  });
});

// Per-frame pixel spread of a raw gray video: ~0 on a flat colour, high once glitched.
function frameSpreads(path) {
  const raw = run(['-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const size = W * H;
  return Array.from({ length: raw.length / size }, (_, f) => {
    const px = raw.subarray(f * size, (f + 1) * size);
    const mean = px.reduce((sum, v) => sum + v, 0) / size;
    return Math.sqrt(px.reduce((sum, v) => sum + (v - mean) ** 2, 0) / size);
  });
}

// Uniquely catches the glitch filter chain failing in ffmpeg, landing on the
// wrong frames, or adding time to the edit.
describe.skipIf(!ffmpeg)('a VHS glitch on a cut in the final render', () => {
  it.each([['vhs-glitch', [11, 12, 13]], ['channel-change', [9, 10, 11, 12, 13, 14, 15]]])('%s repaints only the frames around the cut and keeps every frame of the edit', (style, expected) => {
    const song = join(dir, 'song.wav');
    const clips = ['0x2050a0', '0xa05020'].map((color, i) => {
      const videoPath = join(dir, `clip${i}.mp4`);
      run(['-f', 'lavfi', '-i', `color=${color}:s=${W}x${H}:r=${FPS}:d=1`, '-pix_fmt', 'yuv420p', '-y', videoPath]);
      return { sceneId: `s${i}`, videoPath, width: W, height: H, fps: FPS, duration: 1, sourceSec: 1, loop: false, inSec: 0, outSec: 1, frameFit: 'fill' };
    });
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-y', song]);
    clips[0].transitionOut = style;
    const output = join(dir, `${style}.mp4`);
    const plan = buildMusicVideoFfmpegArgs(clips, song, output, { audioDurationSec: 2, frameGrid: true });
    run(plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress')));
    expect(plan.totalDuration).toBe(2);
    expect(plan.sections.map((s) => [s.startSec, s.endSec])).toEqual([[0, 1], [1, 2]]);
    const spreads = frameSpreads(output);
    expect(spreads).toHaveLength(2 * FPS);
    expect(spreads.map((s, f) => (s > 4 ? f : null)).filter((f) => f != null)).toEqual(expected);
  });
});

// Uniquely catches the scene PATCH refusing the new fields, keeping a cleared one, or taking an unknown style.
describe('a shot\'s transitions on the board', () => {
  const project = { id: 'mv-1', scenes: [{ sceneId: 's1', order: 0, startSec: 0, endSec: 4, takes: [] }] };
  it('saves a glitch on either side, clears it with null and refuses an unknown style', () => {
    const { project: set } = applySceneUpdate(project, 's1', { transitionIn: 'vhs-dropout', transitionOut: 'vhs-glitch' });
    expect(set.scenes[0]).toMatchObject({ transitionIn: 'vhs-dropout', transitionOut: 'vhs-glitch' });
    const { project: cleared } = applySceneUpdate(set, 's1', { transitionOut: null });
    expect(cleared.scenes[0].transitionOut).toBeNull();
    expect(() => applySceneUpdate(project, 's1', { transitionOut: 'crossfade' })).toThrow();
  });
});
