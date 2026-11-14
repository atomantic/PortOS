/** HTTP workflows through the real film engine; only storage and native processes are doubled. */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
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
vi.mock('../services/musicVideo/catalogLinks.js', () => ({ queueProjectCatalogLinkSync: vi.fn() }));
vi.mock('../services/musicVideo/shotSegments.js', () => ({ removeProjectSegments: vi.fn(async () => {}) }));
vi.mock('../services/sharing/recordEvents.js', () => ({ emitRecordUpdated: vi.fn(), emitRecordDeleted: vi.fn(), autoSubscribeRecordToAllPeers: vi.fn(async () => {}) }));
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
import musicVideoBlenderRoutes from './musicVideoBlender.js';
import { getTrack } from '../services/tracks/index.js';
import { mutateFilmProject } from '../services/codeAnimation/projectStore.js';
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { listBlenderJobs, __resetBlenderJobsForTests } from '../services/film/jobs.js';
import { runPromptThroughProvider } from '../services/promptRunner.js';
import { analyzeAudioFile } from '../services/musicVideo/audioAnalysis.js';
import { BLENDER_NEEDS_TRUSTED_LOCAL } from '../services/film/state.js';

const appFor = (address = '127.0.0.1') => {
  const app = express();
  app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: address }); next(); });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/code-animation/films', routes);
  app.use('/api/music-video', musicVideoBlenderRoutes); app.use(errorMiddleware);
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
  __resetBlenderJobsForTests(); vi.clearAllMocks();
  // The real Music Video file store captures its root at import time. Keep that
  // root stable across cases so later writes cannot recreate a removed old root.
  for (const entry of readdirSync(ROOT())) rmSync(join(ROOT(), entry), { recursive: true, force: true });
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


it('refreshes silent song context with timeline edits and refuses an unwritable context without saving', async () => {
  await create(); await scaffoldAndSync();
  const songPath = join(ROOT(), 'code-animation', 'films', id, 'song.json');
  const changed = await request(app).patch(base()).send({ timeline: { durationSec: 12, fps: 30 } });
  expect(changed.status).toBe(200);
  expect(JSON.parse(readFileSync(songPath))).toMatchObject({ durationSec: 12, fps: 30, audio: { master: null } });
  const original = structuredClone(state.projects.get(id));
  unlinkSync(songPath); symlinkSync(join(ROOT(), 'elsewhere.json'), songPath);
  const refused = await request(app).patch(base()).send({ timeline: { durationSec: 15, fps: 24 } });
  expect(refused.status).toBe(400);
  expect(state.projects.get(id)).toEqual(original);
});

