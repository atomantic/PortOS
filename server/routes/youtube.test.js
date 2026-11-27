import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(async () => ({ state: {} })), checkSetup: vi.fn(async () => ({ ok: true })),
  runSync: vi.fn(async () => ({ ok: true, recorded: 1 })), getStoredYoutubePlaylists: vi.fn(async () => ({ playlists: [] })),
  youtubePlaylistSnapshotSummary: vi.fn(() => ({ playlistCount: 0, videoCount: 0 })),
  syncYoutubePlaylists: vi.fn(async () => ({ ok: true, playlistCount: 1, videoCount: 2 })),
}));
vi.mock('../services/youtubeSync.js', () => ({
  getStatus: (...args) => mocks.getStatus(...args), checkSetup: (...args) => mocks.checkSetup(...args), runSync: (...args) => mocks.runSync(...args),
}));
vi.mock('../services/youtubePlaylists.js', () => ({
  getStoredYoutubePlaylists: (...args) => mocks.getStoredYoutubePlaylists(...args), youtubePlaylistSnapshotSummary: (...args) => mocks.youtubePlaylistSnapshotSummary(...args),
  syncYoutubePlaylists: (...args) => mocks.syncYoutubePlaylists(...args),
}));
import youtubeRoutes from './youtube.js';

function makeApp() {
  const app = express(); app.use('/api/youtube', youtubeRoutes); app.use(errorMiddleware); return app;
}
describe('YouTube routes', () => {
  beforeEach(() => vi.clearAllMocks());
  it('serves the stored library and starts an explicit playlist sync', async () => {
    const app = makeApp();
    const snapshot = await request(app).get('/api/youtube/playlists');
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({ snapshot: { playlists: [] }, summary: { playlistCount: 0 } });
    const sync = await request(app).post('/api/youtube/playlists/sync');
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ ok: true, playlistCount: 1, videoCount: 2 });
    expect(mocks.syncYoutubePlaylists).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['/sync', 'YOUTUBE_SYNC_FAILED', mocks.runSync],
    ['/playlists/sync', 'YOUTUBE_PLAYLIST_SYNC_FAILED', mocks.syncYoutubePlaylists],
  ])('returns an HTTP 409 envelope with sign-in remediation for %s', async (path, code, sync) => {
    const remediation = 'Log into YouTube in the managed browser, then sync again.';
    sync.mockResolvedValueOnce({ ok: false, status: 'auth-required', error: 'Signed out of YouTube', remediation });

    const res = await request(makeApp()).post(`/api/youtube${path}`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code, error: 'Signed out of YouTube', context: { needsAuth: true, status: 'auth-required', remediation },
    });
  });

  it.each([
    ['/sync', 'YOUTUBE_SYNC_FAILED', mocks.runSync, 502, { status: 'no-browser', remediation: 'Start the managed browser.' }],
    ['/sync', 'YOUTUBE_SYNC_FAILED', mocks.runSync, 500, { status: 'persist-failed' }],
    ['/playlists/sync', 'YOUTUBE_PLAYLIST_SYNC_FAILED', mocks.syncYoutubePlaylists, 502, { status: 'extraction-failed' }],
    ['/playlists/sync', 'YOUTUBE_PLAYLIST_SYNC_FAILED', mocks.syncYoutubePlaylists, 500, { status: 'snapshot-unreadable' }],
  ])('maps %s operational failures to an error envelope', async (path, code, sync, status, report) => {
    sync.mockResolvedValueOnce({ ok: false, error: 'YouTube sync failed', ...report });

    const res = await request(makeApp()).post(`/api/youtube${path}`);

    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ code, error: 'YouTube sync failed', context: { needsAuth: false, ...report } });
  });

  it('returns a saved playlist snapshot with warnings as HTTP 200', async () => {
    const report = { ok: false, playlistCount: 2, videoCount: 4, warnings: ['One playlist failed'], failed: 1 };
    mocks.syncYoutubePlaylists.mockResolvedValueOnce(report);

    const res = await request(makeApp()).post('/api/youtube/playlists/sync');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
  });
});
