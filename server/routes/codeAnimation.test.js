import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-code-animation-') }));
vi.mock('../services/universeBuilder/crud.js', () => ({ getUniverse: vi.fn() }));
vi.mock('../services/moodBoard/db.js', () => ({ getBoard: vi.fn() }));
vi.mock('../services/providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../services/promptRunner.js', () => ({
  runPromptThroughProvider: vi.fn(),
  resolveProviderAndModel: vi.fn(),
  assertProvider: vi.fn(),
}));

import { PATHS } from '../lib/paths.js';
import { getUniverse } from '../services/universeBuilder/crud.js';
import { getBoard } from '../services/moodBoard/db.js';
import { getProviderById } from '../services/providers.js';
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
  writeFileSync(join(PATHS.uploads, 'abc12345-hero.png'), 'png');
  writeFileSync(join(PATHS.uploads, 'abc12345-theme.mp3'), 'mp3');
  writeFileSync(join(PATHS.imageRefs, 'style-ref.png'), 'png');
  writeFileSync(join(PATHS.images, 'pin.png'), 'png');
  writeFileSync(join(PATHS.imageRefs, 'sheet.png'), 'png');
});
afterAll(cleanupTempDataRoots);

beforeEach(() => {
  vi.clearAllMocks();
  getUniverse.mockResolvedValue(UNIVERSE);
  getBoard.mockResolvedValue(BOARD);
  resolveProviderAndModel.mockResolvedValue({ provider: { id: 'api-1', type: 'api' }, selectedModel: 'example-model' });
});

describe('POST /api/code-animation/brief', () => {
  const briefResponse = (body) => ({ runId: 'run-b', text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`` });

  it('writes the brief from the universe bible and canon cast', async () => {
    runPromptThroughProvider.mockResolvedValue(briefResponse({
      title: 'The Brass Wick',
      concept: 'Mira climbs the flooded arcade as the lamps go out one by one.',
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
      onScreenText: '0:02 "One light remains"',
      styleNotes: 'colder blues at the climax',
    });
    expect(res.body.moodBoardId).toBe('board-1');
    expect(res.body.llm).toEqual({ provider: 'api-1', model: 'example-model', runId: 'run-b' });
    const call = runPromptThroughProvider.mock.calls[0][0];
    expect(call.source).toBe('code-animation-brief');
    expect(call.cwd).toBe(PATHS.data);
    expect(call.prompt).toContain('a chase that ends in silence');
    expect(call.prompt).toContain('- Mira — role: lamplighter');
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
