import { beforeEach, describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  getAccessToken: vi.fn(),
  getAuthStatus: vi.fn(),
  getSettings: vi.fn(),
  tryReadFile: vi.fn(),
  atomicWrite: vi.fn(),
  ensureDir: vi.fn(),
}));

vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: (...args) => mocks.fetchWithTimeout(...args) }));
vi.mock('./spotifyAuth.js', () => ({
  getAccessToken: (...args) => mocks.getAccessToken(...args),
  getAuthStatus: (...args) => mocks.getAuthStatus(...args),
}));
vi.mock('./settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('../lib/fileUtils.js', () => ({
  dataPath: (...parts) => `/tmp/${parts.join('/')}`,
  ensureDir: (...args) => mocks.ensureDir(...args),
  atomicWrite: (...args) => mocks.atomicWrite(...args),
  tryReadFile: (...args) => mocks.tryReadFile(...args),
  safeJSONParse: (raw, fallback) => {
    try { return JSON.parse(raw); } catch { return fallback; }
  },
}));

import {
  spotifyListenCandidate,
  spotifyListenCandidates,
  maxPlayedAtMs,
  runSync,
} from './spotifySync.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAccessToken.mockResolvedValue('access-token');
  mocks.getSettings.mockResolvedValue({});
  mocks.tryReadFile.mockResolvedValue(null);
});

// A minimal recently-played item, shaped like the Spotify Web API response.
function makeItem(overrides = {}) {
  return {
    played_at: '2024-03-10T15:30:00.123Z',
    track: {
      id: 'track123',
      name: 'Test Song',
      duration_ms: 210000,
      artists: [
        { id: 'artist1', name: 'Alpha' },
        { id: 'artist2', name: 'Beta' },
      ],
      album: { id: 'album1', name: 'Test Album' },
      external_urls: { spotify: 'https://open.spotify.com/track/track123' },
      external_ids: { isrc: 'USABC1234567' },
      explicit: false,
      popularity: 72,
    },
    context: { type: 'playlist', uri: 'spotify:playlist:xyz' },
    ...overrides,
  };
}

describe('spotifySync pure helpers', () => {
  describe('spotifyListenCandidate', () => {
    it('maps a recently-played item to a media.listen candidate', () => {
      const c = spotifyListenCandidate(makeItem());
      expect(c.source).toBe('spotify');
      expect(c.kind).toBe('media.listen');
      expect(c.title).toBe('Test Song');
      expect(c.summary).toBe('Alpha, Beta');
      expect(c.durationS).toBe(210);
      expect(c.url).toBe('https://open.spotify.com/track/track123');
      expect(c.happenedAt).toBe(new Date('2024-03-10T15:30:00.123Z').toISOString());
    });

    it('uses spotify:<played_at ISO>:<trackId> as the dedupe key', () => {
      const c = spotifyListenCandidate(makeItem());
      expect(c.dedupeKey).toBe('spotify:2024-03-10T15:30:00.123Z:track123');
    });

    it('carries track/artist/album metadata verbatim for later enrichment', () => {
      const c = spotifyListenCandidate(makeItem());
      expect(c.metadata).toMatchObject({
        trackId: 'track123',
        trackName: 'Test Song',
        album: 'Test Album',
        albumId: 'album1',
        isrc: 'USABC1234567',
        popularity: 72,
        explicit: false,
        context: 'playlist',
        contextUri: 'spotify:playlist:xyz',
      });
      expect(c.metadata.artists).toEqual([
        { id: 'artist1', name: 'Alpha' },
        { id: 'artist2', name: 'Beta' },
      ]);
    });

    it('returns null when the track id is missing', () => {
      expect(spotifyListenCandidate(makeItem({ track: { name: 'x' } }))).toBeNull();
    });

    it('returns null when played_at is missing or invalid', () => {
      expect(spotifyListenCandidate(makeItem({ played_at: null }))).toBeNull();
      expect(spotifyListenCandidate(makeItem({ played_at: 'not-a-date' }))).toBeNull();
      expect(spotifyListenCandidate(null)).toBeNull();
    });

    it('tolerates a missing duration / album / artists', () => {
      const c = spotifyListenCandidate({
        played_at: '2024-03-10T15:30:00.000Z',
        track: { id: 't', name: 'Bare' },
      });
      expect(c.durationS).toBeNull();
      expect(c.summary).toBe('');
      expect(c.metadata.artists).toEqual([]);
      expect(c.metadata.album).toBeNull();
    });

    it('distinguishes the same track replayed at a different time', () => {
      const a = spotifyListenCandidate(makeItem({ played_at: '2024-03-10T10:00:00.000Z' }));
      const b = spotifyListenCandidate(makeItem({ played_at: '2024-03-10T12:00:00.000Z' }));
      expect(a.dedupeKey).not.toBe(b.dedupeKey);
    });
  });

  describe('spotifyListenCandidates', () => {
    it('maps a batch and drops invalid items', () => {
      const list = spotifyListenCandidates([
        makeItem(),
        makeItem({ track: { name: 'no-id' } }),
        makeItem({ played_at: null }),
      ]);
      expect(list).toHaveLength(1);
    });

    it('returns an empty array for non-array input', () => {
      expect(spotifyListenCandidates(null)).toEqual([]);
      expect(spotifyListenCandidates(undefined)).toEqual([]);
    });
  });

  describe('maxPlayedAtMs (cursor advance)', () => {
    it('returns the newest played_at across the batch', () => {
      const items = [
        { played_at: '2024-03-10T10:00:00.000Z' },
        { played_at: '2024-03-10T12:00:00.000Z' },
        { played_at: '2024-03-10T11:00:00.000Z' },
      ];
      expect(maxPlayedAtMs(items, 0)).toBe(new Date('2024-03-10T12:00:00.000Z').getTime());
    });

    it('never regresses below the current cursor', () => {
      const cursor = new Date('2024-03-11T00:00:00.000Z').getTime();
      const items = [{ played_at: '2024-03-10T12:00:00.000Z' }];
      expect(maxPlayedAtMs(items, cursor)).toBe(cursor);
    });

    it('ignores items with an unparseable played_at', () => {
      const items = [{ played_at: 'garbage' }, { played_at: '2024-03-10T12:00:00.000Z' }];
      expect(maxPlayedAtMs(items, 0)).toBe(new Date('2024-03-10T12:00:00.000Z').getTime());
    });

    it('returns the current cursor for an empty batch', () => {
      expect(maxPlayedAtMs([], 42)).toBe(42);
      expect(maxPlayedAtMs(null, 42)).toBe(42);
    });
  });
});

describe('runSync network boundary', () => {
  it('uses the bounded fetch helper and returns an error result when it times out', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetchWithTimeout.mockRejectedValue(new Error('request timed out'));

    const result = await runSync();

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      expect.any(URL),
      { headers: { Authorization: 'Bearer access-token' } },
      15_000,
    );
    expect(result).toEqual({ ok: false, error: 'Spotify API request failed: request timed out' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('request timed out'));
    log.mockRestore();
  });
});
