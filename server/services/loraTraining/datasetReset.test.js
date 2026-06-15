import { describe, it, expect, vi, beforeEach } from 'vitest';

// clearDatasetForDeletedLora lives in index.js, which imports the whole training
// subsystem — mock every external dependency so importing it is cheap and the
// dataset mutator is the only thing under test. Mirrors resume.test.js's header.
const updateDatasetMock = vi.fn();

vi.mock('./db.js', () => ({
  getRunRequired: vi.fn(),
  updateRun: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  deleteRun: vi.fn(),
}));
vi.mock('./checkpoints.js', () => ({
  resolveLatestCheckpointArtifact: vi.fn(),
  listRunCheckpoints: vi.fn(),
  listRunSamples: vi.fn(),
  resolveCheckpointAdapterBuffer: vi.fn(),
  selectDeployableCheckpoint: vi.fn(),
}));
vi.mock('./dataset.js', () => ({ validateDatasetReady: vi.fn() }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../../lib/pythonSetup.js', () => ({
  isFlux2VenvHealthy: vi.fn(),
  resolveFlux2Python: vi.fn(() => '/venv/python'),
}));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(),
  getJob: vi.fn(),
  mediaJobEvents: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('../loraDatasets.js', () => ({ updateDataset: (...a) => updateDatasetMock(...a) }));

const { clearDatasetForDeletedLora } = await import('./index.js');

// updateDataset is called as updateDataset(id, mutator); capture and run the
// mutator against a fake `current` dataset to assert the reset decision.
const runMutator = (current) => {
  expect(updateDatasetMock).toHaveBeenCalledTimes(1);
  const [, mutator] = updateDatasetMock.mock.calls[0];
  return mutator(current);
};

const run = (overrides = {}) => ({
  datasetId: 'ds-1',
  output: { loraFilename: 'kessa-flux2.safetensors' },
  character: { entryId: 'c1', universeId: 'u1', entryKind: 'characters' },
  ...overrides,
});

const trainedDataset = (overrides = {}) => ({
  status: 'trained',
  character: { entryId: 'c1', universeId: 'u1', entryKind: 'characters' },
  training: { loraFilename: 'kessa-flux2.safetensors', completedAt: 'x' },
  ...overrides,
});

describe('clearDatasetForDeletedLora', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateDatasetMock.mockResolvedValue();
  });

  it('resets the dataset to draft when it still advertises the deleted adapter', async () => {
    await clearDatasetForDeletedLora(run(), 'kessa-flux2.safetensors');
    expect(runMutator(trainedDataset())).toEqual({
      status: 'draft',
      character: { entryId: 'c1', universeId: 'u1', entryKind: 'characters' },
      training: {},
    });
  });

  it('does NOT reset when the dataset was retrained to a different LoRA file', async () => {
    await clearDatasetForDeletedLora(run(), 'kessa-flux2.safetensors');
    expect(runMutator(trainedDataset({ training: { loraFilename: 'kessa-v2.safetensors' } }))).toBeNull();
  });

  it('does NOT reset when the dataset was reassigned to another character', async () => {
    await clearDatasetForDeletedLora(run(), 'kessa-flux2.safetensors');
    expect(runMutator(trainedDataset({ character: { entryId: 'c2', universeId: 'u1', entryKind: 'characters' } }))).toBeNull();
  });

  it('no-ops (no dataset write) when the run has no datasetId or no filename', async () => {
    await clearDatasetForDeletedLora(run({ datasetId: null }), 'kessa-flux2.safetensors');
    await clearDatasetForDeletedLora(run(), null);
    expect(updateDatasetMock).not.toHaveBeenCalled();
  });
});
