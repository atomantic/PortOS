import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// startHfDownloadStream's cache short-circuit (`if (existing.cached) continue`)
// must be bypassable via `force` — otherwise a repair that deleted one shard of
// a multi-file repo (leaving the rest cached) would skip the re-download and
// never pull the deleted shard back. Mock the IO-bound cache inspect + HF fetch
// so the pure stream-control logic is exercised in isolation.

vi.mock('./hfCache.js', () => ({
  inspectModelCache: vi.fn(async () => ({ cached: true, sizeBytes: 100, snapshotPath: '/snap' })),
  findCachedRepoFile: vi.fn(async () => null),
}));

vi.mock('./hfDownload.js', () => ({
  // Resolve with the real `{ ok, sizeBytes }` shape downloadHfRepo always
  // returns — a bare undefined would read as a failure to the outcome logging.
  downloadHfRepo: vi.fn(() => ({ promise: Promise.resolve({ ok: true, sizeBytes: 100 }), kill: vi.fn() })),
}));

import { startHfDownloadStream } from './sseDownload.js';
import { inspectModelCache } from './hfCache.js';
import { downloadHfRepo } from './hfDownload.js';

// Minimal req/res doubles. Disconnect detection lives on `res` (see
// onClientDisconnect), so `res.on` records handlers and `disconnect()` fires
// them the way a real client hang-up would.
const makeReqRes = () => {
  const frames = [];
  const req = { on: vi.fn() };
  const handlers = {};
  const res = {
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn((chunk) => { frames.push(chunk); }),
    end: vi.fn(function end() { res.writableEnded = true; }),
    on: vi.fn((event, cb) => { handlers[event] = cb; }),
  };
  const disconnect = () => handlers.close?.();
  return { req, res, frames, disconnect };
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

  it('uses the immutable revision for cache inspection and download', async () => {
    inspectModelCache.mockResolvedValueOnce({ cached: false, sizeBytes: 0, snapshotPath: null });
    const revision = '1111111111111111111111111111111111111111';
    const { req, res } = makeReqRes();
    await startHfDownloadStream({
      req, res,
      repos: [{ repo: 'org/pinned', revision, only: [] }],
    });
    expect(inspectModelCache).toHaveBeenCalledWith('org/pinned', { revision });
    expect(downloadHfRepo).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'org/pinned', revision,
    }));
  });
});

// The download flow used to surface progress ONLY on the SSE stream to the
// browser — a headless/PM2 server log had no record the multi-GB pull ever
// ran. These assert the server-side console visibility added to the driver.
describe('startHfDownloadStream server-side logging', () => {
  let logSpy;
  let errorSpy;

  // res double whose `close` handler we can fire on demand (to simulate the
  // EventSource client hanging up mid-download). The handler lives on `res`,
  // not `req` — see onClientDisconnect.
  const makeLoggingReqRes = () => {
    let closeHandler;
    const req = { on: vi.fn() };
    const res = {
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(function end() { res.writableEnded = true; }),
      on: vi.fn((ev, cb) => { if (ev === 'close') closeHandler = cb; }),
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

  it('does not log every byte-progress tick', async () => {
    inspectModelCache.mockResolvedValue({ cached: false });
    downloadHfRepo.mockImplementation(({ onEvent }) => ({
      promise: (async () => {
        onEvent({
          type: 'progress', stage: 'download', step: 1, total: 1,
          file: 'weights.safetensors',
        });
        onEvent({
          type: 'progress', stage: 'download', step: 1, total: 1,
          file: 'weights.safetensors', downloaded: 1024, totalBytes: 4096,
        });
        onEvent({
          type: 'progress', stage: 'download', step: 1, total: 1,
          file: 'weights.safetensors', downloaded: 2048, totalBytes: 4096,
        });
        return { ok: true, sizeBytes: 4096 };
      })(),
      kill: vi.fn(),
    }));

    const { req, res } = makeLoggingReqRes();
    await startHfDownloadStream({ req, res, repo: 'org/big-file' });

    const fileLines = logged(logSpy).filter((l) => l.includes('org/big-file: weights.safetensors'));
    expect(fileLines).toHaveLength(1);
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

  // The inverse of `only`: still snapshot the repo, but drop paths the runtime
  // never loads. MiniMax Music 3 ships a 20 GB captioner and 10 GB of
  // original-format checkpoints beside the 29 GB its diffusers pipeline reads.
  it('forwards `ignore` globs for a snapshot pull', async () => {
    const { req, res } = makeReqRes();
    await startHfDownloadStream({ req, res, repos: [{ repo: 'org/bundle', ignore: ['extra/*', 'legacy.pth'] }] });
    expect(downloadHfRepo).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'org/bundle',
      only: null,
      ignore: ['extra/*', 'legacy.pth'],
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
    downloadHfRepo.mockImplementation(({ repo, onEvent }) => {
      onEvent({ type: 'error', kind: 'x', message: `${repo} broke` });
      return {
        promise: Promise.resolve({ ok: false, errorKind: 'x', errorMessage: `${repo} broke` }),
        kill: vi.fn(),
      };
    });

    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: CANDIDATES, cachedFile: async () => false });
    const events = parseFrames(frames);
    const terminal = events.filter((event) => event.type === 'error');
    expect(terminal).toHaveLength(1);
    const last = terminal[0];
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

  it('never inspects the whole repo for a single-file pull (#3112)', async () => {
    // inspectModelCache recursively stats EVERY weight in the snapshot. Against a
    // populated 708 GB mirror that's the expensive walk the single-file path
    // exists to avoid — and its verdict would be wrong anyway (cached off any
    // unrelated resident file). It must not be called at all.
    const { req, res } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: CANDIDATES, cachedFile: async () => false });
    expect(inspectModelCache).not.toHaveBeenCalled();
  });

  it('does NOT treat a single-file pull as cached when no predicate is supplied', async () => {
    // Fail-safe direction: a caller that forgot `cachedFile` must re-fetch (cheap,
    // etag no-op) rather than inherit the repo-wide `cached: true` and skip a
    // weight the user doesn't have.
    inspectModelCache.mockResolvedValue({ cached: true, sizeBytes: 700e9, snapshotPath: '/snap' });
    const { req, res } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: [CANDIDATES[0]] });
    expect(downloadHfRepo).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty fallbacks list rather than silently completing', async () => {
    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, fallbacks: [] });
    expect(downloadHfRepo).not.toHaveBeenCalled();
    expect(parseFrames(frames)).toEqual([{ type: 'error', message: 'No repo specified for download.' }]);
  });
});

