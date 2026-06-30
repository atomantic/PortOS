import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression guard for the caption-leak gate's SECOND call site. The gate is
// re-checked when the queued job actually stages (runTraining), not just at
// launch (startTrainingRun). The staging re-check must skip the gate ONLY for a
// run that already opted past it — an explicit "Train anyway" (persisted as
// run.captionLeakAcknowledged) or a resume (resumeCheckpoint set) — while still
// re-checking an ordinary clean-at-launch run, so captions edited leaky WHILE
// the run sat in the queue are caught instead of training silently.
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

// Mirrors the real gate: throw the leak 409 when the caller did NOT acknowledge,
// otherwise return a dataset whose character MISMATCHES the run so runTraining
// bails at the ownership check (before any real spawn). So a regressed staging
// call that dropped the flag surfaces as a leak failure rather than the
// reassignment one.
const LEAK_MSG = 'Identity is leaking into the captions — "red cloak" repeat across most images';
beforeEach(() => {
  vi.clearAllMocks();
  updateRunMock.mockResolvedValue();
  updateDatasetMock.mockResolvedValue();
  validateDatasetReadyMock.mockImplementation(async (_id, opts = {}) => {
    if (!opts.acknowledgeCaptionLeak) {
      const err = new Error(LEAK_MSG);
      err.status = 409;
      err.code = 'CAPTION_IDENTITY_LEAK';
      throw err;
    }
    return { dataset: { character: { entryId: 'other', universeId: 'u1' } }, manifest: { images: [] } };
  });
});

const failError = () =>
  updateRunMock.mock.calls.find(([, patch]) => patch?.status === 'failed')?.[1]?.error || '';

describe('runTraining staging re-validation — caption-leak gate', () => {
  it('skips the gate for a run launched with "Train anyway" (captionLeakAcknowledged)', async () => {
    getRunMock.mockResolvedValue({
      id: 'run-1', datasetId: 'ds1', captionLeakAcknowledged: true,
      character: { entryId: 'c1', universeId: 'u1' },
    });
    await runTraining({ jobId: 'job-1', runId: 'run-1' });
    expect(validateDatasetReadyMock).toHaveBeenCalledWith('ds1', { acknowledgeCaptionLeak: true });
    expect(failError()).not.toMatch(/leaking/i); // bailed at ownership, not the leak gate
  });

  it('skips the gate when resuming (captions already trained once)', async () => {
    getRunMock.mockResolvedValue({
      id: 'run-1', datasetId: 'ds1', captionLeakAcknowledged: false,
      character: { entryId: 'c1', universeId: 'u1' },
    });
    await runTraining({ jobId: 'job-1', runId: 'run-1', resumeCheckpoint: '/ckpt/step-300' });
    expect(validateDatasetReadyMock).toHaveBeenCalledWith('ds1', { acknowledgeCaptionLeak: true });
  });

  it('STILL re-checks an ordinary queued run, catching captions edited leaky while queued', async () => {
    getRunMock.mockResolvedValue({
      id: 'run-1', datasetId: 'ds1', captionLeakAcknowledged: false,
      character: { entryId: 'c1', universeId: 'u1' },
    });
    await runTraining({ jobId: 'job-1', runId: 'run-1' });
    expect(validateDatasetReadyMock).toHaveBeenCalledWith('ds1', { acknowledgeCaptionLeak: false });
    expect(failError()).toMatch(/leaking/i); // the queued-time leak is caught, run fails
  });
});
