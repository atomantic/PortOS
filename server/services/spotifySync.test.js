import { beforeEach, describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  getAccessToken: vi.fn(),
  getAuthStatus: vi.fn(),
  getSettings: vi.fn(),
  recordEvents: vi.fn(),
  refreshTwinEvidenceAfterSync: vi.fn(),
  atomicWrite: vi.fn(),
  ensureDir: vi.fn(),
  readSyncCursorState: vi.fn(),
}));

vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: (...args) => mocks.fetchWithTimeout(...args) }));
vi.mock('../lib/syncCursorState.js', () => ({
  readSyncCursorState: (...args) => mocks.readSyncCursorState(...args),
  readSyncCursorStateForStatus: vi.fn(),
}));
vi.mock('./spotifyAuth.js', () => ({
  getAccessToken: (...args) => mocks.getAccessToken(...args),
  getAuthStatus: (...args) => mocks.getAuthStatus(...args),
}));
vi.mock('./settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('./humanActivity.js', () => ({ recordEvents: (...args) => mocks.recordEvents(...args) }));
vi.mock('./twinEnrichment.js', () => ({ refreshTwinEvidenceAfterSync: () => mocks.refreshTwinEvidenceAfterSync() }));
vi.mock('../lib/fileUtils.js', () => ({
  dataPath: (...parts) => `/tmp/${parts.join('/')}`,
  ensureDir: (...args) => mocks.ensureDir(...args),
  atomicWrite: (...args) => mocks.atomicWrite(...args),
}));

import {
  spotifyListenCandidate,
  spotifyListenCandidates,
  runSync,
} from './spotifySync.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAccessToken.mockResolvedValue('access-token');
  mocks.getSettings.mockResolvedValue({});
  mocks.recordEvents.mockImplementation(async (events) => ({ recorded: events.length, skipped: 0 }));
  mocks.readSyncCursorState.mockResolvedValue({ cursorAfter: 0, lastRunAt: null, lastResult: null });
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

    it('uses spotify:<played_at floored to the second>:<trackId> as the dedupe key', () => {
      const c = spotifyListenCandidate(makeItem());
      expect(c.dedupeKey).toBe('spotify:2024-03-10T15:30:00.000Z:track123');
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

    it('returns an empty array for absent input', () => {
      expect(spotifyListenCandidates(null)).toEqual([]);
      expect(spotifyListenCandidates(undefined)).toEqual([]);
    });
  });
});

const spotifyEndpoint = 'https://api.spotify.com/v1/me/player/recently-played';
const floor = Date.parse('2024-03-10T15:30:00.123Z');
const newest = floor + 51_000;
const olderPageUrl = `${spotifyEndpoint}?before=${floor + 2_000}&limit=50`;
const firstPageUrl = `${spotifyEndpoint}?limit=50&after=${floor}`;
const lastRunAt = '2024-03-10T15:30:00.123Z';

const itemAt = (time, overrides) => makeItem({ played_at: new Date(time).toISOString(), ...overrides });
const firstPageItems = Array.from({ length: 50 }, (_, index) => itemAt(newest - index * 1_000));
const page = (items, next = null) => Response.json({ items, next, cursors: { after: String(newest + 10_000) } });

function savedState() {
  return JSON.parse(mocks.atomicWrite.mock.calls.findLast(([path]) => path.endsWith('sync-state.json'))[1]);
}

