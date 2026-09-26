import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUniverse: vi.fn(),
  getSettings: vi.fn(),
  enqueueJob: vi.fn(),
  getImageModels: vi.fn(),
  buildUniverseRunTag: vi.fn(),
  copy: vi.fn(), update: vi.fn(),
}));

vi.mock('./universeBuilder.js', () => ({ getUniverse: (...args) => mocks.getUniverse(...args), updateUniverse: (...args) => mocks.update(...args) }));
vi.mock('./settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('./mediaJobQueue/index.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { enqueueJob: (...args) => mocks.enqueueJob(...args), mediaJobEvents: new EventEmitter() };
});
vi.mock('../lib/fileUtils.js', async importOriginal => ({
  ...(await importOriginal()), ensureDir: vi.fn(), copyFileGuarded: (...args) => mocks.copy(...args),
}));
vi.mock('./universeRunTag.js', () => ({ buildUniverseRunTag: (...args) => mocks.buildUniverseRunTag(...args) }));
vi.mock('./imageGen/index.js', () => ({
  IMAGE_GEN_MODE: { LOCAL: 'local', CODEX: 'codex', EXTERNAL: 'external' },
  resolveImageCleaners: vi.fn(() => ({ cleanC2PA: false, denoise: false })),
}));
vi.mock('../lib/mediaModels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getImageModels: (...args) => mocks.getImageModels(...args),
}));

import { renderCharacterReferenceSheet, getCharacterReferenceSheet } from './universeCharacterSheet.js';


import { mediaJobEvents } from './mediaJobQueue/index.js';
import { claimPendingSheetSlot } from './universeCharacterSheetSlot.js';

let universe;
beforeEach(() => {
  vi.clearAllMocks();
  universe = { id: 'universe-1', name: 'Example Universe', characters: [{ id: 'character-1', name: 'Example Character' }] };
  mocks.getUniverse.mockImplementation(async () => universe);
  mocks.getSettings.mockResolvedValue({ imageGen: { mode: 'local', local: { modelId: 'dev' } } });
  mocks.getImageModels.mockReturnValue([{ id: 'dev', hardwareCompatibility: { state: 'available' } }]);
  mocks.buildUniverseRunTag.mockResolvedValue(null);
  mocks.enqueueJob.mockResolvedValue({ jobId: 'job-1', position: 1 });
  mocks.copy.mockResolvedValue();
  mocks.update.mockImplementation(async (_id, update) => { universe = { ...universe, ...update(universe) }; });
});
const completed = () => mediaJobEvents.emit('completed', { id: 'job-1', result: { filename: 'render.png' } });
const publication = () => new Promise(resolve => mediaJobEvents.once('reference-sheet:changed', resolve));

it('announces readiness only after the destination copy and pointer persistence, with correlated recovery state', async () => {
  let finishCopy;
  mocks.copy.mockImplementation(() => new Promise(resolve => { finishCopy = resolve; }));
  let finishWrite;
  mocks.update.mockImplementation((_id, update) => new Promise(resolve => {
    finishWrite = () => { universe = { ...universe, ...update(universe) }; resolve(); };
  }));
  const queued = await renderCharacterReferenceSheet('universe-1', 'character-1');
  const listener = vi.fn();
  mediaJobEvents.on('reference-sheet:changed', listener);
  const result = publication();
  completed();
  await vi.waitFor(() => expect(finishCopy).toBeTypeOf('function'));
  expect(listener).not.toHaveBeenCalled();
  finishCopy();
  await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
  expect(listener).not.toHaveBeenCalled();
  finishWrite();
  expect(await result).toEqual({ universeId: 'universe-1', entryId: 'character-1', jobId: 'job-1', variant: 'standard', status: 'ready' });
  expect(await getCharacterReferenceSheet('universe-1', 'character-1')).toEqual({ filename: queued.destFilename, pendingJobId: null });
  mediaJobEvents.off('reference-sheet:changed', listener);
});

it('reports copy failure and releases pending state for reconnect recovery', async () => {
  mocks.copy.mockRejectedValue(new Error('Example copy failure'));
  await renderCharacterReferenceSheet('universe-1', 'character-1');
  const result = publication();
  completed();
  expect(await result).toMatchObject({ jobId: 'job-1', status: 'failed' });
  expect(mocks.update).not.toHaveBeenCalled();
  expect(await getCharacterReferenceSheet('universe-1', 'character-1')).toMatchObject({ pendingJobId: null });
});

it('does not stamp an older render when another job claims the slot during the queued write', async () => {
  mocks.update.mockImplementation(async (_id, update) => {
    claimPendingSheetSlot('universe-1', 'character-1', 'new-job');
    expect(update(universe)).toBeNull();
  });
  await renderCharacterReferenceSheet('universe-1', 'character-1');
  const result = publication();
  completed();
  await result;
  expect(await getCharacterReferenceSheet('universe-1', 'character-1')).toMatchObject({ pendingJobId: 'new-job' });
});
