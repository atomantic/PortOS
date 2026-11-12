/** HTTP workflows through the real film engine; only storage and native processes are doubled. */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import { createFakeBlender, exampleManifest } from '../services/musicVideo/blender/__blenderFixture.js';

function ROOT() { return lazyTempDataRoot('code-film-route-'); }
const state = vi.hoisted(() => ({ projects: new Map(), history: [], blender: null, ffmpeg: [], beforeFfmpeg: null }));
vi.mock('../lib/paths.js', async load => makePathsProxy(await load(), { dataRoot: ROOT }));
vi.mock('../services/codeAnimation/projectStore.js', () => ({
  getProjectRecord: vi.fn(async id => structuredClone(state.projects.get(id) || null)),
  createProjectRecord: vi.fn(async (id, data) => { const project = { id, ...data }; state.projects.set(id, project); return structuredClone(project); }),
  mutateFilmProject: vi.fn(async (id, change) => {
    const current = state.projects.get(id);
    if (!current || current.kind !== 'film') throw Object.assign(new Error('Film not found'), { status: 404 });
    const project = { ...current, ...await change(structuredClone(current)) };
    state.projects.set(id, project); return structuredClone(project);
  }),
}));
vi.mock('../services/socket.js', () => ({ emitCodeAnimationChanged: vi.fn(), emitCodeAnimationFilm: vi.fn() }));
vi.mock('../services/videoGen/history.js', () => ({ mutateVideoHistory: vi.fn(async change => { state.history = change(state.history); }) }));
vi.mock('../services/codeAnimation/execution.js', () => ({
  getCodeAnimationExecution: (...args) => state.blender.getCodeAnimationExecution(...args),
  resolveBlenderTool: (...args) => state.blender.resolveBlenderTool(...args),
}));
vi.mock('../lib/ffmpeg.js', async load => ({
  ...await load(), findFfmpeg: vi.fn(async () => '/opt/example/ffmpeg'), bt709TagFilter: vi.fn(async () => null),
  runFfmpegProcess: vi.fn(async ({ args }) => { state.ffmpeg.push(args); await state.beforeFfmpeg?.(); writeFileSync(args.at(-1), 'video'); return { ok: true }; }),
  generateThumbnail: vi.fn(async (_path, id) => `${id}.jpg`),
}));
vi.mock('../services/musicVideo/audioAnalysis.js', () => ({ analyzeAudioFile: vi.fn(async () => ({
  durationSec: 6.01, bpm: 120, beats: [0, 0.5, 1], downbeats: [0], sections: [],
  features: { envelopes: { fps: 10, rms: [0.1, 0.8], low: [0.2], mid: [0.3], high: [0.4] } },
})) }));
vi.mock('../services/tracks/index.js', () => ({ getTrack: vi.fn(async () => ({ id: 'track', audioFilename: 'example.wav' })) }));
vi.mock('../services/promptRunner.js', () => ({ runPromptThroughProvider: vi.fn(() => { throw new Error('No provider is allowed'); }) }));
vi.mock('../services/auth.js', async load => ({ ...await load(), isAuthEnabled: vi.fn(async () => false), verifyRequestSession: vi.fn(async () => false) }));

import routes from './codeAnimationFilms.js';
import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { listBlenderJobs, __resetBlenderJobsForTests } from '../services/film/jobs.js';
import { runPromptThroughProvider } from '../services/promptRunner.js';
import { analyzeAudioFile } from '../services/musicVideo/audioAnalysis.js';
import { BLENDER_NEEDS_TRUSTED_LOCAL } from '../services/film/state.js';

const appFor = (address = '127.0.0.1') => {
  const app = express();
  app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: address }); next(); });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/code-animation/films', routes); app.use(errorMiddleware);
  return app;
};
const app = appFor();
let id;
const base = () => `/api/code-animation/films/${id}`;
const api = suffix => `${base()}/blender${suffix || ''}`;
const post = (path, body = {}) => request(app).post(path).send(body);
const owner = () => ({ kind: 'code-animation', id });
const settled = jobs => vi.waitFor(() => {
  const ended = listBlenderJobs(owner()).filter(job => jobs.some(expected => expected.id === job.id));
  expect(ended.map(job => [job.status, job.error ?? null])).toEqual(jobs.map(() => ['done', null]));
}, { timeout: 20000, interval: 20 });

beforeEach(() => {
  cleanupTempDataRoots(); __resetBlenderJobsForTests(); vi.clearAllMocks();
  state.projects.clear(); state.history = []; state.ffmpeg = []; state.beforeFfmpeg = null;
  state.blender = createFakeBlender(); state.blender.control.manifest = exampleManifest();
});
afterAll(() => { __resetBlenderJobsForTests(); cleanupTempDataRoots(); });
async function create() {
  const result = await post('/api/code-animation/films', { title: 'Silent film', timeline: { durationSec: 6, fps: 24 } });
  expect(result.status).toBe(201); id = result.body.id;
  return result.body;
}
async function scaffoldAndSync() {
  expect((await post(api('/workspace'), { template: 'starter' })).status).toBe(201);
  for (const shot of state.blender.control.manifest.shots) {
    expect((await request(app).put(api('/file')).send({ path: `shots/${shot.id}.py`, content: '# authored shot' })).status).toBe(200);
  }
  const response = await post(api('/sync'));
  expect(response.status).toBe(202); await settled([response.body.job]);
}

