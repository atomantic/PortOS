/**
 * stitchVideos.local.test.js
 *
 * Split from local.test.js (#16214); shared mocks live in local.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';

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
let stitchVideos;

beforeEach(async () => {
  vi.resetModules();
  fx.resetFsPromisesReadFile();
  ({ stitchVideos } = await import('./local.js'));
});

afterEach(async () => {
  await fx.resetSharedMocks();
});

describe('stitchVideos — history provenance', () => {
  const renderFields = [
    'steps',
    'guidanceScale',
    'tiling',
    'disableAudio',
    'mode',
    'textEncoderId',
    'imageStrength',
    'i2vReferenceMode',
    'conditioning',
    'renderInputsVersion',
  ];

  const stitchHistory = async (firstChunkFields = {}, secondChunkFields = {}, historyKey = 'chainedFrom') => {
    const { readJSONFile } = await import('../../lib/fileUtils.js');
    const chunkIds = ['chunk-a', 'chunk-b'];
    vi.mocked(readJSONFile).mockResolvedValue([
      {
        id: chunkIds[0], filename: 'chunk-a.mp4', prompt: 'first beat',
        modelId: 'ltx2_unified', seed: 42, width: 768, height: 512,
        numFrames: 49, fps: 24, ...firstChunkFields,
      },
      {
        id: chunkIds[1], filename: 'chunk-b.mp4', prompt: 'second beat',
        modelId: 'ltx2_unified', seed: 43, width: 768, height: 512,
        numFrames: 49, fps: 24, ...secondChunkFields,
      },
    ]);
    return stitchVideos(chunkIds, {
      id: randomUUID(),
      filenamePrefix: 'chained',
      historyKey,
    });
  };

  it('publishes the finished encode after a long backup cut', async () => {
    const { acquireBackupSnapshotCut, _backupSnapshotWaitersForTests } = await import('../../lib/backupSnapshotBoundary.js');
    const { videoGenEvents } = await import('./events.js');
    const activity = vi.fn();
    videoGenEvents.on('activity', activity);
    const release = await acquireBackupSnapshotCut();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const work = stitchHistory({}, {});
    const settled = vi.fn();
    void work.then(settled, settled);
    try {
      await vi.waitFor(() => expect(_backupSnapshotWaitersForTests().publications).toBe(1));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(activity).toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
    } finally {
      release();
      vi.useRealTimers();
      videoGenEvents.off('activity', activity);
    }
    expect(await work).toMatchObject({ chainedFrom: ['chunk-a', 'chunk-b'] });
  });

  it('inherits every render dial and provenance field from the first chunk', async () => {
    const chunkRenderConfig = {
      steps: 20,
      guidanceScale: 0,
      tiling: 'none',
      disableAudio: false,
      mode: 'image',
      textEncoderId: 'example-encoder',
      imageStrength: 0,
      i2vReferenceMode: 'inspire',
      conditioning: [],
      renderInputsVersion: 1,
    };

    const stitched = await stitchHistory(chunkRenderConfig);

    expect(stitched).toMatchObject(chunkRenderConfig);
  });

  it('does not stamp absent render fields onto a legacy stitched entry', async () => {
    const stitched = await stitchHistory();

    for (const field of renderFields) expect(stitched).not.toHaveProperty(field);
  });

  // Render duration (#5878). A chain writes its chunk rows `hidden: true`, so the
  // stitched row is the only one the user ever sees — without timing here a chained
  // render would be the one kind that never reports how long it took.
  describe('render duration', () => {
    const timed = (startedAt) => ({ renderStartedAt: startedAt, renderMs: 60_000 });

    it('spans from the earliest chunk start through the concat', async () => {
      const first = '2026-09-02T00:00:00.000Z';
      const stitched = await stitchHistory(timed('2026-09-02T00:05:00.000Z'), timed(first));

      // The EARLIEST start, not chunk 0's: chunks render sequentially but the
      // history rows are not ordered by start time.
      expect(stitched.renderStartedAt).toBe(first);
      expect(Date.parse(stitched.renderCompletedAt) - Date.parse(first)).toBe(stitched.renderMs);
      // The whole span, not the sum of the chunks' own renderMs — the concat and
      // the inter-chunk trimming are time the user waited too.
      expect(stitched.renderMs).toBeGreaterThan(0);
    });

    it('reports nothing when a chunk never observed a start instant', async () => {
      const stitched = await stitchHistory(timed('2026-09-02T00:00:00.000Z'), {});

      // Absent, not a span measured from the one chunk that did report — that
      // would read as a suspiciously fast render.
      expect(stitched).not.toHaveProperty('renderMs');
      expect(stitched).not.toHaveProperty('renderStartedAt');
      expect(stitched).not.toHaveProperty('renderCompletedAt');
    });

    it('reports nothing for a hand-stitched clip, which ran no render of its own', async () => {
      const t = timed('2026-09-02T00:00:00.000Z');
      const stitched = await stitchHistory(t, t, 'stitchedFrom');

      expect(stitched).not.toHaveProperty('renderMs');
      expect(stitched).not.toHaveProperty('renderStartedAt');
    });
  });

  // Block streaming (#6499). The request is
  // chain-wide (every chunk is submitted with the same streamingMode), but the
  // OUTCOME is decided per child process — a mode that streamed on one chunk's
  // machine state and stayed resident on another's would misreport the clip.
  describe('streaming-policy outcome', () => {
    const applied = (active) => ({
      streamingMode: 'stream',
      streamingPolicyApplied: { pipeline: 'one-stage', requestedMode: 'stream', active, supports: true, reason: null },
    });

    it('inherits the request and a unanimous outcome', async () => {
      const stitched = await stitchHistory(applied(true), applied(true));

      expect(stitched.streamingMode).toBe('stream');
      expect(stitched.streamingPolicyApplied).toEqual(applied(true).streamingPolicyApplied);
    });

    it('inherits a unanimous resident outcome even when peakMb readings differ', async () => {
      const stitched = await stitchHistory(
        { ...applied(true), streamingPolicyApplied: { ...applied(true).streamingPolicyApplied, peakMb: 400 } },
        { ...applied(true), streamingPolicyApplied: { ...applied(true).streamingPolicyApplied, peakMb: 420 } },
      );

      // Unanimity is on the `active` verdict, not deep equality.
      expect(stitched.streamingPolicyApplied.active).toBe(true);
    });

    it('keeps the request but omits the outcome when the chunks disagree', async () => {
      const stitched = await stitchHistory(applied(true), applied(false));

      expect(stitched.streamingMode).toBe('stream');
      expect(stitched).not.toHaveProperty('streamingPolicyApplied');
    });

    it('stamps no outcome on a chain that never reported one', async () => {
      const stitched = await stitchHistory({ streamingMode: 'stream' }, { streamingMode: 'stream' });

      expect(stitched.streamingMode).toBe('stream');
      expect(stitched).not.toHaveProperty('streamingPolicyApplied');
    });
  });

  // LoRA application strategy (#12262). Each chunk's child decides whether an
  // adapter applied at inference or was merged and re-quantized, so a stitched
  // clip may claim a strategy only when every chunk agrees on it.
  describe('LoRA strategy outcome', () => {
    const applied = (strategy, quantizedTargets = 480) => ({
      loraStrategyApplied: {
        adapters: [{ role: 'user', name: 'character.safetensors', strategy, stages: ['all'], strength: 0.8, quantizedTargets, fusedTargets: 0 }],
      },
    });

    it('inherits a unanimous outcome even when target counts differ', async () => {
      const stitched = await stitchHistory(applied('runtime-delta'), applied('runtime-delta', 479));

      expect(stitched.loraStrategyApplied).toEqual(applied('runtime-delta').loraStrategyApplied);
    });

    it('omits the outcome when the chunks applied the adapter differently', async () => {
      const stitched = await stitchHistory(applied('runtime-delta'), applied('merged-requantized'));

      expect(stitched).not.toHaveProperty('loraStrategyApplied');
    });

    it('omits the outcome when the chunks used the adapter at different strengths', async () => {
      const weaker = applied('runtime-delta');
      weaker.loraStrategyApplied.adapters[0].strength = 0.4;
      const stitched = await stitchHistory(applied('runtime-delta'), weaker);

      expect(stitched).not.toHaveProperty('loraStrategyApplied');
    });
  });
});

// #4875 — the chunk entries of a chain are written `hidden: true`, so the
// STITCHED record is the only one the user ever sees. Without inheriting the
// profile there, a chained render's lightbox shows no "Speed profile" row at
// all — including for a chain whose TeaCache or adapter was unavailable, which
// is exactly the silent speed claim the feature exists to prevent — and a Remix
// of the clip quietly reverts to Quality.
describe('stitchVideos — speed-profile inheritance (#4875)', () => {
  const chunk = (id, extra = {}) => ({
    id, filename: `${id}.mp4`, prompt: 'a shot', modelId: 'ltx25_mlx_q8',
    width: 512, height: 512, fps: 24, numFrames: 25, seed: 7, ...extra,
  });

  const stitchOf = async (entries) => {
    const { readJSONFile, atomicWrite } = await import('../../lib/fileUtils.js');
    const { probeFrameCount } = await import('../../lib/ffmpeg.js');
    vi.mocked(atomicWrite).mockClear();
    vi.mocked(probeFrameCount).mockImplementation(async () => 25);
    vi.mocked(readJSONFile).mockImplementation(async () => entries);
    return stitchVideos(entries.map((e) => e.id));
  };

  it('carries the requested profile and the runner outcome from the first chunk', async () => {
    const applied = { id: 'fast', teacache: false, degraded: ['teacache'] };
    const stitched = await stitchOf([
      chunk('c1', { speedProfileId: 'fast', speedProfileApplied: applied }),
      chunk('c2', { speedProfileId: 'fast', speedProfileApplied: applied }),
    ]);
    // Both halves: the REQUEST (what Remix round-trips, what the ETA buckets
    // on) and the OUTCOME (what stops a degraded run reading as a full one).
    expect(stitched.speedProfileId).toBe('fast');
    expect(stitched.speedProfileApplied).toEqual(applied);
  });

  it('stamps neither field for a Quality chain, so the record stays pre-feature shaped', async () => {
    const stitched = await stitchOf([chunk('c1'), chunk('c2')]);
    expect('speedProfileId' in stitched).toBe(false);
    expect('speedProfileApplied' in stitched).toBe(false);
  });

  it('carries the id alone when the runner reported no outcome', async () => {
    const stitched = await stitchOf([
      chunk('c1', { speedProfileId: 'fast' }), chunk('c2', { speedProfileId: 'fast' }),
    ]);
    expect(stitched.speedProfileId).toBe('fast');
    expect('speedProfileApplied' in stitched).toBe(false);
  });
});
