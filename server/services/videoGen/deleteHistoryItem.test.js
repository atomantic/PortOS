/**
 * Video delete → media-asset-index delete hook (#2738).
 *
 * Focused wiring suite: the contract is that deleteHistoryItem hands the index
 * the JOB ID (not the filename — the index keys videos by id) and survives a
 * failing hook. Disk + history are fully mocked, so nothing here touches real
 * videos; db.test.js covers the row/count side against a real table.
 *
 * `deleteDownload` (videoDownload.js) delegates straight to deleteHistoryItem,
 * so downloads inherit this hook — no separate wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

const MOCK_PATHS = {
  root: '/mock/root',
  data: '/mock/data',
  videos: '/mock/data/videos',
  images: '/mock/data/images',
  videoThumbnails: '/mock/data/video-thumbnails',
  uploads: '/mock/data/uploads',
  loras: '/mock/data/loras',
};

vi.mock('../../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn(async () => null),
  ensureDir: vi.fn(async () => {}),
  PATHS: MOCK_PATHS,
  readJSONFile: vi.fn(async () => []),
  atomicWrite: vi.fn(async () => {}),
  assertSafeFilename: vi.fn(),
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
}));

vi.mock('../../lib/mediaModels.js', () => ({
  getVideoModels: vi.fn(() => []),
  getDefaultVideoModelId: vi.fn(() => 'ltx2_unified'),
  getTextEncoderRepo: vi.fn(() => 'some/text-encoder'),
}));

vi.mock('../../lib/sseUtils.js', () => ({
  broadcastSse: vi.fn(),
  attachSseClient: vi.fn(() => true),
  closeJobAfterDelay: vi.fn(),
  PYTHON_NOISE_RE: /^\s*$/,
}));

vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn(async () => '/usr/bin/ffmpeg'),
  safeUnder: vi.fn((base, file) => (file ? join(base, file) : null)),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  optimizeForStreaming: vi.fn(async () => {}),
  upscaleVideo2x: vi.fn(async () => ({ ok: true })),
  extractEvaluationFrames: vi.fn(async () => []),
}));

vi.mock('../../lib/hfToken.js', () => ({
  hfTokenEnv: vi.fn(async () => ({})),
  getHfToken: vi.fn(async () => null),
}));

const unlink = vi.fn(async () => {});
vi.mock('fs/promises', () => ({ unlink, writeFile: vi.fn(async () => {}), copyFile: vi.fn(async () => {}) }));
vi.mock('fs', () => ({ existsSync: vi.fn(() => true), statSync: vi.fn(() => ({ size: 1000 })) }));

// The history store the delete reads/writes. mutateVideoHistory applies the
// mutator to the live list so the test can assert the entry really left.
let history = [];
const loadHistory = vi.fn(async () => history.slice());
const mutateVideoHistory = vi.fn(async (fn) => { history = fn(history.slice()); return history; });
vi.mock('./history.js', () => ({ loadHistory, mutateVideoHistory, saveHistory: vi.fn(async () => {}) }));

const unindexVideo = vi.fn(async () => {});
vi.mock('../mediaAssetIndex/index.js', () => ({ unindexVideo }));

const { deleteHistoryItem } = await import('./local.js');

beforeEach(() => {
  vi.clearAllMocks();
  history = [{ id: 'job-1', filename: 'job-1.mp4', thumbnail: 'job-1.jpg', createdAt: '2026-01-01T00:00:00.000Z' }];
});

describe('deleteHistoryItem → media asset index delete hook', () => {
  it('unindexes the deleted video by its JOB ID, not its filename', async () => {
    const res = await deleteHistoryItem('job-1');

    expect(res).toEqual({ ok: true });
    expect(history).toEqual([]);
    // videoToRow keys a video row `video:<id>`, so the delete must pass the id.
    // Passing item.filename here would DELETE NOTHING and leave the row stale.
    expect(unindexVideo).toHaveBeenCalledWith('job-1');
    expect(unindexVideo).not.toHaveBeenCalledWith('job-1.mp4');
  });

  it('is non-fatal: a failing index removal still removes the entry and returns ok', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    unindexVideo.mockRejectedValueOnce(new Error('db down'));

    await expect(deleteHistoryItem('job-1')).resolves.toEqual({ ok: true });
    expect(history).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('db down'));
    errSpy.mockRestore();
  });

  it('never reaches the index for an unknown id (404 before any hook)', async () => {
    await expect(deleteHistoryItem('nope')).rejects.toThrow('Not found');
    expect(unindexVideo).not.toHaveBeenCalled();
  });
});
