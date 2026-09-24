import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
let seed;
let observation;

beforeEach(async () => {
  vi.clearAllMocks();
  originalData = PATHS.data;
  dir = await mkdtemp(join(tmpdir(), 'portos-comparison-test-'));
  PATHS.data = dir;
  seed = JSON.parse(await readFile(join(PATHS.root, 'data.reference/model-comparison.json'), 'utf8'));
  observation = seed.observations[0];
  app = express();
  app.use(express.json());
  app.use('/comparison', createModelComparisonRoutes());
  app.use(errorMiddleware);
});

afterEach(async () => {
  PATHS.data = originalData;
  await rm(dir, { recursive: true, force: true });
});

it('serves only the release-shipped public dataset and exposes no provider or write operations', async () => {
  const localObservation = { ...observation, quality: { ...observation.quality, value: 1 } };
  await writeFile(join(dir, 'model-comparison.json'), JSON.stringify({ schemaVersion: 1, observations: [localObservation] }));

  const result = await request(app).get('/comparison');
  expect(result.status).toBe(200);
  expect(result.body).toEqual(seed);
  expect(result.body.observations).toHaveLength(seed.observations.length);
  expect(result.body.observations.every(row => !/^(?:Artificial Analysis Intelligence Index|SWE-bench\b|PortOS Task Bench\b)/i.test(row.benchmark))).toBe(true);

  for (const path of ['/comparison/discover', '/comparison/run', '/comparison/import', '/comparison/sync/openrouter']) {
    expect((await request(app).post(path).send({})).status).toBe(404);
  }
});

it('imports sourced public observations durably, retains newer metrics, and serializes concurrent imports', async () => {
  const input = { schemaVersion: 1, observations: [{ ...observation, id: 'example-new', model: 'example-new-model' }] };
  await importModelComparison(input);
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
  expect(stored.observations).toHaveLength(seed.observations.length + 2);
  expect(stored.observations.find(row => row.id === 'example-new')[metricKey]).toEqual(observation[metricKey]);
  const changedIdentity = { ...input.observations[0], effort: 'different' };
  await expect(importModelComparison({ schemaVersion: 1, observations: [changedIdentity] })).rejects.toThrow('identity changed');
});

it('rejects retired public scores, forged PortOS runs, malformed metrics, and unsafe sources', async () => {
  for (const [id, benchmark] of [
    ['aa-v4.3.2-example-model', 'Artificial Analysis Intelligence Index v4.3.2'],
    ['swebench-example-model', 'SWE-bench Verified (pass@1, example harness)'],
  ]) {
    const retired = { ...observation, id, benchmark };
    expect(() => importModelComparison({ schemaVersion: 1, observations: [retired] })).toThrow(/imports have been retired/);
  }

  const forgedRun = {
    ...observation,
    id: 'portos:00000000-0000-4000-8000-000000000001',
    benchmark: 'PortOS Task Bench v1 (deterministic)',
  };
  expect(() => importModelComparison({ schemaVersion: 1, observations: [forgedRun] })).toThrow(/only be created by the explicit benchmark run/);

  const malformed = { ...observation, quality: { value: 999 } };
  expect(() => importModelComparison({ schemaVersion: 1, observations: [malformed] })).toThrow();
  const unsafe = structuredClone(observation);
  unsafe.quality.source.url = 'javascript:alert(1)';
  expect(() => importModelComparison({ schemaVersion: 1, observations: [unsafe] })).toThrow();
  unsafe.quality.source.url = 'https://';
  expect(() => importModelComparison({ schemaVersion: 1, observations: [unsafe] })).toThrow();

  const future = JSON.stringify({ schemaVersion: 99, observations: [observation] });
  await writeFile(join(dir, 'model-comparison.json'), future);
  await expect(importModelComparison({ schemaVersion: 1, observations: [observation] })).rejects.toThrow();
  expect(await readFile(join(dir, 'model-comparison.json'), 'utf8')).toBe(future);
});
