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
  app.use('/comparison', createModelComparisonRoutes({ getSelectableProviders: async () => ({ providers: [{ id: 'example-provider', name: 'Example provider', models: [observation.model], enabled: true }, { id: 'disabled', name: 'Disabled', models: ['hidden-model'], enabled: false }] }) }));
  app.use(errorMiddleware);
});

afterEach(async () => {
  PATHS.data = originalData;
  await rm(dir, { recursive: true, force: true });
});

it('merges newer installed evidence with shipped evidence and includes only selectable enabled models', async () => {
  const localObservation = { ...observation, notes: 'Updated evidence: https://example.com/new-source', quality: { ...observation.quality, value: 1, source: { ...observation.quality.source, retrievedAt: new Date().toISOString() } } };
  await writeFile(join(dir, 'model-comparison.json'), JSON.stringify({ schemaVersion: 1, observations: [localObservation] }));
  const result = await request(app).get('/comparison');
  expect(result.status).toBe(200);
  expect(result.body.observations.find(row => row.id === observation.id).quality.value).toBe(1);
  expect(result.body.observations.find(row => row.id === observation.id).notes).toBe(localObservation.notes);
  expect(result.body.observations).toHaveLength(seed.observations.length);
  expect(result.body.inventory).toEqual([{ id: 'example-provider', name: 'Example provider', gateway: null, models: [{ model: observation.model, efforts: [] }] }]);
  expect(result.body.composite.rows.length).toBeGreaterThan(0);
  expect(result.body.composite.rows.every(row => row.providerId === 'example-provider')).toBe(true);
  for (const path of ['/comparison/discover', '/comparison/run']) expect((await request(app).post(path).send({})).status).toBe(404);
  const imported = { ...observation, id: 'research-import' };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [imported] })).status).toBe(200);
  expect((await request(app).get('/comparison')).body.observations.some(row => row.id === imported.id)).toBe(true);
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

it('rejects forged PortOS runs, malformed metrics, and unsafe sources', async () => {
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

it('requires explicit estimation provenance and protects run-only sources on every metric', async () => {
  const estimated = { ...observation, id: 'research:example:high', benchmark: 'PortOS Research Index v1 (AA v4.3.2 scale)' };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [estimated] })).status).toBe(400);
  estimated.quality = { ...estimated.quality, value: 35, source: { ...estimated.quality.source, methodology: 'PortOS estimate: midpoint of documented peer scores 30 and 40; low confidence.' } };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [estimated] })).status).toBe(200);
  const forged = { ...observation, id: 'forged-quota', quota: { unitsPerTask: 1, unit: 'task', source: { ...observation.quality.source, url: 'portos://model-comparison/00000000-0000-4000-8000-000000000001' } } };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [forged] })).status).toBe(400);
});

it('loads legacy benchmark labels after upgrade and preserves evidence through subsequent imports', async () => {
  const shipped = seed.observations.filter(row => row.id.startsWith('lcb-generation-2023-05-08--2025-04-07-'));
  expect(shipped.length).toBeGreaterThan(0);
  const legacy = shipped.map(row => ({ ...row,
    benchmark: 'LiveCodeBench (generation, pass@1, 2023-05-08 to 2025-04-07)',
    inputPerMillion: null, outputPerMillion: null,
  }));
  const stored = JSON.stringify({ schemaVersion: 1, observations: legacy });
  await writeFile(join(dir, 'model-comparison.json'), stored);
  for (let reload = 0; reload < 2; reload++) {
    const result = await request(app).get('/comparison');
    expect(result.status).toBe(200);
    expect(result.body.observations).toHaveLength(seed.observations.length);
    for (const row of shipped) expect(result.body.observations.find(item => item.id === row.id)).toMatchObject({
      benchmark: row.benchmark, quality: row.quality, inputPerMillion: row.inputPerMillion, outputPerMillion: row.outputPerMillion,
    });
  }
  // Reload is read-only; persistence occurs only during an explicit import.
  expect(await readFile(join(dir, 'model-comparison.json'), 'utf8')).toBe(stored);
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: legacy })).status).toBe(200);
  const saved = JSON.parse(await readFile(join(dir, 'model-comparison.json'), 'utf8'));
  expect(saved.observations).toHaveLength(seed.observations.length);
  for (const row of shipped) expect(saved.observations.find(item => item.id === row.id)).toMatchObject({
    benchmark: row.benchmark, quality: row.quality, inputPerMillion: row.inputPerMillion, outputPerMillion: row.outputPerMillion,
  });
  const changed = { ...legacy[0], benchmark: 'LiveCodeBench (generation, pass@1, 2025-01-01 to 2025-04-07)' };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [changed] })).status).toBe(409);
  expect((await request(app).get('/comparison')).status).toBe(200);
});
