import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Mock the service so the test isolates the ROUTE's validation/merge contract:
// we assert exactly what the route forwards to updateRound, independent of the
// JSON-file persistence (covered by services/rounds.test.js).
const mocks = vi.hoisted(() => ({
  listRounds: vi.fn(),
  getRound: vi.fn(),
  createRound: vi.fn(),
  updateRound: vi.fn(),
  deleteRound: vi.fn(),
  refreshRoundFromTemplate: vi.fn(),
}));
vi.mock('../services/rounds.js', async () => {
  const actual = await vi.importActual('../services/rounds.js');
  return { ...actual, ...mocks };
});

// Mock the AI layer so route tests don't spawn a provider — assert the route's
// validation + service wiring, not the LLM call.
const aiMocks = vi.hoisted(() => ({
  generateRound: vi.fn(),
  evaluateRound: vi.fn(),
  deriveRoundParts: vi.fn(),
}));
vi.mock('../services/roundsAI.js', () => aiMocks);

// Isolate the route contract from the real yt-dlp/SSE import service (#2120).
const importMocks = vi.hoisted(() => ({
  startReferenceAudioImport: vi.fn(),
  attachReferenceAudioSseClient: vi.fn(),
  cancelReferenceAudioImport: vi.fn(),
}));
vi.mock('../services/roundReferenceAudioImport.js', () => importMocks);

