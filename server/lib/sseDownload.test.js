import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// startHfDownloadStream's cache short-circuit (`if (existing.cached) continue`)
// must be bypassable via `force` — otherwise a repair that deleted one shard of
// a multi-file repo (leaving the rest cached) would skip the re-download and
// never pull the deleted shard back. Mock the IO-bound cache inspect + HF fetch
// so the pure stream-control logic is exercised in isolation.

vi.mock('./hfCache.js', () => ({
  inspectModelCache: vi.fn(async () => ({ cached: true, sizeBytes: 100, snapshotPath: '/snap' })),
}));

vi.mock('./hfDownload.js', () => ({
  // Resolve with the real `{ ok, sizeBytes }` shape downloadHfRepo always
  // returns — a bare undefined would read as a failure to the outcome logging.
  downloadHfRepo: vi.fn(() => ({ promise: Promise.resolve({ ok: true, sizeBytes: 100 }), kill: vi.fn() })),
}));

import { startHfDownloadStream } from './sseDownload.js';
import { inspectModelCache } from './hfCache.js';
import { downloadHfRepo } from './hfDownload.js';

// Minimal req/res doubles — req only needs `.on('close')`; res captures the
// SSE frames written so we can assert the terminal `complete` message.
const makeReqRes = () => {
  const frames = [];
  const req = { on: vi.fn() };
  const res = {
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn((chunk) => { frames.push(chunk); }),
    end: vi.fn(function end() { res.writableEnded = true; }),
  };
  return { req, res, frames };
};

const parseFrames = (frames) => frames
  .map((f) => f.replace(/^data: /, '').trim())
  .filter(Boolean)
  .map((f) => JSON.parse(f));

describe('startHfDownloadStream force', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectModelCache.mockResolvedValue({ cached: true, sizeBytes: 100, snapshotPath: '/snap' });
  });

  it('skips the HF fetch for a cached repo when force is unset (Download button)', async () => {
    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, repo: 'org/encoder' });
    expect(downloadHfRepo).not.toHaveBeenCalled();
    const events = parseFrames(frames);
    expect(events.some((e) => e.type === 'log' && /already cached/.test(e.message))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
  });

  it('re-fetches a cached repo when force is set (repair re-download)', async () => {
    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, repo: 'org/encoder', force: true });
    // The whole point of the fix: a still-cached repo (surviving shards) is
    // re-downloaded instead of skipped, so a deleted shard is pulled back.
    expect(downloadHfRepo).toHaveBeenCalledWith(expect.objectContaining({ repo: 'org/encoder' }));
    const events = parseFrames(frames);
    expect(events.at(-1)).toMatchObject({ type: 'complete', message: 'org/encoder downloaded.' });
  });
});

