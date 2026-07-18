import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guard: startTrainingRun must REFUSE the torch/diffusers fallback trainer on
// Apple Silicon at request time. PyTorch's MPS backend has no linear_backward
// for the FLUX.2 transformer layers, so a torch LoRA backward dies at the first
// optimizer step — mflux (MLX) is the Apple-Silicon runtime (issue #1227). The
// refusal must happen before any run record is created or job enqueued, so we
// never load a ~16 GB base + precompute latents only to crash. On non-darwin
// (the torch path's real CUDA/CPU target) the same request proceeds.
let mockPlatform = 'darwin';
vi.mock('os', async (importActual) => {
  const actual = await importActual();
  return { ...actual, platform: () => mockPlatform };
});

const createRunMock = vi.fn(async () => {});
const updateRunMock = vi.fn(async () => {});
const enqueueJobMock = vi.fn(() => ({ jobId: 'job-1', position: 0 }));
const validateDatasetReadyMock = vi.fn(async () => ({
  dataset: { character: { entryId: 'c1', universeId: 'u1', name: 'Test Subject' }, triggerWord: 'test_subject' },
  manifest: { images: [] },
}));
const isFlux2VenvHealthyMock = vi.fn(async () => true);

vi.mock('./db.js', () => ({
  createRun: (...a) => createRunMock(...a),
  updateRun: (...a) => updateRunMock(...a),
  getRun: vi.fn(), getRunRequired: vi.fn(), listRuns: vi.fn(), deleteRun: vi.fn(),
}));
vi.mock('./dataset.js', () => ({ validateDatasetReady: (...a) => validateDatasetReadyMock(...a) }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../loraDatasets.js', () => ({ updateDataset: vi.fn(async () => {}) }));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: (...a) => enqueueJobMock(...a),
  getJob: vi.fn(),
  mediaJobEvents: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('../../lib/pythonSetup.js', () => ({
  resolveFlux2Python: () => '/fake/venv-flux2/bin/python3',
  isFlux2VenvHealthy: (...a) => isFlux2VenvHealthyMock(...a),
}));

const { startTrainingRun } = await import('./index.js');

// getSettings → {} means pythonPath is null, so isMfluxTrainAvailable(null) is
// false and routing resolves to the torch (flux2) runtime — the branch the
// guard protects. flux2-klein-4b is a real registry model.
const BASE = 'flux2-klein-4b';

beforeEach(() => { vi.clearAllMocks(); mockPlatform = 'darwin'; });

describe('startTrainingRun — Apple Silicon torch-runtime guard', () => {
  it('refuses torch training on darwin before creating a run or queuing a job', async () => {
    await expect(startTrainingRun({ datasetId: 'ds1', baseModelId: BASE }))
      .rejects.toMatchObject({ code: 'TRAINING_MPS_UNSUPPORTED', status: 412 });
    expect(createRunMock).not.toHaveBeenCalled();
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it('does NOT fire the guard on non-darwin (torch path proceeds to queue)', async () => {
    mockPlatform = 'linux';
    const res = await startTrainingRun({ datasetId: 'ds1', baseModelId: BASE });
    expect(res).toMatchObject({ status: 'queued' });
    expect(createRunMock).toHaveBeenCalled();
    expect(enqueueJobMock).toHaveBeenCalled();
  });
});