// Catches cross-store promotion reusing source timing/output or sharing mutable source files.
it('promotes twice with independent sources/options, unsynced song timing and no new work, while the source still renders', async () => {
  await create(); await scaffoldAndSync();
  mkdirSync(join(ROOT(), 'music'), { recursive: true }); writeFileSync(join(ROOT(), 'music', 'example.wav'), 'audio');
  getTrack.mockResolvedValue({ id: 'track', audioFilename: 'example.wav', durationSec: 9 });
  const sourceDir = join(ROOT(), 'code-animation', 'films', id);
  mkdirSync(join(sourceDir, 'renders', 'cuts'), { recursive: true });
  writeFileSync(join(sourceDir, 'renders', 'cuts', 'preview-source.mp4'), 'source output');
  const manifestPath = join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.options = [{ key: 'color', type: 'text', default: 'blue', label: 'Color' }];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expect((await request(app).put(api('/settings')).send({ options: { color: 'red' } })).status).toBe(200);
  expect((await request(app).put(api('/shots/s010/note')).send({ text: 'Source note' })).status).toBe(200);
  const original = structuredClone(state.projects.get(id));
  const songBefore = readFileSync(join(sourceDir, 'song.json'), 'utf8');
  const jobsBefore = [...state.blender.control.jobs];
  const first = await post(`${base()}/promote`, { trackId: 'track', name: 'Song version' });
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body).toMatchObject({ needsAnalysis: true, needsSync: true, coverageDurationSec: 9,
    project: { name: 'Song version', trackId: 'track', composition: { mode: 'blender' }, audioAnalysis: null, scenes: [],
      sourceFilm: { kind: 'code-animation', projectId: id }, blender: { syncedAt: null, notes: {}, sceneMap: {}, settings: { options: { color: 'red' } } } } });
  expect(first.body.coverageProblems.join(' ')).toContain('after 6 s');
  const second = await post(`${base()}/promote`, { uploadedAudioFilename: 'example.wav' });
  expect(second.status, JSON.stringify(second.body)).toBe(201);
  expect(second.body.project.id).not.toBe(first.body.project.id);
  expect(second.body.project).toMatchObject({ name: original.title, uploadedAudioFilename: 'example.wav', audioAnalysis: null });
  expect(second.body.coverageProblems.join(' ')).toContain('Analyze the song');
  const targetDir = join(ROOT(), 'music-video', first.body.project.id, 'blender');
  const secondDir = join(ROOT(), 'music-video', second.body.project.id, 'blender');
  expect(existsSync(join(targetDir, 'renders'))).toBe(false);
  expect(readFileSync(join(targetDir, 'src', 'film.py'), 'utf8')).toBe(readFileSync(join(sourceDir, 'src', 'film.py'), 'utf8'));
  expect(JSON.parse(readFileSync(join(targetDir, 'manifest.json')))).toEqual({ ...manifest, syncedAt: null });
  expect(JSON.parse(readFileSync(join(targetDir, 'song.json')))).toMatchObject({ projectId: first.body.project.id, durationSec: 0 });
  const targetApi = `/api/music-video/${first.body.project.id}/blender`;
  const targetState = (await request(app).get(targetApi)).body;
  expect(targetState).toMatchObject({ manifest: { syncedAt: null }, jobs: [], cuts: [], renders: {}, notes: {} });
  expect(targetState.manifest.problems.join(' ')).toContain('has not been synced');
  expect((await post(`${targetApi}/render`, { quality: 'still' })).body.code).toBe('MUSIC_VIDEO_BLENDER_NOT_SYNCED');
  expect(state.blender.control.jobs).toEqual(jobsBefore);
  expect(analyzeAudioFile).not.toHaveBeenCalled(); expect(runPromptThroughProvider).not.toHaveBeenCalled();
  writeFileSync(join(targetDir, 'src', 'film.py'), 'import bpy\n# target edit\n');
  expect(readFileSync(join(secondDir, 'src', 'film.py'), 'utf8')).not.toBe('import bpy\n# target edit\n');
  expect(state.projects.get(id)).toEqual({ ...original, promotedTo: second.body.project.id });
  expect(readFileSync(join(sourceDir, 'song.json'), 'utf8')).toBe(songBefore);
  expect(JSON.parse(readFileSync(manifestPath))).toEqual(manifest);
  // After analysis the normal sync replaces the copied inventory and maps the new Board.
  const { setProjectAnalysis } = await import('../services/musicVideo/projects.js');
  await setProjectAnalysis(first.body.project.id, { durationSec: 6, bpm: 120, beats: [], downbeats: [], sections: [] });
  const synced = await post(`${targetApi}/sync`);
  expect(synced.status).toBe(202);
  await vi.waitFor(() => expect(listBlenderJobs({ kind: 'music-video', id: first.body.project.id }).find(job => job.id === synced.body.job.id)?.status).toBe('done'));
  const current = (await request(app).get(targetApi)).body;
  expect(current.manifest.syncedAt).toBeTruthy();
  expect(current.manifest.shots.every(shot => shot.sceneId)).toBe(true);
  const rendered = await post(api('/render'), { quality: 'still', shotIds: ['s010'] });
  expect(rendered.status).toBe(202); await settled(rendered.body.jobs);
});

it('removes an incomplete promotion when source lineage cannot be saved', async () => {
  await create(); await scaffoldAndSync();
  mkdirSync(join(ROOT(), 'music'), { recursive: true }); writeFileSync(join(ROOT(), 'music', 'example.wav'), 'audio');
  const original = structuredClone(state.projects.get(id));
  mutateFilmProject.mockRejectedValueOnce(new Error('Synthetic lineage write failure'));
  const response = await post(`${base()}/promote`, { uploadedAudioFilename: 'example.wav' });
  expect(response.status).toBe(500);
  const { listProjects } = await import('../services/musicVideo/projects.js');
  expect(await listProjects()).toEqual([]);
  const targets = readdirSync(join(ROOT(), 'music-video'));
  expect(targets.every(target => !existsSync(join(ROOT(), 'music-video', target, 'blender')))).toBe(true);
  expect(state.projects.get(id)).toEqual(original);
});

it('refuses invalid, missing-audio and unauthorized promotions without changing the source', async () => {
  await create(); await scaffoldAndSync();
  const original = structuredClone(state.projects.get(id));
  for (const input of [{}, { trackId: 'track', uploadedAudioFilename: 'example.wav' }, { uploadedAudioFilename: '../example.wav' }]) {
    expect((await post(`${base()}/promote`, input)).status).toBe(400);
  }
  expect((await post(`${base()}/promote`, { trackId: 'track' })).body.code).toBe('AUDIO_MISSING');
  getTrack.mockResolvedValueOnce(null);
  expect((await post(`${base()}/promote`, { trackId: 'missing' })).status).toBe(404);
  const remote = await request(appFor('192.0.2.10')).post(`${base()}/promote`).send({ trackId: 'track' });
  expect([remote.status, remote.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
  expect(state.projects.get(id)).toEqual(original);
});
