/**
 * #4162 — a federated video poster must un-stick from MediaImage's "Syncing"
 * placeholder on its own.
 *
 * Two halves to the bug, both covered here:
 *   1. the regenerated thumbnail got NO `asset-arrived` emit (only the `.mp4`
 *      did), and MediaImage matches on filename, so a poster that already 404'd
 *      stayed on the placeholder until a remount;
 *   2. the thumbnail's NAME was derived from the mp4 basename, which is only
 *      coincidentally right for a videoGen clip (`<jobId>.mp4`) and flatly wrong
 *      for a stitched timeline final (`timeline-<slice>-<ts>.mp4` beside an
 *      independent `randomUUID()` history id).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot = mkdtempSync(join(tmpdir(), 'portos-vthumb-boot-'));

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

const peers = [];
vi.mock('../instances.js', () => ({
  getPeers: vi.fn(async () => peers),
}));

vi.mock('../../lib/peerHttpClient.js', () => ({ peerFetch: vi.fn() }));

// Stub only the thumbnail generator — the rest of ffmpeg.js stays real so any
// other consumer in the import graph behaves normally. The real one shells out
// to ffmpeg, which CI has no business requiring.
vi.mock('../../lib/ffmpeg.js', async () => {
  const actual = await vi.importActual('../../lib/ffmpeg.js');
  return { ...actual, generateThumbnail: vi.fn(async (_videoPath, jobId) => `${jobId}.jpg`) };
});

const { peerFetch } = await import('../../lib/peerHttpClient.js');
const { generateThumbnail } = await import('../../lib/ffmpeg.js');
const { pullMissingAssetsFromPeer, assetWriteQueue } = await import('./peerSyncAssets.js');
const { peerSyncEvents } = await import('./peerSyncShared.js');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const mkRes = (buffer) => ({
  ok: true,
  headers: {
    has: (h) => h === 'content-length',
    get: (h) => (h === 'content-length' ? String(buffer.length) : null),
  },
  arrayBuffer: async () => buffer,
});

function writeVideoHistory(rows) {
  writeFileSync(join(tempRoot, 'video-history.json'), JSON.stringify(rows));
}

/** Collect every `asset-arrived` payload emitted during `run()`. */
async function captureArrivals(run) {
  const seen = [];
  const handler = (payload) => seen.push(payload);
  peerSyncEvents.on('asset-arrived', handler);
  try {
    await run();
  } finally {
    peerSyncEvents.off('asset-arrived', handler);
  }
  return seen;
}

async function pullVideo(filename, bytes) {
  vi.mocked(peerFetch).mockResolvedValue(mkRes(bytes));
  return captureArrivals(() => pullMissingAssetsFromPeer('peer-a', [
    { filename, kind: 'video', sha256: sha(bytes) },
  ]));
}

describe('#4162 — pulled-video thumbnail naming + arrival event', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-vthumb-'));
    mkdirSync(join(tempRoot, 'videos'), { recursive: true });
    assetWriteQueue.clear();
    vi.mocked(peerFetch).mockReset();
    vi.mocked(generateThumbnail).mockClear();
    peers.length = 0;
    peers.push({ instanceId: 'peer-a', name: 'peer-a', address: '192.0.2.10', port: 5555, fullSync: true });
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('names a stitched timeline final\'s thumbnail from the history row, not the mp4 stem', async () => {
    // The shape videoTimeline/local.js persists: an independent randomUUID id
    // (and `<id>.jpg` poster) beside a `timeline-…` filename.
    writeVideoHistory([{
      id: '11111111-2222-3333-4444-555555555555',
      filename: 'timeline-abcd1234-1700000000000.mp4',
      thumbnail: '11111111-2222-3333-4444-555555555555.jpg',
    }]);
    const arrivals = await pullVideo('timeline-abcd1234-1700000000000.mp4', Buffer.from('mp4-bytes'));

    expect(vi.mocked(generateThumbnail)).toHaveBeenCalledTimes(1);
    const [videoPath, jobId] = vi.mocked(generateThumbnail).mock.calls[0];
    expect(videoPath).toBe(join(tempRoot, 'videos', 'timeline-abcd1234-1700000000000.mp4'));
    // The bug: this used to be 'timeline-abcd1234-1700000000000'.
    expect(jobId).toBe('11111111-2222-3333-4444-555555555555');

    expect(arrivals.map((a) => a.filename)).toEqual([
      'timeline-abcd1234-1700000000000.mp4',
      '11111111-2222-3333-4444-555555555555.jpg',
    ]);
    const thumbArrival = arrivals[1];
    expect(thumbArrival.kind).toBe('video-thumbnail');
    expect(thumbArrival.peerId).toBe('peer-a');
  });

  it('emits an arrival for a videoGen clip thumbnail too (name already matched the stem)', async () => {
    writeVideoHistory([{
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      filename: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
      thumbnail: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg',
    }]);
    const arrivals = await pullVideo('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4', Buffer.from('clip-bytes'));

    expect(vi.mocked(generateThumbnail).mock.calls[0][1]).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(arrivals.map((a) => a.filename)).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg');
  });

  it('falls back to the mp4 stem when the history row has not synced yet', async () => {
    // No video-history.json at all — the bytes beat the `videoHistory` metadata
    // category across. Pre-fix behavior is the fallback, not a regression.
    const arrivals = await pullVideo('ffffffff-0000-1111-2222-333333333333.mp4', Buffer.from('orphan-bytes'));

    expect(vi.mocked(generateThumbnail).mock.calls[0][1]).toBe('ffffffff-0000-1111-2222-333333333333');
    expect(arrivals.map((a) => a.filename)).toContain('ffffffff-0000-1111-2222-333333333333.jpg');
  });

  it('ignores a traversal-shaped `thumbnail` from a peer row and falls back to the stem', async () => {
    writeVideoHistory([{
      id: 'evil',
      filename: 'timeline-deadbeef-1700000000001.mp4',
      thumbnail: '../../escape.jpg',
    }]);
    await pullVideo('timeline-deadbeef-1700000000001.mp4', Buffer.from('evil-bytes'));

    expect(vi.mocked(generateThumbnail).mock.calls[0][1]).toBe('timeline-deadbeef-1700000000001');
  });

  it('emits no thumbnail arrival when regeneration fails (no ffmpeg)', async () => {
    vi.mocked(generateThumbnail).mockResolvedValueOnce(null);
    const arrivals = await pullVideo('timeline-cafebabe-1700000000002.mp4', Buffer.from('no-ffmpeg-bytes'));

    expect(arrivals.map((a) => a.filename)).toEqual(['timeline-cafebabe-1700000000002.mp4']);
  });
});
