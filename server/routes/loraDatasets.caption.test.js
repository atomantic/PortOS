import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { ServerError } from '../lib/errorHandler.js';

vi.mock('../services/loraDatasets.js', () => ({
  addUploadedImage: vi.fn(),
  createDataset: vi.fn(),
  deleteDataset: vi.fn(),
  deleteImage: vi.fn(),
  getDataset: vi.fn(),
  importGalleryImages: vi.fn(),
  listDatasets: vi.fn(),
  patchDataset: vi.fn(),
  reconcileRenderingImages: vi.fn(async (id) => ({ id, images: [] })),
  stripSharedCaptionFragments: vi.fn(),
  updateImageCaption: vi.fn(),
}));
vi.mock('../services/loraDatasetGenerate.js', () => ({
  generateDatasetImages: vi.fn(),
  getDatasetVariationAxes: vi.fn(),
  sliceReferenceSheet: vi.fn(),
}));
vi.mock('../services/loraDatasetCaption.js', () => ({
  attachCaptionSseClient: vi.fn(),
  cancelCaptionRun: vi.fn(),
  getActiveCaptionRun: vi.fn(),
  startCaptionRun: vi.fn(),
}));
vi.mock('../lib/multipart.js', () => ({ uploadFields: () => (_req, _res, next) => next() }));

import { errorMiddleware } from '../lib/errorHandler.js';
import { attachCaptionSseClient, cancelCaptionRun, getActiveCaptionRun } from '../services/loraDatasetCaption.js';
import loraDatasetRoutes from './loraDatasets.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/lora-datasets', loraDatasetRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('LoRA dataset caption-run routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dataset GET carries the dataset-scoped active caption run (or null)', async () => {
    const run = { runId: 'run-1', datasetId: 'ds-1', status: 'running', total: 3, done: 1, failed: 0 };
    getActiveCaptionRun.mockReturnValueOnce(run);
    const active = await request(makeApp()).get('/api/lora-datasets/ds-1');
    expect(active.body.captionRun).toEqual(run);
    expect(getActiveCaptionRun).toHaveBeenCalledWith('ds-1');
    getActiveCaptionRun.mockReturnValueOnce(null);
    const idle = await request(makeApp()).get('/api/lora-datasets/ds-1');
    expect(idle.body.captionRun).toBeNull();
  });

  it('cancel is scoped to dataset + run id and surfaces a mismatch as 404', async () => {
    cancelCaptionRun.mockReturnValueOnce({ canceled: true, run: { runId: 'run-1', status: 'canceling' } });
    const ok = await request(makeApp()).post('/api/lora-datasets/ds-1/caption-runs/run-1/cancel');
    expect(ok.status).toBe(202);
    expect(cancelCaptionRun).toHaveBeenCalledWith('ds-1', 'run-1');
    cancelCaptionRun.mockImplementationOnce(() => {
      throw new ServerError('Caption run not found: stale', { status: 404, code: 'NOT_FOUND' });
    });
    const stale = await request(makeApp()).post('/api/lora-datasets/ds-1/caption-runs/stale/cancel');
    expect(stale.status).toBe(404);
  });

  it('SSE attach passes the dataset id so a foreign run id is a 404', async () => {
    attachCaptionSseClient.mockReturnValueOnce(false);
    const res = await request(makeApp()).get('/api/lora-datasets/ds-2/caption-runs/run-1/events');
    expect(attachCaptionSseClient).toHaveBeenCalledWith('ds-2', 'run-1', expect.anything());
    expect(res.status).toBe(404);
  });
});
