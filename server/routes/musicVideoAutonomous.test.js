/**
 * Fully-autonomous Music Video (one prompt → lyrics → Suno song → video),
 * through the real router and the real file-backed project store. Only the
 * stage providers (LLM, mood board, Suno, track store, analysis, production)
 * are doubles. Pins what no unit test above can: request validation at the
 * door, that the run checkpoint survives the real store's read/write path, the
 * checkpoint → approve round trip over HTTP, and that the run never leaves
 * this install (peer-sync wire and clone).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots, sweepStrayTempRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-autonomous-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const service = await import('../services/musicVideo/autonomousService.js');
const { stripMusicVideoLocalRenderPins } = await import('../lib/syncWire.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const BRIEF = {
  title: 'Neon Rain', musicalDescription: 'synthwave', sunoStyle: 'synthwave',
  concept: { prompt: 'a courier crosses a rainy city', style: 'neon noir' },
  moodBoard: { name: 'Neon Rain', description: 'wet streets', notes: ['teal'], stylePrompt: 'neon noir', negativePrompt: '' },
};
const startProduction = vi.fn(async () => ({ run: { id: 'mvpr-1' } }));

beforeAll(() => sweepStrayTempRoots('mv-autonomous-route-test-'));
afterAll(() => cleanupTempDataRoots());
beforeEach(() => {
  startProduction.mockClear();
  service.__setAutonomousDepsForTests({
    draftCreativeBrief: async () => ({ brief: BRIEF }),
    writeLyrics: async () => ({ lyrics: '[verse]\nrain on glass' }),
    createMoodBoard: async () => ({ id: 'board-1' }),
    generateSunoSong: async (_fields, opts) => {
      await opts.onSubmitted(['song-a']);
      return { songId: 'song-a', songIds: ['song-a'], filename: 'music-song-a.mp3' };
    },
    createTrack: async () => ({ id: 'track-1' }),
    attachAudio: async () => ({}),
    probeDuration: async () => 120,
    // The real updateProject would validate the track link against the track store.
    updateProject: async (id, patch) => (patch.trackId ? projects.getProject(id) : projects.updateProject(id, patch)),
    analyzeSong: async () => ({}),
    startProduction,
  });
});

const get = async (id) => (await request(app).get(`/api/music-video/${id}/autonomous`)).body.run;

describe('POST /api/music-video/autonomous', () => {
  it('validates at the door: a blank prompt, an unknown tool and an unknown field are 400s', async () => {
    for (const body of [{ prompt: '   ' }, { prompt: 'p', tools: ['image:nope'] }, { prompt: 'p', surprise: true }, {}]) {
      const res = await request(app).post('/api/music-video/autonomous').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('accepts a prompt, persists the run on the real project record and runs through to production', async () => {
    const res = await request(app).post('/api/music-video/autonomous').send({ prompt: 'a courier crosses a rainy city', tools: ['image:local'] });
    expect(res.status).toBe(202);
    const id = res.body.project.id;
    expect(res.body.project).toMatchObject({ mode: 'autonomous', automation: { tools: ['image:local'] } });

    await vi.waitFor(async () => expect((await get(id)).output.productionRunId).toBe('mvpr-1'));
    const run = await get(id);
    expect(run).toMatchObject({ status: 'running', stage: 'produce', interrupted: false });
    expect(Object.values(run.stages).map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'running']);
    const stored = await projects.getProject(id);
    expect(stored.autonomousRun.output).toMatchObject({ moodBoardId: 'board-1', trackId: 'track-1' });
    expect(stored.name).toBe('Neon Rain');
  });

  it('parks at a checkpoint and continues over HTTP, applying the director’s lyric edit', async () => {
    const res = await request(app).post('/api/music-video/autonomous').send({ prompt: 'p', checkpoints: ['lyrics'] });
    const id = res.body.project.id;
    await vi.waitFor(async () => expect((await get(id)).status).toBe('awaiting-approval'));
    expect(startProduction).not.toHaveBeenCalled();

    const bad = await request(app).post(`/api/music-video/${id}/autonomous/resume`).send({ lyrics: 5 });
    expect(bad.status).toBe(400);
    const ok = await request(app).post(`/api/music-video/${id}/autonomous/resume`).send({ lyrics: '[verse]\nedited' });
    expect(ok.status).toBe(200);
    await vi.waitFor(async () => expect((await get(id)).output.lyrics).toBe('[verse]\nedited'));
    await vi.waitFor(() => expect(startProduction).toHaveBeenCalled());
  });

  it('cancels a live run, and refuses to cancel or resume one that is finished or absent', async () => {
    const res = await request(app).post('/api/music-video/autonomous').send({ prompt: 'p', checkpoints: ['lyrics'] });
    const id = res.body.project.id;
    await vi.waitFor(async () => expect((await get(id)).status).toBe('awaiting-approval'));
    expect((await request(app).post(`/api/music-video/${id}/autonomous/cancel`)).body.run.status).toBe('canceled');
    expect((await request(app).post(`/api/music-video/${id}/autonomous/cancel`)).status).toBe(409);
    expect((await request(app).post(`/api/music-video/${id}/autonomous/resume`)).status).toBe(409);

    const plain = await projects.createProject({ name: 'Hand made' });
    expect((await request(app).get(`/api/music-video/${plain.id}/autonomous`)).status).toBe(404);
  });
});

describe('the run stays on this install', () => {
  it('is stripped from the peer-sync wire and not carried into a clone', async () => {
    const res = await request(app).post('/api/music-video/autonomous').send({ prompt: 'p', checkpoints: ['lyrics'] });
    const id = res.body.project.id;
    await vi.waitFor(async () => expect((await get(id)).status).toBe('awaiting-approval'));
    const stored = await projects.getProject(id);
    expect(stripMusicVideoLocalRenderPins(stored)).not.toHaveProperty('autonomousRun');
    const clone = await projects.cloneProject(id, {});
    expect(clone.autonomousRun ?? null).toBeNull();
  });
});
