import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  getRedirectUri: vi.fn(({ origin } = {}) => `${origin || 'http://localhost:5555'}/api/spotify/oauth/callback`),
  getStatus: vi.fn(async () => ({ auth: {} })),
  runSync: vi.fn(async () => ({ ok: true, recorded: 1 })),
  getAuthUrl: vi.fn(async () => ({ url: 'https://accounts.spotify.com/authorize' })),
  saveCredentials: vi.fn(async (_data, options) => ({ redirectUri: mocks.getRedirectUri(options) })),
  handleCallback: vi.fn(async () => ({ success: true })),
  clearAuth: vi.fn(async () => ({ cleared: true })),
  getStoredPlaylists: vi.fn(async () => ({ playlists: [] })),
  playlistSnapshotSummary: vi.fn(() => ({ playlistCount: 0, trackCount: 0 })),
  syncSpotifyPlaylists: vi.fn(async () => ({ ok: true, playlistCount: 1, trackCount: 2 })),
}));

vi.mock('../services/spotifyAuth.js', () => ({
  getRedirectUri: (...args) => mocks.getRedirectUri(...args),
  getAuthUrl: (...args) => mocks.getAuthUrl(...args),
  saveCredentials: (...args) => mocks.saveCredentials(...args),
  handleCallback: (...args) => mocks.handleCallback(...args),
  clearAuth: (...args) => mocks.clearAuth(...args),
}));

vi.mock('../services/spotifySync.js', () => ({
  getStatus: (...args) => mocks.getStatus(...args),
  runSync: (...args) => mocks.runSync(...args),
}));

vi.mock('../services/spotifyPlaylists.js', () => ({
  getStoredPlaylists: (...args) => mocks.getStoredPlaylists(...args),
  playlistSnapshotSummary: (...args) => mocks.playlistSnapshotSummary(...args),
  syncSpotifyPlaylists: (...args) => mocks.syncSpotifyPlaylists(...args),
}));

import spotifyRoutes from './spotify.js';

function makeApp() {
  const app = express();
  // superagent always stamps the Host header from the URL, so a test-only header stands in for it.
  app.use((req, _res, next) => {
    if (req.headers['x-test-host']) req.headers.host = req.headers['x-test-host'];
    next();
  });
  app.use(express.json());
  app.use('/api/spotify', spotifyRoutes);
  app.get('/brain/spotify', (req, res) => res.json(req.query));
  app.use(errorMiddleware);
  return app;
}

describe('Spotify routes', () => {
  it('redirects with oauthError for a repeated callback query key', async () => {
    const res = await request(makeApp()).get(`/api/spotify/oauth/callback?code=a&code=b&state=${'a'.repeat(32)}`);
    expect(res.body).toEqual({ oauthError: expect.stringMatching(/OAuth state/) });
    expect(mocks.handleCallback).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves credentials with Cache-Control: no-store', async () => {
    const res = await request(makeApp()).post('/api/spotify/auth/credentials').send({ clientId: 'cid', clientSecret: 'shh' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('derives the status redirect URI from the Host header', async () => {
    const response = await request(makeApp())
      .get('/api/spotify/status')
      .set('X-Test-Host', 'host-example.ts.net:5555');

    expect(response.status).toBe(200);
    expect(mocks.getStatus).toHaveBeenCalledWith({ origin: 'http://host-example.ts.net:5555' });
  });

  it('ignores spoofed X-Forwarded-* headers when deriving the redirect origin', async () => {
    const response = await request(makeApp())
      .get('/api/spotify/status')
      .set('X-Test-Host', 'host-example.ts.net:5555')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'evil.example.com');

    expect(response.status).toBe(200);
    expect(mocks.getStatus).toHaveBeenCalledWith({ origin: 'http://host-example.ts.net:5555' });
  });

  it('derives no origin from a Host header PortOS does not answer on', async () => {
    await request(makeApp()).get('/api/spotify/status').set('X-Test-Host', 'evil.example.com');
    expect(mocks.getStatus).toHaveBeenCalledWith({ origin: null });
  });

  it('uses the request origin for the OAuth authorize URL', async () => {
    await request(makeApp())
      .post('/api/spotify/auth/url')
      .set('X-Test-Host', 'host-example.ts.net:5555');

    expect(mocks.getAuthUrl).toHaveBeenCalledWith({ origin: 'http://host-example.ts.net:5555' });
  });

  it('serves the stored playlist snapshot and starts an explicit playlist sync', async () => {
    const app = makeApp();
    const snapshot = await request(app).get('/api/spotify/playlists');
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({ snapshot: { playlists: [] }, summary: { playlistCount: 0 } });

    const sync = await request(app).post('/api/spotify/playlists/sync');
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ ok: true, playlistCount: 1, trackCount: 2 });
    expect(mocks.syncSpotifyPlaylists).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, { needsAuth: true }, { needsAuth: true }],
    [502, { status: 429 }, { needsAuth: false, status: 429 }],
    [500, { status: 'persist-failed' }, { needsAuth: false, status: 'persist-failed' }],
  ])('returns an HTTP %i envelope for an unsuccessful history sync', async (status, report, context) => {
    mocks.runSync.mockResolvedValueOnce({ ok: false, error: 'Spotify sync failed', ...report });

    const res = await request(makeApp()).post('/api/spotify/sync');

    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ code: 'SPOTIFY_SYNC_FAILED', error: 'Spotify sync failed', context });
  });

  it.each([
    [409, { needsAuth: true }, { needsAuth: true }],
    [502, {}, { needsAuth: false }],
    [502, { status: 'list-empty', playlistCount: 1 }, { needsAuth: false, status: 'list-empty' }],
    [500, { status: 'snapshot-unreadable' }, { needsAuth: false, status: 'snapshot-unreadable' }],
  ])('returns an HTTP %i envelope when playlist sync could not save a snapshot', async (status, report, context) => {
    mocks.syncSpotifyPlaylists.mockResolvedValueOnce({ ok: false, error: 'Spotify playlists failed', ...report });

    const res = await request(makeApp()).post('/api/spotify/playlists/sync');

    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ code: 'SPOTIFY_PLAYLIST_SYNC_FAILED', error: 'Spotify playlists failed', context });
  });

  it('returns a saved playlist snapshot with warnings as HTTP 200', async () => {
    const report = { ok: false, playlistCount: 2, trackCount: 4, warnings: ['One playlist failed'], failed: 1 };
    mocks.syncSpotifyPlaylists.mockResolvedValueOnce(report);

    const res = await request(makeApp()).post('/api/spotify/playlists/sync');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
  });
});
