import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const { codeAnimationRecords, codeAnimationHtml } = vi.hoisted(() => ({
  codeAnimationRecords: new Map(),
  codeAnimationHtml: new Map(),
}));

vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-code-animation-') }));
vi.mock('../services/codeAnimation/jobStore.js', () => ({
  getCodeAnimationJobRecord: vi.fn(async (id) => codeAnimationRecords.get(id) ?? null),
  isCodeAnimationJobId: (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
  listCodeAnimationJobRecords: vi.fn(async () => [...codeAnimationRecords.values()]),
  listRunningCodeAnimationJobIds: vi.fn(async () => [...codeAnimationRecords.values()].filter((job) => job.status === 'running').map((job) => job.id)),
  listCodeAnimationJobPage: vi.fn(async ({ limit, cursor }) => [...codeAnimationRecords.values()]
    .filter((job) => !cursor || job.createdAt < cursor.createdAt || (job.createdAt === cursor.createdAt && job.id < cursor.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, limit + 1).map(({ id, status, title, providerId, model, createdAt }) => ({ id, status, title, providerId, model, createdAt }))),
  countCodeAnimationJobs: vi.fn(async () => ({
    total: codeAnimationRecords.size,
    running: [...codeAnimationRecords.values()].filter((job) => job.status === 'running').length,
    completed: [...codeAnimationRecords.values()].filter((job) => job.status === 'completed').length,
  })),
  readCodeAnimationHtml: vi.fn(async (id) => codeAnimationHtml.get(id)),
  saveCodeAnimationHtml: vi.fn(async (id, html) => codeAnimationHtml.set(id, html)),
  saveCodeAnimationJobRecord: vi.fn(async (job) => codeAnimationRecords.set(job.id, job)),
}));
vi.mock('../services/universeBuilder/crud.js', () => ({ getUniverse: vi.fn() }));
vi.mock('../services/moodBoard/db.js', () => ({ getBoard: vi.fn() }));
vi.mock('../services/providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../services/tracks/index.js', () => ({ getTrack: vi.fn() }));
vi.mock('../services/promptRunner.js', () => ({
  runPromptThroughProvider: vi.fn(),
  resolveProviderAndModel: vi.fn(),
  assertProvider: vi.fn(),
}));

import { PATHS } from '../lib/paths.js';
import { getUniverse } from '../services/universeBuilder/crud.js';
import { getBoard } from '../services/moodBoard/db.js';
import { getProviderById } from '../services/providers.js';
import { getTrack } from '../services/tracks/index.js';
import { listCodeAnimationJobPage, listCodeAnimationJobRecords } from '../services/codeAnimation/jobStore.js';
import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from '../services/promptRunner.js';
import routes from './codeAnimation.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/code-animation', routes);
  app.use(errorMiddleware);
  return app;
};

const UNIVERSE = {
  id: 'universe-1',
  name: 'Example Universe',
  influences: { embrace: ['ink wash', 'muted indigo'], avoid: ['photorealism'] },
  styleNotes: 'quiet and melancholic',
  styleReferences: [{ id: 'ref-1', title: 'Night markets', prompt: 'paper lanterns', imageRefs: ['style-ref.png'] }],
  moodBoardId: 'board-1',
  logline: 'A drowned city keeps its lamps lit',
  premise: 'Lamplighters trade memory for oil',
  characters: [{ id: 'chr-1', name: 'Mira', role: 'lamplighter', physicalDescription: 'tall, oil-stained coat' }],
  places: [{ id: 'set-1', name: 'The Lower Market', description: 'flooded arcade of stalls' }],
  objects: [{ id: 'obj-1', name: 'The Brass Wick', significance: 'never gutters' }],
};
const BOARD = {
  id: 'board-1',
  name: 'Dusk',
  description: 'amber evenings',
  items: [
    { id: 'i1', type: 'image', mediaKey: 'image:pin.png', caption: 'harbor glow' },
    { id: 'i2', type: 'text', text: 'long shadows' },
    { id: 'i3', type: 'image', imageUrl: '/data/image-refs/sheet.png', caption: 'canon sheet' },
  ],
};
const brief = { concept: 'A lantern drifts over a sleeping city', universeId: 'universe-1' };