it('creates without work, syncs a silent film, renders stills and cuts, and accepts complete finals in Media History', async () => {
  expect(await create()).toMatchObject({ kind: 'film', film: { timeline: { durationSec: 6 }, audio: { filename: null } } });
  expect(listBlenderJobs(owner())).toEqual([]); expect(state.blender.control.jobs).toEqual([]);
  expect(analyzeAudioFile).not.toHaveBeenCalled();
  expect((await request(app).get(api())).body.workspace.exists).toBe(false);
  await scaffoldAndSync();
  const song = JSON.parse(readFileSync(join(ROOT(), 'code-animation', 'films', id, 'song.json')));
  expect(song).toMatchObject({ durationSec: 6, audio: { master: null }, analysis: { beats: [] } });
  const still = await post(api('/render'), { quality: 'still', shotIds: ['s010'] }); await settled(still.body.jobs);
  const previews = await post(api('/render'), { quality: 'preview' }); await settled(previews.body.jobs);
  const cut = await post(api('/cut'), { quality: 'preview' }); await settled([cut.body.job]);
  expect(state.ffmpeg.at(-1)).toContain('-an');
  expect((await post(api('/cut'), { quality: 'final' })).status).toBe(409);
  const finals = await post(api('/render'), { quality: 'final' }); await settled(finals.body.jobs);
  const final = await post(api('/cut'), { quality: 'final' }); expect(final.status, JSON.stringify(final.body)).toBe(202); await settled([final.body.job]);
  const accepted = (await request(app).get(api())).body.acceptedOutput;
  expect(accepted).toMatchObject({ kind: 'film', format: { durationSeconds: 6, fps: 24 } });
  expect(state.history).toEqual([expect.objectContaining({ id: accepted.videoId, filename: accepted.filename })]);
  expect(existsSync(join(ROOT(), 'videos', accepted.filename))).toBe(true);
  expect(runPromptThroughProvider).not.toHaveBeenCalled();
});

it('explicitly analyzes attached library audio, requires its last frame, and joins a cut with sound', async () => {
  await create(); mkdirSync(join(ROOT(), 'music'), { recursive: true }); writeFileSync(join(ROOT(), 'music', 'example.wav'), 'audio');
  expect((await post(`${base()}/audio`, { source: 'track', trackId: 'track' })).status).toBe(200);
  expect(analyzeAudioFile).toHaveBeenCalledTimes(1);
  const song = JSON.parse(readFileSync(join(ROOT(), 'code-animation', 'films', id, 'song.json')));
  expect(song.analysis).toMatchObject({ beats: [0, 0.5, 1], features: { envelopes: { rms: [0.1, 0.8] } } });
  state.blender.control.manifest.shots.at(-1).end = 145 / 24;
  await scaffoldAndSync();
  expect((await request(app).get(api())).body.manifest.problems).toEqual([]);
  const cut = await post(api('/cut'), { quality: 'preview' }); await settled([cut.body.job]);
  expect(state.ffmpeg.at(-1)).toContain(join(ROOT(), 'music', 'example.wav'));
  expect(state.ffmpeg.at(-1)).not.toContain('-an');
  state.blender.control.manifest.shots.at(-1).end = 5;
  const sync = await post(api('/sync')); await settled([sync.body.job]);
  expect((await request(app).get(api())).body.manifest.problems.length).toBeGreaterThan(0);
  expect((await post(api('/cut'), { quality: 'final' })).status).toBe(409);
  expect(runPromptThroughProvider).not.toHaveBeenCalled();
});

it('preserves host-control refusal and the same contained-Blender explanation', async () => {
  await create();
  for (const [suffix, body] of [['/workspace', {}], ['/sync', {}], ['/render', { quality: 'still' }], ['/cut', { quality: 'preview' }]]) {
    const remote = await request(appFor('192.0.2.10')).post(api(suffix)).send(body);
    expect([remote.status, remote.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
  }
  expect(state.blender.control.jobs).toEqual([]);
  state.blender.control.executionMode = 'contained';
  for (const [suffix, body] of [['/sync', {}], ['/render', { quality: 'still' }]]) {
    const response = await post(api(suffix), body);
    expect(response.status).toBe(409); expect(response.body.error).toContain(BLENDER_NEEDS_TRUSTED_LOCAL);
  }
});


it('keeps the saved soundtrack unchanged when song context cannot be written', async () => {
  await create(); await scaffoldAndSync();
  const songPath = join(ROOT(), 'code-animation', 'films', id, 'song.json');
  const original = structuredClone(state.projects.get(id));
  unlinkSync(songPath); symlinkSync(join(ROOT(), 'elsewhere.json'), songPath);
  mkdirSync(join(ROOT(), 'music'), { recursive: true }); writeFileSync(join(ROOT(), 'music', 'example.wav'), 'audio');
  const response = await post(`${base()}/audio`, { source: 'track', trackId: 'track' });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(state.projects.get(id)).toEqual(original);
  expect(existsSync(join(ROOT(), 'elsewhere.json'))).toBe(false);
});

it('refuses to accept a final whose soundtrack changed during assembly', async () => {
  await create(); await scaffoldAndSync();
  const finals = await post(api('/render'), { quality: 'final' }); await settled(finals.body.jobs);
  const first = await post(api('/cut'), { quality: 'final' }); await settled([first.body.job]);
  const accepted = structuredClone(state.projects.get(id).acceptedOutput);
  mkdirSync(join(ROOT(), 'music'), { recursive: true }); writeFileSync(join(ROOT(), 'music', 'example.wav'), 'audio');
  state.beforeFfmpeg = async () => {
    state.beforeFfmpeg = null;
    expect((await post(`${base()}/audio`, { source: 'track', trackId: 'track' })).status).toBe(200);
  };
  const final = await post(api('/cut'), { quality: 'final' });
  expect(final.status).toBe(202);
  await vi.waitFor(() => expect(listBlenderJobs(owner()).find(job => job.id === final.body.job.id)?.status).toBe('error'));
  expect(state.projects.get(id).acceptedOutput).toEqual(accepted);
  expect(state.history).toHaveLength(1);
});
