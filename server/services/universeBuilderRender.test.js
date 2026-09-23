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
}));

vi.mock('./universeBuilder.js', () => ({
  getUniverse: (...args) => mocks.getUniverse(...args),
  compilePrompts: (...args) => mocks.compilePrompts(...args),
  recordRun: (...args) => mocks.recordRun(...args),
}));
vi.mock('./settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('./mediaJobQueue/index.js', () => ({ enqueueJob: (...args) => mocks.enqueueJob(...args) }));
vi.mock('./mediaCollections.js', () => ({ findOrCreateUniverseCollection: (...args) => mocks.findOrCreateUniverseCollection(...args) }));
vi.mock('./universeRunTag.js', () => ({ buildUniverseRunTag: (...args) => mocks.buildUniverseRunTag(...args) }));
vi.mock('./universeBuilderCollectionHook.js', () => ({ registerUniverseBuilderRun: (...args) => mocks.registerUniverseBuilderRun(...args) }));
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
  mocks.enqueueJob.mockReturnValue({ jobId: 'job-1' });
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