import roundsRoutes from './rounds.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/rounds', roundsRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('rounds route', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    for (const fn of Object.values(aiMocks)) fn.mockReset();
    for (const fn of Object.values(importMocks)) fn.mockReset();
  });

  it('GET / returns the song list', async () => {
    mocks.listRounds.mockResolvedValue([{ id: 'song-1', title: 'A' }]);
    const res = await request(makeApp()).get('/api/rounds');
    expect(res.status).toBe(200);
    expect(res.body.rounds).toEqual([{ id: 'song-1', title: 'A' }]);
  });

  it('GET /:id 404s with a NOT_FOUND code when the song is missing', async () => {
    mocks.getRound.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/rounds/song-nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('PUT /:id forwards ONLY the keys the client sent — omitted fields are not clobbered', async () => {
    // Regression guard: a `.default('')` on the schema fields would make
    // .partial() materialize defaults for omitted keys, so a title-only PUT
    // would wipe artist/key/notation/notes via updateRound's `key in patch`
    // merge. The route must forward a patch containing ONLY `title`.
    mocks.updateRound.mockResolvedValue({ id: 'song-1', title: 'Renamed' });
    const res = await request(makeApp())
      .put('/api/rounds/song-1')
      .send({ title: 'Renamed' });
    expect(res.status).toBe(200);
    expect(mocks.updateRound).toHaveBeenCalledTimes(1);
    const [, patch] = mocks.updateRound.mock.calls[0];
    expect(patch).toEqual({ title: 'Renamed' });
    expect('artist' in patch).toBe(false);
    expect('key' in patch).toBe(false);
    expect('notation' in patch).toBe(false);
  });

  it('PUT /:id preserves an explicit empty-string clear (present, not absent)', async () => {
    mocks.updateRound.mockResolvedValue({ id: 'song-1', key: '' });
    await request(makeApp()).put('/api/rounds/song-1').send({ key: '' });
    const [, patch] = mocks.updateRound.mock.calls[0];
    expect('key' in patch).toBe(true);
    expect(patch.key).toBe('');
  });

  it('PUT /:id maps a service NOT_FOUND to a 404', async () => {
    mocks.updateRound.mockRejectedValue(Object.assign(new Error('nope'), { code: 'NOT_FOUND' }));
    const res = await request(makeApp()).put('/api/rounds/song-x').send({ title: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('POST / rejects an over-long title with a 400', async () => {
    const res = await request(makeApp())
      .post('/api/rounds')
      .send({ title: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
    expect(mocks.createRound).not.toHaveBeenCalled();
  });

  it('POST / rejects a tempo outside the supported band', async () => {
    const res = await request(makeApp()).post('/api/rounds').send({ title: 'A', tempo: 9000 });
    expect(res.status).toBe(400);
  });

  it('DELETE /:id returns the deleted id', async () => {
    mocks.deleteRound.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).delete('/api/rounds/song-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('song-1');
  });

  it('PUT /:id accepts a recordings array', async () => {
    mocks.updateRound.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/rounds/song-1').send({
      recordings: [{ layerId: 'lead', filename: 'abc-vocal.wav', durationMs: 1200, peak: 0.4 }],
    });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateRound.mock.calls[0];
    expect(patch.recordings[0].filename).toBe('abc-vocal.wav');
  });

  it('PUT /:id rejects a recording with a peak outside 0–1', async () => {
    const res = await request(makeApp()).put('/api/rounds/song-1').send({
      recordings: [{ filename: 'x.wav', peak: 5 }],
    });
    expect(res.status).toBe(400);
    expect(mocks.updateRound).not.toHaveBeenCalled();
  });

  it('PUT /:id accepts a recording with pitchTrack + accuracy analysis (#1027)', async () => {
    mocks.updateRound.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/rounds/song-1').send({
      recordings: [{
        filename: 'take.wav',
        pitchTrack: [{ tMs: 0, hz: 220, cents: -3, clarity: 0.9 }, { tMs: 50, hz: null }],
        accuracy: { percentInTune: 80, graded: 5, counts: { 'in-tune': 4, close: 1 }, perNote: ['in-tune', 'close'] },
      }],
    });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateRound.mock.calls[0];
    expect(patch.recordings[0].pitchTrack).toHaveLength(2);
    expect(patch.recordings[0].accuracy.percentInTune).toBe(80);
  });

  it('PUT /:id accepts a legacy recording with no pitch analysis (absent-tolerant)', async () => {
    mocks.updateRound.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/rounds/song-1').send({
      recordings: [{ filename: 'legacy.wav', durationMs: 500 }],
    });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateRound.mock.calls[0];
    expect(patch.recordings[0]).not.toHaveProperty('pitchTrack');
  });

  it('PUT /:id rejects a pitchTrack exceeding the bound', async () => {
    const tooMany = Array.from({ length: 4001 }, (_, i) => ({ tMs: i }));
    const res = await request(makeApp()).put('/api/rounds/song-1').send({
      recordings: [{ filename: 'x.wav', pitchTrack: tooMany }],
    });
    expect(res.status).toBe(400);
    expect(mocks.updateRound).not.toHaveBeenCalled();
  });

  it('PUT /:id accepts a references array', async () => {
    mocks.updateRound.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/rounds/song-1').send({
      references: [{ url: 'https://www.tiktok.com/@u/video/123', label: 'TikTok' }],
    });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateRound.mock.calls[0];
    expect(patch.references[0].url).toBe('https://www.tiktok.com/@u/video/123');
  });

  it('PUT /:id passes a segment stacked-mix backing window through validation (#2121)', async () => {
    // The Zod schema strips unknown keys, so bgStartMs/bgEndMs must be typed on
    // refSegmentSchema or they'd never reach the service sanitizer.
    mocks.updateRound.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/rounds/song-1').send({
      references: [{
        url: 'https://www.tiktok.com/@u/video/123',
        audioFilename: 'ref.wav',
        segments: [{ layerId: 'alto', startMs: 8000, endMs: 16000, bgStartMs: 4000, bgEndMs: 8000 }],
      }],
    });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateRound.mock.calls[0];
    expect(patch.references[0].segments[0]).toMatchObject({ bgStartMs: 4000, bgEndMs: 8000 });
  });

  it('PUT /:id rejects a reference without a url', async () => {
    const res = await request(makeApp()).put('/api/rounds/song-1').send({
      references: [{ label: 'no url' }],
    });
    expect(res.status).toBe(400);
    expect(mocks.updateRound).not.toHaveBeenCalled();
  });

  it('PUT /:id accepts an empty-url reference (a blank row is dropped server-side, not rejected)', async () => {
    // The editor seeds new reference rows as { url: '' }; saving must not 400 —
    // the service drops the blank row. Guards against a future `.min(1)` that
    // would reject in-progress rows on save.
    mocks.updateRound.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/rounds/song-1').send({
      references: [{ url: '' }],
    });
    expect(res.status).toBe(200);
  });

  it('PUT /:id accepts a partnerRoundIds array', async () => {
    mocks.updateRound.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).put('/api/rounds/song-1').send({
      partnerRoundIds: ['seed-ah-poor-bird', 'seed-rose-rose-rose-red'],
    });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateRound.mock.calls[0];
    expect(patch.partnerRoundIds).toEqual(['seed-ah-poor-bird', 'seed-rose-rose-rose-red']);
  });

  it('PUT /:id rejects more than PARTNERS_MAX partner ids', async () => {
    const tooMany = Array.from({ length: 20 }, (_, i) => `seed-${i}`);
    const res = await request(makeApp()).put('/api/rounds/song-1').send({ partnerRoundIds: tooMany });
    expect(res.status).toBe(400);
    expect(mocks.updateRound).not.toHaveBeenCalled();
  });

  it('POST /:id/refresh-template returns the refreshed built-in song', async () => {
    mocks.refreshRoundFromTemplate.mockResolvedValue({ id: 'seed-500-miles', title: '500 Miles', builtIn: true });
    const res = await request(makeApp()).post('/api/rounds/seed-500-miles/refresh-template');
    expect(res.status).toBe(200);
    expect(res.body.round.builtIn).toBe(true);
    expect(mocks.refreshRoundFromTemplate).toHaveBeenCalledWith('seed-500-miles');
  });

  it('POST /:id/refresh-template maps NOT_BUILTIN to a 400', async () => {
    mocks.refreshRoundFromTemplate.mockRejectedValue(Object.assign(new Error('nope'), { code: 'NOT_BUILTIN' }));
    const res = await request(makeApp()).post('/api/rounds/song-custom/refresh-template');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_BUILTIN');
  });

  it('POST /generate returns the generated fields (no id needed)', async () => {
    aiMocks.generateRound.mockResolvedValue({ song: { title: 'New', sections: [] }, llm: { provider: 'p' } });
    const res = await request(makeApp()).post('/api/rounds/generate').send({ brief: 'a lament' });
    expect(res.status).toBe(200);
    expect(res.body.song.title).toBe('New');
    expect(aiMocks.generateRound).toHaveBeenCalledTimes(1);
  });

  it('POST /generate coerces an empty providerId to undefined (use default)', async () => {
    aiMocks.generateRound.mockResolvedValue({ song: { title: 'X' }, llm: {} });
    await request(makeApp()).post('/api/rounds/generate').send({ providerId: '' });
    const [arg] = aiMocks.generateRound.mock.calls[0];
    expect(arg.providerId).toBeUndefined();
  });

  it('POST /:id/generate 404s when the song is missing', async () => {
    mocks.getRound.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/rounds/song-nope/generate').send({});
    expect(res.status).toBe(404);
    expect(aiMocks.generateRound).not.toHaveBeenCalled();
  });

  it('POST /:id/generate passes the stored song when expandExisting is set', async () => {
    mocks.getRound.mockResolvedValue({ id: 'song-1', title: 'Stored', artist: 'PPM' });
    aiMocks.generateRound.mockResolvedValue({ song: { title: 'Bigger' }, llm: {} });
    const res = await request(makeApp()).post('/api/rounds/song-1/generate').send({ expandExisting: true });
    expect(res.status).toBe(200);
    const [arg] = aiMocks.generateRound.mock.calls[0];
    expect(arg.existingRound).toEqual({ id: 'song-1', title: 'Stored', artist: 'PPM' });
    expect(arg.title).toBe('Stored'); // falls back to the stored title
  });

  it('POST /:id/evaluate returns the verdict', async () => {
    mocks.getRound.mockResolvedValue({ id: 'song-1', title: 'A' });
    aiMocks.evaluateRound.mockResolvedValue({ evaluation: { score: 72, strengths: [] }, llm: {} });
    const res = await request(makeApp()).post('/api/rounds/song-1/evaluate').send({});
    expect(res.status).toBe(200);
    expect(res.body.evaluation.score).toBe(72);
  });

  it('POST /:id/evaluate 404s when the song is missing', async () => {
    mocks.getRound.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/rounds/song-x/evaluate').send({});
    expect(res.status).toBe(404);
    expect(aiMocks.evaluateRound).not.toHaveBeenCalled();
  });

  it('PUT /:id accepts a scoreParts array', async () => {
    mocks.updateRound.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp())
      .put('/api/rounds/song-1')
      .send({ scoreParts: [{ label: 'Bass', role: 'bass', score: '| G2w(x) |' }] });
    expect(res.status).toBe(200);
    const [, patch] = mocks.updateRound.mock.calls[0];
    expect(patch.scoreParts).toHaveLength(1);
    expect(patch.scoreParts[0].score).toBe('| G2w(x) |');
  });

  it('PUT /:id rejects a scorePart without a score', async () => {
    const res = await request(makeApp())
      .put('/api/rounds/song-1')
      .send({ scoreParts: [{ label: 'Bass', role: 'bass' }] });
    expect(res.status).toBe(400);
    expect(mocks.updateRound).not.toHaveBeenCalled();
  });

  it('POST /:id/derive-parts returns the derived scoreParts', async () => {
    mocks.getRound.mockResolvedValue({ id: 'song-1', title: '500 Miles', score: '| [G] B4q |' });
    aiMocks.deriveRoundParts.mockResolvedValue({
      scoreParts: [{ role: 'bass', label: 'Bass', score: '| G2w |' }], llm: { provider: 'p' },
    });
    const res = await request(makeApp()).post('/api/rounds/song-1/derive-parts').send({});
    expect(res.status).toBe(200);
    expect(res.body.scoreParts).toHaveLength(1);
    const [arg] = aiMocks.deriveRoundParts.mock.calls[0];
    expect(arg.song.id).toBe('song-1');
  });

  it('POST /:id/derive-parts 404s when the song is missing', async () => {
    mocks.getRound.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/rounds/song-x/derive-parts').send({});
    expect(res.status).toBe(404);
    expect(aiMocks.deriveRoundParts).not.toHaveBeenCalled();
  });

  it('POST /:id/derive-parts forwards a partIds restriction', async () => {
    mocks.getRound.mockResolvedValue({ id: 'song-1', score: '| [G] B4q |' });
    aiMocks.deriveRoundParts.mockResolvedValue({ scoreParts: [], llm: {} });
    await request(makeApp()).post('/api/rounds/song-1/derive-parts').send({ partIds: ['bass', 'high-harmony-1'] });
    const [arg] = aiMocks.deriveRoundParts.mock.calls[0];
    expect(arg.partIds).toEqual(['bass', 'high-harmony-1']);
  });

  // --- Reference-audio import (#2120) ---------------------------------------
  it('POST /reference-audio/import 202s with the jobId from the service', async () => {
    importMocks.startReferenceAudioImport.mockResolvedValue({ jobId: 'job-1' });
    const res = await request(makeApp())
      .post('/api/rounds/reference-audio/import')
      .send({ url: 'https://tiktok.com/@a/video/1' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: 'job-1' });
    expect(importMocks.startReferenceAudioImport).toHaveBeenCalledWith('https://tiktok.com/@a/video/1');
  });

  it('POST /reference-audio/import 400s on a missing url (not read as a round id)', async () => {
    const res = await request(makeApp()).post('/api/rounds/reference-audio/import').send({});
    expect(res.status).toBe(400);
    expect(importMocks.startReferenceAudioImport).not.toHaveBeenCalled();
  });

  it('POST /reference-audio/import/:jobId/cancel reports the cancel result', async () => {
    importMocks.cancelReferenceAudioImport.mockReturnValue(true);
    const res = await request(makeApp()).post('/api/rounds/reference-audio/import/job-1/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(importMocks.cancelReferenceAudioImport).toHaveBeenCalledWith('job-1');
  });
});
