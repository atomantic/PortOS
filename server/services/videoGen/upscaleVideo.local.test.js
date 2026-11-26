/**
 * upscaleVideo.local.test.js
 *
 * Split from local.test.js (#16214); shared mocks live in local.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way so its state objects outlive vi.resetModules().
const fx = await vi.hoisted(() => import('./local.testFixtures.js'));

vi.mock('os', async (importOriginal) => fx.osFactory(importOriginal));
vi.mock('../../lib/heavyJobClaim.js', () => fx.heavyJobClaimFactory());
vi.mock('../localMemory.js', async (importOriginal) => fx.localMemoryFactory(importOriginal));
vi.mock('../../lib/fileUtils.js', () => fx.fileUtilsFactory());
vi.mock('../settings.js', () => fx.settingsFactory());
vi.mock('../../lib/mediaModels.js', async () => fx.mediaModelsFactory());
vi.mock('../../lib/sseUtils.js', () => fx.sseUtilsFactory());
vi.mock('../../lib/ffmpeg.js', async () => fx.ffmpegFactory());
vi.mock('./extendSplice.js', () => fx.extendSpliceFactory());
vi.mock('../../lib/lipsyncAlign.js', () => fx.lipsyncAlignFactory());
vi.mock('../hfToken.js', () => fx.hfTokenFactory());
vi.mock('../../lib/hfCache.js', async (original) => fx.hfCacheFactory(original));
// The file mocks below cannot read a real maintenance journal.
vi.mock('../../lib/databaseMaintenanceJournal.js', async importOriginal => ({
  ...await importOriginal(),
  assertDatabaseAdmission: () => {},
}));
vi.mock('fs', () => fx.fsFactory());
vi.mock('../../lib/frameQuality.js', async (importOriginal) => fx.frameQualityFactory(importOriginal));
vi.mock('./runtimes.js', async (importOriginal) => fx.runtimesFactory(importOriginal));
vi.mock('../loras.js', () => fx.lorasFactory());
vi.mock('../loraEffectProbe.js', () => fx.loraEffectProbeFactory());
vi.mock('./ensureWeights.js', async (importOriginal) => fx.ensureWeightsFactory(importOriginal));
vi.mock('../../lib/childProcess.js', () => fx.childProcessFactory());
vi.mock('../../lib/detachedSpawn.js', () => fx.detachedSpawnFactory());
vi.mock('fs/promises', () => fx.fsPromisesMock);

// ─── module under test ───────────────────────────────────────────────────────


beforeEach(async () => {
  vi.resetModules();
  fx.resetFsPromisesReadFile();
  ({  } = await import('./local.js'));
});

afterEach(async () => {
  await fx.resetSharedMocks();
});

// Render duration (#5878). The upscaled row is built by spreading the SOURCE
// history row, so the source's `renderMs` is one careless spread away from being
// displayed on a card whose only work was a 2x ffmpeg pass — and, before the
// estimator learned to skip derived rows, from training the render-time cost
// model at 4x the work units against seconds of duration.
describe('upscaleHistoryItem — render duration', () => {
  const SOURCE_ID = '11111111-1111-4111-8111-111111111111';

  const upscaleFrom = async (sourceFields) => {
    const { readJSONFile } = await import('../../lib/fileUtils.js');
    vi.mocked(readJSONFile).mockImplementation(fx.mockReadJSONFile([{
      id: SOURCE_ID, filename: `${SOURCE_ID}.mp4`, prompt: 'a lighthouse',
      modelId: 'ltx2_unified', width: 768, height: 512, numFrames: 49, fps: 24,
      ...sourceFields,
    }]));
    const { upscaleHistoryItem } = await import('./local.js');
    return upscaleHistoryItem(SOURCE_ID);
  };

  it('publishes the finished encode after a long backup cut', async () => {
    const { acquireBackupSnapshotCut, _backupSnapshotWaitersForTests } = await import('../../lib/backupSnapshotBoundary.js');
    const release = await acquireBackupSnapshotCut();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const work = upscaleFrom({});
    const settled = vi.fn();
    void work.then(settled, settled);
    try {
      await vi.waitFor(() => expect(_backupSnapshotWaitersForTests().publications).toBe(1));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      release();
      vi.useRealTimers();
    }
    expect(await work).toMatchObject({ upscaledFrom: SOURCE_ID });
  });

  it('times its own ffmpeg pass instead of inheriting the source render', async () => {
    const upscaled = await upscaleFrom({
      renderMs: 900_000,
      renderStartedAt: '2026-09-02T00:00:00.000Z',
      renderCompletedAt: '2026-09-02T00:15:00.000Z',
    });

    expect(upscaled.renderMs).not.toBe(900_000);
    expect(upscaled.renderMs).toBeLessThan(900_000);
    expect(Date.parse(upscaled.renderStartedAt)).toBeGreaterThan(Date.parse('2026-09-02T00:15:00.000Z'));
  });

  it('stamps the upscaled row with this install\'s origin', async () => {
    const upscaled = await upscaleFrom({});

    expect(upscaled.originInstanceId).toBe(fx.FIXTURE_INSTANCE_ID);
    expect(upscaled).not.toHaveProperty('suppliedByInstanceId');
  });

  it('still times the pass when the source carried no timing of its own', async () => {
    const upscaled = await upscaleFrom({});

    expect(upscaled.renderMs).toBeGreaterThanOrEqual(0);
    expect(upscaled.upscaledFrom).toBe(SOURCE_ID);
  });
});
