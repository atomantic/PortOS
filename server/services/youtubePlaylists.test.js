import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOrOpenPage: vi.fn(), listCdpPages: vi.fn(), isAuthPage: vi.fn(), evaluateOnPage: vi.fn(), readJSONFile: vi.fn(), ensureDir: vi.fn(), atomicWrite: vi.fn(),
}));
vi.mock('./browserService.js', () => ({
  findOrOpenPage: (...args) => mocks.findOrOpenPage(...args), listCdpPages: (...args) => mocks.listCdpPages(...args), isAuthPage: (...args) => mocks.isAuthPage(...args),
  evaluateOnPage: (...args) => mocks.evaluateOnPage(...args),
}));
vi.mock('../lib/fileUtils.js', () => ({
  dataPath: (...parts) => `/tmp/${parts.join('/')}`, readJSONFile: (...args) => mocks.readJSONFile(...args),
  ensureDir: (...args) => mocks.ensureDir(...args), atomicWrite: (...args) => mocks.atomicWrite(...args), sleep: vi.fn(async () => {}),
}));

import { normalizeYoutubePlaylist, normalizeYoutubeVideo, youtubePlaylistSnapshotSummary, syncYoutubePlaylists } from './youtubePlaylists.js';

describe('YouTube playlist normalization', () => {
  it('produces downloader-ready video URLs', () => {
    expect(normalizeYoutubeVideo({ id: 'video-1', title: 'Example video', channel: 'Example channel' })).toMatchObject({
      id: 'video-1', url: 'https://www.youtube.com/watch?v=video-1',
    });
    expect(normalizeYoutubePlaylist({ id: 'PL-example', name: 'Example playlist' }, [{ id: 'video-1' }])).toMatchObject({
      id: 'PL-example', videoCount: 1, videos: [{ id: 'video-1' }],
    });
  });
  it('summarizes a missing snapshot as unsynced', () => {
    expect(youtubePlaylistSnapshotSummary(null)).toEqual({ playlistCount: 0, videoCount: 0, syncedAt: null, warningCount: 0 });
  });
});

