import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { PERSONALITY_TRAIT_KEYS } from '../lib/modelPersonalityValidation.js';

// Real modelPersonality service (file-backed) over a temp data root; only the
// LLM runner, prompt builder and twin meta are doubled.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-model-personality-routes-') }));
afterAll(cleanupTempDataRoots);

const runner = vi.hoisted(() => ({
  resolveProviderAndModel: vi.fn(),
  runPromptThroughProvider: vi.fn(),
  assertProvider: (provider, { message } = {}) => {
    if (!provider) throw new Error(message || 'no provider');
  },
}));
vi.mock('../services/promptRunner.js', () => runner);
vi.mock('../services/promptService.js', () => ({ buildPrompt: vi.fn(async (stage) => `PROMPT:${stage}`) }));
vi.mock('../services/digital-twin-meta.js', () => ({ loadMeta: vi.fn(async () => ({})) }));

const { default: modelPersonalityRoutes } = await import('./model-personality.js');

const app = express();
app.use(express.json());
app.use('/api/model-personality', modelPersonalityRoutes);
app.use(errorMiddleware);

const api = (method, path, body) => request(app)[method](`/api/model-personality${path}`).send(body);

const traits = Object.fromEntries(PERSONALITY_TRAIT_KEYS.map((k) => [k, { score: 0.4, rationale: `r-${k}` }]));

describe('model-personality routes', () => {
  it('persists a run, reads it back through history, and deletes it', async () => {
    runner.resolveProviderAndModel.mockResolvedValue({ provider: { id: 'p1', type: 'api' }, selectedModel: 'm1' });
    runner.runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify({ traits, summary: 'dry' }), model: 'effective', provider: { id: 'p1' },
    });

    const run = await api('post', '/run', { providerId: 'p1', model: 'm1', includeAlignment: false });
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ providerId: 'p1', model: 'effective', summary: 'dry' });

    const history = await api('get', '/history?limit=5');
    expect(history.body.map((r) => r.runId)).toEqual([run.body.runId]);

    expect((await api('delete', `/history/${run.body.runId}`)).status).toBe(204);
    expect((await api('get', '/history')).body).toEqual([]);
    expect((await api('delete', `/history/${run.body.runId}`)).status).toBe(404);
  });

  it('rejects invalid run and history input without calling the runner', async () => {
    runner.runPromptThroughProvider.mockClear();
    const noProvider = await api('post', '/run', { model: 'm1' });
    expect(noProvider.status).toBe(400);
    expect(noProvider.body.code).toBe('VALIDATION_ERROR');
    expect((await api('post', '/run', { providerId: 'p1', includeAlignment: 'yes' })).status).toBe(400);
    expect((await api('get', '/history?limit=0')).status).toBe(400);
    expect(runner.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('persists settings patches, normalizing empty scorer sentinels to null', async () => {
    expect((await api('get', '/settings')).body).toMatchObject({ historyCap: 200, scorerProviderId: null });

    const patched = await api('put', '/settings', { historyCap: 50, scorerProviderId: '', scorerModel: '' });
    expect(patched.status).toBe(200);
    expect((await api('get', '/settings')).body).toMatchObject({ historyCap: 50, scorerProviderId: null, scorerModel: null });

    expect((await api('put', '/settings', { historyCap: 100000 })).status).toBe(400);
    expect((await api('get', '/settings')).body.historyCap).toBe(50);
  });
});
