vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})), updateSettingsWith: vi.fn() }));
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { PATHS } from '../lib/paths.js';
import { createModelComparisonRoutes } from './modelComparison.js';
import { importModelComparison } from '../services/modelComparison.js';

let dir;
let originalData;
let app;
let providerService;
let observation;
let seedCount;
beforeEach(async () => {
  originalData = PATHS.data;
  dir = await mkdtemp(join(tmpdir(), 'portos-comparison-test-'));
  PATHS.data = dir;
  const seed = JSON.parse(await readFile(join(PATHS.root, 'data.reference/model-comparison.json'), 'utf8'));
  observation = seed.observations[0];
  seedCount = seed.observations.length;
  providerService = {
    getAllProviders: vi.fn().mockResolvedValue({ providers: [{ id: 'example-api', name: 'Example API', type: 'api', endpoint: 'https://example.com/v1', apiKey: 'example-private-key', envVars: { PRIVATE: 'example-secret' }, enabled: true, models: ['example-model'] }, { id: 'disabled', enabled: false, models: ['hidden'] }] }),
    fetchProviderModelCatalog: vi.fn().mockResolvedValue({ models: ['new-example-model'], contextWindows: {} }),
  };
  app = express();
  app.use(express.json());
  app.use('/comparison', createModelComparisonRoutes(providerService));
  app.use(errorMiddleware);
});
afterEach(async () => {
  PATHS.data = originalData;
  await rm(dir, { recursive: true, force: true });
});

it('loads seeded public evidence without discovery or exposing credentials, and discovers only on explicit action', async () => {
  const result = await request(app).get('/comparison');
  expect(result.status).toBe(200);
  expect(result.body.observations.length).toBeGreaterThan(0);
  expect(result.body.inventory).toEqual([{ id: 'example-api', name: 'Example API', type: 'api', canDiscover: true, models: [{ model: 'example-model', efforts: [], catalogModel: 'example-model' }] }]);
  expect(providerService.fetchProviderModelCatalog).not.toHaveBeenCalled();
  const discovery = await request(app).post('/comparison/discover').send({ providerId: 'example-api' });
  expect(discovery.status).toBe(200);
  expect(discovery.body.models).toEqual([{ model: 'new-example-model', efforts: [], catalogModel: 'new-example-model' }]);
  expect((await request(app).post('/comparison/discover').send({ providerId: 'disabled' })).status).toBe(400);
});

it('normalizes a local backend id onto its benchmarked model so the page can match it to an observation', async () => {
  providerService.getAllProviders.mockResolvedValue({
    providers: [{ id: 'ollama', name: 'Ollama', type: 'api', enabled: true, models: ['qwen3-coder:30b', 'ornith:35b', 'auto'] }],
  });
  const { body } = await request(app).get('/comparison');
  expect(body.inventory[0].models).toEqual([
    { model: 'qwen3-coder:30b', efforts: [], catalogModel: 'qwen3-coder-30b-a3b' },
    { model: 'ornith:35b', efforts: [], catalogModel: 'ornith-1.0-35b' },
    { model: 'auto', efforts: [], catalogModel: null },
  ]);
  expect(body.availableModels).toEqual(['ornith-1.0-35b', 'qwen3-coder-30b-a3b']);
});

it('imports sourced observations durably, retains unrelated and newer metrics, and serializes concurrent imports', async () => {
  const input = { schemaVersion: 1, observations: [{ ...observation, id: 'example-new', model: 'example-new-model' }] };
  expect((await request(app).post('/comparison/import').send(input)).status).toBe(200);
  const older = structuredClone(input);
  older.observations[0].quality.value = 1;
  older.observations[0].quality.source.retrievedAt = '2020-01-01T00:00:00Z';
  older.observations[0].costPerTask = null;
  await Promise.all([
    importModelComparison(older),
    importModelComparison({ schemaVersion: 1, observations: [{ ...observation, id: 'example-concurrent', model: 'example-other-model' }] }),
  ]);
  const stored = JSON.parse(await readFile(join(dir, 'model-comparison.json'), 'utf8'));
  expect(stored.observations).toHaveLength(seedCount + 2);
  expect(stored.observations.find(row => row.id === 'example-new')).toMatchObject({ quality: observation.quality, costPerTask: observation.costPerTask });
  const changedIdentity = { ...input.observations[0], effort: 'different' };
  await expect(importModelComparison({ schemaVersion: 1, observations: [changedIdentity] })).rejects.toThrow('identity changed');
});

