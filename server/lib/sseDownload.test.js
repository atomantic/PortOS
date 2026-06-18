import { describe, it, expect, vi, beforeEach } from 'vitest';

// startHfDownloadStream's cache short-circuit (`if (existing.cached) continue`)
// must be bypassable via `force` — otherwise a repair that deleted one shard of
// a multi-file repo (leaving the rest cached) would skip the re-download and
// never pull the deleted shard back. Mock the IO-bound cache inspect + HF fetch
// so the pure stream-control logic is exercised in isolation.

vi.mock('./hfCache.js', () => ({
  inspectModelCache: vi.fn(async () => ({ cached: true, sizeBytes: 100, snapshotPath: '/snap' })),
}));

vi.mock('./hfDownload.js', () => ({
  downloadHfRepo: vi.fn(() => ({ promise: Promise.resolve(), kill: vi.fn() })),
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
