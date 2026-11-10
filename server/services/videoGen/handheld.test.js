import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

// Real files under a temp data root: the shake writes a new clip and a history row.
vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-handheld-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../instanceIdentity.js', async (importOriginal) => ({ ...(await importOriginal()), getInstanceId: async () => 'local-inst' }));

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

const { handheldHistoryItem } = await import('./handheld.js');
const { loadHistory, mutateVideoHistory } = await import('./history.js');
const { PATHS } = await import('../../lib/fileUtils.js');
const { probeFrameCount, probeVideoStreamInfo } = await import('../../lib/ffmpeg.js');

const SOURCE_ID = '33333333-3333-4333-8333-333333333333';

describe.skipIf(!hasFfmpeg)('handheldHistoryItem (real ffmpeg)', () => {
  beforeEach(async () => {
    mkdirSync(PATHS.videos, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x72:rate=24:duration=2',
      '-pix_fmt', 'yuv420p', join(PATHS.videos, `${SOURCE_ID}.mp4`)]);
    writeFileSync(join(PATHS.data, 'video-history.json'), '[]');
    await mutateVideoHistory(() => [{ id: SOURCE_ID, filename: `${SOURCE_ID}.mp4`, prompt: 'a hallway', width: 128, height: 72, numFrames: 48, fps: 24 }]);
  });

  // Uniquely catches a shake that edits the source, drops frames or changes the size.
  it('writes a new same-size, same-length gallery clip and leaves the source intact', async () => {
    const entry = await handheldHistoryItem(SOURCE_ID, { shake: 0.6, steps: 0.5, seed: 12 });
    expect(entry).toMatchObject({ handheldFrom: SOURCE_ID, handheld: { shake: 0.6, steps: 0.5, seed: 12 }, numFrames: 48, prompt: 'a hallway' });
    const info = await probeVideoStreamInfo(join(PATHS.videos, entry.filename));
    expect([info.width, info.height]).toEqual([128, 72]);
    expect(await probeFrameCount(join(PATHS.videos, `${SOURCE_ID}.mp4`))).toBe(48);
    expect((await loadHistory()).map((h) => h.id)).toEqual([entry.id, SOURCE_ID]);
  });

  // Uniquely catches a second shake stacking on the first instead of re-shooting the steady original.
  it('re-shoots the steady original when given a handheld take', async () => {
    const first = await handheldHistoryItem(SOURCE_ID, { shake: 0.5, steps: 0, seed: 3 });
    const second = await handheldHistoryItem(first.id, { shake: 0.2, steps: 0.8, seed: 4 });
    expect(second.handheldFrom).toBe(SOURCE_ID);
  });

  it('refuses settings that move nothing, writing nothing', async () => {
    await expect(handheldHistoryItem(SOURCE_ID, { shake: 0, steps: 0 })).rejects.toMatchObject({ code: 'HANDHELD_STILL' });
    expect((await loadHistory()).map((h) => h.id)).toEqual([SOURCE_ID]);
  });
});
