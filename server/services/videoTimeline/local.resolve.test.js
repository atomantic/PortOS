import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../../lib/mockPathsDataRoot.js';

// resolveTimeline is where the lane model meets the filesystem: it verifies
// every source, picks the canonical canvas, probes audio presence and bed
// durations, and refits fades that a later change made too long. buildFfmpegArgs
// tests all START from a resolved timeline, so none of that is covered there.
const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'timeline-resolve-' });

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makeProxy(actual);
});

const h = vi.hoisted(() => ({
  history: [],
  // `null` from a duration probe means "could not probe", never "zero seconds".
  probedDuration: null,
  hasAudio: true,
}));

vi.mock('../videoGen/local.js', () => ({
  loadHistory: async () => h.history,
  mutateVideoHistory: async (fn) => fn([]),
}));

vi.mock('../../lib/ffmpeg.js', async () => {
  const actual = await vi.importActual('../../lib/ffmpeg.js');
  return {
    ...actual,
    findFfprobe: async () => '/usr/bin/ffprobe',
    probeVideoDuration: async () => h.probedDuration,
  };
});

// probeAudio spawns ffprobe itself; stub the child so the flag is ours to set.
vi.mock('../../lib/childProcess.js', async () => {
  const actual = await vi.importActual('../../lib/childProcess.js');
  return { ...actual, spawn: () => {
    const listeners = {};
    const proc = {
      stdout: { on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(h.hasAudio ? 'audio\n' : '\n')); } },
      on: (ev, fn) => { listeners[ev] = fn; if (ev === 'close') setImmediate(() => fn(0)); return proc; },
    };
    return proc;
  } };
});

const { resolveTimeline } = await import('./local.js');

const VIDEOS = join(tempRoot, 'videos');
const IMAGES = join(tempRoot, 'images');
const MUSIC = join(tempRoot, 'music');

const CLIP_A = '11111111-1111-4111-8111-111111111111';
const CLIP_B = '22222222-2222-4222-8222-222222222222';

const historyEntry = (id, over = {}) => ({
  id, filename: `${id}.mp4`, width: 1920, height: 1080, fps: 24, numFrames: 240, ...over,
});

beforeEach(() => {
  for (const dir of [VIDEOS, IMAGES, MUSIC]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(VIDEOS, `${CLIP_A}.mp4`), 'x');
  writeFileSync(join(VIDEOS, `${CLIP_B}.mp4`), 'x');
  writeFileSync(join(IMAGES, 'plate.png'), 'x');
  writeFileSync(join(MUSIC, 'bed.mp3'), 'x');
  h.history = [historyEntry(CLIP_A), historyEntry(CLIP_B)];
  h.probedDuration = null;
  h.hasAudio = true;
});

afterAll(() => cleanup());

const project = (over = {}) => ({
  id: 'p1', schemaVersion: 2, overlays: [], audio: { clipVolume: 1, tracks: [] }, clips: [], ...over,
});

describe('resolveTimeline — sources', () => {
  it('refuses an empty lane', async () => {
    await expect(resolveTimeline(project({ segments: [] }))).rejects.toMatchObject({ code: 'EMPTY_PROJECT' });
  });

  it('reports every missing clip AND asset in one 404, so the editor can flag them all at once', async () => {
    const err = await resolveTimeline(project({
      segments: [
        { type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4 },
        { type: 'clip', clipId: '33333333-3333-4333-8333-333333333333', inSec: 0, outSec: 2 },
        { type: 'still', assetKind: 'images', assetFile: 'gone.png', durationSec: 2 },
      ],
      overlays: [{ type: 'image', assetKind: 'images', assetFile: 'nologo.png', startSec: 0, durationSec: 1, x: 0, y: 0, width: 0.5, opacity: 1, fadeInSec: 0, fadeOutSec: 0 }],
      audio: { clipVolume: 1, tracks: [{ assetKind: 'music', assetFile: 'nobed.mp3', startSec: 0, offsetSec: 0, durationSec: 2, volume: 1, fadeInSec: 0, fadeOutSec: 0 }] },
    })).catch((e) => e);

    expect(err.context.missingClipIds).toHaveLength(1);
    expect(err.context.missingAssets).toEqual(['images/gone.png', 'images/nologo.png', 'music/nobed.mp3']);
  });

  it('rejects a clip trimmed shorter than one frame', async () => {
    await expect(resolveTimeline(project({
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 0.001 }],
    }))).rejects.toMatchObject({ code: 'CLIP_TOO_SHORT' });
  });

  it('clamps an out point past the source duration', async () => {
    // 240 frames at 24fps = 10s of source.
    const { segments } = await resolveTimeline(project({
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 99 }],
    }));
    expect(segments[0].outSec).toBe(10);
    expect(segments[0].duration).toBe(10);
  });
});

