import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the history store so listDownloads/deleteDownload can be exercised
// without touching disk, and mock deleteHistoryItem so deleteDownload's
// delegation is observable.
const { historyStore, deleteHistoryItem } = vi.hoisted(() => ({
  historyStore: { items: [] },
  deleteHistoryItem: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./videoGen/history.js', () => ({
  loadHistory: vi.fn(async () => historyStore.items),
  saveHistory: vi.fn(async (h) => { historyStore.items = h; }),
}));
vi.mock('./videoGen/local.js', () => ({ deleteHistoryItem }));
vi.mock('./videoGen/events.js', () => ({ videoGenEvents: { emit: vi.fn() } }));

import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SUPPORTED_VIDEO_URL_RE,
  assertSupportedVideoUrl,
  listDownloads,
  deleteDownload,
  buildDownloadHistoryEntry,
  findDownloadedFile,
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

  it('deletes a download by delegating to deleteHistoryItem', async () => {
    const res = await deleteDownload('dl-1');
    expect(res).toEqual({ ok: true });
    expect(deleteHistoryItem).toHaveBeenCalledWith('dl-1');
  });

  it('refuses to delete a non-download history id (404)', async () => {
    await expect(deleteDownload('gen-1')).rejects.toMatchObject({ status: 404 });
    expect(deleteHistoryItem).not.toHaveBeenCalled();
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

describe('findDownloadedFile (robust output detection)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'viddl-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('prefers an exact .mp4 over other candidates', async () => {
    await writeFile(join(dir, 'downloaded-x.mp4'), 'v');
    await writeFile(join(dir, 'downloaded-x.webm'), 'v');
    expect(await findDownloadedFile('x', dir)).toBe('downloaded-x.mp4');
  });

  it('finds a non-mp4 single-file result (the .mp4-assumption bug)', async () => {
    await writeFile(join(dir, 'downloaded-y.webm'), 'v');
    expect(await findDownloadedFile('y', dir)).toBe('downloaded-y.webm');
  });

  it('ignores in-progress and format-fragment intermediates', async () => {
    await writeFile(join(dir, 'downloaded-z.f137.mp4'), 'v'); // fragment
    await writeFile(join(dir, 'downloaded-z.mp4.part'), 'v'); // partial
    await writeFile(join(dir, 'downloaded-z.webm.ytdl'), 'v'); // sidecar
    expect(await findDownloadedFile('z', dir)).toBeNull();
  });

  it('does not match a different job id', async () => {
    await writeFile(join(dir, 'downloaded-other.mp4'), 'v');
    expect(await findDownloadedFile('mine', dir)).toBeNull();
  });
});
