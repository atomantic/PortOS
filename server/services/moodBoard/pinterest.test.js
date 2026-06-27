/**
 * Pinterest importer orchestration tests. The network (safeUrlFetch), the board
 * store (db.js), disk (fs/promises + fileUtils), and the federation emit are
 * mocked; the real pure parser (pinterestFeed) runs so the feed→pin→item
 * pipeline is exercised end to end without a DB or network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = {
  getBoard: vi.fn(),
  setPinterestLink: vi.fn(),
  healPinterestFeed: vi.fn(),
  clearPinterestLink: vi.fn(),
  appendPinterestItems: vi.fn(),
};
vi.mock('./db.js', () => store);

const net = { fetchPublicText: vi.fn(), fetchPublicBinary: vi.fn() };
vi.mock('../../lib/safeUrlFetch.js', () => net);

const emitRecordUpdated = vi.fn();
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated: (...a) => emitRecordUpdated(...a) }));

const writeFile = vi.fn();
vi.mock('fs/promises', () => ({ writeFile: (...a) => writeFile(...a) }));
// Keep the real detectImageFormat (byte-sniffing) — only override PATHS/ensureDir.
vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PATHS: { images: '/tmp/imgs' },
  ensureDir: vi.fn(),
}));

const { linkPinterestBoard, unlinkPinterestBoard, syncPinterestBoard } = await import('./pinterest.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const feedXml = (...pins) => `<rss><channel>${pins.map((p) => `
  <item>
    <title>${p.title}</title>
    <link>${p.link}</link>
    <description><![CDATA[<img src="${p.img}">]]></description>
  </item>`).join('')}</channel></rss>`;

const PIN1 = { title: 'one', link: 'https://www.pinterest.com/pin/1/', img: 'https://i.pinimg.com/236x/a.jpg' };
const PIN2 = { title: 'two', link: 'https://www.pinterest.com/pin/2/', img: 'https://i.pinimg.com/236x/b.jpg' };

describe('linkPinterestBoard', () => {
  it('normalizes the URL and stores the link', async () => {
    store.setPinterestLink.mockResolvedValue({ id: 'mb-1', pinterest: { feedUrl: 'x' } });
    await linkPinterestBoard('mb-1', { url: 'https://www.pinterest.com/jane/board/' });
    expect(store.setPinterestLink).toHaveBeenCalledWith('mb-1', {
      feedUrl: 'https://www.pinterest.com/jane/board.rss',
      boardUrl: 'https://www.pinterest.com/jane/board/',
    });
    expect(emitRecordUpdated).toHaveBeenCalledWith('moodBoard', 'mb-1');
  });

  it('rejects a non-Pinterest URL before touching the store', async () => {
    await expect(linkPinterestBoard('mb-1', { url: 'https://example.com/x' })).rejects.toMatchObject({ status: 400 });
    expect(store.setPinterestLink).not.toHaveBeenCalled();
  });
});

describe('unlinkPinterestBoard', () => {
  it('clears the link and emits', async () => {
    store.clearPinterestLink.mockResolvedValue({ id: 'mb-1' });
    await unlinkPinterestBoard('mb-1');
    expect(store.clearPinterestLink).toHaveBeenCalledWith('mb-1');
    expect(emitRecordUpdated).toHaveBeenCalledWith('moodBoard', 'mb-1');
  });
});

describe('syncPinterestBoard', () => {
  it('404s when the board is missing', async () => {
    store.getBoard.mockResolvedValue(null);
    await expect(syncPinterestBoard('mb-x')).rejects.toMatchObject({ status: 404 });
  });

  it('400s when the board is not linked', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [] });
    await expect(syncPinterestBoard('mb-1')).rejects.toMatchObject({ status: 400, code: 'NOT_LINKED' });
  });

  it('502s when the feed cannot be fetched', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [], pinterest: { feedUrl: 'https://www.pinterest.com/j/b.rss' } });
    net.fetchPublicText.mockResolvedValue(null);
    await expect(syncPinterestBoard('mb-1')).rejects.toMatchObject({ status: 502 });
  });

  it('downloads only NEW pins, persists images, and appends them', async () => {
    store.getBoard.mockResolvedValue({
      id: 'mb-1',
      // pin 1 already on the board → should be deduped out
      items: [{ id: 'mbi-old', type: 'image', source: 'https://www.pinterest.com/pin/1/' }],
      pinterest: { feedUrl: 'https://www.pinterest.com/j/b.rss' },
    });
    net.fetchPublicText.mockResolvedValue(feedXml(PIN1, PIN2));
    // Valid JPEG magic bytes — downloadPinImage sniffs the format from the bytes.
    net.fetchPublicBinary.mockResolvedValue({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), contentType: 'image/jpeg' });
    store.appendPinterestItems.mockImplementation(async (_id, imported) => ({ board: { id: 'mb-1' }, added: imported.length }));

    const result = await syncPinterestBoard('mb-1');

    // only pin 2 was downloaded (pin 1 deduped before fetching)
    expect(net.fetchPublicBinary).toHaveBeenCalledTimes(1);
    expect(net.fetchPublicBinary.mock.calls[0][0]).toBe('https://i.pinimg.com/736x/b.jpg');
    expect(writeFile).toHaveBeenCalledTimes(1);

    const [, imported] = store.appendPinterestItems.mock.calls[0];
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ source: 'https://www.pinterest.com/pin/2/', caption: 'two' });
    expect(imported[0].imageUrl).toMatch(/^\/data\/images\/pinterest-[0-9a-f]{16}\.jpg$/);
    expect(result).toMatchObject({ added: 1, feedCount: 2 });
    expect(emitRecordUpdated).toHaveBeenCalledWith('moodBoard', 'mb-1');
  });

  it('reports aborted (and does not emit) when the link changed mid-sync', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [], pinterest: { feedUrl: 'https://www.pinterest.com/j/b.rss' } });
    net.fetchPublicText.mockResolvedValue(feedXml(PIN1));
    net.fetchPublicBinary.mockResolvedValue({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), contentType: 'image/jpeg' });
    // store reports the locked append aborted (board was unlinked/repointed)
    store.appendPinterestItems.mockResolvedValue({ board: { id: 'mb-1' }, added: 0, aborted: true });

    const result = await syncPinterestBoard('mb-1');
    expect(result).toMatchObject({ added: 0, aborted: true });
    expect(emitRecordUpdated).not.toHaveBeenCalled();
  });

  it('forwards the fetched feed as expectedFeedUrl to the locked append', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [], pinterest: { feedUrl: 'https://www.pinterest.com/j/b.rss' } });
    net.fetchPublicText.mockResolvedValue(feedXml(PIN1));
    net.fetchPublicBinary.mockResolvedValue({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), contentType: 'image/jpeg' });
    store.appendPinterestItems.mockImplementation(async (_id, imported) => ({ board: { id: 'mb-1' }, added: imported.length }));

    await syncPinterestBoard('mb-1');
    expect(store.appendPinterestItems.mock.calls[0][2]).toMatchObject({ expectedFeedUrl: 'https://www.pinterest.com/j/b.rss' });
  });

  it('self-heals a stored section feed to the parent board feed, then syncs against it', async () => {
    // A section link saved before section detection: feed points at the section
    // .rss (HTML, 0 pins); boardUrl retains the section path.
    store.getBoard.mockResolvedValue({
      id: 'mb-1',
      items: [],
      pinterest: { feedUrl: 'https://www.pinterest.com/j/b/sec.rss', boardUrl: 'https://www.pinterest.com/j/b/sec/' },
    });
    // The guarded heal returns the corrected, board-level feed.
    store.healPinterestFeed.mockResolvedValue({
      board: { id: 'mb-1', items: [], pinterest: { feedUrl: 'https://www.pinterest.com/j/b.rss', boardUrl: 'https://www.pinterest.com/j/b/sec/' } },
      changed: true,
    });
    net.fetchPublicText.mockResolvedValue(feedXml(PIN1));
    net.fetchPublicBinary.mockResolvedValue({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), contentType: 'image/jpeg' });
    store.appendPinterestItems.mockImplementation(async (_id, imported) => ({ board: { id: 'mb-1' }, added: imported.length }));

    await syncPinterestBoard('mb-1');
    expect(store.healPinterestFeed).toHaveBeenCalledWith('mb-1', {
      fromFeedUrl: 'https://www.pinterest.com/j/b/sec.rss',
      feedUrl: 'https://www.pinterest.com/j/b.rss',
      boardUrl: 'https://www.pinterest.com/j/b/sec/',
    });
    // Fetch + the append guard both use the healed (board-level) feed.
    expect(net.fetchPublicText).toHaveBeenCalledWith('https://www.pinterest.com/j/b.rss', expect.anything());
    expect(store.appendPinterestItems.mock.calls[0][2]).toMatchObject({ expectedFeedUrl: 'https://www.pinterest.com/j/b.rss' });
  });

  it('aborts (no fetch) when a concurrent unlink wins the heal race', async () => {
    store.getBoard.mockResolvedValue({
      id: 'mb-1',
      items: [],
      pinterest: { feedUrl: 'https://www.pinterest.com/j/b/sec.rss', boardUrl: 'https://www.pinterest.com/j/b/sec/' },
    });
    // User unlinked concurrently: the guarded heal didn't write and the board is now unlinked.
    store.healPinterestFeed.mockResolvedValue({ board: { id: 'mb-1', items: [] }, changed: false });

    const result = await syncPinterestBoard('mb-1');
    expect(result).toMatchObject({ aborted: true, added: 0 });
    expect(net.fetchPublicText).not.toHaveBeenCalled();
    expect(store.appendPinterestItems).not.toHaveBeenCalled();
  });

  it('aborts (no fetch) when a concurrent repoint wins the heal race', async () => {
    store.getBoard.mockResolvedValue({
      id: 'mb-1',
      items: [],
      pinterest: { feedUrl: 'https://www.pinterest.com/j/b/sec.rss', boardUrl: 'https://www.pinterest.com/j/b/sec/' },
    });
    // User repointed to a DIFFERENT board mid-heal: guard didn't write; the
    // persisted feed is neither the section nor the healed board feed.
    store.healPinterestFeed.mockResolvedValue({
      board: { id: 'mb-1', items: [], pinterest: { feedUrl: 'https://www.pinterest.com/other/board.rss', boardUrl: 'https://www.pinterest.com/other/board/' } },
      changed: false,
    });

    const result = await syncPinterestBoard('mb-1');
    expect(result).toMatchObject({ aborted: true, added: 0 });
    // Must NOT silently sync the user's newly-repointed feed.
    expect(net.fetchPublicText).not.toHaveBeenCalled();
    expect(store.appendPinterestItems).not.toHaveBeenCalled();
  });

  it('skips a pin whose download returns a non-image body', async () => {
    store.getBoard.mockResolvedValue({ id: 'mb-1', items: [], pinterest: { feedUrl: 'https://www.pinterest.com/j/b.rss' } });
    net.fetchPublicText.mockResolvedValue(feedXml(PIN1));
    net.fetchPublicBinary.mockResolvedValue({ buffer: Buffer.from('<html>'), contentType: 'text/html' });
    store.appendPinterestItems.mockImplementation(async (_id, imported) => ({ board: { id: 'mb-1' }, added: imported.length }));

    const result = await syncPinterestBoard('mb-1');
    expect(writeFile).not.toHaveBeenCalled();
    expect(store.appendPinterestItems.mock.calls[0][1]).toEqual([]); // nothing imported
    expect(result.added).toBe(0);
  });
});
