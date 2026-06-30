import { describe, it, expect, vi, beforeEach } from 'vitest';

// validateDatasetReady is a thin orchestration over the pure readiness/invariant
// helpers + getDataset + an fs.access existence probe. Mock the data + fs deps so
// the gate logic (leak detection, acknowledge override, resume skip) is testable
// without a real dataset store or files on disk.
vi.mock('../loraDatasets.js', () => ({
  getDataset: vi.fn(),
  datasetImagePath: vi.fn((id, file) => `/tmp/${id}/${file}`),
  datasetImagesDir: vi.fn((id) => `/tmp/${id}`),
}));
vi.mock('fs/promises', () => ({ access: vi.fn(async () => {}) }));

const { getDataset } = await import('../loraDatasets.js');
const { validateDatasetReady } = await import('./dataset.js');

// 10 ready, trigger-prefixed images = trainable. `body(i)` lets a test make the
// per-shot descriptive tail unique (no leak) or repeat a fragment (leak).
const dataset = (body) => ({
  id: 'ds1',
  triggerWord: 'freydis',
  character: { entryId: 'c1', universeId: 'u1', entryKind: 'characters' },
  images: Array.from({ length: 10 }, (_, i) => ({
    id: `img${i}`, file: `${i}.png`, status: 'ready', caption: `freydis, ${body(i)}`,
  })),
});

beforeEach(() => vi.clearAllMocks());

describe('validateDatasetReady caption-identity-leak gate', () => {
  it('passes (returns manifest) when captions share no identity fragment', async () => {
    getDataset.mockResolvedValue(dataset((i) => `pose ${i}, angle ${i}`));
    const { manifest } = await validateDatasetReady('ds1');
    expect(manifest.triggerWord).toBe('freydis');
    expect(manifest.images).toHaveLength(10);
  });

  it('throws 409 CAPTION_IDENTITY_LEAK with the shared fragments when identity repeats', async () => {
    getDataset.mockResolvedValue(dataset((i) => `red cloak, woven crown, pose ${i}`));
    await expect(validateDatasetReady('ds1')).rejects.toMatchObject({
      status: 409,
      code: 'CAPTION_IDENTITY_LEAK',
      context: {
        total: 10,
        sharedFragments: expect.arrayContaining([
          expect.objectContaining({ fragment: 'red cloak' }),
          expect.objectContaining({ fragment: 'woven crown' }),
        ]),
      },
    });
  });

  it('trains anyway when acknowledgeCaptionLeak overrides the gate', async () => {
    getDataset.mockResolvedValue(dataset((i) => `red cloak, woven crown, pose ${i}`));
    const { manifest } = await validateDatasetReady('ds1', { acknowledgeCaptionLeak: true });
    expect(manifest.images).toHaveLength(10);
  });

  it('still rejects an untrainable dataset before the leak check', async () => {
    getDataset.mockResolvedValue({
      id: 'ds1', triggerWord: 'freydis', character: { entryId: 'c1' }, images: [],
    });
    await expect(validateDatasetReady('ds1')).rejects.toMatchObject({
      status: 409, code: 'DATASET_NOT_READY',
    });
  });
});
