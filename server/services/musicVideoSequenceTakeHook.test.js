import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

// Real clip files and history rows under a temp data root, never the live gallery.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-sequence-take-') }));
afterAll(cleanupTempDataRoots);
vi.mock('./instanceIdentity.js', async (importOriginal) => ({ ...(await importOriginal()), getInstanceId: async () => 'local-inst' }));
const appendTakesAcrossScenes = vi.fn(async (_id, items) => ({
  project: { scenes: items.map((item) => ({ sceneId: item.sceneId, takes: [] })) },
  appended: items.map((item) => ({ sceneId: item.sceneId, take: { takeId: `t-${item.sceneId}` } })),
}));
const recordSceneFailure = vi.fn(async (_id, sceneId, failure) => ({ sceneId, lastFailure: failure }));
vi.mock('./musicVideo/projects.js', () => ({ appendTakesAcrossScenes, recordSceneFailure, getProject: vi.fn() }));

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

const { initMusicVideoSequenceTakeHook, __testing } = await import('./musicVideoSequenceTakeHook.js');
const { initMusicVideoSequenceVideoHook, __testing: coverageTesting } = await import('./musicVideoSequenceVideoHook.js');
const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const { loadHistory, mutateVideoHistory } = await import('./videoGen/history.js');
const { PATHS } = await import('../lib/fileUtils.js');

const CLIP_ID = '44444444-4444-4444-8444-444444444444';
// Three shots planned back to back: 2s, 2s, 1s.
const windows = [
  { sceneId: 'a', startSec: 0, endSec: 2 },
  { sceneId: 'b', startSec: 2, endSec: 4 },
  { sceneId: 'c', startSec: 4, endSec: 5 },
];
const params = {
  prompt: 'Shot 1 (0-2s): Image 1. a', musicVideoCostUsd: 0.5, musicVideoCostModelId: 'minimax/h3-max/reference-to-video',
  musicVideoSequenceDependencies: { a: { references: [{ assetId: 'frame-a.png' }] } },
};

// The hook's public boundary: a completed sequence-take job on the media-job bus.
const complete = async (tagWindows = windows) => {
  mediaJobEvents.emit('completed', { id: CLIP_ID, kind: 'video', result: { generationId: CLIP_ID },
    params: { ...params, musicVideo: { projectId: 'p1', sequenceTake: { sceneIds: tagWindows.map((w) => w.sceneId), windows: tagWindows } } } });
  await __testing.settled();
  await coverageTesting.settled();
};

// Solid colour segments joined by hard cuts: red 2.2s, blue 1.8s, green 2s (a 6s take).
function writeCutClip(durations = [2.2, 1.8, 2]) {
  const colors = ['red', 'blue', 'green'];
  const inputs = durations.flatMap((d, i) => ['-f', 'lavfi', '-i', `color=c=${colors[i]}:s=64x64:r=24:d=${d}`]);
  const concat = `${durations.map((_, i) => `[${i}:v]`).join('')}concat=n=${durations.length}:v=1:a=0[v]`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', concat, '-map', '[v]', '-pix_fmt', 'yuv420p', join(PATHS.videos, `${CLIP_ID}.mp4`)]);
}

describe.skipIf(!hasFfmpeg)('sequence-take hook (real ffmpeg)', () => {
  beforeEach(async () => {
    __testing.reset();
    coverageTesting.reset();
    initMusicVideoSequenceTakeHook();
    // The coverage hook listens on the same bus; it must leave a sequence take alone.
    initMusicVideoSequenceVideoHook();
    appendTakesAcrossScenes.mockClear();
    recordSceneFailure.mockClear();
    mkdirSync(PATHS.videos, { recursive: true });
    writeFileSync(join(PATHS.data, 'video-history.json'), '[]');
    await mutateVideoHistory(() => [{ id: CLIP_ID, filename: `${CLIP_ID}.mp4`, prompt: params.prompt, modelId: 'fal:minimax/h3-max/reference-to-video' }]);
  });

  // Uniquely catches filing that cuts the clip, picks the take for the director,
  // ignores the detected cuts, or charges the one request once per shot.
  it('files the whole clip on each shot, unselected, with an in-point at its detected cut', async () => {
    writeCutClip();
    await complete();
    expect(appendTakesAcrossScenes).toHaveBeenCalledTimes(1);
    const [[projectId, items]] = appendTakesAcrossScenes.mock.calls;
    expect(projectId).toBe('p1');
    expect(items.map((i) => i.sceneId)).toEqual(['a', 'b', 'c']);
    expect(items.every((i) => i.assetId === CLIP_ID && i.kind === 'video' && i.autoSelect === false)).toBe(true);
    expect(items.map((i) => i.sequence.from)).toEqual(['start', 'cut', 'cut']);
    expect(items.map((i) => i.sequence.index)).toEqual([0, 1, 2]);
    const inSec = items.map((i) => i.sequence.offsetFrames / 24);
    // a: centred in red (0-2.2s); b: blue is shorter than 2s, so it starts on the cut; c: centred in green (4-6s).
    expect(inSec[0]).toBeCloseTo(0.1, 1);
    expect(inSec[1]).toBeCloseTo(2.2, 1);
    expect(inSec[2]).toBeCloseTo(4.5, 1);
    expect(items[0].sourceImageId).toBe('frame-a.png');
    expect(items.reduce((sum, i) => sum + i.costUsd, 0)).toBeCloseTo(0.5, 2);
    expect(recordSceneFailure).not.toHaveBeenCalled();
    // Nothing is cut: the history still holds only the one take.
    expect((await loadHistory()).map((row) => row.id)).toEqual([CLIP_ID]);
  });

  it('refuses a clip too short for one of its shots and records it on every shot', async () => {
    writeCutClip([0.5, 0.5]);
    await complete();
    expect(appendTakesAcrossScenes).not.toHaveBeenCalled();
    expect(recordSceneFailure.mock.calls.map((c) => c[1])).toEqual(['a', 'b', 'c']);
    expect(recordSceneFailure.mock.calls[0][2].error).toMatch(/not filed: the take is 1s, shorter than one 2s shot/);
  });
});

describe('sequence-take hook (no ffmpeg needed)', () => {
  it('falls back to the planned in-points when cut detection fails', async () => {
    const append = vi.fn(async (_id, items) => ({ project: { scenes: [] }, appended: items.map(() => null) }));
    await __testing.fileSequenceTake({ projectId: 'p1', windows, videoHistoryId: CLIP_ID, job: { id: CLIP_ID, params } }, {
      history: async () => ({ id: CLIP_ID, filename: `${CLIP_ID}.mp4` }),
      probe: async () => 5,
      detectCuts: async () => null,
      append,
    });
    const [[, items]] = append.mock.calls;
    expect(items.map((i) => i.sequence.from)).toEqual(['start', 'planned', 'planned']);
    expect(items.map((i) => i.sequence.offsetFrames)).toEqual([0, 48, 96]);
  });
});