// The download flow used to surface progress ONLY on the SSE stream to the
// browser — a headless/PM2 server log had no record the multi-GB pull ever
// ran. These assert the server-side console visibility added to the driver.
describe('startHfDownloadStream server-side logging', () => {
  let logSpy;
  let errorSpy;

  // req double whose `close` handler we can fire on demand (to simulate the
  // EventSource client hanging up mid-download).
  const makeLoggingReqRes = () => {
    let closeHandler;
    const req = { on: vi.fn((ev, cb) => { if (ev === 'close') closeHandler = cb; }) };
    const res = {
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(function end() { res.writableEnded = true; }),
    };
    return { req, res, fireClose: () => closeHandler?.() };
  };

  const logged = (spy) => spy.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs start, per-file progress, and completion for a fresh download', async () => {
    inspectModelCache.mockResolvedValue({ cached: false });
    downloadHfRepo.mockImplementation(({ onEvent }) => ({
      promise: (async () => {
        onEvent({ type: 'progress', step: 1, total: 2, file: 'model-00001-of-00002.safetensors' });
        return { ok: true, sizeBytes: 4096 };
      })(),
      kill: vi.fn(),
    }));

    const { req, res } = makeLoggingReqRes();
    await startHfDownloadStream({ req, res, repo: 'org/flux-fresh' });

    const lines = logged(logSpy);
    expect(lines.some((l) => l.includes('Downloading HuggingFace repo: org/flux-fresh'))).toBe(true);
    expect(lines.some((l) => l.includes('org/flux-fresh: model-00001-of-00002.safetensors (1/2)'))).toBe(true);
    expect(lines.some((l) => l.includes('download complete: org/flux-fresh (4096 bytes)'))).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs the forced re-fetch marker', async () => {
    inspectModelCache.mockResolvedValue({ cached: true, sizeBytes: 10 });
    downloadHfRepo.mockImplementation(() => ({
      promise: Promise.resolve({ ok: true, sizeBytes: 10 }),
      kill: vi.fn(),
    }));

    const { req, res } = makeLoggingReqRes();
    await startHfDownloadStream({ req, res, repo: 'org/flux-force', force: true });

    expect(logged(logSpy).some((l) => l.includes('Downloading HuggingFace repo: org/flux-force (forced re-fetch)'))).toBe(true);
  });

  it('logs a cache hit without spawning a download', async () => {
    inspectModelCache.mockResolvedValue({ cached: true, sizeBytes: 2048 });

    const { req, res } = makeLoggingReqRes();
    await startHfDownloadStream({ req, res, repo: 'org/flux-cached' });

    expect(downloadHfRepo).not.toHaveBeenCalled();
    expect(logged(logSpy).some((l) => l.includes('already cached: org/flux-cached (2048 bytes)'))).toBe(true);
  });

  it('logs a failed download at error level (non-cancelled)', async () => {
    inspectModelCache.mockResolvedValue({ cached: false });
    downloadHfRepo.mockImplementation(() => ({
      promise: Promise.resolve({ ok: false, errorKind: 'auth', errorMessage: 'gated repo' }),
      kill: vi.fn(),
    }));

    const { req, res } = makeLoggingReqRes();
    await startHfDownloadStream({ req, res, repo: 'org/flux-fail' });

    expect(logged(errorSpy).some((l) => l.includes('download failed: org/flux-fail — gated repo'))).toBe(true);
  });

  it('logs cancellation and kills the child on client disconnect', async () => {
    inspectModelCache.mockResolvedValue({ cached: false });
    let resolveDownload;
    const kill = vi.fn();
    downloadHfRepo.mockImplementation(() => ({
      promise: new Promise((resolve) => { resolveDownload = resolve; }),
      kill,
    }));

    const { req, res, fireClose } = makeLoggingReqRes();
    const done = startHfDownloadStream({ req, res, repo: 'org/flux-cancel' });

    // Wait until the driver has actually spawned the download (currentHandle
    // set) before simulating the client hanging up.
    await vi.waitFor(() => expect(downloadHfRepo).toHaveBeenCalled());
    fireClose();

    expect(kill).toHaveBeenCalled();
    expect(logged(logSpy).some((l) => l.includes('cancelled (client disconnect)'))).toBe(true);

    // A cancelled result must NOT be logged as a failure.
    resolveDownload({ ok: false, errorKind: 'cancelled', errorMessage: 'Cancelled' });
    await done;
    expect(logged(errorSpy).some((l) => l.includes('download failed'))).toBe(false);
  });
});

