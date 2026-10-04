import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

const datasets = Array.from({ length: 5 }, (_, i) => ({ id: `dataset-${i}` }));

vi.mock('../services/loraDatasets.js', () => ({
  addUploadedImage: vi.fn(),
  createDataset: vi.fn(),
  deleteDataset: vi.fn(),
  deleteImage: vi.fn(),
  getDataset: vi.fn(),
  importGalleryImages: vi.fn(),
  listDatasets: vi.fn(async () => datasets),
  patchDataset: vi.fn(),
  reconcileRenderingImages: vi.fn(),
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

vi.mock('../lib/multipart.js', () => ({
  uploadFields: () => (_req, _res, next) => next(),
}));

vi.mock('../lib/loraDataset.js', () => ({
  LORA_DATASET_ENTRY_KINDS: ['characters', 'objects', 'places', 'ingredients'],
  computeDatasetReadiness: vi.fn(() => ({})),
}));

import { errorMiddleware } from '../lib/errorHandler.js';
import loraDatasetRoutes from './loraDatasets.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/lora-datasets', loraDatasetRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('LoRA dataset list pagination', () => {
  it('preserves the bare array when pagination is not requested', async () => {
    const response = await request(makeApp()).get('/api/lora-datasets');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(datasets);
  });

  it('returns a bounded envelope when pagination is requested', async () => {
    const response = await request(makeApp()).get('/api/lora-datasets?limit=2&offset=1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [{ id: 'dataset-1' }, { id: 'dataset-2' }],
      total: 5,
      limit: 2,
      offset: 1,
    });
  });
});
