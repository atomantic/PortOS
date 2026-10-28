import { it, expect, vi, beforeEach } from 'vitest';
import { RUNNER_FAMILIES } from '../lib/runners.js';

vi.mock('../lib/imageCleanDefaults.js', () => ({
  resolveImageCleaners: vi.fn(() => ({ cleanC2PA: false, denoise: false })),
}));

const mocks = vi.hoisted(() => ({
  getUniverse: vi.fn(), getSettings: vi.fn(), enqueueJob: vi.fn(), getImageModels: vi.fn(),
  getIngredient: vi.fn(), listMedia: vi.fn(), listRelations: vi.fn(), missing: new Set(),
}));

vi.mock('./universeBuilder.js', () => ({
  getUniverse: (...args) => mocks.getUniverse(...args),
  updateUniverse: async (_id, update) => update(await mocks.getUniverse()),
}));
vi.mock('./settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('./mediaJobQueue/index.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { enqueueJob: (...args) => mocks.enqueueJob(...args), getJob: () => null, mediaJobEvents: new EventEmitter() };
});
vi.mock('./universeRunTag.js', () => ({ buildUniverseRunTag: async () => null }));
vi.mock('../lib/mediaModels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getImageModels: (...args) => mocks.getImageModels(...args),
}));
vi.mock('./catalogDB.js', () => ({
  getIngredient: (...args) => mocks.getIngredient(...args),
  listMediaForIngredient: (...args) => mocks.listMedia(...args),
  listRelationsForIngredient: (...args) => mocks.listRelations(...args),
}));
vi.mock('../lib/pathSafety.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveImageInputPath: (path) => (mocks.missing.has(path.split('/').pop()) ? null : `/example/images/${path.split('/').pop()}`),
}));

const { previewCharacterReferenceSheet, renderCharacterReferenceSheet } = await import('./universeCharacterSheet.js');

const records = {
  'ing-nora': { id: 'ing-nora', type: 'character', name: 'Nora', payload: { age: '30', physicalDescription: 'freckles, auburn hair', primaryImageRef: 'nora.png' } },
  'ing-frank': { id: 'ing-frank', type: 'character', name: 'Frank', payload: { age: '62', primaryImageRef: 'frank.png' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.missing.clear();
  mocks.getUniverse.mockResolvedValue({ id: 'universe-1', name: 'Example Universe',
    characters: [{ id: 'character-1', name: 'Mara', ingredientId: 'ing-mara' }] });
  mocks.getSettings.mockResolvedValue({ imageGen: { mode: 'local', local: { modelId: 'dev' } } });
  mocks.getImageModels.mockReturnValue([{ id: 'dev', runner: RUNNER_FAMILIES.FLUX2, hardwareCompatibility: { state: 'available' } }]);
  mocks.enqueueJob.mockResolvedValue({ jobId: 'job-1', position: 1 });
  mocks.getIngredient.mockImplementation(async (id) => records[id] || null);
  mocks.listMedia.mockResolvedValue([]);
  // Picked on Mara's record: wife of Frank, mother of Nora. An inbound edge and
  // a non-family edge must not reach the render.
  mocks.listRelations.mockResolvedValue({
    outbound: [
      { kind: 'wife-of', other: { id: 'ing-frank', type: 'character', name: 'Frank' } },
      { kind: 'mother-of', other: { id: 'ing-nora', type: 'character', name: 'Nora' } },
      { kind: 'lives-in', other: { id: 'ing-house', type: 'place', name: 'Example House' } },
    ],
    inbound: [{ kind: 'sister-of', other: { id: 'ing-aunt', type: 'character', name: 'Aunt' } }],
  });
});

it('sends each relative as a visible addition and their canonical images after the record’s own, blood relatives first', async () => {
  const preview = await previewCharacterReferenceSheet('universe-1', 'character-1');

  expect(preview.sentPrompt).toContain('Mara is the mother of Nora. Nora: age 30; freckles, auburn hair. Give Mara a believable family resemblance to Nora');
  expect(preview.sentPrompt).toContain('Make Mara look like a believable wife for Frank');
  expect(preview.sentPrompt).toContain('The attached images of Nora (blood relative), Frank (by marriage) show Mara’s family, not Mara.');
  expect(preview.sentPrompt).not.toContain('Use the attached canonical character images as the identity reference');
  for (const addition of preview.promptAdditions.filter((a) => a.id.startsWith('family'))) expect(preview.sentPrompt).toContain(addition.text);
  expect(preview.promptAdditions.map((a) => a.label)).toEqual(expect.arrayContaining([
    'Family · Wife of Frank', 'Family · Mother of Nora', 'Family reference images',
  ]));
  expect(preview.sentPrompt).not.toMatch(/Example House|Aunt/);
  expect(preview.referenceImages.map(({ filename, status, source }) => ({ filename, status, source }))).toEqual([
    { filename: 'nora.png', status: 'included', source: 'Mother of Nora · Primary canon image' },
    { filename: 'frank.png', status: 'included', source: 'Wife of Frank · Primary canon image' },
  ]);
});

it('never blocks the record’s own render on a relative’s unavailable image, and still sends the descriptions', async () => {
  mocks.missing.add('nora.png');
  mocks.getImageModels.mockReturnValue([{ id: 'dev', hardwareCompatibility: { state: 'available' } }]);

  await renderCharacterReferenceSheet('universe-1', 'character-1');

  const { params } = mocks.enqueueJob.mock.calls[0][0];
  expect(params.referenceImagePaths).toBeUndefined();
  expect(params.prompt).toContain('Mara is the mother of Nora.');
  expect(params.prompt).not.toContain('show Mara’s family');
});

it('adds nothing for a typed prompt override', async () => {
  const preview = await previewCharacterReferenceSheet('universe-1', 'character-1', { overridePrompt: 'Exactly this.' });
  expect(preview.sentPrompt).toBe('Exactly this.');
  expect(preview.promptAdditions.some((a) => a.id.startsWith('family'))).toBe(false);
});
