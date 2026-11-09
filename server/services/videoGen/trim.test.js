import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

// Real files under a temp data root: the trim writes a new clip and a history
// row, and the install's data/ is the developer's live gallery.
vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-trim-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../instanceIdentity.js', async (importOriginal) => ({ ...(await importOriginal()), getInstanceId: async () => 'local-inst' }));

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

const { trimHistoryItem } = await import('./trim.js');
const { loadHistory, mutateVideoHistory } = await import('./history.js');
const { PATHS } = await import('../../lib/fileUtils.js');
const { probeFrameCount } = await import('../../lib/ffmpeg.js');

const SOURCE_ID = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!hasFfmpeg)('trimHistoryItem (real ffmpeg)', () => {
  beforeEach(async () => {
    mkdirSync(PATHS.videos, { recursive: true });
    // 2 s at 24 fps = 48 frames.
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=24:duration=2',
      '-pix_fmt', 'yuv420p', join(PATHS.videos, `${SOURCE_ID}.mp4`)]);
    writeFileSync(join(PATHS.data, 'video-history.json'), '[]');
    await mutateVideoHistory(() => [{
      id: SOURCE_ID, filename: `${SOURCE_ID}.mp4`, prompt: 'a lighthouse', modelId: 'ltx23_distilled_q4',
      width: 64, height: 64, numFrames: 48, fps: 24, posterSec: 0.2, renderMs: 90000,
    }]);
  });

  // Uniquely catches a trim that edits the source in place, keeps the wrong
  // frames, or leaves the new clip out of the gallery.
  it('writes a new gallery clip from the chosen frame and leaves the source intact', async () => {
    const entry = await trimHistoryItem(SOURCE_ID, { startSec: 0.5 });
    expect(entry).toMatchObject({
      trimmedFrom: SOURCE_ID, trimStartFrame: 12, trimStartSec: 0.5, numFrames: 36, fps: 24, prompt: 'a lighthouse',
    });
    expect(entry.id).not.toBe(SOURCE_ID);
    expect(entry.posterSec).toBeUndefined();
    expect(await probeFrameCount(join(PATHS.videos, entry.filename))).toBe(36);
    expect(await probeFrameCount(join(PATHS.videos, `${SOURCE_ID}.mp4`))).toBe(48);
    const history = await loadHistory();
    expect(history.map((h) => h.id)).toEqual([entry.id, SOURCE_ID]);
  });

  // Uniquely catches a derived clip that inherits a peer source row's origin and
  // machine-local supplier, which would make the peer its owner here.
  it('stamps a trim of a peer-supplied clip with the local origin and no supplier', async () => {
    await mutateVideoHistory((h) => { Object.assign(h[0], { originInstanceId: 'peer-o', suppliedByInstanceId: 'peer-o' }); return h; }, { stampOrigin: false });
    const entry = await trimHistoryItem(SOURCE_ID, { startSec: 0.5 });
    const stored = (await loadHistory()).find((h) => h.id === entry.id);
    expect(stored.originInstanceId).toBe('local-inst');
    expect(stored).not.toHaveProperty('suppliedByInstanceId');
  });

  // Uniquely catches an end cut that keeps the wrong frames or drops the start.
  it('keeps only a middle range when both start and end are given', async () => {
    const entry = await trimHistoryItem(SOURCE_ID, { startSec: 0.5, endSec: 1.5 });
    expect(entry).toMatchObject({ trimStartFrame: 12, trimEndFrame: 36, trimEndSec: 1.5, numFrames: 24 });
    expect(await probeFrameCount(join(PATHS.videos, entry.filename))).toBe(24);
    const tail = await trimHistoryItem(SOURCE_ID, { endSec: 1 });
    expect(tail).toMatchObject({ trimStartFrame: 0, trimEndFrame: 24, numFrames: 24 });
  });

  it('refuses an end at the last frame or too close to the start, writing nothing', async () => {
    await expect(trimHistoryItem(SOURCE_ID, { endSec: 2 })).rejects.toMatchObject({ code: 'TRIM_AT_END' });
    await expect(trimHistoryItem(SOURCE_ID, { startSec: 0.5, endSec: 0.52 })).rejects.toMatchObject({ code: 'TRIM_TOO_SHORT' });
    expect((await loadHistory()).map((h) => h.id)).toEqual([SOURCE_ID]);
  });

  it('refuses a start at the first frame or past the end, writing nothing', async () => {
    await expect(trimHistoryItem(SOURCE_ID, { startSec: 0.01 })).rejects.toMatchObject({ code: 'TRIM_AT_START' });
    await expect(trimHistoryItem(SOURCE_ID, { startSec: 1.99 })).rejects.toMatchObject({ code: 'TRIM_PAST_END' });
    expect((await loadHistory()).map((h) => h.id)).toEqual([SOURCE_ID]);
  });
});