describe('resolveTimeline — canonical canvas', () => {
  it('skips a clip carrying no dimensions rather than letterboxing the project into the fallback', async () => {
    // An uploaded or downloaded clip has no width/height in history
    // (videoUpload.js / videoDownload.js write none). Taking the first clip
    // unconditionally would force the whole render to 720p — and disagree
    // with the editor's preview, which skips those too.
    h.history = [historyEntry(CLIP_A, { width: undefined, height: undefined, fps: undefined }), historyEntry(CLIP_B, { width: 1080, height: 1920, fps: 30 })];

    const resolved = await resolveTimeline(project({
      segments: [
        { type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4 },
        { type: 'clip', clipId: CLIP_B, inSec: 0, outSec: 4 },
      ],
    }));

    expect([resolved.canonW, resolved.canonH, resolved.fps]).toEqual([1080, 1920, 30]);
  });

  it('falls back to 720p24 when NO clip has dimensions', async () => {
    h.history = [historyEntry(CLIP_A, { width: undefined, height: undefined, fps: undefined })];
    const resolved = await resolveTimeline(project({
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4 }],
    }));
    expect([resolved.canonW, resolved.canonH, resolved.fps]).toEqual([1280, 720, 24]);
  });

  it('falls back to 720p24 for a stills-only project', async () => {
    const resolved = await resolveTimeline(project({
      segments: [{ type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 3, fadeInSec: 0, fadeOutSec: 0 }],
    }));
    expect([resolved.canonW, resolved.canonH, resolved.fps]).toEqual([1280, 720, 24]);
    expect(resolved.segments[0]).toMatchObject({ type: 'still', duration: 3 });
  });
});

describe('resolveTimeline — fades that a later change made too long', () => {
  it('refits a clip fade against a trim the history entry has since shortened', async () => {
    // Stored trim says 0–8s with 3s+3s of fade; the source is only 1s long
    // now, so the pair must shrink or ffmpeg renders the segment all black.
    h.history = [historyEntry(CLIP_A, { numFrames: 24, fps: 24 })];
    const { segments } = await resolveTimeline(project({
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 8, fadeInSec: 3, fadeOutSec: 3, volume: 1 }],
    }));

    expect(segments[0].duration).toBe(1);
    expect(segments[0].fadeInSec + segments[0].fadeOutSec).toBeCloseTo(1);
  });

  it('refits a still fade against its own hold', async () => {
    const { segments } = await resolveTimeline(project({
      segments: [{ type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 1, fadeInSec: 3, fadeOutSec: 3 }],
    }));
    expect(segments[0].fadeInSec + segments[0].fadeOutSec).toBeCloseTo(1);
  });
});

describe('resolveTimeline — bed probing', () => {
  const bedProject = (over = {}) => project({
    segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4 }],
    audio: {
      clipVolume: 1,
      tracks: [{ assetKind: 'music', assetFile: 'bed.mp3', startSec: 0, offsetSec: 0, durationSec: 30, volume: 1, fadeInSec: 0, fadeOutSec: 0, ...over }],
    },
  });

  it('clamps a requested slice to what the file actually holds', async () => {
    h.probedDuration = 5;
    const { audioTracks } = await resolveTimeline(bedProject());
    expect(audioTracks[0].durationSec).toBe(5);
  });

  it('leaves the slice alone when the probe could not run — null is not zero seconds', async () => {
    // With no ffprobe (or an unreadable container) the requested slice stands;
    // collapsing null into 0 would silently drop the bed from every render.
    h.probedDuration = null;
    const { audioTracks } = await resolveTimeline(bedProject());
    expect(audioTracks[0].durationSec).toBe(30);
  });

  it('pulls an offset back inside the file and shrinks the slice to match', async () => {
    h.probedDuration = 4;
    const { audioTracks } = await resolveTimeline(bedProject({ offsetSec: 100, durationSec: 10 }));
    expect(audioTracks[0].offsetSec).toBeLessThanOrEqual(4);
    expect(audioTracks[0].offsetSec + audioTracks[0].durationSec).toBeLessThanOrEqual(4);
  });

  it('refits the bed fades after the probe shortens it', async () => {
    h.probedDuration = 2;
    const { audioTracks } = await resolveTimeline(bedProject({ fadeInSec: 5, fadeOutSec: 5 }));
    expect(audioTracks[0].fadeInSec + audioTracks[0].fadeOutSec).toBeCloseTo(2);
  });
});

describe('resolveTimeline — audio presence', () => {
  it('records the probed flag per clip', async () => {
    h.hasAudio = false;
    const { segments } = await resolveTimeline(project({
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4 }],
    }));
    expect(segments[0].hasAudio).toBe(false);
  });

  it('carries the project clip volume through for the mix', async () => {
    const resolved = await resolveTimeline(project({
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4 }],
      audio: { clipVolume: 0.25, tracks: [] },
    }));
    expect(resolved.clipVolume).toBe(0.25);
  });
});
