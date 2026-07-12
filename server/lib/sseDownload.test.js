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
