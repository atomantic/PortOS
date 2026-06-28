import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression guard for the caption-leak gate's SECOND call site. The gate is
// re-checked when the queued job actually stages (runTraining), not just at
// launch (startTrainingRun). That staging re-validation must NOT re-apply the
// leak gate — a leaky run only reaches the queue via an explicit "Train anyway"
// (acknowledgeCaptionLeak) or a resume, and re-blocking it there would fail the
// very runs those paths opted in. This pins runTraining → validateDatasetReady
// being called with { acknowledgeCaptionLeak: true }.
const getRunMock = vi.fn();
const updateRunMock = vi.fn();
const validateDatasetReadyMock = vi.fn();
const updateDatasetMock = vi.fn();

vi.mock('./db.js', () => ({
  getRun: (...a) => getRunMock(...a),
  getRunRequired: vi.fn(),
  updateRun: (...a) => updateRunMock(...a),
  listRuns: vi.fn(),
  deleteRun: vi.fn(),
}));
vi.mock('./dataset.js', () => ({ validateDatasetReady: (...a) => validateDatasetReadyMock(...a) }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../loraDatasets.js', () => ({ updateDataset: (...a) => updateDatasetMock(...a) }));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(),
  getJob: vi.fn(),
  mediaJobEvents: { emit: vi.fn(), on: vi.fn() },
}));

const { runTraining } = await import('./index.js');

// validateDatasetReady mock that mirrors the real gate: throw the leak 409 when
// the caller did NOT acknowledge, succeed (with a deliberately MISMATCHED
// character so runTraining bails at the ownership check, before any real spawn)
// when it did. So if the staging call ever drops the acknowledge flag again,
// runTraining fails with the leak message instead of the reassignment one.
const wireLeakyDataset = () => {
  validateDatasetReadyMock.mockImplementation(async (_id, opts = {}) => {
    if (!opts.acknowledgeCaptionLeak) {
      const err = new Error('Identity is leaking into the captions — "red cloak" repeat across most images');
      err.status = 409;
      err.code = 'CAPTION_IDENTITY_LEAK';
      throw err;
    }
    return { dataset: { character: { entryId: 'other', universeId: 'u1' } }, manifest: { images: [] } };
  });
};

describe('runTraining staging re-validation bypasses the caption-leak gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRunMock.mockResolvedValue({
      id: 'run-1',
      datasetId: 'ds1',
      character: { entryId: 'c1', universeId: 'u1' },
    });
    updateRunMock.mockResolvedValue();
    updateDatasetMock.mockResolvedValue();
    wireLeakyDataset();
  });

  it('re-validates with acknowledgeCaptionLeak so an acknowledged leaky run is not re-blocked at staging', async () => {
    await runTraining({ jobId: 'job-1', runId: 'run-1' });

    expect(validateDatasetReadyMock).toHaveBeenCalledWith('ds1', { acknowledgeCaptionLeak: true });
    // The run still failed — but at the ownership check (mismatched character),
    // NOT the leak gate. Proves the gate was bypassed at staging.
    const failError = updateRunMock.mock.calls.find(([, patch]) => patch?.status === 'failed')?.[1]?.error || '';
    expect(failError).not.toMatch(/leaking/i);
  });
});
