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
describe('YouTube playlist routes', () => {
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
});
