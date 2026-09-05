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
  expect(result.body.inventory).toEqual([{ id: 'example-api', name: 'Example API', type: 'api', canDiscover: true, models: [{ model: 'example-model', efforts: [] }] }]);
  expect(providerService.fetchProviderModelCatalog).not.toHaveBeenCalled();
  const discovery = await request(app).post('/comparison/discover').send({ providerId: 'example-api' });
  expect(discovery.status).toBe(200);
  expect(discovery.body.models).toEqual([{ model: 'new-example-model', efforts: [] }]);
  expect((await request(app).post('/comparison/discover').send({ providerId: 'disabled' })).status).toBe(400);
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
