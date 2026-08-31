import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  getRedirectUri: vi.fn(({ origin } = {}) => `${origin || 'http://localhost:5555'}/api/spotify/oauth/callback`),
  getStatus: vi.fn(async () => ({ auth: {} })),
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
  runSync: vi.fn(),
}));

vi.mock('../services/spotifyPlaylists.js', () => ({
  getStoredPlaylists: (...args) => mocks.getStoredPlaylists(...args),
  playlistSnapshotSummary: (...args) => mocks.playlistSnapshotSummary(...args),
  syncSpotifyPlaylists: (...args) => mocks.syncSpotifyPlaylists(...args),
}));

import spotifyRoutes from './spotify.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/spotify', spotifyRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('Spotify routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives the status redirect URI from the forwarded public origin', async () => {
    const response = await request(makeApp())
      .get('/api/spotify/status')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'host-example.ts.net:5555');

    expect(response.status).toBe(200);
    expect(mocks.getStatus).toHaveBeenCalledWith({ origin: 'https://host-example.ts.net:5555' });
  });

  it('uses the request origin for the OAuth authorize URL', async () => {
    await request(makeApp())
      .get('/api/spotify/auth/url')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'host-example.ts.net:5555');

    expect(mocks.getAuthUrl).toHaveBeenCalledWith({ origin: 'https://host-example.ts.net:5555' });
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
});
