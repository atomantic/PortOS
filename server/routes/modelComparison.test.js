vi.mock('../services/portosModelBenchmarks.js', () => ({
  modelComparisonBilling: provider => provider.id === 'ollama' ? 'local' : 'free',
  runPortosModelBenchmark: vi.fn(),
}));
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
import { runPortosModelBenchmark } from '../services/portosModelBenchmarks.js';

let dir;
let originalData;
let app;
let providerService;
let observation;
let seedCount;

beforeEach(async () => {
  vi.clearAllMocks();
  originalData = PATHS.data;
  dir = await mkdtemp(join(tmpdir(), 'portos-comparison-test-'));
  PATHS.data = dir;
  const seed = JSON.parse(await readFile(join(PATHS.root, 'data.reference/model-comparison.json'), 'utf8'));
  observation = seed.observations[0];
  seedCount = seed.observations.length;
  providerService = {
    getAllProviders: vi.fn().mockResolvedValue({ providers: [
      { id: 'opencode-zen', name: 'OpenCode Zen', type: 'api', endpoint: 'https://opencode.ai/zen/v1', apiKey: 'example-private-key', envVars: { PRIVATE: 'example-secret' }, enabled: true, models: ['opencode/example-model'] },
      { id: 'disabled', enabled: false, models: ['hidden'] },
    ] }),
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

it('returns local reference data and a credential-free inventory, then discovers models only on request', async () => {
  const result = await request(app).get('/comparison');
  expect(result.status).toBe(200);
  expect(result.body.observations.length).toBeGreaterThan(0);
  expect(result.body.observations.every(row => !/^(?:Artificial Analysis Intelligence Index|SWE-bench\b)/i.test(row.benchmark))).toBe(true);
  expect(result.body.inventory).toEqual([{
    id: 'opencode-zen', name: 'OpenCode Zen', type: 'api', billing: 'free', canBenchmark: true,
    benchmarkUnavailableReason: null, canDiscover: true,
    models: [{ model: 'opencode/example-model', efforts: [] }],
  }]);
  expect(JSON.stringify(result.body)).not.toContain('example-private-key');
  expect(JSON.stringify(result.body)).not.toContain('example-secret');
  expect(result.body.syncSources.map(source => source.id)).not.toContain('artificial-analysis');
  expect(result.body.syncSources.map(source => source.id)).not.toContain('swebench');
  expect(providerService.fetchProviderModelCatalog).not.toHaveBeenCalled();

  const discovery = await request(app).post('/comparison/discover').send({ providerId: 'opencode-zen' });
  expect(discovery.status).toBe(200);
  expect(discovery.body.models).toEqual([{ model: 'new-example-model', efforts: [] }]);
  expect((await request(app).post('/comparison/discover').send({ providerId: 'disabled' })).status).toBe(400);
  expect((await request(app).post('/comparison/sync/artificial-analysis').send({})).status).toBe(404);
  expect((await request(app).post('/comparison/sync/swebench').send({})).status).toBe(404);
});

it('identifies local models for token-based comparisons without treating them as hosted equivalents', async () => {
  providerService.getAllProviders.mockResolvedValue({
    providers: [{ id: 'ollama', name: 'Ollama', type: 'api', enabled: true, models: ['qwen3-coder:30b', 'ornith:35b', 'auto'] }],
  });
  const { body } = await request(app).get('/comparison');
  expect(body.inventory[0].billing).toBe('local');
  expect(body.inventory[0].models).toEqual([
    { model: 'qwen3-coder:30b', efforts: [] },
    { model: 'ornith:35b', efforts: [] },
    { model: 'auto', efforts: [] },
  ]);
});

it('runs only the explicitly selected model available to that provider', async () => {
  runPortosModelBenchmark.mockResolvedValue({ observation, complete: true });
  const accepted = await request(app).post('/comparison/run').send({ providerId: 'opencode-zen', model: 'opencode/example-model' });
  expect(accepted.status).toBe(200);
  expect(accepted.body.observation).toEqual(observation);
  expect(runPortosModelBenchmark).toHaveBeenCalledWith(
    expect.objectContaining({ provider: expect.objectContaining({ id: 'opencode-zen' }), model: 'opencode/example-model', effort: null, signal: expect.any(AbortSignal) }),
  );

  expect((await request(app).post('/comparison/run').send({ providerId: 'opencode-zen', model: 'not-configured' })).status).toBe(400);
  expect((await request(app).post('/comparison/run').send({ providerId: 'disabled', model: 'hidden' })).status).toBe(400);
  expect(runPortosModelBenchmark).toHaveBeenCalledTimes(1);
});

it('imports sourced observations durably, retains newer metrics, and serializes concurrent imports', async () => {
  const input = { schemaVersion: 1, observations: [{ ...observation, id: 'example-new', model: 'example-new-model' }] };
  expect((await request(app).post('/comparison/import').send(input)).status).toBe(200);
  const older = structuredClone(input);
  const metricKey = ['quality', 'inputPerMillion', 'outputPerMillion'].find(key => older.observations[0][key]);
  older.observations[0][metricKey].value = 1;
  older.observations[0][metricKey].source.retrievedAt = '2020-01-01T00:00:00Z';
  older.observations[0].costPerTask = null;
  await Promise.all([
    importModelComparison(older),
    importModelComparison({ schemaVersion: 1, observations: [{ ...observation, id: 'example-concurrent', model: 'example-other-model' }] }),
  ]);
  const stored = JSON.parse(await readFile(join(dir, 'model-comparison.json'), 'utf8'));
  expect(stored.observations).toHaveLength(seedCount + 2);
  expect(stored.observations.find(row => row.id === 'example-new')[metricKey]).toEqual(observation[metricKey]);
  const changedIdentity = { ...input.observations[0], effort: 'different' };
  await expect(importModelComparison({ schemaVersion: 1, observations: [changedIdentity] })).rejects.toThrow('identity changed');
});

it('rejects retired public scores and malformed or unsafe source URLs', async () => {
  for (const [id, benchmark] of [
    ['aa-v4.3.2-example-model', 'Artificial Analysis Intelligence Index v4.3.2'],
    ['swebench-example-model', 'SWE-bench Verified (pass@1, example harness)'],
  ]) {
    const retired = {
      ...observation,
      id,
      benchmark,
      quality: { value: 50, source: observation.inputPerMillion?.source || observation.outputPerMillion.source },
    };
    expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [retired] })).status).toBe(410);
  }

  const forgedRun = {
    ...observation,
    id: 'portos:00000000-0000-4000-8000-000000000001',
    benchmark: 'PortOS Task Bench v1 (deterministic)',
    quality: { value: 100, source: observation.inputPerMillion.source },
  };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [forgedRun] })).status).toBe(400);

  const malformed = { ...observation, quality: { value: 999 } };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [malformed] })).status).toBe(400);
  const unsafe = structuredClone(observation);
  const metricKey = ['quality', 'inputPerMillion', 'outputPerMillion'].find(key => unsafe[key]);
  unsafe[metricKey].source.url = 'javascript:alert(1)';
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [unsafe] })).status).toBe(400);
  unsafe[metricKey].source.url = 'https://';
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [unsafe] })).status).toBe(400);

  const future = JSON.stringify({ schemaVersion: 99, observations: [observation] });
  await writeFile(join(dir, 'model-comparison.json'), future);
  await expect(importModelComparison({ schemaVersion: 1, observations: [observation] })).rejects.toThrow();
  expect(await readFile(join(dir, 'model-comparison.json'), 'utf8')).toBe(future);
});
