import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import {
  SUPPORTED_VIDEO_URL_RE,
  assertSupportedVideoUrl,
  listDownloads,
  deleteDownload,
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