it('rejects unsourced or malformed imports and refuses to overwrite an unreadable/future-version store', async () => {
  const malformed = { schemaVersion: 1, observations: [{ ...observation, quality: { value: 999 } }] };
  expect((await request(app).post('/comparison/import').send(malformed)).status).toBe(400);
  const unsafe = structuredClone(observation);
  unsafe.quality.source.url = 'javascript:alert(1)';
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [unsafe] })).status).toBe(400);
  unsafe.quality.source.url = 'not-a-url';
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [unsafe] })).status).toBe(400);
  const future = JSON.stringify({ schemaVersion: 99, observations: [observation] });
  await writeFile(join(dir, 'model-comparison.json'), future);
  await expect(importModelComparison({ schemaVersion: 1, observations: [observation] })).rejects.toThrow();
  expect(await readFile(join(dir, 'model-comparison.json'), 'utf8')).toBe(future);
});

it('imports an observation when reasoning pricing is its only known metric', async () => {
  const row = { ...observation, id: 'example-reasoning-only', reasoningPerMillion: observation.outputPerMillion };
  for (const key of ['quality', 'costPerTask', 'inputPerMillion', 'outputPerMillion', 'responseSeconds', 'tokensPerSecond', 'quota']) row[key] = null;
  const response = await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [row] });
  expect(response.status).toBe(200);
  const stored = (await request(app).get('/comparison')).body.observations.find(item => item.id === row.id);
  expect(stored).toEqual(row);
});

// The comparison page skips its key prompt on this flag, so presence has to be
// reported — and the key itself must never ride along with it.
it('reports Artificial Analysis key presence without exposing the key', async () => {
  const { getSettings } = await import('../services/settings.js');
  delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  expect((await request(app).get('/comparison')).body.artificialAnalysisKeyConfigured).toBe(false);

  getSettings.mockResolvedValueOnce({ secrets: { artificialAnalysis: { apiKey: 'mock-stored-key' } } });
  const configured = (await request(app).get('/comparison')).body;
  expect(configured.artificialAnalysisKeyConfigured).toBe(true);
  expect(JSON.stringify(configured)).not.toContain('mock-stored-key');
});

it('rejects sync-aa when no API key is provided and syncs successfully when mocked', async () => {
  delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  const noKey = await request(app).post('/comparison/sync-aa').send({});
  expect(noKey.status).toBe(400);

  const originalFetch = globalThis.fetch;
  let benchmarkVersion = '4.2';
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, opts) => {
    if (typeof url === 'string' && url.includes('artificialanalysis.ai')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          intelligence_index_version: benchmarkVersion,
          data: [{
            id: 'test-uuid-1',
            name: 'TestModel (high)',
            slug: 'test-model-high',
            model_creator: { name: 'TestProvider' },
            evaluations: { artificial_analysis_intelligence_index: 45.5 },
            artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.12 } },
            pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 5 },
            performance: { median_end_to_end_response_time_seconds: 12.3, median_output_tokens_per_second: 80 },
          }],
          pagination: { has_more: false },
        }),
      });
    }
    return originalFetch(url, opts);
  });

  try {
    const res = await request(app).post('/comparison/sync-aa').send({ apiKey: 'mock-key' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.observations).toBeGreaterThan(0);
    benchmarkVersion = '4.3';
    expect((await request(app).post('/comparison/sync-aa').send({ apiKey: 'mock-key' })).status).toBe(200);
    const stored = (await request(app).get('/comparison')).body.observations.filter(row => row.model === 'testmodel');
    expect(stored.map(row => row.benchmark).sort()).toEqual([
      'Artificial Analysis Intelligence Index v4.2', 'Artificial Analysis Intelligence Index v4.3',
    ]);
    expect(new Set(stored.map(row => row.id)).size).toBe(2);
  } finally {
    spy.mockRestore();
  }
});

