/**
 * Fully-autonomous Music Video (one prompt → lyrics → Suno song → video),
 * through the real router and the real file-backed project store. Only the
 * stage providers (LLM, mood board, Suno, track store, analysis, production)
 * are doubles. Pins what no unit test above can: request validation at the
 * door, that the run checkpoint survives the real store's read/write path, the
 * checkpoint → approve round trip over HTTP, and that the run never leaves
 * this install (peer-sync wire and clone).
 *
 * The route answers 202 while the workflow keeps running in the background, so
 * every test settles it (`settle`) instead of polling on a wall clock, and
 * `afterEach` owns whatever a test left running: it cancels the live runs,
 * releases any held stage and settles before the shared doubles are cleared.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots, sweepStrayTempRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-autonomous-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
// Preparing a visual guide may call a provider. Keep that authoring boundary
// inert; persisted review readiness and the HTTP approval transitions are real.
vi.mock('../services/musicVideo/productionReviewService.js', async load => ({
  ...await load(), prepareProductionReview: vi.fn(async () => {}),
}));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: async () => true,
  verifyPassword: async password => password === 'synthetic-operator-password',
}));

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

const settle = () => service.__testing.settleBackground();
const projectIds = [];
let heldStage = null;
const holdStage = () => {
  heldStage = Promise.withResolvers();
  return heldStage;
};
const begin = async (body) => {
  const res = await request(app).post('/api/music-video/autonomous').send(body);
  if (res.status === 202) projectIds.push(res.body.project.id);
  return res;
};

beforeAll(() => sweepStrayTempRoots('mv-autonomous-route-test-'));
afterAll(() => cleanupTempDataRoots());
afterEach(async () => {
  heldStage?.resolve();
  heldStage = null;
  // A run still live (or a failed assertion's leftovers) is canceled so nothing keeps advancing into the next test.
  await Promise.allSettled(projectIds.splice(0).map((id) => service.cancelAutonomousVideo(id)));
  await settle();
});
beforeEach(() => {
  startProduction.mockClear();
  service.__setAutonomousDepsForTests({
    draftCreativeBrief: async () => ({ brief: BRIEF }),
    writeLyrics: async () => {
      await heldStage?.promise;
      return { lyrics: '[verse]\nrain on glass' };
    },
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

async function approveSyntheticStoryboard(id) {
  await projects.setProjectAnalysis(id, { durationSec: 20, bpm: 120, beats: [0, 1], downbeats: [0],
    sections: [{ startSec: 0, endSec: 20, label: 'Chorus' }] });
  await projects.updateProject(id, { lyricCues: [{ id: 'line', text: 'Rain on glass', startSec: 1, endSec: 4,
    words: [{ w: 'Rain', conf: 'matched', startSec: 1, endSec: 2 }, { w: 'on', conf: 'matched', startSec: 2, endSec: 3 }, { w: 'glass', conf: 'matched', startSec: 3, endSec: 4 }] }] });
  const scene = await projects.addProjectScene(id, { label: 'Chorus', startSec: 0, endSec: 20, prompt: 'Paper figure in the rain' });
  const { saveGeneratedDevArtifact } = await import('../services/musicVideo/devArtifactService.js');
  const { artifact } = await saveGeneratedDevArtifact(id, { kind: 'cast-sets', title: 'Synthetic visual guide', html: '<html><body>Paper figure, painted rain</body></html>' });
  const base = `/api/music-video/${id}/production-review`;
  const saved = await request(app).put(base).send({ cast: 'Paper figure', environments: 'Painted street',
    visualLanguage: 'Ink and cream', motionLanguage: 'Slow camera orbit', guideArtifactId: artifact.id,
    lyricsMode: 'vocal', timingStatus: 'verified', timingNotes: 'Synthetic fixture onsets checked.',
    storyboard: [{ sceneId: scene.sceneId, lyricCueIds: ['line'], action: 'Step into rain', staging: 'Wide street', camera: 'Orbit', transition: 'Fade' }],
  });
  expect(saved.status).toBe(200);
  for (const stage of ['art', 'storyboard']) {
    const current = await request(app).get(base);
    const approved = await request(app).post(`${base}/approve`).send({ stage,
      basis: current.body.readiness.basis[stage], password: 'synthetic-operator-password' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  }
}


describe('POST /api/music-video/autonomous', () => {
  it('validates at the door: a blank prompt, an unknown tool and an unknown field are 400s', async () => {
    for (const body of [{ prompt: '   ' }, { prompt: 'p', tools: ['image:nope'] }, { prompt: 'p', surprise: true }, {}]) {
      const res = await request(app).post('/api/music-video/autonomous').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('persists the review pause and only hands off production after current approvals over HTTP', async () => {
    const res = await begin({ prompt: 'a courier crosses a rainy city', tools: ['image:local'] });
    expect(res.status).toBe(202);
    const id = res.body.project.id;
    expect(res.body.project).toMatchObject({ mode: 'autonomous', automation: { tools: ['image:local'] } });

    await settle();
    const run = await get(id);
    expect(run.output.productionRunId).toBeUndefined();
    expect(startProduction).not.toHaveBeenCalled();
    expect(run).toMatchObject({ status: 'needs-human', stage: 'produce', errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED', interrupted: false });
    expect(Object.values(run.stages).map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'failed']);
    // Resume alone is not approval and cannot hand off production.
    expect((await request(app).post(`/api/music-video/${id}/autonomous/resume`).send({})).status).toBe(200);
    await settle();
    expect((await get(id)).status).toBe('needs-human');
    expect(startProduction).not.toHaveBeenCalled();
    await approveSyntheticStoryboard(id);
    expect((await request(app).post(`/api/music-video/${id}/autonomous/resume`).send({})).status).toBe(200);
    await settle();
    expect((await get(id))).toMatchObject({ status: 'running', stage: 'produce', output: { productionRunId: 'mvpr-1' } });
    expect(startProduction).toHaveBeenCalledOnce();
    const stored = await projects.getProject(id);
    expect(stored.autonomousRun.output).toMatchObject({ moodBoardId: 'board-1', trackId: 'track-1' });
    expect(stored.name).toBe('Neon Rain');
  });

  it('parks at a checkpoint and continues over HTTP, applying the director’s lyric edit', async () => {
    const res = await begin({ prompt: 'p', checkpoints: ['lyrics'] });
    const id = res.body.project.id;
    await settle();
    expect((await get(id)).status).toBe('awaiting-approval');
    expect(startProduction).not.toHaveBeenCalled();

    const bad = await request(app).post(`/api/music-video/${id}/autonomous/resume`).send({ lyrics: 5 });
    expect(bad.status).toBe(400);
    const ok = await request(app).post(`/api/music-video/${id}/autonomous/resume`).send({ lyrics: '[verse]\nedited' });
    expect(ok.status).toBe(200);
    await settle();
    expect((await get(id))).toMatchObject({ status: 'needs-human', errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED', output: { lyrics: '[verse]\nedited' } });
    expect(startProduction).not.toHaveBeenCalled();
  });

  it('stores the Suno form options, and retakes the song over HTTP only at the song checkpoint', async () => {
    expect((await request(app).post('/api/music-video/autonomous').send({ prompt: 'p', suno: { model: 'latest' } })).status).toBe(400);
    const res = await begin({ prompt: 'p', checkpoints: ['lyrics', 'song'], suno: { excludeStyles: 'metal', vocalGender: 'female' } });
    const id = res.body.project.id;
    await settle();
    expect(await get(id)).toMatchObject({ status: 'awaiting-approval', awaiting: 'lyrics', brief: { suno: { excludeStyles: 'metal', vocalGender: 'female', model: null } } });
    const resume = (body) => request(app).post(`/api/music-video/${id}/autonomous/resume`).send(body);
    const early = await resume({ retakeSong: true });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('NOT_AT_SONG_CHECKPOINT');
    expect((await get(id)).awaiting).toBe('lyrics');

    expect((await resume({ suno: { vocalGender: 'robot' } })).status).toBe(400);
    expect((await resume({ suno: { model: 'v6' } })).status).toBe(200);
    await settle();
    expect(await get(id)).toMatchObject({ status: 'awaiting-approval', awaiting: 'song', output: { sunoSongIds: ['song-a'] } });

    expect((await resume({ retakeSong: true, suno: { vocalGender: 'male' } })).status).toBe(200);
    await settle();
    expect(await get(id)).toMatchObject({
      status: 'awaiting-approval', awaiting: 'song', stages: { song: { status: 'done' } },
      brief: { suno: { excludeStyles: 'metal', vocalGender: 'male', model: 'v6' } },
    });
  });

  it('cancels a live run, and refuses to cancel or resume one that is finished or absent', async () => {
    const res = await begin({ prompt: 'p', checkpoints: ['lyrics'] });
    const id = res.body.project.id;
    await settle();
    expect((await get(id)).status).toBe('awaiting-approval');
    expect((await request(app).post(`/api/music-video/${id}/autonomous/cancel`)).body.run.status).toBe('canceled');
    expect((await request(app).post(`/api/music-video/${id}/autonomous/cancel`)).status).toBe(409);
    expect((await request(app).post(`/api/music-video/${id}/autonomous/resume`)).status).toBe(409);

    const plain = await projects.createProject({ name: 'Hand made' });
    expect((await request(app).get(`/api/music-video/${plain.id}/autonomous`)).status).toBe(404);
  });
});

describe('background workflow ownership', () => {
  it('a delayed stage is settled inside its own test, never into the next one', async () => {
    const held = holdStage();
    const res = await begin({ prompt: 'p' });
    const id = res.body.project.id;
    expect(res.status).toBe(202);

    let settled = false;
    const settling = settle().then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(startProduction).not.toHaveBeenCalled();

    held.resolve();
    await settling;
    expect(startProduction).not.toHaveBeenCalled();
    expect((await get(id))).toMatchObject({ status: 'needs-human', errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED' });
  });

  it('a canceled run releases its held stage before teardown', async () => {
    const held = holdStage();
    const res = await begin({ prompt: 'p' });
    const id = res.body.project.id;
    expect((await request(app).post(`/api/music-video/${id}/autonomous/cancel`)).body.run.status).toBe('canceled');

    held.resolve();
    await settle();
    expect((await get(id)).status).toBe('canceled');
    expect(startProduction).not.toHaveBeenCalled();
  });
});

describe('the run stays on this install', () => {
  it('is stripped from the peer-sync wire and not carried into a clone', async () => {
    const res = await begin({ prompt: 'p', checkpoints: ['lyrics'] });
    const id = res.body.project.id;
    await settle();
    expect((await get(id)).status).toBe('awaiting-approval');
    const stored = await projects.getProject(id);
    expect(stripMusicVideoLocalRenderPins(stored)).not.toHaveProperty('autonomousRun');
    const clone = await projects.cloneProject(id, {});
    expect(clone.autonomousRun ?? null).toBeNull();
  });
});
