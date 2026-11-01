import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

// Real clip files and history rows under a temp data root, never the live gallery.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-sequence-') }));
afterAll(cleanupTempDataRoots);
vi.mock('./instanceIdentity.js', async (importOriginal) => ({ ...(await importOriginal()), getInstanceId: async () => 'local-inst' }));
const appendTakesAcrossScenes = vi.fn(async (_id, items) => ({
  project: { scenes: items.map((item) => ({ sceneId: item.sceneId, takes: [] })) },
  appended: items.map((item) => ({ sceneId: item.sceneId, take: { takeId: `t-${item.sceneId}` } })),
}));
const recordSceneFailure = vi.fn(async (_id, sceneId, failure) => ({ sceneId, lastFailure: failure }));
vi.mock('./musicVideo/projects.js', () => ({ appendTakesAcrossScenes, recordSceneFailure }));

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

const { initMusicVideoSequenceVideoHook, __testing } = await import('./musicVideoSequenceVideoHook.js');
const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const { loadHistory, mutateVideoHistory } = await import('./videoGen/history.js');
const { PATHS } = await import('../lib/fileUtils.js');
const { probeVideoDuration } = await import('../lib/ffmpeg.js');

const CLIP_ID = '33333333-3333-4333-8333-333333333333';
const spans = [
  { sceneId: 'a', clipStartSec: 0, clipEndSec: 1 },
  { sceneId: 'b', clipStartSec: 1, clipEndSec: 2.5 },
  { sceneId: 'c', clipStartSec: 2.5, clipEndSec: 3 },
];
const job = {
  id: CLIP_ID,
  params: { prompt: '0-1s: Image 1. a', musicVideoCostUsd: 0.96, musicVideoCostModelId: 'minimax/h3-max/reference-to-video', musicVideoSequenceDependencies: {} },
};

// The hook's public boundary: a completed sequence job on the media-job bus.
const complete = async (sequenceSpans) => {
  mediaJobEvents.emit('completed', { ...job, kind: 'video', result: { generationId: CLIP_ID },
    params: { ...job.params, musicVideo: { projectId: 'p1', sequence: { sceneIds: sequenceSpans.map((s) => s.sceneId), spans: sequenceSpans } } } });
  await __testing.settled();
};

describe.skipIf(!hasFfmpeg)('sequence-video hook (real ffmpeg)', () => {
  beforeEach(async () => {
    __testing.reset();
    initMusicVideoSequenceVideoHook();
    appendTakesAcrossScenes.mockClear();
    recordSceneFailure.mockClear();
    mkdirSync(PATHS.videos, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=24:duration=3',
      '-pix_fmt', 'yuv420p', join(PATHS.videos, `${CLIP_ID}.mp4`)]);
    writeFileSync(join(PATHS.data, 'video-history.json'), '[]');
    await mutateVideoHistory(() => [{
      id: CLIP_ID, filename: `${CLIP_ID}.mp4`, prompt: job.params.prompt, sentPrompt: job.params.prompt,
      promptAdditions: [{ id: 'prompt-expansion', label: 'Prompt expansion', text: 'prompt_expansion_mode: disabled' }],
      modelId: 'fal:minimax/h3-max/reference-to-video', numFrames: 72,
    }]);
  });

  // Uniquely catches a split that invents cut times, drops the sent-prompt record,
  // or charges the one request once per scene.
  it('cuts the clip at each scene\'s planned in/out and files one take per scene', async () => {
    await complete(spans);
    const [[projectId, items]] = appendTakesAcrossScenes.mock.calls;
    expect(projectId).toBe('p1');
    expect(items.map((i) => i.sceneId)).toEqual(['a', 'b', 'c']);
    const history = await loadHistory();
    const pieces = items.map((i) => history.find((row) => row.id === i.assetId));
    expect(pieces.map((p) => p.sequenceSpan)).toEqual(spans.map((s) => ({ startSec: s.clipStartSec, endSec: s.clipEndSec })));
    for (const [i, piece] of pieces.entries()) {
      expect(piece).toMatchObject({ sequenceOf: CLIP_ID, sentPrompt: job.params.prompt, promptAdditions: [expect.objectContaining({ id: 'prompt-expansion' })] });
      const sec = await probeVideoDuration(join(PATHS.videos, piece.filename));
      expect(sec).toBeCloseTo(spans[i].clipEndSec - spans[i].clipStartSec, 1);
    }
    expect(items.reduce((sum, i) => sum + i.costUsd, 0)).toBeCloseTo(0.96, 2);
    expect(recordSceneFailure).not.toHaveBeenCalled();
  });

  it('refuses to split a clip shorter than the planned run and records it on every scene', async () => {
    const long = [...spans.slice(0, 2), { sceneId: 'c', clipStartSec: 2.5, clipEndSec: 5 }];
    await complete(long);
    expect(appendTakesAcrossScenes).not.toHaveBeenCalled();
    expect(recordSceneFailure.mock.calls.map((c) => c[1])).toEqual(['a', 'b', 'c']);
    expect(recordSceneFailure.mock.calls[0][2].error).toMatch(/clip is 3s but its shots need 5s/);
    expect((await loadHistory()).map((row) => row.id)).toEqual([CLIP_ID]);
  });
});