describe('runSync recently-played pagination', () => {
  beforeEach(() => mocks.readSyncCursorState.mockResolvedValue({ cursorAfter: floor, lastRunAt }));

  it('drains a 51-play backlog above the original floor before saving the newest accepted play', async () => {
    const oldestEligible = itemAt(floor + 1_000);
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(page(firstPageItems, olderPageUrl))
      .mockResolvedValueOnce(page([oldestEligible, itemAt(floor), itemAt(floor - 1)]));

    await expect(runSync()).resolves.toMatchObject({
      ok: true, scanned: 53, recorded: 51, skipped: 0, cursorAfter: newest, hasMore: false,
    });

    expect(mocks.fetchWithTimeout.mock.calls.map(([url]) => url.href)).toEqual([firstPageUrl, olderPageUrl]);
    const [events] = mocks.recordEvents.mock.calls[0];
    expect(events.map(({ happenedAt }) => happenedAt)).toEqual(
      [...firstPageItems, oldestEligible].map(({ played_at }) => played_at),
    );
    expect(savedState()).toMatchObject({ cursorAfter: newest, lastResult: { ok: true, recorded: 51 } });
    expect(mocks.refreshTwinEvidenceAfterSync).toHaveBeenCalledTimes(1);
  });

  it('keeps the checkpoint on a failed continuation, then retries the same window without duplicate rows', async () => {
    const storedKeys = new Set([spotifyListenCandidate(firstPageItems[0]).dedupeKey]);
    mocks.recordEvents.mockImplementation(async (events) => {
      const previousSize = storedKeys.size;
      for (const { dedupeKey } of events) storedKeys.add(dedupeKey);
      const recorded = storedKeys.size - previousSize;
      return { recorded, skipped: events.length - recorded };
    });
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(page(firstPageItems, olderPageUrl))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(runSync()).resolves.toMatchObject({ ok: false, status: 503 });
    expect(savedState()).toMatchObject({ cursorAfter: floor, lastRunAt, lastResult: { ok: false, status: 503 } });
    expect(mocks.recordEvents).not.toHaveBeenCalled();

    mocks.readSyncCursorState.mockResolvedValue(savedState());
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(page(firstPageItems, olderPageUrl))
      .mockResolvedValueOnce(page([itemAt(floor + 1_000)]));

    await expect(runSync()).resolves.toMatchObject({ ok: true, recorded: 50, skipped: 1, cursorAfter: newest });
    expect(mocks.fetchWithTimeout.mock.calls.map(([url]) => url.href)).toEqual([
      firstPageUrl, olderPageUrl, firstPageUrl, olderPageUrl,
    ]);
    expect(storedKeys.size).toBe(51);
  });

  it('makes one request for a full terminal page and keeps the cursor independent of response cursors', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(page(firstPageItems));

    await expect(runSync()).resolves.toMatchObject({ ok: true, recorded: 50, cursorAfter: newest, hasMore: false });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('includes newer eligible plays from a later page when choosing the checkpoint', async () => {
    const later = newest + 1_000;
    const newerPageUrl = `${spotifyEndpoint}?after=${newest}&limit=50`;
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(page(firstPageItems, newerPageUrl))
      .mockResolvedValueOnce(page([itemAt(later), itemAt(later + 1_000, { track: null })]));

    await expect(runSync()).resolves.toMatchObject({ ok: true, recorded: 51, cursorAfter: later });

    expect(savedState()).toMatchObject({ cursorAfter: later });
  });

  it('does not advance the cursor when the activity write fails after pagination', async () => {
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(page(firstPageItems, olderPageUrl))
      .mockResolvedValueOnce(page([itemAt(floor + 1_000)]));
    mocks.recordEvents.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(runSync()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Persistence failed') });

    expect(savedState()).toMatchObject({ cursorAfter: floor, lastRunAt, lastResult: { ok: false } });
    expect(mocks.refreshTwinEvidenceAfterSync).not.toHaveBeenCalled();
  });

  it('stops a repeated page even if its query parameters are reordered', async () => {
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(page(firstPageItems, olderPageUrl))
      .mockResolvedValueOnce(page([itemAt(floor + 1_000)], `${spotifyEndpoint}?limit=50&before=${floor + 2_000}`));

    await expect(runSync()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('repeated') });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(mocks.recordEvents).not.toHaveBeenCalled();
    expect(savedState()).toMatchObject({ cursorAfter: floor, lastRunAt });
  });

  it.each([
    'https://example.com/v1/me/player/recently-played?before=1',
    'https://api.spotify.com/v1/me?before=1',
    'http://api.spotify.com/v1/me/player/recently-played?before=1',
    'https://api.spotify.com:444/v1/me/player/recently-played?before=1',
    '/v1/me/player/recently-played?before=1',
    {},
  ])('rejects an invalid continuation (%s) without issuing a credentialed request', async (next) => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(page(firstPageItems, next));

    await expect(runSync()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('invalid') });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mocks.recordEvents).not.toHaveBeenCalled();
    expect(savedState()).toMatchObject({ cursorAfter: floor, lastRunAt });
  });

  it('holds the checkpoint on a malformed continuation page', async () => {
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(page(firstPageItems, olderPageUrl))
      .mockResolvedValueOnce(Response.json({ next: null }));

    await expect(runSync()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('invalid') });

    expect(mocks.recordEvents).not.toHaveBeenCalled();
    expect(savedState()).toMatchObject({ cursorAfter: floor, lastRunAt });
  });

  it('does not advance past an empty page that still points to a continuation', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(page([], olderPageUrl));

    await expect(runSync()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('invalid') });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(savedState()).toMatchObject({ cursorAfter: floor, lastRunAt });
  });
});

