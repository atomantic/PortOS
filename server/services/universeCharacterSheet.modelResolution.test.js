import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUniverse: vi.fn(),
  getSettings: vi.fn(),
  enqueueJob: vi.fn(),
  getImageModels: vi.fn(),
  buildUniverseRunTag: vi.fn(),
  claimPendingSheetSlot: vi.fn(),
}));

vi.mock('./universeBuilder.js', () => ({ getUniverse: (...args) => mocks.getUniverse(...args) }));
vi.mock('./settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('./mediaJobQueue/index.js', () => ({
  enqueueJob: (...args) => mocks.enqueueJob(...args),
  mediaJobEvents: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('./universeRunTag.js', () => ({ buildUniverseRunTag: (...args) => mocks.buildUniverseRunTag(...args) }));
vi.mock('./universeCharacterSheetSlot.js', () => ({
  claimPendingSheetSlot: (...args) => mocks.claimPendingSheetSlot(...args),
  getPendingSheetSlot: vi.fn(),
  releasePendingSheetSlot: vi.fn(),
}));
vi.mock('./imageGen/index.js', () => ({
  IMAGE_GEN_MODE: { LOCAL: 'local', CODEX: 'codex', EXTERNAL: 'external' },
  resolveImageCleaners: vi.fn(() => ({ cleanC2PA: false, denoise: false })),
}));
vi.mock('../lib/mediaModels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getImageModels: (...args) => mocks.getImageModels(...args),
}));

import { renderCharacterReferenceSheet } from './universeCharacterSheet.js';

const models = [
  { id: 'dev', hardwareCompatibility: { state: 'available' } },
  { id: 'pinned-model', hardwareCompatibility: { state: 'available' } },
  { id: 'incompatible-pin', hardwareCompatibility: { state: 'unavailable' } },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUniverse.mockResolvedValue({
    id: 'universe-1',
    name: 'Example Universe',
    influences: { embrace: [] },
    characters: [{ id: 'character-1', name: 'Example Character' }],
  });
  mocks.getSettings.mockResolvedValue({
    imageGen: { mode: 'local', local: { pythonPath: '/python', modelId: 'pinned-model' } },
  });
  mocks.enqueueJob.mockReturnValue({ jobId: 'job-1', position: 1 });
  mocks.getImageModels.mockReturnValue(models);
  mocks.buildUniverseRunTag.mockResolvedValue(null);
});

describe('renderCharacterReferenceSheet local model selection', () => {
  it('queues the install-pinned model when the request has no model override', async () => {
    await renderCharacterReferenceSheet('universe-1', 'character-1');

    expect(mocks.enqueueJob.mock.calls[0][0].params.modelId).toBe('pinned-model');
  });

  it('skips an incompatible install pin and queues the compatible default', async () => {
    mocks.getSettings.mockResolvedValue({
      imageGen: { mode: 'local', local: { pythonPath: '/python', modelId: 'incompatible-pin' } },
    });

    await renderCharacterReferenceSheet('universe-1', 'character-1');

    expect(mocks.enqueueJob.mock.calls[0][0].params.modelId).toBe('dev');
  });
});