beforeAll(() => {
  mkdirSync(PATHS.uploads, { recursive: true });
  mkdirSync(PATHS.imageRefs, { recursive: true });
  mkdirSync(PATHS.images, { recursive: true });
  mkdirSync(PATHS.music, { recursive: true });
  writeFileSync(join(PATHS.uploads, 'abc12345-hero.png'), 'png');
  writeFileSync(join(PATHS.uploads, 'abc12345-theme.mp3'), 'mp3');
  writeFileSync(join(PATHS.imageRefs, 'style-ref.png'), 'png');
  writeFileSync(join(PATHS.images, 'pin.png'), 'png');
  writeFileSync(join(PATHS.imageRefs, 'sheet.png'), 'png');
  writeFileSync(join(PATHS.music, 'track-active.mp3'), 'mp3');
  writeFileSync(join(PATHS.music, 'wavesketch-active.wav'), 'wav');
});
afterAll(cleanupTempDataRoots);

beforeEach(() => {
  vi.clearAllMocks();
  codeAnimationRecords.clear();
  codeAnimationHtml.clear();
  getUniverse.mockResolvedValue(UNIVERSE);
  getBoard.mockResolvedValue(BOARD);
  resolveProviderAndModel.mockResolvedValue({ provider: { id: 'api-1', type: 'api' }, selectedModel: 'example-model' });
});

