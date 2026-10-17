import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg, findFfprobe } from '../../lib/ffmpeg.js';
import { FILTER_GRAPH_ARG_LIMIT, filterGraphViaFile } from '../../lib/ffmpegFilterGraph.js';
import { MUSIC_VIDEO_TRANSITION_STYLES, sceneTransitions, shotGlitchFrames, transitionGlitchFrames } from '../../lib/musicVideoTransitions.js';
import { buildMusicVideoFfmpegArgs } from './render.js';
import { applySceneUpdate } from './projectsLogic.js';

const ffmpeg = await findFfmpeg();
const ffprobe = await findFfprobe();
const dir = mkdtempSync(join(tmpdir(), 'portos-mv-transitions-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// The unchanged 30-input fixture spawned up to 601 native threads with ffmpeg
// 8.1.1 defaults; explicitly budgeting each decoder, encoder and filter pool
// reduced the observed peak to 16. These tiny frames need no native fan-out.
// Bound synchronous children too: Vitest's timer cannot interrupt execFileSync.
const FFMPEG_BUDGET_MS = 25000; // Leave 5s of the existing 30s test budget for diagnostics/cleanup.
// The long-edit encode is ~4s idle but single-threaded, so a saturated full-suite run (hundreds of workers) stretches it past 25s.
const LONG_EDIT_BUDGET_MS = 110000;
const LONG_EDIT_TEST_TIMEOUT_MS = LONG_EDIT_BUDGET_MS + 10000;
const run = (args, timeout = FFMPEG_BUDGET_MS) => execFileSync(ffmpeg, [
  '-v', 'error', '-nostdin', '-filter_threads', '1', '-filter_complex_threads', '1',
  // Decoder options apply to the NEXT input; one leading -threads only caps
  // the first of the long edit's 30 inputs. The final option caps the encoder.
  ...args.slice(0, -1).flatMap((arg) => arg === '-i' ? ['-threads', '1', arg] : [arg]),
  '-threads', '1', args.at(-1),
], { timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
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

// Uniquely catches where an in-shot glitch lands: its time counted from the
// shot's start, its stretch over a set length, staying inside the shot, and a
// split or intercut shot painting it once.
describe('shotGlitchFrames', () => {
  const FPS24 = 24;
  const piece = (scene, extra = {}) => ({ sceneId: scene.sceneId, startFrame: Math.round(scene.startSec * FPS24),
    endFrame: Math.round(scene.endSec * FPS24), ...sceneTransitions(scene), ...extra });
  const framesOf = (pieces) => shotGlitchFrames(pieces, FPS24).map((g) => `${g.frame}:${g.index}`);

  it('starts the glitch at its time in the shot and stretches the style over a set length', () => {
    const shot = { sceneId: 'a', startSec: 10, endSec: 14, glitches: [{ atSec: 2, style: 'color-block' }] };
    expect(framesOf([piece(shot)])).toEqual(['288:0', '289:1', '290:2', '291:3']);
    const long = { ...shot, glitches: [{ atSec: 2, style: 'color-block', lengthSec: 0.25 }] };
    expect(framesOf([piece(long)])).toEqual(['288:0', '289:0', '290:1', '291:2', '292:2', '293:3']);
  });

  it('never paints past the shot, whether timed or stretched past its end', () => {
    const late = { sceneId: 'a', startSec: 0, endSec: 1, glitches: [{ atSec: 5, style: 'vhs-dropout' }] };
    expect(framesOf([piece(late)])).toEqual(['23:0']);
    const long = { sceneId: 'a', startSec: 0, endSec: 1, glitches: [{ atSec: 0.9, style: 'color-block', lengthSec: 0.5 }] };
    expect(framesOf([piece(long), piece({ sceneId: 'b', startSec: 1, endSec: 2 })])).toEqual(['21:0', '22:0', '23:0']);
  });

  it('paints a split shot\'s glitch once, only on its own pieces, and none for an intercut partner', () => {
    const shot = { sceneId: 'a', startSec: 0, endSec: 4, glitches: [{ atSec: 1, style: 'vhs-dropout' }, { atSec: 1.5, style: 'vhs-dropout' }] };
    const other = { sceneId: 'b', startSec: 4, endSec: 8, glitches: [{ atSec: 1, style: 'vhs-dropout' }] };
    const pieces = [{ ...piece(shot), endFrame: 36 }, { ...piece(other, { partner: true }), startFrame: 36, endFrame: 48 }, { ...piece(shot), startFrame: 48, endFrame: 96 }];
    expect(framesOf(pieces)).toEqual(['24:0', '25:1']);
  });
});

// Per-frame pixel spread of a raw gray video: ~0 on a flat colour, high once glitched.
function frameSpreads(path, timeout) {
  const raw = run(['-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], timeout);
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
  // A rewind's smeared bands also split the stream inside the chain and lay it back.
  it.each([['vhs-glitch', [11, 12, 13]], ['channel-change', [9, 10, 11, 12, 13, 14, 15]], ['vhs-rewind', [8, 9, 10, 11, 12, 13, 14, 15]]])('%s repaints only the frames around the cut and keeps every frame of the edit', (style, expected) => {
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

// Uniquely catches the encode's output rate drifting from the project's fps
// (ffmpeg 7.0 picked 25 fps and re-timed the graph's frames, #11476).
describe('the render pins the output frame rate', () => {
  const clipsAt = (fps, videoPath = 'c.mp4') => [0, 1].map((i) => ({ sceneId: `s${i}`, videoPath, width: W, height: H, fps, duration: 1, sourceSec: 1, loop: false, inSec: 0, outSec: 1, frameFit: 'fill' }));

  it('passes the plan fps as an explicit output rate', () => {
    const { args, fps } = buildMusicVideoFfmpegArgs(clipsAt(FPS), 's.wav', 'o.mp4', { audioDurationSec: 2, frameGrid: true });
    expect(fps).toBe(FPS);
    expect(args[args.indexOf('-r') + 1]).toBe(String(FPS));
    expect(args.indexOf('-r')).toBeGreaterThan(args.indexOf('-filter_complex'));
    expect(args.indexOf('-r')).toBeLessThan(args.indexOf('-c:v'));
  });

  it.skipIf(!ffmpeg || !ffprobe)('encodes a stream whose r_frame_rate is the plan fps with one frame per graph frame', () => {
    const song = join(dir, 'fps-song.wav');
    const clips = ['0x2050a0', '0xa05020'].map((color, i) => {
      const videoPath = join(dir, `fps-clip${i}.mp4`);
      run(['-f', 'lavfi', '-i', `color=${color}:s=${W}x${H}:r=${FPS}:d=1`, '-pix_fmt', 'yuv420p', '-y', videoPath]);
      return { ...clipsAt(FPS, videoPath)[i] };
    });
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-y', song]);
    const output = join(dir, 'fps.mp4');
    const plan = buildMusicVideoFfmpegArgs(clips, song, output, { audioDurationSec: 2, frameGrid: true });
    run(plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress')));
    const probe = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=r_frame_rate,nb_read_frames', '-of', 'json', output],
    { timeout: FFMPEG_BUDGET_MS, killSignal: 'SIGKILL' }).toString();
    const stream = JSON.parse(probe).streams[0];
    expect(stream.r_frame_rate).toBe(`${FPS}/1`);
    expect(Number(stream.nb_read_frames)).toBe(2 * FPS);
  });
});

// Uniquely catches a film or camera effect's filters failing in ffmpeg, adding
// time, or painting outside its frames around the cut.
describe.skipIf(!ffmpeg)('film and camera effects on a cut in the final render', () => {
  const renderRgb = (name, transitionOut) => {
    const song = join(dir, 'song.wav');
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-y', song]);
    const clips = ['0x2050a0', '0xa05020'].map((color, i) => {
      const videoPath = join(dir, `fx${i}.mp4`);
      run(['-f', 'lavfi', '-i', `color=${color}:s=${W}x${H}:r=${FPS}:d=1`, '-pix_fmt', 'yuv420p', '-y', videoPath]);
      return { sceneId: `s${i}`, videoPath, width: W, height: H, fps: FPS, duration: 1, sourceSec: 1, loop: false, inSec: 0, outSec: 1, frameFit: 'fill' };
    });
    if (transitionOut) clips[0].transitionOut = transitionOut;
    const output = join(dir, `${name}.mp4`);
    const plan = buildMusicVideoFfmpegArgs(clips, song, output, { audioDurationSec: 2, frameGrid: true });
    run(plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress')));
    expect(plan.totalDuration).toBe(2);
    return run(['-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  };
  it.each(['film-burn', 'light-leak', 'gate-jump', 'shutter', 'film-scratches', 'color-split'])('%s repaints only its frames around the cut', (style) => {
    const clean = renderRgb('fx-clean', null);
    const fx = renderRgb(`fx-${style}`, style);
    expect(fx.length).toBe(clean.length);
    const size = W * H * 3;
    const changed = Array.from({ length: fx.length / size }, (_, f) => f)
      .filter((f) => fx.subarray(f * size, (f + 1) * size).some((v, i) => Math.abs(v - clean[f * size + i]) > 6));
    const { lead, frames } = MUSIC_VIDEO_TRANSITION_STYLES[style];
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((f) => f >= FPS - lead && f < FPS - lead + frames.length)).toBe(true);
  });
});

// Uniquely catches a long edit exceeding the cross-platform argument budget:
// the graph must go by file and still render all 360 frames.
describe.skipIf(!ffmpeg)('effects on every cut of a long edit', () => {
  it('passes the filter graph to ffmpeg in a file and renders every frame', async () => {
    const deadline = performance.now() + LONG_EDIT_BUDGET_MS;
    const timings = [];
    let version = 'unprobed';
    let graphBytes = 0;
    const remaining = () => {
      const ms = Math.floor(deadline - performance.now());
      if (ms <= 0) throw new Error(`Long-edit cumulative ${LONG_EDIT_BUDGET_MS}ms subprocess budget exhausted`);
      return ms;
    };
    const measured = async (phase, fn) => {
      const start = performance.now();
      try {
        return await fn();
      } catch (err) {
        // Avoid echoing the graph/argv: report the failing phase and a bounded
        // ffmpeg stderr tail, including ETIMEDOUT and SIGKILL on a deadline.
        const stderr = String(err.stderr || '').trim().slice(-1000).replace(/\r?\n/g, ' | ');
        throw new Error(`Long-edit ${phase} failed: ${err.code || err.message}; signal=${err.signal || 'none'}; ${stderr}`);
      } finally {
        timings.push(`${phase}=${Math.round(performance.now() - start)}ms`);
      }
    };
    try {
      version = await measured('version', () => execFileSync(ffmpeg, ['-version'], { timeout: Math.min(5000, remaining()), killSignal: 'SIGKILL' }).toString().split('\n')[0]);
      const song = join(dir, 'long-song.wav');
      await measured('audio-fixture', () => run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-y', song], remaining()));
      const videoPath = join(dir, 'long-clip.mp4');
      await measured('video-fixture', () => run(['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=1`, '-pix_fmt', 'yuv420p', '-y', videoPath], remaining()));
      const styles = ['light-leak', 'vhs-rewind', 'film-burn'];
      const clips = Array.from({ length: 30 }, (_, i) => ({
        videoPath, width: W, height: H, fps: FPS, duration: 1, sourceSec: 1, loop: false, inSec: 0, outSec: 1, frameFit: 'fill',
        ...sceneTransitions({ sceneId: `s${i}`, startSec: i, endSec: i + 1, transitionIn: styles[i % 3], transitionOut: styles[(i + 1) % 3], glitches: [{ atSec: 0.5, style: styles[(i + 2) % 3] }] }),
        sceneId: `s${i}`,
      }));
      const output = join(dir, 'long-edit.mp4');
      const plan = await measured('graph-plan', () => buildMusicVideoFfmpegArgs(clips, song, output, { audioDurationSec: 30, frameGrid: true }));
      const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
      expect(Buffer.byteLength(graph)).toBeGreaterThan(FILTER_GRAPH_ARG_LIMIT);
      graphBytes = Buffer.byteLength(graph);
      const encode = await measured('graph-file', () => filterGraphViaFile(ffmpeg, plan.args, join(dir, 'long-edit.filtergraph')));
      expect(encode.args).not.toContain('-filter_complex');
      expect(encode.args).not.toContain(graph);
      expect(readFileSync(encode.file, 'utf8')).toBe(graph);
      await measured('encode', () => run(encode.args.filter((arg, i) => !(arg === '-progress' || encode.args[i - 1] === '-progress')), remaining()));
      expect(await measured('decode', () => frameSpreads(output, remaining()))).toHaveLength(30 * FPS);
    } finally {
      console.log(`⏱️ Long-edit ${version}; workers=${process.env.PORTOS_PREGATE_MAX_WORKERS || process.env.PORTOS_CI_MAX_WORKERS || 'runner default'}; threads=1/input,1/output,1/filter; budget=${LONG_EDIT_BUDGET_MS}ms; graph=${graphBytes}B; ${timings.join(', ')}`);
    }
  }, LONG_EDIT_TEST_TIMEOUT_MS);
});

// Uniquely catches the in-shot glitch filters failing in ffmpeg, landing on
// the wrong frames, or adding time to the edit.
describe.skipIf(!ffmpeg)('a color block glitch inside a shot in the final render', () => {
  it('repaints only the frames from its time in the shot and keeps every frame of the edit', () => {
    const song = join(dir, 'song.wav');
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-y', song]);
    const scenes = [{ sceneId: 's0', startSec: 0, endSec: 1, glitches: [{ atSec: 0.5, style: 'color-block', lengthSec: 0.25 }] }, { sceneId: 's1', startSec: 1, endSec: 2 }];
    const clips = ['0x2050a0', '0xa05020'].map((color, i) => {
      const videoPath = join(dir, `shot${i}.mp4`);
      run(['-f', 'lavfi', '-i', `color=${color}:s=${W}x${H}:r=${FPS}:d=1`, '-pix_fmt', 'yuv420p', '-y', videoPath]);
      return { sceneId: `s${i}`, videoPath, width: W, height: H, fps: FPS, duration: 1, sourceSec: 1, loop: false, inSec: 0, outSec: 1, frameFit: 'fill', ...sceneTransitions(scenes[i]) };
    });
    const output = join(dir, 'color-block.mp4');
    const plan = buildMusicVideoFfmpegArgs(clips, song, output, { audioDurationSec: 2, frameGrid: true });
    run(plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress')));
    expect(plan.totalDuration).toBe(2);
    const spreads = frameSpreads(output);
    expect(spreads).toHaveLength(2 * FPS);
    expect(spreads.map((s, f) => (s > 1 ? f : null)).filter((f) => f != null)).toEqual([6, 7, 8]);
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

  it('saves in-shot glitches, clears them with null and refuses an unknown style', () => {
    const glitches = [{ atSec: 1.5, style: 'color-block', lengthSec: 0.5 }];
    const { project: set } = applySceneUpdate(project, 's1', { glitches });
    expect(set.scenes[0].glitches).toEqual(glitches);
    expect(applySceneUpdate(set, 's1', { glitches: null }).project.scenes[0].glitches).toBeNull();
    expect(() => applySceneUpdate(project, 's1', { glitches: [{ atSec: 1, style: 'crossfade' }] })).toThrow();
  });
});
