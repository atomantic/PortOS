import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the history store so listDownloads/deleteDownload can be exercised
// without touching disk, and mock the owner-aware delete so deleteDownload's
// delegation is observable.
const { historyStore, deleteMediaAnywhere } = vi.hoisted(() => ({
  historyStore: { items: [] },
  deleteMediaAnywhere: vi.fn(async () => ({ ok: true, status: 'deleted' })),
}));
vi.mock('./videoGen/history.js', () => ({
  loadHistory: vi.fn(async () => historyStore.items),
  saveHistory: vi.fn(async (h) => { historyStore.items = h; }),
}));
vi.mock('./mediaRemoteDelete.js', () => ({ deleteMediaAnywhere }));
vi.mock('./videoGen/events.js', () => ({ videoGenEvents: { emit: vi.fn() } }));

import {
  SUPPORTED_VIDEO_URL_RE,
  assertSupportedVideoUrl,
  listDownloads,
  deleteDownload,
  buildDownloadHistoryEntry,
  cancelVideoDownload,
  __testing,
} from './videoDownload.js';

describe('videoDownload URL allowlist', () => {
  it('accepts YouTube watch, shorts, and youtu.be', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/shorts/abc123XYZ',
      'https://youtu.be/dQw4w9WgXcQ',
    ]) {
      expect(SUPPORTED_VIDEO_URL_RE.test(url)).toBe(true);
      expect(() => assertSupportedVideoUrl(url)).not.toThrow();
    }
  });

  it('accepts x.com and twitter.com status URLs', () => {
    expect(() => assertSupportedVideoUrl('https://x.com/someone/status/1234567890')).not.toThrow();
    expect(() => assertSupportedVideoUrl('https://twitter.com/someone/status/1234567890')).not.toThrow();
  });

  it('rejects other hosts and malformed URLs with a 400', () => {
    for (const url of ['https://vimeo.com/12345', 'https://example.com/x', 'not-a-url', '', null]) {
      expect(() => assertSupportedVideoUrl(url)).toThrow(/Unsupported video URL/);
    }
    // The thrown error carries the 400 status/code contract.
    try {
      assertSupportedVideoUrl('https://vimeo.com/12345');
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('VIDEO_URL_INVALID');
    }
  });
});

describe('listDownloads / deleteDownload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyStore.items = [
      { id: 'gen-1', filename: 'abc.mp4' }, // a real generation — must be excluded
      { id: 'dl-1', filename: 'downloaded-dl-1.mp4', source: 'download', title: 'Clip' },
    ];
  });

  it('lists only the source:download slice of history', async () => {
    const list = await listDownloads();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('dl-1');
  });

  // Uniquely catches a download delete that tombstones a peer's row here
  // instead of asking its owner (the owner-aware path decides where it goes).
  it('deletes a download through the owner-aware media delete', async () => {
    const res = await deleteDownload('dl-1');
    expect(res).toEqual({ ok: true, status: 'deleted' });
    expect(deleteMediaAnywhere).toHaveBeenCalledWith('video', 'dl-1');
  });

  it('refuses to delete a non-download history id (404)', async () => {
    await expect(deleteDownload('gen-1')).rejects.toMatchObject({ status: 404 });
    expect(deleteMediaAnywhere).not.toHaveBeenCalled();
  });

  it('404s for an unknown id', async () => {
    await expect(deleteDownload('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('buildDownloadHistoryEntry (contract shape)', () => {
  it('pins the fields normalizeVideo / videoToRow / deleteHistoryItem depend on', () => {
    const entry = buildDownloadHistoryEntry({
      jobId: 'job-1',
      filename: 'downloaded-job-1.mp4',
      thumbnail: 'job-1.jpg',
      durationSec: 42,
      title: 'A Clip',
      sourceUrl: 'https://youtu.be/abc123XYZ',
    });
    // id === jobId so the media-index completed hook + deleteHistoryItem resolve;
    // thumbnail/filename are what deleteHistoryItem unlinks.
    expect(entry.id).toBe('job-1');
    expect(entry.filename).toBe('downloaded-job-1.mp4');
    expect(entry.thumbnail).toBe('job-1.jpg');
    expect(entry.source).toBe('download');
    expect(entry.sourceUrl).toBe('https://youtu.be/abc123XYZ');
    expect(entry.title).toBe('A Clip');
    expect(entry.durationSec).toBe(42);
    expect(typeof entry.createdAt).toBe('string');
    // No `mode` field — `source` is the marker; a bogus mode would confuse the
    // gallery Remix path.
    expect(entry).not.toHaveProperty('mode');
  });

  it('defaults a missing title and omits durationSec when unknown', () => {
    const entry = buildDownloadHistoryEntry({
      jobId: 'j', filename: 'downloaded-j.mp4', thumbnail: null, durationSec: null, title: '', sourceUrl: 'u',
    });
    expect(entry.title).toBe('Downloaded video');
    expect(entry).not.toHaveProperty('durationSec');
  });
});

describe('cancelVideoDownload', () => {
  beforeEach(() => __testing.downloadJobs.clear());

  it('returns false for an unknown or already-finished job', () => {
    expect(cancelVideoDownload('nope')).toBe(false);
    // A job past its download has no process to signal.
    __testing.downloadJobs.set('done', { id: 'done', clients: [], process: null });
    expect(cancelVideoDownload('done')).toBe(false);
  });

  // Actually RUNS the cancel body. Without this the path had no coverage at all,
  // which is how a refactor shipped it calling an unimported killWithEscalation
  // — a ReferenceError on every cancel, with the whole suite green.
  it('signals the running child and escalates to SIGKILL if it survives the grace window', () => {
    vi.useFakeTimers();
    const proc = { exitCode: null, signalCode: null, kill: vi.fn() };
    const job = { id: 'live', clients: [], process: proc };
    __testing.downloadJobs.set('live', job);

    expect(cancelVideoDownload('live')).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(8000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });

  it('does not escalate when the child already exited', () => {
    vi.useFakeTimers();
    const proc = { exitCode: null, signalCode: null, kill: vi.fn() };
    __testing.downloadJobs.set('live', { id: 'live', clients: [], process: proc });

    cancelVideoDownload('live');
    proc.exitCode = 0; // the child honored SIGTERM
    vi.advanceTimersByTime(8000);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });
});
