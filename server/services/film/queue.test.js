import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { __resetBlenderJobsForTests, activeBlenderJobs, listBlenderJobs, reserveBlenderSync, updateBlenderJob } from './jobs.js';
import { writeBlenderManifest } from './manifest.js';
import * as pending from './pending.js';
import { cancelBlenderJob, cancelBlenderProjectJobs, enqueueBlenderRenders, resumePendingBlenderRenders } from './queue.js';
import { runBlenderShotRender } from './renderJob.js';

vi.mock('../../lib/maintenanceAdmission.js', async (load) => ({
  ...await load(),
  maintenance: { run: (_category, _name, work) => work() },
}));
vi.mock('./encode.js', async (load) => ({ ...await load(), requireFfmpeg: vi.fn(async () => {}) }));
vi.mock('./renderJob.js', async (load) => ({ ...await load(), runBlenderShotRender: vi.fn(async () => {}) }));

const fps = 24;
let owner;

beforeEach(async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'portos-film-queue-'));
  owner = {
    kind: 'standalone-test', id: basename(workspaceDir), workspaceDir,
    readRecord: vi.fn(async () => ({ settings: { fps, concurrency: 1 } })),
    song: async () => null,
    timeline: async () => ({ durationSec: 3 }),
    emit: vi.fn(),
  };
  await mkdir(join(workspaceDir, 'src'));
  await writeBlenderManifest(owner, {
    fps, syncedAt: '2026-01-01T00:00:00.000Z',
    shots: ['a', 'b', 'c'].map((id, index) => ({
      id, start: index, end: index + 1, renderer: 'code', entry: 'shot.js',
    })),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (owner) {
    await cancelBlenderProjectJobs(owner);
    await vi.waitFor(() => expect(activeBlenderJobs(owner)).toEqual([]));
    await rm(owner.workspaceDir, { recursive: true, force: true });
  }
  __resetBlenderJobsForTests();
  runBlenderShotRender.mockReset();
});

const enqueue = (quality, ...shotIds) => enqueueBlenderRenders(owner, { quality, shotIds });
const dispatchOrder = () => runBlenderShotRender.mock.calls.map(([, { shotId, quality }]) => [shotId, quality]);

function holdFirstRender() {
  const { promise, resolve, reject } = Promise.withResolvers();
  runBlenderShotRender.mockImplementationOnce((entry) => {
    const { signal } = entry.abort;
    const abort = () => reject(new Error('Fixture render canceled'));
    signal.addEventListener('abort', abort, { once: true });
    updateBlenderJob(entry, { status: 'running' });
    return promise.finally(() => signal.removeEventListener('abort', abort));
  });
  return resolve;
}

it('prioritizes waiting stills and sheets over previews and finals, with FIFO within a priority', async () => {
  const release = holdFirstRender();
  await enqueue('final', 'a');
  await enqueue('final', 'b');
  await enqueue('preview', 'b', 'a');
  await enqueue('sheet', 'a');
  await enqueue('still', 'b');
  expect(dispatchOrder()).toEqual([['a', 'final']]);
  expect(await pending.readPendingBlenderRenders(owner)).toEqual([
    { quality: 'final', shotIds: ['a', 'b'], attempt: 0 },
    { quality: 'preview', shotIds: ['b', 'a'], attempt: 0 },
  ]);

  release();
  await vi.waitFor(() => expect(listBlenderJobs(owner).map(({ status }) => status)).toEqual(Array(6).fill('done')));

  expect(dispatchOrder()).toEqual([
    ['a', 'final'], ['a', 'sheet'], ['b', 'still'], ['b', 'preview'], ['a', 'preview'], ['b', 'final'],
  ]);
  expect(await pending.readPendingBlenderRenders(owner)).toEqual([]);
});

it('keeps a queued job intact if cancellation cannot remove its persisted intent', async () => {
  const release = holdFirstRender();
  await enqueue('final', 'a');
  const { jobs: [canceled, surviving] } = await enqueue('final', 'b', 'c');
  vi.spyOn(pending, 'removePendingBlenderShots').mockRejectedValueOnce(new Error('Fixture pending write failed'));

  await expect(cancelBlenderJob(owner, canceled.id)).rejects.toThrow('Fixture pending write failed');
  expect(activeBlenderJobs(owner).find(({ job }) => job.id === canceled.id)).toMatchObject({
    job: { status: 'queued' }, abort: { signal: { aborted: false } },
  });
  expect(await pending.readPendingBlenderRenders(owner)).toEqual([{ quality: 'final', shotIds: ['a', 'b', 'c'], attempt: 0 }]);

  await expect(cancelBlenderJob(owner, canceled.id)).resolves.toBe(true);
  expect(await pending.readPendingBlenderRenders(owner)).toEqual([{ quality: 'final', shotIds: ['a', 'c'], attempt: 0 }]);
  release();
  await vi.waitFor(() => expect(listBlenderJobs(owner)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: canceled.id, status: 'canceled' }),
    expect.objectContaining({ id: surviving.id, status: 'done' }),
  ])));
  expect(dispatchOrder()).toEqual([['a', 'final'], ['c', 'final']]);
});

it('restores previous pending intent when sync wins during an admission write', async () => {
  const previous = [{ quality: 'preview', shotIds: ['b'], attempt: 1 }];
  await pending.writePendingBlenderRenders(owner, previous);
  const persist = pending.writePendingBlenderRenders;
  let releaseSync;
  vi.spyOn(pending, 'writePendingBlenderRenders').mockImplementationOnce(async (...args) => {
    await persist(...args);
    releaseSync = reserveBlenderSync(owner);
  });

  try {
    await expect(enqueue('final', 'a')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_BLENDER_SYNC_IN_PROGRESS' });
    expect(await pending.readPendingBlenderRenders(owner)).toEqual(previous);
    expect(listBlenderJobs(owner)).toEqual([]);
    expect(runBlenderShotRender).not.toHaveBeenCalled();
  } finally {
    releaseSync?.();
  }
});

it('counts a failed boot recovery against the retry cap and drops only exhausted work', async () => {
  await pending.writePendingBlenderRenders(owner, [
    { quality: 'final', shotIds: ['a'], attempt: 1 },
    { quality: 'preview', shotIds: ['b'], attempt: 2 },
  ]);
  owner.readRecord.mockRejectedValueOnce(new Error('Fixture store unavailable'));
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

  await resumePendingBlenderRenders([owner], 2);

  expect(await pending.readPendingBlenderRenders(owner)).toEqual([{ quality: 'final', shotIds: ['a'], attempt: 2 }]);
  expect(errors).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalledWith(expect.stringContaining('retained 1 final shot(s) after an unexpected failure'));

  await resumePendingBlenderRenders([owner], 2);

  expect(await pending.readPendingBlenderRenders(owner)).toEqual([]);
  expect(owner.readRecord).toHaveBeenCalledOnce();
  expect(runBlenderShotRender).not.toHaveBeenCalled();
});
