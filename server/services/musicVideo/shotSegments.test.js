/**
 * Per-shot render segments, against real ffmpeg on tiny generated clips: the
 * stitched segments are the picture the whole-film graph draws (cut effects
 * and glitches that cross a cut included), a tweak to one shot re-renders only
 * the segments it reaches, and a film look change keeps every base segment.
 */
import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-shot-segments-test-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));

const fixture = { clips: [], audioPath: null };
vi.mock('./render.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    planMusicVideoRender: vi.fn(async () => ({
      ffmpeg: 'ffmpeg', audioPath: fixture.audioPath, composed: true, clips: fixture.clips.map((c) => ({ ...c })),
      audioDurationSec: 3, soundBed: null, aspect: null,
    })),
  };
});

const { planShotSegments, renderMissingSegments, stitchSegments, shotFilmLook } = await import('./shotSegments.js');
const { buildMusicVideoFfmpegArgs } = await import('./render.js');

afterAll(cleanupTempDataRoots);

const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
const probe = (path, entries) => execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', entries, '-of', 'default=nw=1:nk=1', path]).toString().trim().split('\n');

const project = (over = {}) => ({
  id: 'mv-segments-test', name: 'Example', composition: { mode: 'composed' },
  scenes: [{ sceneId: 'a', order: 0 }, { sceneId: 'b', order: 1 }, { sceneId: 'c', order: 2 }],
  ...over,
});
const footage = (sceneId, path, over = {}) => ({
  sceneId, videoPath: path, width: 320, height: 180, fps: 24, duration: 1, sourceSec: 2, inSec: 0, outSec: 1, loop: false, frameFit: 'fill', ...over,
});

let media;
beforeAll(() => {
  media = join(ROOT(), 'fixture');
  mkdirSync(media, { recursive: true });
  for (const [name, src] of [['a', 'testsrc2'], ['b', 'smptebars'], ['c', 'rgbtestsrc']]) {
    run(['-f', 'lavfi', '-i', `${src}=s=320x180:r=24`, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(media, `${name}.mp4`)]);
  }
  fixture.audioPath = join(media, 'song.wav');
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-y', fixture.audioPath]);
  fixture.clips = [
    // A dissolves into B (B's footage is read over A's end) with a glitch on the cut.
    footage('a', join(media, 'a.mp4'), { cutEffect: { enabled: true, style: 'dissolve', overlapSec: 0.5 }, transitionOut: 'vhs-glitch' }),
    footage('b', join(media, 'b.mp4')),
    footage('c', join(media, 'c.mp4')),
  ];
});

describe('shot segments', () => {
  it('stitch to the picture the whole-film graph draws, with the song under it', async () => {
    const plan = await planShotSegments(project());
    expect(plan.segments.map((s) => [s.sceneId, s.frames])).toEqual([['a', 24], ['b', 24], ['c', 24]]);
    expect(await renderMissingSegments(plan, { concurrency: 2 })).toBe(0);
    const out = join(ROOT(), 'stitched.mp4');
    await stitchSegments(plan, out);
    expect(probe(out, 'stream=codec_type').sort()).toEqual(['audio', 'video']);
    expect(probe(out, 'stream=nb_read_frames')).toContain('72');

    // The whole film through the one-graph path, then compared frame by frame.
    const whole = join(ROOT(), 'whole.mp4');
    const { args } = buildMusicVideoFfmpegArgs(fixture.clips, fixture.audioPath, whole, { audioDurationSec: 3, frameGrid: true });
    run(args.filter((a, i) => a !== '-progress' && args[i - 1] !== '-progress'));
    const report = execFileSync('sh', ['-c', `ffmpeg -hide_banner -i '${out}' -i '${whole}' -lavfi psnr -f null - 2>&1 | grep -o 'average:[0-9.inf]*'`]).toString();
    const average = report.split(':')[1].trim();
    expect(average === 'inf' || Number(average) > 35).toBe(true);
  }, 60000);

  it('re-renders only the segments a shot tweak reaches, and keeps bases through a look change', async () => {
    const before = await planShotSegments(project());
    // B played faster: B changes, and so does A, which shows B's footage in its dissolve.
    fixture.clips[1] = { ...fixture.clips[1], rate: 1.5 };
    const tweaked = await planShotSegments(project());
    expect(tweaked.segments.map((s, i) => s.baseKey === before.segments[i].baseKey)).toEqual([false, false, true]);
    expect(tweaked.segments.map((s) => existsSync(s.path))).toEqual([false, false, true]);

    const look = { preset: 'vhs', grain: 0.3 };
    const looked = await planShotSegments(project({ filmLook: look }));
    expect(looked.segments.map((s, i) => s.baseKey === tweaked.segments[i].baseKey)).toEqual([true, true, true]);
    expect(looked.segments.every((s) => s.lookKey && s.path !== s.basePath)).toBe(true);

    // A shot with its own look keeps it when the video's look changes.
    const pinned = { preset: 'polaroid', grain: 0.2 };
    const scenes = project().scenes.map((s) => (s.sceneId === 'c' ? { ...s, filmLook: pinned } : s));
    const a = await planShotSegments(project({ scenes, filmLook: look }));
    const b = await planShotSegments(project({ scenes, filmLook: { preset: 'super8' } }));
    expect(a.segments[2].path).toBe(b.segments[2].path);
    expect(a.segments[0].path).not.toBe(b.segments[0].path);
    expect(shotFilmLook({ filmLook: look }, { filmLook: { preset: 'none' } })).toBeNull();
  }, 60000);
});
