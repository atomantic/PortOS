import { it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/imageCleanDefaults.js', () => ({
  resolveImageCleaners: vi.fn(() => ({ cleanC2PA: false, denoise: false })),
}));

const mocks = vi.hoisted(() => ({
  getUniverse: vi.fn(),
  getSettings: vi.fn(),
  enqueueJob: vi.fn(), getJob: vi.fn(),
  getImageModels: vi.fn(),
  buildUniverseRunTag: vi.fn(),
  copy: vi.fn(), update: vi.fn(),
}));

vi.mock('./universeBuilder.js', () => ({ getUniverse: (...args) => mocks.getUniverse(...args), updateUniverse: (...args) => mocks.update(...args) }));
vi.mock('./settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('./mediaJobQueue/index.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { enqueueJob: (...args) => mocks.enqueueJob(...args), getJob: (...args) => mocks.getJob(...args), mediaJobEvents: new EventEmitter() };
});
vi.mock('../lib/fileUtils.js', async importOriginal => ({
  ...(await importOriginal()), ensureDir: vi.fn(), copyFileGuarded: (...args) => mocks.copy(...args),
}));
vi.mock('./universeRunTag.js', () => ({ buildUniverseRunTag: (...args) => mocks.buildUniverseRunTag(...args) }));
vi.mock('../lib/mediaModels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getImageModels: (...args) => mocks.getImageModels(...args),
}));

import { renderCharacterReferenceSheet, getCharacterReferenceSheet } from './universeCharacterSheet.js';


import { mediaJobEvents } from './mediaJobQueue/index.js';
import { __testing as slots } from './universeCharacterSheetSlot.js';

let universe;
beforeEach(() => {
  vi.clearAllMocks();
  slots.reset();
  universe = { id: 'universe-1', name: 'Example Universe', characters: [{ id: 'character-1', name: 'Example Character' }] };
  mocks.getUniverse.mockImplementation(async () => universe);
  mocks.getSettings.mockResolvedValue({ imageGen: { mode: 'local', local: { modelId: 'dev' } } });
  mocks.getImageModels.mockReturnValue([{ id: 'dev', hardwareCompatibility: { state: 'available' } }]);
  mocks.buildUniverseRunTag.mockResolvedValue(null);
  mocks.getJob.mockReturnValue(null);
  mocks.enqueueJob.mockResolvedValue({ jobId: 'job-1', position: 1 });
  mocks.copy.mockResolvedValue();
  mocks.update.mockImplementation(async (_id, update) => { universe = { ...universe, ...update(universe) }; });
});
const queuedJob = (index = 0) => ({ id: `job-${index + 1}`, params: structuredClone(mocks.enqueueJob.mock.calls[index][0].params), result: { filename: 'render.png' } });
const completed = (job = queuedJob()) => mediaJobEvents.emit('completed', job);
afterEach(() => vi.useRealTimers());
const publication = () => new Promise(resolve => mediaJobEvents.once('reference-sheet:changed', resolve));

it('announces readiness only after the destination copy and pointer persistence, with correlated recovery state', async () => {
  let finishCopy;
  mocks.copy.mockImplementation(() => new Promise(resolve => { finishCopy = resolve; }));
  const queued = await renderCharacterReferenceSheet('universe-1', 'character-1');
  let finishWrite;
  mocks.update.mockImplementation((_id, update) => new Promise(resolve => {
    finishWrite = () => { universe = { ...universe, ...update(universe) }; resolve(); };
  }));
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
  expect(mocks.update).toHaveBeenCalledTimes(1); // Only the durable request claim.
  expect(await getCharacterReferenceSheet('universe-1', 'character-1')).toMatchObject({ pendingJobId: null });
});

it('publishes from persisted job metadata after restart without a subscriber or pending slot', async () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  universe.characters[0].referenceSheetRequests = { blueprint: requestId };
  const result = publication();
  completed({ id: 'recovered-job', params: { characterSheet: {
    universeId: 'universe-1', entryId: 'character-1', variant: 'blueprint', requestId,
  } }, result: { filename: 'recovered.png' } });
  expect(await result).toMatchObject({ jobId: 'recovered-job', variant: 'blueprint', status: 'ready' });
  expect(mocks.copy).toHaveBeenCalledOnce();
  expect(universe.characters[0].referenceSheets.blueprint).toContain('recovere');
});

