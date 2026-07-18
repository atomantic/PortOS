import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every external dependency resumeTrainingRun reaches so we can drive the
// branch logic without a real DB, queue, or python venv. Keeping runtimes.js
// real lets the test reference TRAINING_RUNTIMES.FLUX2 against the same source.
const getRunRequiredMock = vi.fn();
const updateRunMock = vi.fn();
const resolveLatestCheckpointArtifactMock = vi.fn();
const validateDatasetReadyMock = vi.fn();
const enqueueJobMock = vi.fn();
const updateDatasetMock = vi.fn();
const isFlux2VenvHealthyMock = vi.fn();

vi.mock('./db.js', () => ({
  getRunRequired: (...a) => getRunRequiredMock(...a),
  updateRun: (...a) => updateRunMock(...a),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  deleteRun: vi.fn(),
}));
vi.mock('./checkpoints.js', () => ({
  resolveLatestCheckpointArtifact: (...a) => resolveLatestCheckpointArtifactMock(...a),
  listRunCheckpoints: vi.fn(),
  listRunSamples: vi.fn(),
  resolveCheckpointAdapterBuffer: vi.fn(),
  selectDeployableCheckpoint: vi.fn(),
}));
vi.mock('./dataset.js', () => ({ validateDatasetReady: (...a) => validateDatasetReadyMock(...a) }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../../lib/pythonSetup.js', () => ({
  isFlux2VenvHealthy: (...a) => isFlux2VenvHealthyMock(...a),
  resolveFlux2Python: vi.fn(() => '/venv/python'),
  resolveMfluxPython: (p) => p || null,
}));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: (...a) => enqueueJobMock(...a),
  getJob: vi.fn(),
  mediaJobEvents: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('../loraDatasets.js', () => ({ updateDataset: (...a) => updateDatasetMock(...a) }));

const { TRAINING_RUNTIMES } = await import('./runtimes.js');
const { resumeTrainingRun } = await import('./index.js');

const flux2Run = (overrides = {}) => ({
  id: 'run-flux2',
  status: 'failed',
  runtime: TRAINING_RUNTIMES.FLUX2,
  datasetId: 'ds-1',
  character: { entryId: 'c1', universeId: 'u1' },
  triggerWord: 'kessa',
  baseModelId: 'm1',
  params: { steps: 600, rank: 16 },
  ...overrides,
});

describe('resumeTrainingRun — flux2 path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateRunMock.mockResolvedValue();
    updateDatasetMock.mockResolvedValue();
    validateDatasetReadyMock.mockResolvedValue({ dataset: { character: { entryId: 'c1', universeId: 'u1' } } });
    isFlux2VenvHealthyMock.mockResolvedValue(true);
    enqueueJobMock.mockReturnValue({ jobId: 'job-1', position: 0 });
  });

  it('enqueues a resume job for a failed flux2 run (no RESUME_UNSUPPORTED_RUNTIME)', async () => {
    getRunRequiredMock.mockResolvedValue(flux2Run());
    resolveLatestCheckpointArtifactMock.mockReturnValue({ step: 150, path: '/runs/run-flux2/checkpoints/step-000150' });

    const result = await resumeTrainingRun('run-flux2');

    expect(result).toMatchObject({ runId: 'run-flux2', jobId: 'job-1', status: 'queued', fromStep: 150 });
    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
    const job = enqueueJobMock.mock.calls[0][0];
    expect(job.kind).toBe('training');
    expect(job.params.runtime).toBe(TRAINING_RUNTIMES.FLUX2);
    // The checkpoint dir flows through to the trainer's --resume-from.
    expect(job.params.resumeCheckpoint).toBe('/runs/run-flux2/checkpoints/step-000150');
    // The run record is flipped back to queued with the resume bookkeeping.
    expect(updateRunMock).toHaveBeenCalledWith('run-flux2', expect.any(Function));
  });

  it('still rejects a flux2 run with no on-disk checkpoint (NO_RESUMABLE_CHECKPOINT)', async () => {
    getRunRequiredMock.mockResolvedValue(flux2Run());
    resolveLatestCheckpointArtifactMock.mockReturnValue(null);

    await expect(resumeTrainingRun('run-flux2')).rejects.toMatchObject({ code: 'NO_RESUMABLE_CHECKPOINT' });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it('refuses to resume a still-running flux2 run (RUN_NOT_RESUMABLE)', async () => {
    getRunRequiredMock.mockResolvedValue(flux2Run({ status: 'running' }));

    await expect(resumeTrainingRun('run-flux2')).rejects.toMatchObject({ code: 'RUN_NOT_RESUMABLE' });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  // Issue #1330: the phase-aware stall watchdog auto-resumes with { auto: true }.
  // The resume bookkeeping must increment autoCount (the watchdog's own budget,
  // separate from total count) and stamp lastReason so the cap is enforceable.
  it('stamps auto-resume bookkeeping (autoCount + lastReason) when auto:true', async () => {
    getRunRequiredMock.mockResolvedValue(flux2Run({ resume: { count: 1, autoCount: 1 } }));
    resolveLatestCheckpointArtifactMock.mockReturnValue({ step: 300, path: '/runs/run-flux2/checkpoints/step-000300' });

    await resumeTrainingRun('run-flux2', { auto: true });

    const updater = updateRunMock.mock.calls.find((c) => c[0] === 'run-flux2' && typeof c[1] === 'function')[1];
    const next = updater(flux2Run({ resume: { count: 1, autoCount: 1 } }));
    expect(next.resume).toMatchObject({ count: 2, autoCount: 2, fromStep: 300, lastReason: 'stall-watchdog' });
  });

  it('manual resume does not bump autoCount and stamps lastReason manual', async () => {
    getRunRequiredMock.mockResolvedValue(flux2Run({ resume: { count: 2, autoCount: 2 } }));
    resolveLatestCheckpointArtifactMock.mockReturnValue({ step: 300, path: '/runs/run-flux2/checkpoints/step-000300' });

    await resumeTrainingRun('run-flux2');

    const updater = updateRunMock.mock.calls.find((c) => c[0] === 'run-flux2' && typeof c[1] === 'function')[1];
    const next = updater(flux2Run({ resume: { count: 2, autoCount: 2 } }));
    expect(next.resume).toMatchObject({ count: 3, autoCount: 2, lastReason: 'manual' });
  });
});