describe('runSync failure persistence and error handling', () => {
  it('uses the bounded fetch helper and returns an error result when it times out, persisting failure state', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.readSyncCursorState.mockResolvedValue({
      cursorAfter: 12345,
      lastRunAt: '2026-01-01T00:00:00.000Z',
      lastResult: { ok: true },
    });
    mocks.fetchWithTimeout.mockRejectedValue(new Error('request timed out'));

    const result = await runSync();

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      expect.any(URL),
      { headers: { Authorization: 'Bearer access-token' }, redirect: 'error' },
      15_000,
    );
    expect(result).toMatchObject({
      ok: false,
      needsAuth: false,
      error: 'Spotify API request failed: request timed out',
    });
    expect(typeof result.failedAt).toBe('string');
    expect(mocks.atomicWrite).toHaveBeenCalledWith(
      expect.stringContaining('sync-state.json'),
      expect.stringContaining('"cursorAfter": 12345'),
      { mode: 0o600, dirMode: 0o700 },
    );
    const saved = JSON.parse(mocks.atomicWrite.mock.calls.find((call) => call[0].endsWith('sync-state.json'))[1]);
    expect(saved.cursorAfter).toBe(12345);
    expect(saved.lastRunAt).toBe('2026-01-01T00:00:00.000Z');
    expect(saved.lastResult).toMatchObject({
      ok: false,
      needsAuth: false,
      error: 'Spotify API request failed: request timed out',
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('request timed out'));
    log.mockRestore();
  });

  it('handles auth rejection with invalid_grant by persisting failure with needsAuth: true', async () => {
    mocks.readSyncCursorState.mockResolvedValue({
      cursorAfter: 555,
      lastRunAt: '2026-02-01T00:00:00.000Z',
    });
    const authError = new Error('Spotify rejected the saved authorization — reconnect Spotify.');
    authError.code = 'INVALID_GRANT';
    authError.context = { isInvalidGrant: true };
    mocks.getAccessToken.mockRejectedValue(authError);

    const result = await runSync();

    expect(result).toMatchObject({
      ok: false,
      needsAuth: true,
      error: 'Spotify rejected the saved authorization — reconnect Spotify.',
    });
    expect(typeof result.failedAt).toBe('string');
    const saved = JSON.parse(mocks.atomicWrite.mock.calls.find((call) => call[0].endsWith('sync-state.json'))[1]);
    expect(saved.cursorAfter).toBe(555);
    expect(saved.lastRunAt).toBe('2026-02-01T00:00:00.000Z');
    expect(saved.lastResult.needsAuth).toBe(true);
  });

  it('handles auth timeout with needsAuth: false and underlying message', async () => {
    mocks.readSyncCursorState.mockResolvedValue({
      cursorAfter: 777,
      lastRunAt: null,
    });
    mocks.getAccessToken.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await runSync();

    expect(result).toMatchObject({
      ok: false,
      needsAuth: false,
      error: 'Spotify auth failed: ETIMEDOUT',
    });
    const saved = JSON.parse(mocks.atomicWrite.mock.calls.find((call) => call[0].endsWith('sync-state.json'))[1]);
    expect(saved.cursorAfter).toBe(777);
    expect(saved.lastResult.needsAuth).toBe(false);
  });

  it('persists non-2xx API failure to sync-state', async () => {
    mocks.readSyncCursorState.mockResolvedValue({
      cursorAfter: 888,
      lastRunAt: null,
    });
    mocks.fetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const result = await runSync();

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      error: 'Spotify API returned 500',
    });
    const saved = JSON.parse(mocks.atomicWrite.mock.calls.find((call) => call[0].endsWith('sync-state.json'))[1]);
    expect(saved.cursorAfter).toBe(888);
    expect(saved.lastResult.status).toBe(500);
  });
});
