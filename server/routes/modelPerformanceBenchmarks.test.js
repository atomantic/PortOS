vi.mock('../services/portosModelBenchmarks.js', () => ({
  modelComparisonBilling: provider => provider.id === 'ollama' ? 'local' : 'free',
  runPortosModelBenchmark: vi.fn(),
}));

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { PATHS } from '../lib/paths.js';
import { createModelPerformanceBenchmarkRoutes } from './modelPerformanceBenchmarks.js';
import { runPortosModelBenchmark } from '../services/portosModelBenchmarks.js';

let dir;
let originalData;
let app;
let providerService;
let publicObservation;
let portosObservation;

beforeEach(async () => {
  vi.clearAllMocks();
  originalData = PATHS.data;
  dir = await mkdtemp(join(tmpdir(), 'portos-performance-benchmarks-test-'));
  PATHS.data = dir;
  const seed = JSON.parse(await readFile(join(PATHS.root, 'data.reference/model-comparison.json'), 'utf8'));
  publicObservation = seed.observations[0];
  portosObservation = {
    ...publicObservation,
    id: 'portos:00000000-0000-4000-8000-000000000001',
    benchmark: 'PortOS Task Bench v1 (deterministic)',
    billing: 'local',
  };
  providerService = {
    getAllProviders: vi.fn().mockResolvedValue({ providers: [
      { id: 'opencode-zen', name: 'OpenCode Zen', type: 'api', endpoint: 'https://opencode.ai/zen/v1', apiKey: 'example-private-key', envVars: { PRIVATE: 'example-secret' }, enabled: true, models: ['opencode/example-model'] },
      { id: 'disabled', enabled: false, models: ['hidden'] },
    ] }),
    fetchProviderModelCatalog: vi.fn().mockResolvedValue({ models: ['new-example-model'], contextWindows: {} }),
  };
  app = express();
  app.use(express.json());
  app.use('/performance', createModelPerformanceBenchmarkRoutes(providerService));
  app.use(errorMiddleware);
});

afterEach(async () => {
  PATHS.data = originalData;
  await rm(dir, { recursive: true, force: true });
});

it('shows only this machine’s PortOS runs and leaves provider discovery explicit', async () => {
  await writeFile(join(dir, 'model-comparison.json'), JSON.stringify({
    schemaVersion: 1,
    observations: [publicObservation, portosObservation],
  }));

  const result = await request(app).get('/performance');
  expect(result.status).toBe(200);
  expect(result.body.observations).toEqual([portosObservation]);
  expect(result.body.inventory).toEqual([{
    id: 'opencode-zen', name: 'OpenCode Zen', type: 'api', billing: 'free', canBenchmark: true,
    benchmarkUnavailableReason: null, canDiscover: true,
    models: [{ model: 'opencode/example-model', efforts: [] }],
  }]);
  expect(JSON.stringify(result.body)).not.toContain('example-private-key');
  expect(JSON.stringify(result.body)).not.toContain('example-secret');
  expect(providerService.fetchProviderModelCatalog).not.toHaveBeenCalled();
});

it('discovers and runs only after explicit Performance actions', async () => {
  runPortosModelBenchmark.mockResolvedValue({ observation: portosObservation, complete: true });

  const discovery = await request(app).post('/performance/discover').send({ providerId: 'opencode-zen' });
  expect(discovery.status).toBe(200);
  expect(discovery.body.models).toEqual([{ model: 'new-example-model', efforts: [] }]);
  expect(providerService.fetchProviderModelCatalog).toHaveBeenCalledTimes(1);

  const run = await request(app).post('/performance/run').send({ providerId: 'opencode-zen', model: 'opencode/example-model' });
  expect(run.status).toBe(200);
  expect(run.body).toEqual({ observation: portosObservation, complete: true });
  expect(runPortosModelBenchmark).toHaveBeenCalledWith(expect.objectContaining({
    provider: expect.objectContaining({ id: 'opencode-zen' }),
    model: 'opencode/example-model',
    effort: null,
    signal: expect.any(AbortSignal),
  }));

  expect((await request(app).post('/performance/run').send({ providerId: 'opencode-zen', model: 'not-configured' })).status).toBe(400);
  expect((await request(app).post('/performance/run').send({ providerId: 'disabled', model: 'hidden' })).status).toBe(400);
  expect(runPortosModelBenchmark).toHaveBeenCalledTimes(1);
});
