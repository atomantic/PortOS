import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Mock the service so the test isolates the ROUTE's validation/merge contract:
// we assert exactly what the route forwards to updateSong, independent of the
// JSON-file persistence (covered by services/songs.test.js).
const mocks = vi.hoisted(() => ({
  listSongs: vi.fn(),
  getSong: vi.fn(),
  createSong: vi.fn(),
  updateSong: vi.fn(),
  deleteSong: vi.fn(),
  refreshSongFromTemplate: vi.fn(),
}));
vi.mock('../services/songs.js', async () => {
  const actual = await vi.importActual('../services/songs.js');
  return { ...actual, ...mocks };
});

// Mock the AI layer so route tests don't spawn a provider — assert the route's
// validation + service wiring, not the LLM call.
const aiMocks = vi.hoisted(() => ({
  generateSong: vi.fn(),
  evaluateSong: vi.fn(),
  deriveSongParts: vi.fn(),
}));
vi.mock('../services/songsAI.js', () => aiMocks);

import songsRoutes from './songs.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/songs', songsRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('songs route', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    for (const fn of Object.values(aiMocks)) fn.mockReset();
  });

  it('GET / returns the song list', async () => {
    mocks.listSongs.mockResolvedValue([{ id: 'song-1', title: 'A' }]);
    const res = await request(makeApp()).get('/api/songs');
    expect(res.status).toBe(200);
    expect(res.body.songs).toEqual([{ id: 'song-1', title: 'A' }]);
  });

  it('GET /:id 404s with a NOT_FOUND code when the song is missing', async () => {
    mocks.getSong.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/songs/song-nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('PUT /:id forwards ONLY the keys the client sent — omitted fields are not clobbered', async () => {
    // Regression guard: a `.default('')` on the schema fields would make
    // .partial() materialize defaults for omitted keys, so a title-only PUT
    // would wipe artist/key/notation/notes via updateSong's `key in patch`
    // merge. The route must forward a patch containing ONLY `title`.
    mocks.updateSong.mockResolvedValue({ id: 'song-1', title: 'Renamed' });
    const res = await request(makeApp())
      .put('/api/songs/song-1')
      .send({ title: 'Renamed' });
    expect(res.status).toBe(200);
    expect(mocks.updateSong).toHaveBeenCalledTimes(1);
    const [, patch] = mocks.updateSong.mock.calls[0];
    expect(patch).toEqual({ title: 'Renamed' });
    expect('artist' in patch).toBe(false);
    expect('key' in patch).toBe(false);
    expect('notation' in patch).toBe(false);
  });

  it('PUT /:id preserves an explicit empty-string clear (present, not absent)', async () => {
    mocks.updateSong.mockResolvedValue({ id: 'song-1', key: '' });
    await request(makeApp()).put('/api/songs/song-1').send({ key: '' });
    const [, patch] = mocks.updateSong.mock.calls[0];
    expect('key' in patch).toBe(true);
    expect(patch.key).toBe('');
  });

  it('PUT /:id maps a service NOT_FOUND to a 404', async () => {
    mocks.updateSong.mockRejectedValue(Object.assign(new Error('nope'), { code: 'NOT_FOUND' }));
    const res = await request(makeApp()).put('/api/songs/song-x').send({ title: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('POST / rejects an over-long title with a 400', async () => {
    const res = await request(makeApp())
      .post('/api/songs')
      .send({ title: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
    expect(mocks.createSong).not.toHaveBeenCalled();
  });

  it('POST / rejects a tempo outside the supported band', async () => {
    const res = await request(makeApp()).post('/api/songs').send({ title: 'A', tempo: 9000 });
    expect(res.status).toBe(400);
  });

  it('DELETE /:id returns the deleted id', async () => {
    mocks.deleteSong.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).delete('/api/songs/song-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('song-1');
  });

  it('PUT /:id accepts a recordings array', async () => {
    mocks.updateSong.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/songs/song-1').send({
      recordings: [{ layerId: 'lead', filename: 'abc-vocal.wav', durationMs: 1200, peak: 0.4 }],
    });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateSong.mock.calls[0];
    expect(patch.recordings[0].filename).toBe('abc-vocal.wav');
  });

  it('PUT /:id rejects a recording with a peak outside 0–1', async () => {
    const res = await request(makeApp()).put('/api/songs/song-1').send({
      recordings: [{ filename: 'x.wav', peak: 5 }],
    });
    expect(res.status).toBe(400);
    expect(mocks.updateSong).not.toHaveBeenCalled();
  });

  it('PUT /:id accepts a references array', async () => {
    mocks.updateSong.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/songs/song-1').send({
      references: [{ url: 'https://www.tiktok.com/@u/video/123', label: 'TikTok' }],
    });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateSong.mock.calls[0];
    expect(patch.references[0].url).toBe('https://www.tiktok.com/@u/video/123');
  });

  it('PUT /:id rejects a reference without a url', async () => {
    const res = await request(makeApp()).put('/api/songs/song-1').send({
      references: [{ label: 'no url' }],
    });
    expect(res.status).toBe(400);
    expect(mocks.updateSong).not.toHaveBeenCalled();
  });

  it('PUT /:id accepts an empty-url reference (a blank row is dropped server-side, not rejected)', async () => {
    // The editor seeds new reference rows as { url: '' }; saving must not 400 —
    // the service drops the blank row. Guards against a future `.min(1)` that
    // would reject in-progress rows on save.
    mocks.updateSong.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/songs/song-1').send({
      references: [{ url: '' }],
    });
    expect(res.status).toBe(200);
  });

  it('PUT /:id accepts a partnerSongIds array', async () => {
    mocks.updateSong.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/songs/song-1').send({
      partnerSongIds: ['seed-ah-poor-bird', 'seed-rose-rose-rose-red'],
    });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateSong.mock.calls[0];
    expect(patch.partnerSongIds).toEqual(['seed-ah-poor-bird', 'seed-rose-rose-rose-red']);
  });

  it('PUT /:id rejects more than PARTNERS_MAX partner ids', async () => {
    const tooMany = Array.from({ length: 20 }, (_, i) => `seed-${i}`);
    const res = await request(makeApp()).put('/api/songs/song-1').send({ partnerSongIds: tooMany });
    expect(res.status).toBe(400);
    expect(mocks.updateSong).not.toHaveBeenCalled();
  });

  it('POST /:id/refresh-template returns the refreshed built-in song', async () => {
    mocks.refreshSongFromTemplate.mockResolvedValue({ id: 'seed-500-miles', title: '500 Miles', builtIn: true });
    const res = await request(makeApp()).post('/api/songs/seed-500-miles/refresh-template');
    expect(res.status).toBe(200);
    expect(res.body.song.builtIn).toBe(true);
    expect(mocks.refreshSongFromTemplate).toHaveBeenCalledWith('seed-500-miles');
  });

  it('POST /:id/refresh-template maps NOT_BUILTIN to a 400', async () => {
    mocks.refreshSongFromTemplate.mockRejectedValue(Object.assign(new Error('nope'), { code: 'NOT_BUILTIN' }));
    const res = await request(makeApp()).post('/api/songs/song-custom/refresh-template');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_BUILTIN');
  });

  it('POST /generate returns the generated fields (no id needed)', async () => {
    aiMocks.generateSong.mockResolvedValue({ song: { title: 'New', sections: [] }, llm: { provider: 'p' } });
    const res = await request(makeApp()).post('/api/songs/generate').send({ brief: 'a lament' });
    expect(res.status).toBe(200);
    expect(res.body.song.title).toBe('New');
    expect(aiMocks.generateSong).toHaveBeenCalledTimes(1);
  });

  it('POST /generate coerces an empty providerId to undefined (use default)', async () => {
    aiMocks.generateSong.mockResolvedValue({ song: { title: 'X' }, llm: {} });
    await request(makeApp()).post('/api/songs/generate').send({ providerId: '' });
    const [arg] = aiMocks.generateSong.mock.calls[0];
    expect(arg.providerId).toBeUndefined();
  });

  it('POST /:id/generate 404s when the song is missing', async () => {
    mocks.getSong.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/songs/song-nope/generate').send({});
    expect(res.status).toBe(404);
    expect(aiMocks.generateSong).not.toHaveBeenCalled();
  });

  it('POST /:id/generate passes the stored song when expandExisting is set', async () => {
    mocks.getSong.mockResolvedValue({ id: 'song-1', title: 'Stored', artist: 'PPM' });
    aiMocks.generateSong.mockResolvedValue({ song: { title: 'Bigger' }, llm: {} });
    const res = await request(makeApp()).post('/api/songs/song-1/generate').send({ expandExisting: true });
    expect(res.status).toBe(200);
    const [arg] = aiMocks.generateSong.mock.calls[0];
    expect(arg.existingSong).toEqual({ id: 'song-1', title: 'Stored', artist: 'PPM' });
    expect(arg.title).toBe('Stored'); // falls back to the stored title
  });

  it('POST /:id/evaluate returns the verdict', async () => {
    mocks.getSong.mockResolvedValue({ id: 'song-1', title: 'A' });
    aiMocks.evaluateSong.mockResolvedValue({ evaluation: { score: 72, strengths: [] }, llm: {} });
    const res = await request(makeApp()).post('/api/songs/song-1/evaluate').send({});
    expect(res.status).toBe(200);
    expect(res.body.evaluation.score).toBe(72);
  });

  it('POST /:id/evaluate 404s when the song is missing', async () => {
    mocks.getSong.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/songs/song-x/evaluate').send({});
    expect(res.status).toBe(404);
    expect(aiMocks.evaluateSong).not.toHaveBeenCalled();
  });

  it('PUT /:id accepts a scoreParts array', async () => {
    mocks.updateSong.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp())
      .put('/api/songs/song-1')
      .send({ scoreParts: [{ label: 'Bass', role: 'bass', score: '| G2w(x) |' }] });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateSong.mock.calls[0];
    expect(patch.scoreParts).toHaveLength(1);
    expect(patch.scoreParts[0].score).toBe('| G2w(x) |');
  });

  it('PUT /:id rejects a scorePart without a score', async () => {
    const res = await request(makeApp())
      .put('/api/songs/song-1')
      .send({ scoreParts: [{ label: 'Bass', role: 'bass' }] });
    expect(res.status).toBe(400);
    expect(mocks.updateSong).not.toHaveBeenCalled();
  });

  it('POST /:id/derive-parts returns the derived scoreParts', async () => {
    mocks.getSong.mockResolvedValue({ id: 'song-1', title: '500 Miles', score: '| [G] B4q |' });
    aiMocks.deriveSongParts.mockResolvedValue({
      scoreParts: [{ role: 'bass', label: 'Bass', score: '| G2w |' }], llm: { provider: 'p' },
    });
    const res = await request(makeApp()).post('/api/songs/song-1/derive-parts').send({});
    expect(res.status).toBe(200);
    expect(res.body.scoreParts).toHaveLength(1);
    const [arg] = aiMocks.deriveSongParts.mock.calls[0];
    expect(arg.song.id).toBe('song-1');
  });

  it('POST /:id/derive-parts 404s when the song is missing', async () => {
    mocks.getSong.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/songs/song-x/derive-parts').send({});
    expect(res.status).toBe(404);
    expect(aiMocks.deriveSongParts).not.toHaveBeenCalled();
  });

  it('POST /:id/derive-parts forwards a partIds restriction', async () => {
    mocks.getSong.mockResolvedValue({ id: 'song-1', score: '| [G] B4q |' });
    aiMocks.deriveSongParts.mockResolvedValue({ scoreParts: [], llm: {} });
    await request(makeApp()).post('/api/songs/song-1/derive-parts').send({ partIds: ['bass', 'high-harmony-1'] });
    const [arg] = aiMocks.deriveSongParts.mock.calls[0];
    expect(arg.partIds).toEqual(['bass', 'high-harmony-1']);
  });
});
