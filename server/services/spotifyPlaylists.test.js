import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(), fetchWithTimeout: vi.fn(), readJSONFile: vi.fn(), ensureDir: vi.fn(), atomicWrite: vi.fn(), sleep: vi.fn(),
}));

vi.mock('./spotifyAuth.js', () => ({ getAccessToken: (...args) => mocks.getAccessToken(...args) }));
vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: (...args) => mocks.fetchWithTimeout(...args) }));
vi.mock('../lib/fileUtils.js', () => ({
  dataPath: (...parts) => `/tmp/${parts.join('/')}`, readJSONFile: (...args) => mocks.readJSONFile(...args),
  ensureDir: (...args) => mocks.ensureDir(...args), atomicWrite: (...args) => mocks.atomicWrite(...args), sleep: (...args) => mocks.sleep(...args),
}));

import { normalizeSpotifyPlaylist, normalizeSpotifyTrack, playlistSnapshotSummary, syncSpotifyPlaylists } from './spotifyPlaylists.js';

const playlist = {
  id: 'playlist-1', name: 'Example playlist', description: 'A reference shelf', public: false, collaborative: false,
  tracks: { total: 1 }, external_urls: { spotify: 'https://open.spotify.com/playlist/playlist-1' },
  images: [{ url: 'https://i.scdn.co/image/example', height: 300, width: 300 }],
};
const trackItem = {
  added_at: '2026-08-29T09:00:00Z', item: {
    id: 'track-1', name: 'Example track', artists: [{ id: 'artist-1', name: 'Example artist' }],
    album: { id: 'album-1', name: 'Example album' }, duration_ms: 180000,
    external_urls: { spotify: 'https://open.spotify.com/track/track-1' },
  },
};

describe('Spotify playlist normalization', () => {
  it('keeps bounded playlist and track metadata with Spotify links', () => {
    expect(normalizeSpotifyTrack(trackItem)).toMatchObject({ id: 'track-1', name: 'Example track', album: 'Example album' });
    expect(normalizeSpotifyPlaylist(playlist, [normalizeSpotifyTrack(trackItem)])).toMatchObject({
      id: 'playlist-1', name: 'Example playlist', trackCount: 1, tracks: [{ id: 'track-1' }],
    });
  });
  it('summarizes a missing snapshot as unsynced', () => {
    expect(playlistSnapshotSummary(null)).toEqual({ playlistCount: 0, trackCount: 0, syncedAt: null, warningCount: 0 });
  });
});

describe('syncSpotifyPlaylists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccessToken.mockResolvedValue('access-token');
    mocks.readJSONFile.mockResolvedValue(null);
    mocks.fetchWithTimeout
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 1, items: [playlist] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 1, items: [trackItem] }) });
  });
  it('fetches playlists and current playlist items, then writes one local snapshot', async () => {
    const result = await syncSpotifyPlaylists();
    expect(result).toMatchObject({ ok: true, playlistCount: 1, trackCount: 1, scanned: 1, failed: 0 });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(mocks.fetchWithTimeout.mock.calls[0][0].toString()).toContain('/me/playlists?limit=50&offset=0');
    expect(mocks.fetchWithTimeout.mock.calls[1][0].toString()).toContain('/playlists/playlist-1/items?limit=50&offset=0');
    expect(mocks.atomicWrite).toHaveBeenCalledWith('/tmp/spotify/playlists.json', expect.objectContaining({ schemaVersion: 1 }));
  });

  it('stops pagination when Spotify returns an empty page', async () => {
    const pageItems = Array.from({ length: 50 }, (_, index) => ({
      ...trackItem,
      item: { ...trackItem.item, id: `track-${index}` },
    }));
    mocks.fetchWithTimeout
      .mockReset()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 1, items: [playlist] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 100, items: pageItems }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 100, items: [] }) });

    const result = await syncSpotifyPlaylists();

    expect(result).toMatchObject({ ok: true, playlistCount: 1, trackCount: 50 });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(3);
    expect(mocks.fetchWithTimeout.mock.calls[2][0].toString()).toContain('/playlists/playlist-1/items?limit=50&offset=50');
  });

  it('limits concurrent playlist item requests to bounded batches', async () => {
    const playlists = Array.from({ length: 6 }, (_, index) => ({ ...playlist, id: `playlist-${index}` }));
    let active = 0;
    let maximumActive = 0;
    mocks.fetchWithTimeout.mockReset().mockImplementation(async (url) => {
      if (url.includes('/me/playlists')) return { ok: true, json: async () => ({ total: playlists.length, items: playlists }) };
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return { ok: true, json: async () => ({ total: 0, items: [] }) };
    });

    await syncSpotifyPlaylists();

    expect(maximumActive).toBe(5);
  });

  it('skips unresolved playlist entries before fetching items', async () => {
    mocks.fetchWithTimeout
      .mockReset()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 2, items: [null, playlist] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 1, items: [trackItem] }) });

    const result = await syncSpotifyPlaylists();

    expect(result).toMatchObject({ ok: true, playlistCount: 1, trackCount: 1, scanned: 1 });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it('retries rate-limited playlist item requests before recording a failure', async () => {
    mocks.fetchWithTimeout
      .mockReset()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 1, items: [playlist] }) })
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '0' }, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 1, items: [trackItem] }) });

    const result = await syncSpotifyPlaylists();

    expect(result).toMatchObject({ ok: true, playlistCount: 1, trackCount: 1 });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(3);
    expect(mocks.sleep).toHaveBeenCalledWith(0);
  });

  it('keeps the prior library when Spotify returns an empty playlist list', async () => {
    mocks.readJSONFile.mockResolvedValue({ playlists: [normalizeSpotifyPlaylist(playlist)] });
    mocks.fetchWithTimeout.mockReset().mockResolvedValueOnce({ ok: true, json: async () => ({ total: 1, items: [] }) });

    const result = await syncSpotifyPlaylists();

    expect(result).toMatchObject({ ok: false, status: 'list-empty', playlistCount: 1, scanned: 0 });
    expect(mocks.atomicWrite).not.toHaveBeenCalled();
  });

  it('stops instead of sleeping past the rate-limit wait bound', async () => {
    mocks.fetchWithTimeout
      .mockReset()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 1, items: [playlist] }) })
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '11' }, json: async () => ({}) });

    const result = await syncSpotifyPlaylists();

    expect(result).toMatchObject({ ok: false, playlistCount: 0, failed: 1 });
    expect(mocks.sleep).not.toHaveBeenCalled();
  });

  it('does not overwrite an unreadable prior snapshot', async () => {
    mocks.readJSONFile.mockRejectedValueOnce(new Error('EIO'));

    const result = await syncSpotifyPlaylists();

    expect(result).toMatchObject({ ok: false, status: 'snapshot-unreadable' });
    expect(mocks.atomicWrite).not.toHaveBeenCalled();
  });
});