// ── Multi-repo `repos:` — ALL must succeed, unlike `fallbacks` above ────────
describe('startHfDownloadStream repos (ALL must succeed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectModelCache.mockResolvedValue({ cached: false, sizeBytes: 0, snapshotPath: null });
  });

  it('reports an error and stops when one of several required repos fails, instead of completing', async () => {
    downloadHfRepo
      .mockReturnValueOnce({ promise: Promise.resolve({ ok: true, sizeBytes: 100 }), kill: vi.fn() })
      .mockReturnValueOnce({
        promise: Promise.resolve({ ok: false, errorKind: 'download_failed', errorMessage: 'network reset' }),
        kill: vi.fn(),
      });

    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, repos: ['org/repo-a', 'org/repo-b'] });

    const parsed = parseFrames(frames);
    expect(parsed.some((f) => f.type === 'complete')).toBe(false);
    expect(parsed.at(-1)).toMatchObject({ type: 'error', repo: 'org/repo-b' });
    // A required repo failing must stop the chain rather than rolling on.
    expect(downloadHfRepo).toHaveBeenCalledTimes(2);
  });

  it('completes once every required repo succeeds', async () => {
    // Explicit mockReturnValue (not -Once) so this test's total doesn't depend
    // on how many queued mockReturnValueOnce entries earlier tests left behind.
    downloadHfRepo.mockReturnValue({ promise: Promise.resolve({ ok: true, sizeBytes: 100 }), kill: vi.fn() });
    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({ req, res, repos: ['org/repo-a', 'org/repo-b'] });

    const parsed = parseFrames(frames);
    expect(parsed.at(-1)).toMatchObject({ type: 'complete', repos: ['org/repo-a', 'org/repo-b'], sizeBytes: 200 });
  });

  it('downloads only the exact files declared by a required aggregate target', async () => {
    downloadHfRepo.mockReturnValue({ promise: Promise.resolve({ ok: true, sizeBytes: 50 }), kill: vi.fn() });
    const { req, res, frames } = makeReqRes();
    await startHfDownloadStream({
      req,
      res,
      repos: [
        { repo: 'org/base', only: [] },
        { repo: 'org/adapters', only: ['profile/high.safetensors', 'profile/low.safetensors'] },
      ],
      pythonPath: '/runtime/bin/python3',
    });
    expect(downloadHfRepo).toHaveBeenNthCalledWith(2, expect.objectContaining({
      repo: 'org/adapters',
      only: ['profile/high.safetensors', 'profile/low.safetensors'],
      pythonPath: '/runtime/bin/python3',
    }));
    expect(parseFrames(frames).at(-1)).toMatchObject({ type: 'complete' });
  });
});

// The bug this guards was invisible to the doubles above: it depended on Node's
// real `IncomingMessage` lifecycle, so it needs a real socket. `express.json()`
// finishes reading a POST body before the handler runs, leaving `req.complete
// === true` — so a `req.on('close')` listener attached before the first `await`
// fired immediately and read as a client disconnect. The download aborted
// before its first frame, the stream closed empty, and because an empty stream
// carries no `error` event the UI reported the install as a success.
describe('startHfDownloadStream over a real socket (POST body already consumed)', () => {
  let server;
  let baseUrl;

  const startServer = async () => {
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.post('/download', (req, res) => {
      // Mirrors POST /api/music/models: hand the response straight to the driver.
      startHfDownloadStream({ req, res, repo: 'org/model' });
    });
    app.get('/download', (req, res) => {
      startHfDownloadStream({ req, res, repo: 'org/model' });
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  };

  const collect = async (init) => {
    const res = await fetch(`${baseUrl}/download`, init);
    const text = await res.text();
    return text.split('\n\n').map((f) => f.replace(/^data: /, '').trim()).filter(Boolean).map((f) => JSON.parse(f));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    inspectModelCache.mockResolvedValue({ cached: false, sizeBytes: 0 });
    downloadHfRepo.mockImplementation(({ onEvent }) => ({
      promise: Promise.resolve().then(() => {
        onEvent({ type: 'progress', stage: 'download', step: 1, total: 1, file: 'weights.safetensors' });
        return { ok: true, sizeBytes: 1234 };
      }),
      kill: vi.fn(),
    }));
    await startServer();
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('downloads on a POST instead of closing an empty stream', async () => {
    const events = await collect({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'minimax-music3', repo: 'org/model' }),
    });

    expect(downloadHfRepo).toHaveBeenCalledTimes(1);
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
    // The exact shape of the old failure: a 200 that streamed nothing at all.
    expect(events).not.toHaveLength(0);
  });

  it('still downloads on a GET (the shape every other caller uses)', async () => {
    const events = await collect({ method: 'GET' });
    expect(downloadHfRepo).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
  });
});