// ── Single-file + first-success-wins fallbacks (#3112) ──────────────────────
// `fallbacks` exists because the Ingredients IC weight lives in TWO repos with
// different access: a gated first-party repo and the un-gated ~708 GB
// `DeepBeepMeep/LTX-2` aggregate mirror. That makes two behaviors mandatory —
// single-file pulls (a snapshot of the mirror would fill the user's disk) and
// advancing to the next source on failure (so a user with no HF token succeeds).
describe('startHfDownloadStream single-file + fallbacks (#3112)', () => {
  const CANDIDATES = [
    { repo: 'org/official', only: ['weight.safetensors'] },
    { repo: 'org/mirror-708gb', only: ['weight.safetensors'] },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    inspectModelCache.mockResolvedValue({ cached: false, sizeBytes: 0, snapshotPath: null });
    downloadHfRepo.mockImplementation(() => ({
      promise: Promise.resolve({ ok: true, sizeBytes: 1000 }),
      kill: vi.fn(),
    }));
  });

  it('forwards `only` so the helper never enumerates the repo', async () => {
    const { req, res } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: [CANDIDATES[0]], cachedFile: async () => false });
    expect(downloadHfRepo).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'org/official',
      only: ['weight.safetensors'],
    }));
  });

  it('stops at the first success without touching the mirror', async () => {
    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: CANDIDATES, cachedFile: async () => false });
    expect(downloadHfRepo).toHaveBeenCalledTimes(1);
    expect(downloadHfRepo.mock.calls[0][0].repo).toBe('org/official');
    expect(parseFrames(frames).at(-1)).toMatchObject({ type: 'complete', repos: ['org/official'] });
  });

  it('advances to the mirror when the gated repo fails', async () => {
    downloadHfRepo.mockImplementation(({ repo }) => ({
      promise: Promise.resolve(repo === 'org/official'
        ? { ok: false, errorKind: 'gated_repo', errorMessage: 'gated' }
        : { ok: true, sizeBytes: 1000 }),
      kill: vi.fn(),
    }));

    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: CANDIDATES, cachedFile: async () => false });
    expect(downloadHfRepo.mock.calls.map((c) => c[0].repo)).toEqual(['org/official', 'org/mirror-708gb']);
    const events = parseFrames(frames);
    // The retried failure must NOT reach the client as an error — otherwise the UI
    // flashes a red "gated repo" banner for something the mirror then delivers.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'complete', repos: ['org/mirror-708gb'] });
  });

  it('reports every attempt when all sources fail', async () => {
    downloadHfRepo.mockImplementation(({ repo }) => ({
      promise: Promise.resolve({ ok: false, errorKind: 'x', errorMessage: `${repo} broke` }),
      kill: vi.fn(),
    }));

    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: CANDIDATES, cachedFile: async () => false });
    const last = parseFrames(frames).at(-1);
    expect(last).toMatchObject({ type: 'error', kind: 'all_sources_failed' });
    expect(last.message).toContain('org/official broke');
    expect(last.message).toContain('org/mirror-708gb broke');
  });

  it('does not roll onto the next source after a user cancel', async () => {
    downloadHfRepo.mockImplementation(() => ({
      promise: Promise.resolve({ ok: false, errorKind: 'cancelled', errorMessage: 'Cancelled' }),
      kill: vi.fn(),
    }));

    const { req, res } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: CANDIDATES, cachedFile: async () => false });
    // Cancel means "stop", not "try somewhere else".
    expect(downloadHfRepo).toHaveBeenCalledTimes(1);
  });

  it('defers the already-cached verdict to cachedFile, not the repo-wide flag', async () => {
    // The aggregate mirror reports `cached: true` off ANY resident weight. Without
    // the per-file predicate the driver would skip a weight the user doesn't have.
    inspectModelCache.mockResolvedValue({ cached: true, sizeBytes: 700e9, snapshotPath: '/snap' });

    const { req, res } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: [CANDIDATES[1]], cachedFile: async () => false });
    expect(downloadHfRepo).toHaveBeenCalledTimes(1);
  });

  it('short-circuits when cachedFile says the weight is already resident', async () => {
    inspectModelCache.mockResolvedValue({ cached: false, sizeBytes: 0, snapshotPath: null });

    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: CANDIDATES, cachedFile: async () => true });
    expect(downloadHfRepo).not.toHaveBeenCalled();
    const last = parseFrames(frames).at(-1);
    expect(last).toMatchObject({ type: 'complete' });
    // Present already ⇒ don't fall through to the mirror for something we have.
    expect(last.repos).toEqual(['org/official']);
  });

  it('never reports the aggregate repo size for a single-file cache hit', async () => {
    // 700 GB of unrelated weights is not this weight's footprint; reporting it
    // would put a wildly wrong number on the download badge.
    inspectModelCache.mockResolvedValue({ cached: true, sizeBytes: 700e9, snapshotPath: '/snap' });

    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: [CANDIDATES[1]], cachedFile: async () => true });
    expect(parseFrames(frames).at(-1).sizeBytes).toBe(0);
  });

  it('rejects an empty fallbacks list rather than silently completing', async () => {
    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: [] });
    expect(downloadHfRepo).not.toHaveBeenCalled();
    expect(parseFrames(frames)).toEqual([{ type: 'error', message: 'No repo specified for download.' }]);
  });
});
