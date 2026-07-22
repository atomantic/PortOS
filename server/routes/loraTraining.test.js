import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { request } from '../lib/testHelper.js';

// The route module pulls in the whole training service graph at import time —
// stub every collaborator so the suite only exercises the HTTP layer.
const svc = vi.hoisted(() => ({ samplesDir: '' }));
vi.mock('../services/loraTraining/index.js', () => ({
  clearDatasetForDeletedLora: vi.fn(),
  deleteRun: vi.fn(),
  getRunRequired: vi.fn(async (id) => ({ id, status: 'completed' })),
  isMfluxTrainAvailable: () => false,
  listCheckpoints: vi.fn(),
  listRuns: vi.fn(),
  listSamples: vi.fn(),
  promoteCheckpoint: vi.fn(),
  resumeTrainingRun: vi.fn(),
  runDir: vi.fn(),
  runSamplesDir: () => svc.samplesDir,
  startTrainingRun: vi.fn(),
}));
vi.mock('../services/loraTraining/runtimes.js', () => ({ TRAINING_DEFAULTS: {} }));
vi.mock('../services/settings.js', () => ({ getSettings: async () => ({}) }));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  attachSseClient: vi.fn(),
  cancelJob: vi.fn(),
}));
vi.mock('../services/loras.js', () => ({ deleteLora: vi.fn() }));
vi.mock('../lib/pythonSetup.js', () => ({
  resolveFlux2Python: () => null,
  isFlux2VenvHealthy: async () => false,
  resolveMfluxPython: () => null,
}));

import { errorMiddleware } from '../lib/errorHandler.js';
import loraTrainingRoutes from './loraTraining.js';

function makeApp() {
  const app = express();
  app.use('/api/lora-training', loraTrainingRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('lora-training sample serving', () => {
  let app;
  beforeEach(async () => {
    app = makeApp();
    svc.samplesDir = await mkdtemp(join(tmpdir(), 'portos-lora-samples-'));
  });
  afterEach(async () => {
    await rm(svc.samplesDir, { recursive: true, force: true });
  });

  it('serves an existing sample', async () => {
    await writeFile(join(svc.samplesDir, 'step-1.png'), 'png-bytes');
    const r = await request(app).get('/api/lora-training/runs/run-1/samples/step-1.png');
    expect(r.status).toBe(200);
  });

  // The 404 fires from the sendFile callback, outside asyncHandler's catch —
  // it must still carry the shared `{ error, code, timestamp }` envelope (#2845).
  it('returns the standard error envelope when the sample is missing', async () => {
    const r = await request(app).get('/api/lora-training/runs/run-1/samples/missing.png');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Sample not found');
    expect(r.body.code).toBe('NOT_FOUND');
    expect(typeof r.body.timestamp).toBe('number');
  });
});
