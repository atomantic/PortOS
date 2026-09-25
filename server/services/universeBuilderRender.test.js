import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUniverse: vi.fn(),
  compilePrompts: vi.fn(),
  recordRun: vi.fn(),
  enqueueJob: vi.fn(),
  getSettings: vi.fn(),
  getImageModels: vi.fn(),
  findOrCreateUniverseCollection: vi.fn(),
  buildUniverseRunTag: vi.fn(),
  registerUniverseBuilderRun: vi.fn(),
  shrinkUniverseBuilderRun: vi.fn(),
  assertMediaQueueRoom: vi.fn(),
}));

vi.mock('./universeBuilder.js', () => ({
  getUniverse: (...args) => mocks.getUniverse(...args),
  compilePrompts: (...args) => mocks.compilePrompts(...args),
  recordRun: (...args) => mocks.recordRun(...args),
}));
vi.mock('./settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('./mediaJobQueue/index.js', async () => ({
  enqueueJob: (...args) => mocks.enqueueJob(...args),
  assertMediaQueueRoom: (...args) => mocks.assertMediaQueueRoom(...args),
  partialBatchAdmissionError: (await import('./mediaJobQueue/admission.js')).partialBatchAdmissionError,
}));
vi.mock('./mediaCollections.js', () => ({ findOrCreateUniverseCollection: (...args) => mocks.findOrCreateUniverseCollection(...args) }));
vi.mock('./universeRunTag.js', () => ({ buildUniverseRunTag: (...args) => mocks.buildUniverseRunTag(...args) }));
vi.mock('./universeBuilderCollectionHook.js', () => ({
  registerUniverseBuilderRun: (...args) => mocks.registerUniverseBuilderRun(...args),
  shrinkUniverseBuilderRun: (...args) => mocks.shrinkUniverseBuilderRun(...args),
}));
vi.mock('./imageGen/index.js', () => ({
  IMAGE_GEN_MODE: { LOCAL: 'local', EXTERNAL: 'external' },
  resolveImageCleaners: () => ({ cleanC2PA: false, denoise: false }),
}));
vi.mock('../lib/mediaModels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getImageModels: (...args) => mocks.getImageModels(...args),
}));

import { renderUniverseJobs } from './universeBuilderRender.js';

const models = [
  { id: 'dev', hardwareCompatibility: { state: 'available' } },
  { id: 'pinned-model', hardwareCompatibility: { state: 'available' } },
  { id: 'incompatible-pin', hardwareCompatibility: { state: 'unavailable' } },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUniverse.mockResolvedValue({ id: 'universe-1', name: 'Example Universe' });
  mocks.compilePrompts.mockReturnValue([{ prompt: 'render prompt', category: 'character', label: 'Example' }]);
  mocks.recordRun.mockImplementation(async (run) => run);
  mocks.enqueueJob.mockResolvedValue({ jobId: 'job-1' });
  mocks.getSettings.mockResolvedValue({
    imageGen: { mode: 'local', local: { pythonPath: '/python', modelId: 'pinned-model' } },
  });
  mocks.getImageModels.mockReturnValue(models);
  mocks.findOrCreateUniverseCollection.mockResolvedValue({ id: 'collection-1', name: 'Universe: Example' });
  mocks.buildUniverseRunTag.mockResolvedValue({ universeId: 'universe-1' });
});

describe('renderUniverseJobs local model selection', () => {
  it('queues the install-pinned model when the request leaves modelId unset', async () => {
    await renderUniverseJobs('universe-1', {}, (err) => err);

    expect(mocks.enqueueJob.mock.calls[0][0].params.modelId).toBe('pinned-model');
  });

  it('falls back from an incompatible install pin to a hardware-compatible model', async () => {
    mocks.getSettings.mockResolvedValue({
      imageGen: { mode: 'local', local: { pythonPath: '/python', modelId: 'incompatible-pin' } },
    });

    await renderUniverseJobs('universe-1', {}, (err) => err);

    expect(mocks.enqueueJob.mock.calls[0][0].params.modelId).toBe('dev');
  });

  it('keeps the existing unknown-model 400 when the request names an unregistered model', async () => {
    await expect(renderUniverseJobs('universe-1', { modelId: 'missing-model' }, (err) => err))
      .rejects.toMatchObject({ status: 400, code: 'IMAGE_GEN_UNKNOWN_MODEL' });
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });
});

// #8326: the batch is preflighted against the queue ceiling, but another
// producer can still fill the queue mid-batch. The renders that landed must be
// recorded, the rest released from the run's coalescing count (or its final
// re-export never fires), and the error must say how many landed.
describe('renderUniverseJobs under a full media queue', () => {
  const queueFull = () => Object.assign(new Error('The media queue is full'), { status: 429, code: 'MEDIA_QUEUE_FULL' });

  it('refuses an oversized batch before provisioning the collection', async () => {
    mocks.assertMediaQueueRoom.mockImplementationOnce(() => { throw queueFull(); });
    await expect(renderUniverseJobs('universe-1', {}, (err) => err)).rejects.toMatchObject({ code: 'MEDIA_QUEUE_FULL' });
    expect(mocks.findOrCreateUniverseCollection).not.toHaveBeenCalled();
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('records the admitted renders and releases the rest when the queue fills mid-batch', async () => {
    mocks.compilePrompts.mockReturnValue([
      { prompt: 'first', category: 'character', label: 'A' },
      { prompt: 'second', category: 'character', label: 'B' },
    ]);
    mocks.enqueueJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockRejectedValueOnce(queueFull());
    await expect(renderUniverseJobs('universe-1', {}, (err) => err)).rejects.toMatchObject({
      status: 429, code: 'MEDIA_QUEUE_FULL', message: 'Queued 1 of 2 renders — The media queue is full',
    });
    const runId = mocks.registerUniverseBuilderRun.mock.calls[0][0].runId;
    expect(mocks.shrinkUniverseBuilderRun).toHaveBeenCalledWith(runId, 1);
    expect(mocks.recordRun).toHaveBeenCalledWith(expect.objectContaining({ id: runId, jobIds: ['job-1'], promptCount: 2 }));
  });
});