describe('syncYoutubePlaylists', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOrOpenPage.mockResolvedValue({ id: 'page-1', url: 'https://www.youtube.com/feed/playlists' });
    mocks.listCdpPages.mockResolvedValue([]);
    mocks.isAuthPage.mockReturnValue(false);
    mocks.readJSONFile.mockResolvedValue(null);
    mocks.evaluateOnPage
      .mockResolvedValueOnce({ signedOut: false, playlists: [{ id: 'PL-example', name: 'Example playlist', videoCount: 1 }] })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ signedOut: false, videos: [{ id: 'video-1', title: 'Example video', channel: 'Example channel' }] });
  });
  it('scrapes playlist pages and writes a local video snapshot', async () => {
    const result = await syncYoutubePlaylists();
    expect(result).toMatchObject({ ok: true, playlistCount: 1, videoCount: 1, scanned: 1, failed: 0 });
    expect(mocks.findOrOpenPage).toHaveBeenCalledWith('https://www.youtube.com/feed/playlists');
    expect(mocks.evaluateOnPage.mock.calls[0][1]).toContain('/accounts\\.google\\.com|\\/ServiceLogin/i');
    expect(mocks.evaluateOnPage.mock.calls[0][1]).toContain('ytd-rich-item-renderer');
    expect(mocks.evaluateOnPage.mock.calls[0][1]).toContain('yt-lockup-view-model');
    expect(mocks.evaluateOnPage.mock.calls[2][1]).toContain('ytd-rich-grid-media');
    expect(mocks.atomicWrite).toHaveBeenCalledWith('/tmp/youtube/playlists.json', expect.objectContaining({ schemaVersion: 1 }));
  });

  it('navigates an existing YouTube tab to the playlists feed', async () => {
    mocks.findOrOpenPage.mockResolvedValue({ id: 'page-1', url: 'https://www.youtube.com/watch?v=video-1' });
    mocks.listCdpPages.mockResolvedValue([{ id: 'page-1', url: 'https://www.youtube.com/feed/playlists' }]);
    mocks.readJSONFile.mockResolvedValue(null);
    mocks.evaluateOnPage
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ signedOut: false, playlists: [{ id: 'PL-example', name: 'Example playlist' }] })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ signedOut: false, videos: [] });

    await syncYoutubePlaylists();

    expect(mocks.evaluateOnPage.mock.calls[0][1]).toContain('location.assign("https://www.youtube.com/feed/playlists")');
    expect(mocks.listCdpPages).toHaveBeenCalledTimes(1);
  });

  it('keeps the prior snapshot when playlist extraction is unexpectedly empty', async () => {
    mocks.readJSONFile.mockResolvedValue({
      syncedAt: '2026-08-28T00:00:00.000Z',
      playlists: [{ id: 'PL-example', name: 'Example playlist', videos: [{ id: 'video-1' }] }],
    });
    mocks.evaluateOnPage.mockReset().mockResolvedValueOnce({ signedOut: false, playlists: [] });

    const result = await syncYoutubePlaylists();

    expect(result).toMatchObject({ ok: false, status: 'extraction-empty', playlistCount: 1, videoCount: 1 });
    expect(mocks.atomicWrite).not.toHaveBeenCalled();
  });

  it('retains a stale playlist when navigation closes the CDP context', async () => {
    const stale = { id: 'PL-example', name: 'Example playlist', videoCount: 1, videos: [{ id: 'video-1' }] };
    mocks.readJSONFile.mockResolvedValue({ playlists: [stale] });
    mocks.evaluateOnPage
      .mockReset()
      .mockResolvedValueOnce({ signedOut: false, playlists: [{ id: stale.id, name: stale.name, videoCount: 1 }] })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await syncYoutubePlaylists();

    expect(result).toMatchObject({ ok: false, playlistCount: 1, videoCount: 1, failed: 1 });
    expect(result.warnings).toEqual(['Example playlist: could not read videos']);
    expect(mocks.atomicWrite).toHaveBeenCalledWith('/tmp/youtube/playlists.json', expect.objectContaining({ playlists: [stale] }));
  });

  it('retains a stale playlist when a known non-empty page scrapes no videos', async () => {
    const stale = { id: 'PL-example', name: 'Example playlist', videoCount: 1, videos: [{ id: 'video-1' }] };
    mocks.readJSONFile.mockResolvedValue({ playlists: [stale] });
    mocks.evaluateOnPage
      .mockReset()
      .mockResolvedValueOnce({ signedOut: false, playlists: [{ id: stale.id, name: stale.name, videoCount: 1 }] })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ signedOut: false, videos: [] });

    const result = await syncYoutubePlaylists();

    expect(result).toMatchObject({ ok: false, playlistCount: 1, videoCount: 1, failed: 1 });
    expect(result.warnings).toEqual(['Example playlist: no videos read']);
  });

  it('retains a complete prior snapshot when the page only hydrates a small fraction', async () => {
    const stale = {
      id: 'PL-example', name: 'Example playlist', videoCount: 90,
      videos: Array.from({ length: 90 }, (_, index) => ({ id: `video-${index}` })),
    };
    mocks.readJSONFile.mockResolvedValue({ playlists: [stale] });
    mocks.evaluateOnPage
      .mockReset()
      .mockResolvedValueOnce({ signedOut: false, playlists: [{ id: stale.id, name: stale.name, videoCount: 90 }] })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ signedOut: false, videos: [{ id: 'video-1', title: 'Example video' }] });

    const result = await syncYoutubePlaylists();

    expect(result).toMatchObject({ ok: false, playlistCount: 1, videoCount: 90, failed: 1 });
    expect(result.warnings).toEqual(['Example playlist: only read 1 of 90 video(s)']);
    expect(mocks.atomicWrite).toHaveBeenCalledWith('/tmp/youtube/playlists.json', expect.objectContaining({ playlists: [stale] }));
  });

  it('resumes a timed-out sync from the first unrefreshed playlist', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(120000);
    const playlists = [
      { id: 'PL-first', name: 'First playlist', videoCount: 1 },
      { id: 'PL-second', name: 'Second playlist', videoCount: 2 },
    ];
    mocks.evaluateOnPage
      .mockReset()
      .mockResolvedValueOnce({ signedOut: false, playlists })
      .mockResolvedValueOnce(null);

    const result = await syncYoutubePlaylists();

    expect(result).toMatchObject({ ok: false, scanned: 0, playlistCount: 2, videoCount: 0 });
    expect(result.warnings).toEqual(['Sync stopped after 2 minutes; remaining playlists were not refreshed']);
    expect(mocks.atomicWrite).toHaveBeenCalledWith('/tmp/youtube/playlists.json', expect.objectContaining({
      nextPlaylistId: 'PL-first',
      playlists: [
        expect.objectContaining({ id: 'PL-first', videos: [] }),
        expect.objectContaining({ id: 'PL-second', videos: [] }),
      ],
    }));
    now.mockRestore();
  });

  it('starts the next sync at the persisted playlist cursor', async () => {
    mocks.readJSONFile.mockResolvedValue({ nextPlaylistId: 'PL-second', playlists: [] });
    mocks.evaluateOnPage
      .mockReset()
      .mockResolvedValueOnce({ signedOut: false, playlists: [
        { id: 'PL-first', name: 'First playlist' },
        { id: 'PL-second', name: 'Second playlist' },
      ] })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ signedOut: false, videos: [] })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ signedOut: false, videos: [] });

    await syncYoutubePlaylists();

    expect(mocks.evaluateOnPage.mock.calls[1][1]).toContain('PL-second');
  });

  it('does not overwrite an unreadable prior snapshot', async () => {
    mocks.readJSONFile.mockRejectedValueOnce(new Error('EIO'));
    mocks.evaluateOnPage.mockReset().mockResolvedValueOnce({ signedOut: false, playlists: [{ id: 'PL-example', name: 'Example playlist' }] });

    const result = await syncYoutubePlaylists();

    expect(result).toMatchObject({ ok: false, status: 'snapshot-unreadable' });
    expect(mocks.atomicWrite).not.toHaveBeenCalled();
  });
});