it('scopes the chart inventory — and a fresh discovery — to the provider model-access policy', async () => {
  // The chart defaults its pills to "models your providers can dispatch", so a
  // provider scoped to a free tier must narrow the chart too. Otherwise the page
  // plots, and offers to research, models an unentitled account cannot run.
  providerService.getAllProviders.mockResolvedValue({ providers: [{
    id: 'nvidia-nim', name: 'NVIDIA NIM', type: 'api', enabled: true,
    models: ['meta/llama-3.3-70b-instruct', 'nvidia/nemotron-4-340b-instruct'],
    modelAccess: { mode: 'allow', patterns: ['meta/*'] },
  }] });
  providerService.fetchProviderModelCatalog.mockResolvedValue({
    models: ['meta/llama-3.1-8b-instruct', 'nvidia/nemotron-4-340b-instruct'], contextWindows: {},
  });

  const result = await request(app).get('/comparison');
  expect(result.body.inventory[0].models.map(m => m.model)).toEqual(['meta/llama-3.3-70b-instruct']);
  // The scoped inventory is what `availableModels` is read back off, so the
  // chart's default selection cannot reach past the policy either.
  expect(result.body.availableModels).not.toContain('nemotron-4-340b-instruct');

  // A freshly probed catalog is scoped the same way: the policy describes the
  // ACCOUNT, not just whatever happens to be on the stored record.
  const discovery = await request(app).post('/comparison/discover').send({ providerId: 'nvidia-nim' });
  expect(discovery.body.models.map(m => m.model)).toEqual(['meta/llama-3.1-8b-instruct']);
});

it('exposes the sync sources and syncs each keyless source without a key', async () => {
  const listed = (await request(app).get('/comparison')).body.syncSources;
  expect(listed).toEqual([
    { id: 'artificial-analysis', label: 'Artificial Analysis', requiresKey: true },
    { id: 'openrouter', label: 'OpenRouter routed pricing', requiresKey: false },
    { id: 'openrouter-endpoints', label: 'OpenRouter serving endpoints', requiresKey: false },
    { id: 'epoch-ai', label: 'Epoch AI benchmarks', requiresKey: false },
    { id: 'swebench', label: 'SWE-bench leaderboards', requiresKey: false },
    { id: 'livecodebench', label: 'LiveCodeBench', requiresKey: false },
  ]);
  expect((await request(app).post('/comparison/sync/unknown-source').send({})).status).toBe(404);

  const originalFetch = globalThis.fetch;
  const swebenchPage = {
    name: 'Verified',
    results: [{
      agent: 'mini-SWE-agent', agent_org: 'Example Org', date: '2026-02-13',
      folder: '20260213_mini-v2.0.0a0_example-model', instance_cost: 0.35,
      model_display: 'Example Model', model_org: 'Example Org', name: 'Example Model',
      reasoning_effort: null, resolved: 52.62, tags: [], warning: null,
    }],
  };
  const lcbData = {
    performances: [
      { question_id: '1_A', model: 'Example-Model', date: Date.parse('2024-01-01'), difficulty: 'easy', 'pass@1': 100.0 },
      { question_id: '2_A', model: 'Example-Model', date: Date.parse('2024-06-01'), difficulty: 'hard', 'pass@1': 50.0 },
    ],
    models: [{ model_name: 'example-model', model_repr: 'Example-Model', model_style: 'OpenAIChat', release_date: 1, link: 'https://example.com/model' }],
  };
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, opts) => {
    if (typeof url === 'string' && url.includes('swebench.com')) {
      return Promise.resolve({
        ok: true,
        text: async () => `<html><script type="application/json" id="leaderboard-data">${JSON.stringify([swebenchPage])}</script></html>`,
      });
    }
    if (typeof url === 'string' && url.includes('livecodebench.github.io')) {
      return Promise.resolve({ ok: true, json: async () => lcbData });
    }
    return originalFetch(url, opts);
  });

  try {
    const swe = await request(app).post('/comparison/sync/swebench').send({});
    expect(swe.status).toBe(200);
    expect(swe.body.success).toBe(true);
    expect(swe.body.observations).toBe(1);

    const lcb = await request(app).post('/comparison/sync/livecodebench').send({});
    expect(lcb.status).toBe(200);
    expect(lcb.body.success).toBe(true);
    expect(lcb.body.observations).toBe(1);

    const stored = (await request(app).get('/comparison')).body.observations;
    expect(stored.find(row => row.id.startsWith('swebench-'))).toMatchObject({
      benchmark: 'SWE-bench Verified (pass@1, mini-SWE-agent)', billing: 'api',
    });
    expect(stored.find(row => row.id.startsWith('lcb-generation-'))).toMatchObject({
      benchmark: 'LiveCodeBench (generation, pass@1, 2024-01-01 to 2024-06-01)', provider: 'OpenAI',
    });
  } finally {
    spy.mockRestore();
  }
});