it('releases an expired listener slot and still publishes its later completion', async () => {
  vi.useFakeTimers();
  await renderCharacterReferenceSheet('universe-1', 'character-1');
  await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
  expect(await getCharacterReferenceSheet('universe-1', 'character-1')).toMatchObject({ pendingJobId: null });
  const result = publication();
  completed();
  expect(await result).toMatchObject({ status: 'ready' });
});

it('keeps newer intent after restart even when its render fails and an older job completes last', async () => {
  await renderCharacterReferenceSheet('universe-1', 'character-1');
  const older = queuedJob();
  mocks.enqueueJob.mockResolvedValue({ jobId: 'job-2', position: 2 });
  await renderCharacterReferenceSheet('universe-1', 'character-1');
  const newer = queuedJob(1);
  mediaJobEvents.emit('failed', newer);
  slots.reset();
  const result = publication();
  completed(older);
  expect(await result).toMatchObject({ status: 'superseded' });
  expect(universe.characters[0].referenceSheetImageRef).toBeUndefined();
});

it('preserves the newest completed pointer and independently rendered variants', async () => {
  await renderCharacterReferenceSheet('universe-1', 'character-1');
  const older = queuedJob();
  mocks.enqueueJob.mockResolvedValue({ jobId: 'job-2', position: 2 });
  await renderCharacterReferenceSheet('universe-1', 'character-1');
  const newer = queuedJob(1);
  const ready = publication();
  completed(newer);
  expect(await ready).toMatchObject({ status: 'ready' });
  const filename = universe.characters[0].referenceSheetImageRef;
  slots.reset();
  const stale = publication();
  completed(older);
  expect(await stale).toMatchObject({ status: 'superseded' });
  expect(universe.characters[0].referenceSheetImageRef).toBe(filename);

  mocks.enqueueJob.mockResolvedValue({ jobId: 'job-3', position: 3 });
  await renderCharacterReferenceSheet('universe-1', 'character-1', { variant: 'blueprint' });
  const blueprint = publication();
  completed(queuedJob(2));
  expect(await blueprint).toMatchObject({ status: 'ready' });
  expect(universe.characters[0].referenceSheetImageRef).toBe(filename);
  expect(universe.characters[0].referenceSheets.blueprint).toContain('job-3');
});

it('does not enqueue if the durable claim fails', async () => {
  mocks.update.mockRejectedValue(new Error('request write failed'));
  await expect(renderCharacterReferenceSheet('universe-1', 'character-1')).rejects.toThrow('request write failed');
  expect(mocks.enqueueJob).not.toHaveBeenCalled();
});

it('rechecks supersession when the pointer write waits behind a newer request', async () => {
  await renderCharacterReferenceSheet('universe-1', 'character-1');
  const job = queuedJob();
  let finishWrite;
  mocks.update.mockImplementation((_id, update) => new Promise(resolve => {
    finishWrite = () => { universe = { ...universe, ...update(universe) }; resolve(); };
  }));
  const result = publication();
  completed(job);
  await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
  universe.characters[0].referenceSheetRequests.standard = '22222222-2222-4222-8222-222222222222';
  finishWrite();
  expect(await result).toMatchObject({ status: 'superseded' });
  expect(universe.characters[0].referenceSheetImageRef).toBeUndefined();
});

it('does not reclaim pending state when a fast job publishes before enqueue returns', async () => {
  mocks.enqueueJob.mockImplementation(async ({ params }) => {
    const job = { id: 'fast-job', status: 'completed', params, result: { filename: 'fast.png' } };
    const result = publication();
    completed(job);
    expect(await result).toMatchObject({ status: 'ready' });
    mocks.getJob.mockReturnValue(job);
    return { jobId: job.id, position: 1, status: 'queued' };
  });
  const queued = await renderCharacterReferenceSheet('universe-1', 'character-1');
  expect(await getCharacterReferenceSheet('universe-1', 'character-1')).toEqual({ filename: queued.destFilename, pendingJobId: null });
});
