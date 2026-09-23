/**
 * X post importer orchestration tests. The network (safeUrlFetch), the board
 * store (db.js), disk (fs/promises + fileUtils), and the federation emit are
 * mocked; the real pure parser (xPostMedia) runs so the URL→fetch→media→item
 * pipeline is exercised end to end without a DB or network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = {
  getBoard: vi.fn(),
  appendImportedItems: vi.fn(),
};
vi.mock('./db.js', () => store);

const net = { fetchPublicText: vi.fn(), fetchPublicBinary: vi.fn() };
vi.mock('../../lib/safeUrlFetch.js', () => net);

const emitRecordUpdated = vi.fn();
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated: (...a) => emitRecordUpdated(...a) }));

const writeFile = vi.fn();
const unlink = vi.fn(async () => {});
vi.mock('fs/promises', () => ({ writeFile: (...a) => writeFile(...a), unlink: (...a) => unlink(...a) }));
// Keep the real detectImageFormat (byte-sniffing) — only override PATHS/ensureDir.
vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PATHS: { images: '/tmp/imgs', videos: '/tmp/vids' },
  ensureDir: vi.fn(),
}));

const { importXPost } = await import('./xPost.js');

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const mp4Bytes = () => Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(20)]);

const POST_URL = 'https://x.com/someuser/status/42';
const CANONICAL = 'https://x.com/i/status/42';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('importXPost', () => {
  it('rejects a non-X URL before touching the store', async () => {
    await expect(importXPost('mb-1', { url: 'https://example.com/x' })).rejects.toMatchObject({ status: 400 });
    expect(store.getBoard).not.toHaveBeenCalled();
  });

  it('404s when the board is missing', async () => {
    store.getBoard.mockResolvedValue(null);
    await expect(importXPost('mb-x', { url: POST_URL })).rejects.toMatchObject({ status: 404 });
  });

  it('502s when the post cannot be fetched', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [] });
    net.fetchPublicText.mockResolvedValue(null);
    await expect(importXPost('mb-1', { url: POST_URL })).rejects.toMatchObject({ status: 502, code: 'X_POST_FETCH_FAILED' });
  });

  it('502s on unparseable JSON', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [] });
    net.fetchPublicText.mockResolvedValue('not json');
    await expect(importXPost('mb-1', { url: POST_URL })).rejects.toMatchObject({ status: 502, code: 'X_POST_FETCH_FAILED' });
  });

  it('400s when the post has no photos or video', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [] });
    net.fetchPublicText.mockResolvedValue(JSON.stringify({}));
    await expect(importXPost('mb-1', { url: POST_URL })).rejects.toMatchObject({ status: 400, code: 'NO_MEDIA_FOUND' });
  });

  it('downloads photos and appends them, deduping by source', async () => {
    store.getBoard.mockResolvedValue({
      id: 'mb-1',
      // photo #0 already on the board → should be deduped out
      items: [{ id: 'mbi-old', type: 'image', source: `${CANONICAL}#0` }],
    });
    net.fetchPublicText.mockResolvedValue(JSON.stringify({
      photos: [{ url: 'https://pbs.twimg.com/a.jpg' }, { url: 'https://pbs.twimg.com/b.jpg' }],
    }));
    net.fetchPublicBinary.mockResolvedValue({ buffer: JPEG_BYTES, contentType: 'image/jpeg' });
    store.appendImportedItems.mockImplementation(async (_id, imported) => ({ board: { id: 'mb-1' }, added: imported.length }));

    const result = await importXPost('mb-1', { url: POST_URL });

    // only photo #1 was downloaded (photo #0 deduped before fetching)
    expect(net.fetchPublicBinary).toHaveBeenCalledTimes(1);
    expect(net.fetchPublicBinary.mock.calls[0][0]).toBe('https://pbs.twimg.com/b.jpg');
    expect(writeFile).toHaveBeenCalledTimes(1);

    const [, imported] = store.appendImportedItems.mock.calls[0];
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ type: 'image', source: `${CANONICAL}#1` });
    expect(imported[0].imageUrl).toMatch(/^\/data\/images\/x-[0-9a-f]{16}\.jpg$/);
    expect(result).toMatchObject({ added: 1 });
    expect(emitRecordUpdated).toHaveBeenCalledWith('moodBoard', 'mb-1');
  });

  it('downloads a video + poster and appends a video item', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [] });
    net.fetchPublicText.mockResolvedValue(JSON.stringify({
      video: {
        poster: 'https://pbs.twimg.com/poster.jpg',
        variants: [{ type: 'video/mp4', src: 'https://video.twimg.com/v.mp4', bitrate: 1000 }],
      },
    }));
    net.fetchPublicBinary.mockImplementation(async (url) => (
      url === 'https://video.twimg.com/v.mp4'
        ? { buffer: mp4Bytes(), contentType: 'video/mp4' }
        : { buffer: JPEG_BYTES, contentType: 'image/jpeg' }
    ));
    store.appendImportedItems.mockImplementation(async (_id, imported) => ({ board: { id: 'mb-1' }, added: imported.length }));

    await importXPost('mb-1', { url: POST_URL });

    const [, imported] = store.appendImportedItems.mock.calls[0];
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ type: 'video', source: `${CANONICAL}#video` });
    expect(imported[0].mediaKey).toMatch(/^video:x-[0-9a-f]{16}\.mp4$/);
    expect(imported[0].imageUrl).toMatch(/^\/data\/images\/x-[0-9a-f]{16}\.jpg$/);
  });

  it('502s when media exists but every download fails', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [] });
    net.fetchPublicText.mockResolvedValue(JSON.stringify({ photos: [{ url: 'https://pbs.twimg.com/a.jpg' }] }));
    net.fetchPublicBinary.mockResolvedValue({ buffer: Buffer.from('<html>'), contentType: 'text/html' });

    await expect(importXPost('mb-1', { url: POST_URL })).rejects.toMatchObject({ status: 502, code: 'X_POST_DOWNLOAD_FAILED' });
    expect(store.appendImportedItems).not.toHaveBeenCalled();
  });

  it('rejects a video download whose bytes are not an mp4 container', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [] });
    net.fetchPublicText.mockResolvedValue(JSON.stringify({
      video: { variants: [{ type: 'video/mp4', src: 'https://video.twimg.com/v.mp4', bitrate: 1000 }] },
    }));
    net.fetchPublicBinary.mockResolvedValue({ buffer: Buffer.from('<html>not a video</html>'), contentType: 'video/mp4' });

    await expect(importXPost('mb-1', { url: POST_URL })).rejects.toMatchObject({ status: 502, code: 'X_POST_DOWNLOAD_FAILED' });
  });

  it('deletes an orphaned poster when the video body fails but the poster downloaded (they run in parallel)', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [] });
    net.fetchPublicText.mockResolvedValue(JSON.stringify({
      video: {
        poster: 'https://pbs.twimg.com/poster.jpg',
        variants: [{ type: 'video/mp4', src: 'https://video.twimg.com/v.mp4', bitrate: 1000 }],
      },
    }));
    net.fetchPublicBinary.mockImplementation(async (url) => (
      url === 'https://video.twimg.com/v.mp4'
        ? { buffer: Buffer.from('<html>not a video</html>'), contentType: 'video/mp4' } // video body fails
        : { buffer: JPEG_BYTES, contentType: 'image/jpeg' } // poster succeeds
    ));

    await expect(importXPost('mb-1', { url: POST_URL })).rejects.toMatchObject({ status: 502, code: 'X_POST_DOWNLOAD_FAILED' });
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink.mock.calls[0][0]).toMatch(/^\/tmp\/imgs\/x-[0-9a-f]{16}\.jpg$/);
    expect(store.appendImportedItems).not.toHaveBeenCalled();
  });
});
