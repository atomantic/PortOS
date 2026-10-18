/**
 * Per-shot render segments, against real ffmpeg on tiny generated clips: the
 * stitched segments are the picture the whole-film graph draws (cut effects
 * and glitches that cross a cut included), a tweak to one shot re-renders only
 * the segments it reaches, and a film look change keeps every base segment.
 */
import { describe, it, expect, vi, afterAll, afterEach, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
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

// The look pass draws in a browser; here it keeps the base picture, which is
// enough to follow which look file each segment lands in.
vi.mock('./filmLookFinish.js', () => ({ applyFilmLookFinish: vi.fn(async () => true) }));
vi.mock('./projects.js', () => ({ getProject: vi.fn(async (id) => (id === fixture.project?.id ? fixture.project : null)), withProjectMediaMutation: async work => work({}) }));

const { planShotSegments, renderMissingSegments, renderSegment, segmentConcurrency, stitchSegments, pruneSegments, listFilmLooks, deleteFilmLook, buildRenderPreview, segmentRendering, cleanupShotSegments, getSegmentCleanup, startShotRender, shotSegmentDir } = await import('./shotSegments.js');
const { buildMusicVideoFfmpegArgs } = await import('./render.js');
const { musicVideoEvents } = await import('./events.js');
const { applyFilmLookFinish } = await import('./filmLookFinish.js');

afterAll(cleanupTempDataRoots);
// A test that makes the look pass fail leaves it passing again for the next one.
afterEach(() => { applyFilmLookFinish.mockReset(); applyFilmLookFinish.mockResolvedValue(true); });

// Runs against the installed ffmpeg; skipped where none is on PATH (Linux CI).
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
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
  if (!hasFfmpeg) return;
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

describe('segmentConcurrency', () => {
  const GB = 1024 ** 3;
  it('renders at most four shots at once, fewer on a small machine', () => {
    expect(segmentConcurrency({ cores: 18, memoryBytes: 128 * GB, override: undefined })).toBe(4);
    expect(segmentConcurrency({ cores: 4, memoryBytes: 128 * GB, override: undefined })).toBe(2);
    expect(segmentConcurrency({ cores: 18, memoryBytes: 4 * GB, override: undefined })).toBe(1);
  });
  it('takes a positive override, capped at 32, and ignores anything else', () => {
    expect(segmentConcurrency({ cores: 18, memoryBytes: 128 * GB, override: '6' })).toBe(6);
    expect(segmentConcurrency({ cores: 18, memoryBytes: 128 * GB, override: '99' })).toBe(32);
    expect(segmentConcurrency({ cores: 18, memoryBytes: 128 * GB, override: '0' })).toBe(4);
    expect(segmentConcurrency({ cores: 18, memoryBytes: 128 * GB, override: 'many' })).toBe(4);
  });
});

describe.skipIf(!hasFfmpeg)('shot segments', () => {
  it('stitch to the picture the whole-film graph draws, with the song under it', async () => {
    const plan = await planShotSegments(project());
    expect(plan.segments.map((s) => [s.sceneId, s.frames])).toEqual([['a', 24], ['b', 24], ['c', 24]]);
    // Each shot a final render finishes is announced, so an open shot card can play it mid-render.
    const announced = [];
    const onShot = (event) => announced.push(`${event.projectId}:${event.sceneId}:${event.state}`);
    musicVideoEvents.on('shot-render', onShot);
    expect(await renderMissingSegments(plan, { concurrency: 2 })).toBe(0);
    musicVideoEvents.off('shot-render', onShot);
    expect(announced.sort()).toEqual(['a', 'b', 'c'].map((id) => `mv-segments-test:${id}:rendered`));
    const out = join(ROOT(), 'stitched.mp4');
    await stitchSegments(plan, out);
    expect(probe(out, 'stream=codec_type').sort()).toEqual(['audio', 'video']);
    expect(probe(out, 'stream=nb_read_frames')).toContain('72');

    // The whole film through the one-graph path, then compared frame by frame.
    const whole = join(ROOT(), 'whole.mp4');
    const { args } = buildMusicVideoFfmpegArgs(fixture.clips, fixture.audioPath, whole, { audioDurationSec: 3, frameGrid: true });
    // Encoded at the segments' preset, and both sides given the segments' BT.709
    // tags: ffmpeg 7 converts between differently tagged inputs before
    // comparing, which scores matching pixels around 27 dB.
    run(args.filter((a, i) => a !== '-progress' && args[i - 1] !== '-progress').map((a, i, all) => (all[i - 1] === '-preset' ? 'medium' : a)));
    const tags = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
    const lavfi = `[0:v]${tags}[a];[1:v]${tags}[b];[a][b]psnr`;
    const report = execFileSync('sh', ['-c', `ffmpeg -hide_banner -i '${out}' -i '${whole}' -lavfi '${lavfi}' -f null - 2>&1 | grep -o 'average:[0-9.inf]*'`]).toString();
    const average = report.split(':')[1].trim();
    expect(average === 'inf' || Number(average) > 35).toBe(true);
  }, 60000);

  it("files an intercut piece under the shot whose span it plays in, with that shot's look", async () => {
    const saved = fixture.clips;
    // C's span plays a piece of B's spare footage in its middle (an intercut partner).
    fixture.clips = [saved[0], saved[1], { ...saved[2], outSec: 0.5, duration: 0.5 },
      { ...saved[1], inSec: 1, outSec: 1.25, duration: 0.25, intercutOf: 'c' }, { ...saved[2], inSec: 0.75, outSec: 1, duration: 0.25 }];
    const pinned = { preset: 'polaroid', grain: 0.2 };
    const scenes = project().scenes.map((s) => (s.sceneId === 'c' ? { ...s, filmLook: pinned } : s));
    const plan = await planShotSegments(project({ scenes })).finally(() => { fixture.clips = saved; });
    expect(plan.segments.map((s) => s.sceneId)).toEqual(['a', 'b', 'c', 'c', 'c']);
    expect(plan.segments[3].look).toMatchObject({ preset: 'polaroid' });
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
    // A shot set to a clean look skips the look pass under a looked video.
    const clean = await planShotSegments(project({ scenes: scenes.map((s) => (s.sceneId === 'c' ? { ...s, filmLook: { preset: 'none' } } : s)), filmLook: look }));
    expect(clean.segments[2].path).toBe(clean.segments[2].basePath);
  }, 60000);

  it('keeps each film look to swap back to, plays what is rendered so far, and deletes a look', async () => {
    const lookA = { preset: 'vhs', grain: 0.3 };
    const lookB = { preset: 'super8', grain: 0.6 };
    fixture.project = project({ filmLook: lookA });
    const planA = await planShotSegments(fixture.project);
    await renderMissingSegments(planA, { concurrency: 2 });

    const whole = await buildRenderPreview(fixture.project.id);
    expect(whole).toMatchObject({ shots: 3, totalShots: 3, complete: true });
    expect(whole.durationSec).toBeCloseTo(3, 5);
    const wholePath = join(planA.dir, whole.name);
    expect(probe(wholePath, 'stream=codec_type').sort()).toEqual(['audio', 'video']);

    fixture.project = project({ filmLook: lookB });
    const planB = await planShotSegments(fixture.project);
    await renderMissingSegments(planB, { concurrency: 2 });
    await pruneSegments(planB);
    // The other look's files survive the prune: switching back only stitches.
    expect(planA.segments.every((s) => existsSync(s.path))).toBe(true);
    const listed = await listFilmLooks(fixture.project.id);
    expect(listed.total).toBe(3);
    expect(listed.looks.map((l) => [l.look.preset, l.current, l.rendered])).toEqual([['super8', true, 3], ['vhs', false, 3]]);

    const left = await deleteFilmLook(fixture.project.id, listed.looks[1].id);
    expect(left.looks.map((l) => l.look.preset)).toEqual(['super8']);
    expect(planA.segments.some((s) => existsSync(s.path))).toBe(false);
    expect(planB.segments.every((s) => existsSync(s.path))).toBe(true);

    // A missing shot in the middle: the player stops before it.
    rmSync(planB.segments[1].path);
    const partial = await buildRenderPreview(fixture.project.id);
    expect(partial).toMatchObject({ shots: 1, totalShots: 3, complete: false });
    expect(partial.durationSec).toBeCloseTo(1, 5);
    // Only the newest preview is kept.
    expect(existsSync(wholePath)).toBe(false);
    expect(probe(join(planB.dir, partial.name), 'stream=nb_read_frames')).toContain('24');
  }, 60000);

  it('deletes the look in use from a cache made before looks were listed, and keeps a pinned shot\'s old look for comparison', async () => {
    fixture.project = project({ filmLook: { preset: 'polaroid', grain: 0.4 } });
    const plan = await planShotSegments(fixture.project);
    await renderMissingSegments(plan, { concurrency: 2 });
    rmSync(join(plan.dir, 'looks.json'));
    const listed = await listFilmLooks(fixture.project.id);
    const inUse = listed.looks.find((l) => l.current);
    expect(inUse.rendered).toBe(3);
    rmSync(join(plan.dir, 'looks.json'));
    const left = await deleteFilmLook(fixture.project.id, inUse.id);
    expect(plan.segments.some((s) => existsSync(s.path))).toBe(false);
    expect(left.looks.map((l) => l.rendered)).toEqual([0]);

    // Changing only a shot's film look keeps its previous effect for comparison.
    const pin = (grain) => project({ scenes: project().scenes.map((sc) => (sc.sceneId === 'c' ? { ...sc, filmLook: { preset: 'polaroid', grain } } : sc)) });
    const before = await planShotSegments(pin(0.2));
    await renderMissingSegments(before, { concurrency: 2 });
    const after = await planShotSegments(pin(0.5));
    await renderMissingSegments(after, { concurrency: 2 });
    await pruneSegments(after);
    expect(existsSync(before.segments[2].path)).toBe(true);
    expect(existsSync(after.segments[2].path)).toBe(true);
  }, 60000);

  it('retires only a successfully replaced shot while another edited shot still needs its replacement', async () => {
    fixture.project = project({ id: 'mv-shot-replacement' });
    const originalClips = fixture.clips;
    const before = await planShotSegments(fixture.project);
    await renderMissingSegments(before, { concurrency: 2 });
    fixture.clips = originalClips.map(clip => ['a', 'b'].includes(clip.sceneId) ? { ...clip, inSec: 0.1, outSec: 1.1 } : clip);
    const after = await planShotSegments(fixture.project);
    let listener;
    const cleaned = new Promise(resolve => {
      listener = event => {
        if (event.projectId !== fixture.project.id) return;
        musicVideoEvents.off('render-cleanup', listener);
        resolve();
      };
      musicVideoEvents.on('render-cleanup', listener);
    });
    try {
      expect(await startShotRender(fixture.project.id, 'a')).toMatchObject({ state: 'rendering' });
      await cleaned;
      expect(existsSync(before.segments[0].path)).toBe(false);
      expect(existsSync(after.segments[0].path)).toBe(true);
      expect(existsSync(before.segments[1].path)).toBe(true);
      expect(existsSync(after.segments[1].path)).toBe(false);
      expect(existsSync(before.segments[2].path)).toBe(true);
    } finally {
      musicVideoEvents.off('render-cleanup', listener);
      fixture.clips = originalClips;
    }
  });

  it('tries a shot whose film look failed again before failing the render', async () => {
    fixture.project = project({ id: 'mv-segments-retry-test', filmLook: { preset: 'vhs', grain: 0.7 } });
    const plan = await planShotSegments(fixture.project);
    applyFilmLookFinish.mockRejectedValueOnce(new Error('render seek timed out @ 0.021s'));
    await renderMissingSegments(plan, { concurrency: 1 });
    expect(plan.segments.every((s) => existsSync(s.path))).toBe(true);

    const again = await planShotSegments(project({ id: 'mv-segments-retry-test', filmLook: { preset: 'vhs', grain: 0.8 } }));
    // A shot that fails both times fails the render.
    applyFilmLookFinish.mockClear().mockRejectedValue(new Error('stalled'));
    await expect(renderMissingSegments(again, { concurrency: 1 })).rejects.toThrow(/stalled/);
    expect(applyFilmLookFinish).toHaveBeenCalledTimes(4);
  }, 60000);

  it('lists a look rendered only shot by shot, and drops an un-pinned shot\'s old look', async () => {
    const id = 'mv-segments-shot-test';
    const lookA = { preset: 'vhs', grain: 0.1 };
    fixture.project = project({ id, filmLook: lookA });
    const planA = await planShotSegments(fixture.project);
    await renderSegment(planA, planA.segments[0]);
    fixture.project = project({ id, filmLook: { preset: 'super8', grain: 0.1 } });
    const planB = await planShotSegments(fixture.project);
    await renderSegment(planB, planB.segments[0]);
    const listed = await listFilmLooks(id);
    expect(listed.looks.map((l) => [l.look.preset, l.rendered])).toEqual([['super8', 1], ['vhs', 1]]);
    await pruneSegments(planB);
    expect(existsSync(planA.segments[0].path)).toBe(true);

    // A shot-pinned look also stays for comparison until explicitly purged.
    const pinnedScenes = project().scenes.map((sc) => (sc.sceneId === 'c' ? { ...sc, filmLook: { preset: 'polaroid', grain: 0.2 } } : sc));
    const pinned = await planShotSegments(project({ id, scenes: pinnedScenes, filmLook: fixture.project.filmLook }));
    await renderSegment(pinned, pinned.segments[2]);
    expect(pinned.segments[2].path).not.toBe(pinned.segments[2].basePath);
    const unpinned = await planShotSegments(fixture.project);
    await pruneSegments(unpinned);
    expect(existsSync(pinned.segments[2].path)).toBe(true);
    expect(existsSync(pinned.segments[2].basePath)).toBe(true);
    const inventory = await getSegmentCleanup(id);
    expect(inventory.unusedLooks.map(file => file.name)).toContain(basename(pinned.segments[2].path));
    await cleanupShotSegments(id, { unusedLooks: true });
    expect(existsSync(pinned.segments[2].path)).toBe(false);
    expect(existsSync(pinned.segments[2].basePath)).toBe(true);
    expect(existsSync(planB.segments[0].path)).toBe(true);
    expect(existsSync(planA.segments[0].path)).toBe(false);
  }, 60000);
});

describe.skipIf(!hasFfmpeg)('pruneSegments time floor', () => {
  it('keeps a file written after the render started and still removes older unplanned ones', async () => {
    fixture.project = project({ id: 'mv-segments-floor-test' });
    const plan = await planShotSegments(fixture.project);
    mkdirSync(plan.dir, { recursive: true });
    const older = join(plan.dir, 'older-take.mp4');
    const newer = join(plan.dir, 'newer-look.mp4');
    writeFileSync(older, 'x');
    writeFileSync(newer, 'x');
    const startedAtMs = Date.now();
    utimesSync(older, (startedAtMs - 5000) / 1000, (startedAtMs - 5000) / 1000);
    utimesSync(newer, (startedAtMs + 5000) / 1000, (startedAtMs + 5000) / 1000);
    await pruneSegments(plan, { startedAtMs });
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
  });
});

describe('cleanup after changing render styles', () => {
  it('reports and removes abandoned shot caches, preserving unfinished files', async () => {
    fixture.project = project({ id: 'mv-abandoned-cache', composition: { mode: 'document' } });
    const dir = shotSegmentDir(fixture.project.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'superseded.mp4'), 'cache');
    writeFileSync(join(dir, 'unfinished.partial.mp4'), 'partial');
    expect((await getSegmentCleanup(fixture.project.id)).stale.map(file => file.name)).toEqual(['superseded.mp4']);
    await cleanupShotSegments(fixture.project.id);
    expect(existsSync(join(dir, 'superseded.mp4'))).toBe(false);
    expect(existsSync(join(dir, 'unfinished.partial.mp4'))).toBe(true);
  });
});

