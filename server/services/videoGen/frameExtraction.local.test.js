/**
 * frameExtraction.local.test.js
 *
 * Split from local.test.js (#16214); shared mocks live in local.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'node:events';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way so its state objects outlive vi.resetModules().
const fx = await vi.hoisted(() => import('./local.testFixtures.js'));
const { MOCK_PATHS, fsState, anchorPick, spawnState } = fx;

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
let extractLastFrame;

beforeEach(async () => {
  vi.resetModules();
  fx.resetFsPromisesReadFile();
  ({ extractLastFrame } = await import('./local.js'));
});

afterEach(async () => {
  await fx.resetSharedMocks();
});

describe('extractLastFrame — anchor selection', () => {
  const ID = 'upload-ab12cd34';
  const ANCHOR = 'anchor-upload-ab12cd34.png';

  const seedHistory = async () => {
    const { readJSONFile } = await import('../../lib/fileUtils.js');
    vi.mocked(readJSONFile).mockResolvedValue([{
      id: ID,
      filename: `${ID}.mp4`,
      prompt: 'example',
    }]);
  };

  const ffmpegSpawns = async () => {
    const { spawn } = await import('../../lib/childProcess.js');
    return vi.mocked(spawn).mock.calls.map(([, args]) => (Array.isArray(args) ? args : []));
  };

  it('accepts an uploaded gallery history id and serves the cached anchor', async () => {
    await seedHistory();
    // Cache hit (statSync reports a non-empty file) — no ffmpeg at all.
    await expect(extractLastFrame(ID)).resolves.toEqual({
      filename: ANCHOR,
      path: `/data/images/${ANCHOR}`,
    });
    expect(await ffmpegSpawns()).toHaveLength(0);
  });

  it('scores the tail window and installs the winning candidate', async () => {
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    anchorPick.best = {
      path: join(tmpdir(), `anchorcand-${ID}`, 'cand-003.png'),
      index: 2,
      focus: 0.81,
      quality: 0.79,
      score: 0.82,
      usable: true,
    };
    const { copyFile, writeFile, rm } = await import('fs/promises');

    await expect(extractLastFrame(ID)).resolves.toEqual({
      filename: ANCHOR,
      path: `/data/images/${ANCHOR}`,
    });

    // The winner is installed under the NEW cache name, not the legacy one, and
    // straight to it — no `.tmp` alongside, which the peer media-library
    // manifest would federate as an image asset (it skips only `.json`).
    const dest = join(MOCK_PATHS.images, ANCHOR);
    expect(vi.mocked(copyFile)).toHaveBeenCalledWith(anchorPick.best.path, dest);
    expect(vi.mocked(copyFile).mock.calls.some(([, d]) => String(d).endsWith('.tmp'))).toBe(false);
    // One decode pass over the tail window; the single-seek fallback must NOT
    // have run — that would mean the scored pick was thrown away.
    const spawns = await ffmpegSpawns();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toEqual(expect.arrayContaining(['-sseof', '-1.00', '-vf', 'fps=12']));
    expect(spawns[0]).not.toContain('-vframes');
    // Temp candidates are cleaned up rather than left in tmpdir.
    expect(vi.mocked(rm)).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`anchorcand-${ID}-[0-9a-f-]{36}$`)),
      { recursive: true, force: true },
    );
    // Sidecar names the offset the anchor actually came from, derived from the
    // candidates actually decoded rather than a nominal window start. The fps
    // grid stops one interval short of EOF, so index 2 of 12 at 12fps sits
    // (12−2)/12 = 0.83s from the end — not 0.75s, which would be the distance
    // to the newest CANDIDATE rather than to the cut.
    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ filename: ANCHOR, extractedAt: '-0.83s' });
  });

  it('reads back exactly the candidate files it told ffmpeg to write', async () => {
    // The enumerator builds `cand-NNN.png` names by hand rather than reading the
    // directory, so nothing else checks that they match the pattern ffmpeg
    // actually received. A typo in the pattern or the padding would produce zero
    // candidates in production with every other test still green — derive the
    // expectation from the argv so the two sides can't drift apart.
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    fsState.candidateCount = 3; // ffmpeg only managed three frames
    const { pickBestFrame } = await import('../../lib/frameQuality.js');

    await extractLastFrame(ID);

    const outPattern = (await ffmpegSpawns())[0].at(-1);
    expect(outPattern).toContain('%03d');
    const [scanned] = vi.mocked(pickBestFrame).mock.calls.at(-1);
    expect(scanned).toEqual([1, 2, 3].map((n) => outPattern.replace('%03d', String(n).padStart(3, '0'))));
    // Enumeration stops at the first gap instead of inventing a full window.
    expect(scanned).toHaveLength(3);
  });

  it('reports the offset against the candidates it got, not a nominal window', async () => {
    // The short-clip case the offset arithmetic exists for: `-sseof` clamps to
    // the file start, so a sub-window clip yields fewer candidates and a
    // TAIL_WINDOW_SECONDS-derived offset would name a time the frame does not
    // have. (3 − 1) / 12fps = 0.17s from the cut.
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    fsState.candidateCount = 3;
    anchorPick.best = {
      path: join(tmpdir(), `anchorcand-${ID}`, 'cand-002.png'),
      index: 1,
      focus: 0.6,
      quality: 0.6,
      score: 0.65,
      usable: true,
    };
    const { writeFile } = await import('fs/promises');

    await extractLastFrame(ID);

    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: '-0.17s' });
  });

  it.each([
    ['re-scans', 'last-frame-unscanned', true],
    ['serves', '-0.42s', false],
    ['serves', 'last-frame', false],
  ])('%s a cached anchor whose sidecar says %s', async (_verb, extractedAt, rescans) => {
    // A one-off ffmpeg or tmpdir failure used to pin the degraded end-seek frame
    // to this clip forever behind the size>0 cache hit. The sidecar marker is
    // what makes THAT attempt provisional — and the other two rows are the
    // bypass probe: without the marker the cache must still short-circuit, or
    // every click re-spawns ffmpeg and the cache stops existing.
    const { tryReadFile } = await import('../../lib/fileUtils.js');
    await seedHistory();
    vi.mocked(tryReadFile).mockResolvedValueOnce(
      JSON.stringify({ filename: ANCHOR, extractedAt }),
    );
    anchorPick.best = null;
    fsState.candidateCount = 0; // the scan still can't produce anything

    await extractLastFrame(ID);

    // statSync reports a healthy non-zero file in every row; only the marker
    // decides whether the scan runs anyway.
    expect((await ffmpegSpawns()).length > 0).toBe(rescans);
  });

  it.each([
    ['a scan that ran and found nothing usable', 12, 'last-frame'],
    ['a scan that could not run at all', 0, 'last-frame-unscanned'],
  ])('marks the fallback anchor from %s as %s', async (_label, count, expected) => {
    // Only the second is provisional: a degenerate tail is a property of the
    // clip and must stay cached, or every click re-spawns ffmpeg for nothing.
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    fsState.candidateCount = count;
    anchorPick.best = null;
    const { writeFile } = await import('fs/promises');

    await extractLastFrame(ID);

    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: expected });
  });

  it('names the candidate rather than a time when the scan was truncated', async () => {
    // A partial run's candidates end wherever ffmpeg stopped, not at EOF, so
    // the grid gives no distance to the cut. Inventing one would put a silent
    // lie in the gallery record.
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    fsState.candidateCount = 3;
    spawnState.nextExitCode = 1; // ffmpeg wrote 3 frames, then died
    anchorPick.best = {
      path: join(tmpdir(), `anchorcand-${ID}`, 'cand-002.png'),
      index: 1, focus: 0.6, quality: 0.6, score: 0.65, usable: true,
    };
    const { writeFile } = await import('fs/promises');

    await extractLastFrame(ID);

    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: 'tail-candidate 2/3' });
  });

  it('treats a failed install as provisional, not as a degenerate tail', async () => {
    // A winner WAS found; only the copy failed (ENOSPC/EIO/EACCES — all
    // transient). Stamping that 'last-frame' would classify it as a property of
    // the clip and pin the degraded end-seek anchor behind the cache forever.
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    anchorPick.best = {
      path: join(tmpdir(), `anchorcand-${ID}`, 'cand-006.png'),
      index: 5, focus: 0.7, quality: 0.7, score: 0.8, usable: true,
    };
    const { copyFile, writeFile } = await import('fs/promises');
    vi.mocked(copyFile).mockRejectedValueOnce(new Error('ENOSPC'));

    await extractLastFrame(ID);

    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: 'last-frame-unscanned' });
  });

  it('clears a stale provisional marker once a scan finally runs', async () => {
    // call 1 could not scan → 'last-frame-unscanned'; call 2 scans and finds the
    // tail genuinely degenerate. The `wx` sidecar write is a no-op against the
    // surviving file, so without an unconditional unlink the marker outlives the
    // scan and the clip re-scans on every click forever.
    const { tryReadFile } = await import('../../lib/fileUtils.js');
    await seedHistory();
    vi.mocked(tryReadFile).mockResolvedValueOnce(
      JSON.stringify({ filename: ANCHOR, extractedAt: 'last-frame-unscanned' }),
    );
    fsState.candidateCount = 12; // this time the scan runs...
    anchorPick.best = null;      // ...and the tail really is degenerate
    const { unlink, writeFile } = await import('fs/promises');

    await extractLastFrame(ID);

    const sidecarPath = join(MOCK_PATHS.images, ANCHOR.replace('.png', '.metadata.json'));
    expect(vi.mocked(unlink)).toHaveBeenCalledWith(sidecarPath);
    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: 'last-frame' });
  });

  it('terminates a hung end seek and removes its partial anchor', async () => {
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    anchorPick.best = null;
    const { spawn } = await import('../../lib/childProcess.js');
    const { unlink } = await import('fs/promises');
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(signal => {
        if (signal === 'SIGKILL') child.emit('close', null, signal);
      }),
    });
    const { promise: started, resolve: markStarted } = Promise.withResolvers();
    vi.mocked(spawn).mockImplementationOnce(() => fx.makeProc()).mockImplementationOnce(() => {
      // Leave the scan and fixture I/O on the real clock.
      vi.useFakeTimers();
      markStarted();
      return child;
    });
    const result = expect(extractLastFrame(ID)).rejects.toMatchObject({ code: 'FFMPEG_FAILED' });
    try {
      await started;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
      const { FFMPEG_KILL_GRACE_MS } = await import('../../lib/ffmpeg/process.js');
      await vi.advanceTimersByTimeAsync(FFMPEG_KILL_GRACE_MS);
      await result;
      expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
      expect(unlink).toHaveBeenCalledWith(join(MOCK_PATHS.images, ANCHOR));
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the end seek when no candidate is usable', async () => {
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    anchorPick.best = null;
    const { copyFile, writeFile } = await import('fs/promises');

    await expect(extractLastFrame(ID)).resolves.toEqual({
      filename: ANCHOR,
      path: `/data/images/${ANCHOR}`,
    });

    expect(vi.mocked(copyFile)).not.toHaveBeenCalled();
    const spawns = await ffmpegSpawns();
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toEqual(expect.arrayContaining(['-sseof', '-1.0', '-vframes', '1']));
    // The fallback genuinely doesn't know which frame it got, so the sidecar
    // keeps the legacy value rather than inventing an offset.
    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: 'last-frame' });
  });
});