describe('GET /api/code-animation/jobs', () => {
  it('reconciles only stale running records before paging and counting', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    codeAnimationRecords.set(id, { id, status: 'running', title: 'Interrupted', concept: 'Private brief',
      createdAt: '2026-01-01T00:00:00.000Z' });
    const response = await request(makeApp()).get('/api/code-animation/jobs?limit=50');
    expect(response.status).toBe(200);
    expect(response.body.items).toMatchObject([{ id, status: 'failed' }]);
    expect(response.body.counts).toEqual({ running: 0, completed: 0 });
    expect(listCodeAnimationJobRecords).not.toHaveBeenCalled();
    expect((await request(makeApp()).get(`/api/code-animation/generate/${id}`)).body.error)
      .toMatch(/interrupted by a server restart/);
  });

  it('keeps the legacy array and pages a compact thousand-job archive with stable equal-time cursors', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    for (let n = 0; n < 1000; n += 1) {
      const id = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
      codeAnimationRecords.set(id, { id, status: 'completed', title: `Animation ${n}`, concept: 'x'.repeat(2000), createdAt });
    }
    const app = makeApp();
    const legacy = await request(app).get('/api/code-animation/jobs');
    expect(legacy.status).toBe(200);
    expect(legacy.body).toHaveLength(1000);
    expect(legacy.body[0].concept).toHaveLength(2000);

    const first = await request(app).get('/api/code-animation/jobs?limit=50');
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(50);
    expect(first.body.items[0]).not.toHaveProperty('concept');
    expect(first.body.counts).toEqual({ running: 0, completed: 1000 });
    expect(first.body.total).toBe(1000);
    expect(JSON.stringify(first.body).length).toBeLessThan(JSON.stringify(legacy.body).length / 10);
    expect(first.body.nextCursor).toBeTruthy();
    expect(JSON.parse(Buffer.from(first.body.nextCursor, 'base64url').toString('utf8'))).toEqual([createdAt, first.body.items.at(-1).id]);
    const second = await request(app).get(`/api/code-animation/jobs?limit=50&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items).toHaveLength(50);
    expect(new Set([...first.body.items, ...second.body.items].map(({ id }) => id)).size).toBe(100);
    const capped = await request(app).get('/api/code-animation/jobs?limit=1000');
    expect(capped.body.items).toHaveLength(100);
    expect(listCodeAnimationJobPage).toHaveBeenLastCalledWith({ limit: 100, cursor: null });
    expect((await request(app).get('/api/code-animation/jobs?cursor=garbage')).status).toBe(400);
  });
});

describe('POST /api/code-animation/brief', () => {
  const briefResponse = (body) => ({ runId: 'run-b', text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`` });

  it('writes the brief from the universe bible and canon cast', async () => {
    runPromptThroughProvider.mockResolvedValue(briefResponse({
      title: 'The Brass Wick',
      concept: 'Mira climbs the flooded arcade as the lamps go out one by one.',
      cast: 'Mira — tall, oil-stained coat; lantern pole that dips when she is afraid.',
      onScreenText: '0:02 "One light remains"',
      styleNotes: 'colder blues at the climax',
    }));
    const res = await request(makeApp()).post('/api/code-animation/brief').send({
      universeId: 'universe-1',
      seedIdea: 'a chase that ends in silence',
    });
    expect(res.status).toBe(200);
    expect(res.body.brief).toEqual({
      title: 'The Brass Wick',
      concept: 'Mira climbs the flooded arcade as the lamps go out one by one.',
      cast: 'Mira — tall, oil-stained coat; lantern pole that dips when she is afraid.',
      onScreenText: '0:02 "One light remains"',
      styleNotes: 'colder blues at the climax',
    });
    const call = runPromptThroughProvider.mock.calls[0][0];
    expect(call.source).toBe('code-animation-brief');
    expect(call.cwd).toBe(PATHS.data);
    expect(call.prompt).toContain('a chase that ends in silence');
    expect(call.prompt).toContain('  - Mira [lamplighter]: tall, oil-stained coat');
    expect(call.prompt).toContain('Mood board: "Dusk"');
    // The brief is text — no reference images are attached or named.
    expect(call.screenshots).toBeUndefined();
    expect(call.prompt).not.toContain('Reference images');
  });

  it('502s a response that holds no brief', async () => {
    runPromptThroughProvider.mockResolvedValue({ text: 'I would rather not.' });
    const res = await request(makeApp()).post('/api/code-animation/brief').send({ universeId: 'universe-1' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('LLM_INVALID_JSON');
  });

  it('refuses a request with no universe and nothing written', async () => {
    const res = await request(makeApp()).post('/api/code-animation/brief').send({ seedIdea: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BRIEF_INPUT_REQUIRED');
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('surfaces a missing provider as a 400 instead of running', async () => {
    resolveProviderAndModel.mockResolvedValue({ provider: null, selectedModel: null });
    assertProvider.mockImplementation(() => { throw new ServerError('No AI provider available to write the brief', { status: 400, code: 'PROVIDER_UNAVAILABLE' }); });
    const res = await request(makeApp()).post('/api/code-animation/brief').send({ seedIdea: 'a lantern' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROVIDER_UNAVAILABLE');
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });
});

describe('POST /api/code-animation/prompt', () => {
  it('builds the art direction from the universe and its linked mood board', async () => {
    const res = await request(makeApp()).post('/api/code-animation/prompt').send({
      ...brief,
      referenceImages: [{ filename: 'abc12345-hero.png', label: 'hero.png', note: 'the silhouette' }],
      audio: { filename: 'abc12345-theme.mp3', label: 'theme.mp3', durationSeconds: 30, notes: '120 BPM' },
    });
    expect(res.status).toBe(200);
    expect(getBoard).toHaveBeenCalledWith('board-1');
    expect(res.body.moodBoardId).toBe('board-1');
    expect(res.body.prompt).toContain('The art style comes from the universe "Example Universe"');
    expect(res.body.prompt).toContain('ink wash, muted indigo');
    expect(res.body.prompt).toContain('note: long shadows');
    expect(res.body.prompt).toContain('"theme.mp3" (30.0s long)');
    expect(res.body.frame).toEqual({ width: 1920, height: 1080, fps: 30, durationSeconds: 20 });
    // Uploads first, then the universe's style image, then the board's pin —
    // and only served URLs reach the client.
    expect(res.body.attachments).toEqual([
      { label: 'hero.png', origin: 'upload', url: '/api/uploads/abc12345-hero.png' },
      { label: 'Night markets', origin: 'universe', url: '/data/image-refs/style-ref.png' },
      { label: 'harbor glow', origin: 'mood-board', url: '/data/images/pin.png' },
      { label: 'canon sheet', origin: 'mood-board', url: '/data/image-refs/sheet.png' },
    ]);
    expect(res.body.audioUrl).toBe('/api/uploads/abc12345-theme.mp3');
    // The coding prompt is art direction — the universe's bible and cast are
    // the brief writer's material and stay out of it.
    expect(res.body.prompt).not.toContain('Mira');
    expect(res.body.prompt).not.toContain('A drowned city keeps its lamps lit');
    expect(JSON.stringify(res.body)).not.toContain(PATHS.data);
  });

  it('rigs the brief\'s character bible into the coding prompt', async () => {
    const res = await request(makeApp()).post('/api/code-animation/prompt').send({
      ...brief,
      cast: 'Wick — a palm-sized paper lantern whose wire handle droops when sad.',
    });
    expect(res.status).toBe(200);
    expect(res.body.prompt).toContain('CHARACTERS — the design bible');
    expect(res.body.prompt).toContain('Wick — a palm-sized paper lantern whose wire handle droops when sad.');
  });

  it('skips the board when the user explicitly picks none', async () => {
    const res = await request(makeApp()).post('/api/code-animation/prompt').send({ ...brief, moodBoardId: '' });
    expect(res.status).toBe(200);
    expect(getBoard).not.toHaveBeenCalled();
    expect(res.body.moodBoardId).toBeNull();
    expect(res.body.prompt).not.toContain('Mood board:');
  });

  it('rejects a missing brief, a stray upload, and an unknown universe', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/code-animation/prompt').send({ concept: '' })).status).toBe(400);
    const stray = await request(app).post('/api/code-animation/prompt').send({ ...brief, referenceImages: [{ filename: 'missing.png' }] });
    expect(stray.status).toBe(400);
    expect(stray.body.code).toBe('REFERENCE_NOT_FOUND');
    const traversal = await request(app).post('/api/code-animation/prompt').send({ ...brief, audio: { filename: '../secret.mp3' } });
    expect(traversal.status).toBe(400);
    getUniverse.mockRejectedValueOnce(Object.assign(new Error('Universe not found'), { code: 'NOT_FOUND' }));
    expect((await request(app).post('/api/code-animation/prompt').send(brief)).status).toBe(404);
  });

  it('creates an animation with a music-library track and gets the resolved music URL and duration', async () => {
    getTrack.mockResolvedValueOnce({
      id: 'track-1',
      title: 'Neon Drift',
      audioFilename: 'track-active.mp3',
      durationSec: 45,
      waveSketch: null,
    });
    const res = await request(makeApp()).post('/api/code-animation/prompt').send({
      ...brief,
      audio: { source: 'track', trackId: 'track-1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.audioUrl).toBe('/data/music/track-active.mp3');
    expect(res.body.prompt).toContain('"Neon Drift" (45.0s long)');
    expect(res.body.prompt).not.toContain('Drawn waveform timing cues');
  });

  it('appends timing cues when the track has a waveSketch, but not for a plain diffusion track', async () => {
    const sketch = {
      version: 1,
      title: 'Glass Tide',
      durationSec: 2,
      shapes: { glass: [0, 0.8, 1, 0.3, 0, -0.5, -1, -0.2] },
      voices: [{ name: 'lead', shape: 'glass', notes: [{ t: 0, d: 1, pitch: 'A4' }, { t: 1, d: 1, pitch: 'E5' }] }],
      contour: [0.1, 0.8, 0.4],
    };
    getTrack.mockResolvedValueOnce({
      id: 'track-wave',
      title: 'Glass Tide',
      audioFilename: 'wavesketch-active.wav',
      durationSec: 2,
      waveSketch: sketch,
    });
    const res = await request(makeApp()).post('/api/code-animation/prompt').send({
      ...brief,
      audio: { source: 'track', trackId: 'track-wave' },
    });
    expect(res.status).toBe(200);
    expect(res.body.audioUrl).toBe('/data/music/wavesketch-active.wav');
    expect(res.body.prompt).toContain('Drawn waveform timing cues:');
    expect(res.body.prompt).toContain('- Section/onset times:');
    expect(res.body.prompt).toContain('- Strongest onsets:');
    expect(res.body.prompt).toContain('- Loudness contour:');
  });

  it('returns 400 AUDIO_NOT_FOUND for unknown, deleted, or missing audio file track', async () => {
    const app = makeApp();
    getTrack.mockResolvedValueOnce(null);
    const unknown = await request(app).post('/api/code-animation/prompt').send({
      ...brief,
      audio: { source: 'track', trackId: 'track-missing' },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('AUDIO_NOT_FOUND');

    getTrack.mockResolvedValueOnce({ id: 'track-deleted', deletedAt: '2026-01-01T00:00:00Z', audioFilename: 'track-active.mp3' });
    const deleted = await request(app).post('/api/code-animation/prompt').send({
      ...brief,
      audio: { source: 'track', trackId: 'track-deleted' },
    });
    expect(deleted.status).toBe(400);
    expect(deleted.body.code).toBe('AUDIO_NOT_FOUND');

    getTrack.mockResolvedValueOnce({ id: 'track-no-file', audioFilename: 'ghost-file.mp3' });
    const missingFile = await request(app).post('/api/code-animation/prompt').send({
      ...brief,
      audio: { source: 'track', trackId: 'track-no-file' },
    });
    expect(missingFile.status).toBe(400);
    expect(missingFile.body.code).toBe('AUDIO_NOT_FOUND');
  });
});

describe('POST /api/code-animation/generate', () => {
  const pollUntilSettled = async (app, id) => {
    let job;
    await vi.waitFor(async () => {
      job = (await request(app).get(`/api/code-animation/generate/${id}`)).body;
      expect(job.status).not.toBe('running');
    });
    return job;
  };

  it('runs the prompt on an API provider with the references attached and returns the HTML', async () => {
    getProviderById.mockResolvedValue({ id: 'api-1', type: 'api', enabled: true });
    runPromptThroughProvider.mockResolvedValue({
      runId: 'run-1',
      text: 'Here:\n```html\n<!DOCTYPE html><html><body><canvas></canvas></body></html>\n```',
      provider: { id: 'api-1' },
      model: 'example-model',
    });
    const app = makeApp();
    const res = await request(app).post('/api/code-animation/generate').send({ ...brief, providerId: 'api-1' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('running');
    const job = await pollUntilSettled(app, res.body.id);
    expect(job).toMatchObject({ status: 'completed', providerId: 'api-1', model: 'example-model', runId: 'run-1' });
    expect(job.html).toBe('<!DOCTYPE html><html><body><canvas></canvas></body></html>');
    const call = runPromptThroughProvider.mock.calls[0][0];
    expect(call.source).toBe('code-animation-generation');
    expect(call.cwd).toBe(PATHS.data);
    expect(call.screenshots).toEqual([join(PATHS.imageRefs, 'style-ref.png'), join(PATHS.images, 'pin.png'), join(PATHS.imageRefs, 'sheet.png')]);
    expect(call.prompt).toContain('attached to this request');
  });

  it('fails the job when the response holds no HTML document', async () => {
    getProviderById.mockResolvedValue({ id: 'cli-1', type: 'cli', enabled: true });
    runPromptThroughProvider.mockResolvedValue({ text: 'I wrote the file to disk.', provider: { id: 'cli-1' } });
    const app = makeApp();
    const res = await request(app).post('/api/code-animation/generate').send({ ...brief, providerId: 'cli-1' });
    const call = runPromptThroughProvider.mock.calls[0][0];
    expect(call.screenshots).toEqual([]);
    // The agent reads references from disk; the client gets the copy form.
    expect(call.prompt).toContain(join(PATHS.images, 'pin.png'));
    expect(res.body.prompt).not.toContain(PATHS.data);
    const job = await pollUntilSettled(app, res.body.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/did not contain an HTML document/);
  });

  it('refuses a disabled provider before starting a job', async () => {
    getProviderById.mockResolvedValue({ id: 'api-1', type: 'api', enabled: false });
    const res = await request(makeApp()).post('/api/code-animation/generate').send({ ...brief, providerId: 'api-1' });
    expect(res.status).toBe(400);
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('404s an unknown job', async () => {
    expect((await request(makeApp()).get('/api/code-animation/generate/nope')).status).toBe(404);
  });
});