describe('renderSegment after a cancel', () => {
  const deferred = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };

  it('starts a fresh render instead of joining the aborted one still tearing down', async () => {
    const dir = join(ROOT(), 'cancel-rejoin');
    mkdirSync(dir, { recursive: true });
    const segment = { sceneId: 'scene-cancel', startSec: 0, look: { id: 'look' }, ownLook: true, basePath: join(dir, 'base.mp4'), path: join(dir, 'final.mp4') };
    writeFileSync(segment.basePath, 'base');
    const plan = { dir, project: { id: 'p' } };
    const first = deferred();
    const second = deferred();
    applyFilmLookFinish.mockReset();
    applyFilmLookFinish.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const cancel = new AbortController();
    const cancelled = renderSegment(plan, segment, { signal: cancel.signal });
    await vi.waitFor(() => expect(applyFilmLookFinish).toHaveBeenCalledTimes(1));
    cancel.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELED' });
    expect(segmentRendering(segment)).toBe(true); // old render still tearing down

    const retry = renderSegment(plan, segment);
    await vi.waitFor(() => expect(applyFilmLookFinish).toHaveBeenCalledTimes(2));

    first.release(true); // the old render settles; it must not evict the new entry
    await new Promise((r) => setTimeout(r, 20));
    expect(segmentRendering(segment)).toBe(true);

    second.release(true);
    await expect(retry).resolves.toBe(segment.path);
    expect(segmentRendering(segment)).toBe(false);
  });
});
