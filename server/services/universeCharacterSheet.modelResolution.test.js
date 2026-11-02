import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/imageCleanDefaults.js', () => ({
  resolveImageCleaners: vi.fn(() => ({ cleanC2PA: false, denoise: false })),
}));

const mocks = vi.hoisted(() => ({
  getUniverse: vi.fn(),
  getSettings: vi.fn(),
  enqueueJob: vi.fn(),
  getImageModels: vi.fn(),
  buildUniverseRunTag: vi.fn(),
  claimPendingSheetSlot: vi.fn(),
}));

vi.mock('./universeBuilder.js', () => ({ getUniverse: (...args) => mocks.getUniverse(...args), updateUniverse: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('./mediaJobQueue/index.js', () => ({
  enqueueJob: (...args) => mocks.enqueueJob(...args),
  getJob: vi.fn(),
  mediaJobEvents: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('./universeRunTag.js', () => ({ buildUniverseRunTag: (...args) => mocks.buildUniverseRunTag(...args) }));
vi.mock('./universeCharacterSheetSlot.js', () => ({
  claimPendingSheetSlot: (...args) => mocks.claimPendingSheetSlot(...args),
  getPendingSheetSlot: vi.fn(),
  releasePendingSheetSlot: vi.fn(),
}));
vi.mock('../lib/mediaModels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getImageModels: (...args) => mocks.getImageModels(...args),
}));

import { renderCharacterReferenceSheet, previewCharacterReferenceSheet } from './universeCharacterSheet.js';

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

// Uniquely catches the sheet's universe style reaching the model unlisted, or a
// typed override being labeled with blocks it never carried (#11317).
describe('renderCharacterReferenceSheet prompt additions', () => {
  it('lists the universe style and sheet negatives on a template render, and nothing on an override', async () => {
    mocks.getUniverse.mockResolvedValue({
      id: 'universe-1', name: 'Example Universe',
      influences: { embrace: ['ink wash'] },
      characters: [{ id: 'character-1', name: 'Example Character' }],
    });
    await renderCharacterReferenceSheet('universe-1', 'character-1');
    const { params } = mocks.enqueueJob.mock.calls[0][0];
    expect(params.promptAdditions.map((item) => item.id)).toEqual(['universe-style', 'sheet-negatives']);
    expect(params.prompt).toContain(params.promptAdditions[0].text);

    await renderCharacterReferenceSheet('universe-1', 'character-1', { overridePrompt: 'my own sheet', overrideNegativePrompt: 'blur' });
    expect(mocks.enqueueJob.mock.calls[1][0].params.promptAdditions).toBeUndefined();
  });
});

// Uniquely catches authored list entries lost between preview and queued render,
// while keeping fixed sheet layouts coherent for both long and short lists.
describe('character sheet authored lists', () => {
  it.each(['standard', 'photographic', 'face'])('preserves complete expression context in %s preview and render', async (variant) => {
    const expressions = Array.from({ length: 8 }, (_, i) => ({ name: `expression-${i + 1}`, description: `face detail ${i + 1}` }));
    const handGestures = Array.from({ length: 8 }, (_, i) => ({ name: `gesture-${i + 1}`, description: `hand detail ${i + 1}` }));
    mocks.getUniverse.mockResolvedValue({
      id: 'universe-1', name: 'Example Universe', influences: { embrace: [] },
      characters: [{ id: 'character-1', name: 'Example Character', expressions, handGestures }],
    });
    const preview = await previewCharacterReferenceSheet('universe-1', 'character-1', { variant });
    await renderCharacterReferenceSheet('universe-1', 'character-1', { variant });
    const { prompt } = mocks.enqueueJob.mock.calls[0][0].params;
    expect(preview.sentPrompt).toBe(prompt);
    for (const expression of expressions) expect(prompt).toContain(`${expression.name} (${expression.description})`);
    if (variant === 'standard') {
      for (const gesture of handGestures) expect(prompt).toContain(`${gesture.name} (${gesture.description})`);
      expect(prompt).toContain('exactly five labeled hand close-ups');
      expect(prompt).toContain('if more, choose five without adding frames');
    }
    if (variant !== 'face') {
      expect(prompt).toContain('exactly seven head-and-shoulders');
      expect(prompt).toContain('if more, choose seven without adding frames');
    }
  });

  it.each(['standard', 'photographic'])('keeps supplied values and fills the %s layout when lists are short', async (variant) => {
    mocks.getUniverse.mockResolvedValue({
      id: 'universe-1', name: 'Example Universe', influences: { embrace: [] },
      characters: [{ id: 'character-1', name: 'Example Character', expressions: [{ name: 'authored expression' }], handGestures: [{ name: 'authored gesture' }] }],
    });
    const preview = await previewCharacterReferenceSheet('universe-1', 'character-1', { variant });
    await renderCharacterReferenceSheet('universe-1', 'character-1', { variant });
    expect(preview.sentPrompt).toBe(mocks.enqueueJob.mock.calls[0][0].params.prompt);
    expect(preview.sentPrompt).toContain('authored expression');
    expect(preview.sentPrompt).toContain('show each supplied expression and add variations to fill the row');
    if (variant === 'standard') {
      expect(preview.sentPrompt).toContain('authored gesture');
      expect(preview.sentPrompt).toContain('show each supplied gesture and add variations to fill the row');
    }
  });
});
