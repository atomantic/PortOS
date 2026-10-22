import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const state = vi.hoisted(() => ({ jobs: [], enqueued: [], stitch: null }));

vi.mock('../mediaJobQueue/index.js', () => ({
  listJobs: vi.fn(({ kind }) => state.jobs.filter((j) => j.kind === kind)),
  enqueueJob: vi.fn(async (job) => {
    state.enqueued.push(job);
    return { jobId: `job-${state.enqueued.length}`, position: 1, status: 'queued' };
  }),
}));
vi.mock('./events.js', () => ({ videoGenEvents: new EventEmitter() }));
vi.mock('./stitchVideos.js', () => ({ stitchVideos: vi.fn((...args) => state.stitch(...args)) }));

const { enqueueStitch, runVideoStitch, cancel, STITCH_JOB_KIND } = await import('./stitchJob.js');
const { videoGenEvents } = await import('./events.js');

beforeEach(() => {
  state.jobs = [];
  state.enqueued = [];
  state.stitch = async (ids, { id }) => ({ id, stitchedFrom: ids });
  videoGenEvents.removeAllListeners();
});

describe('enqueueStitch', () => {
  it('returns the live job for the same ordered ids instead of queueing a second encode', async () => {
    state.jobs = [{ id: 'live', kind: STITCH_JOB_KIND, status: 'running', position: 1, params: { stitchKey: 'a,b' } }];
    await expect(enqueueStitch(['a', 'b'])).resolves.toMatchObject({ jobId: 'live', deduplicated: true });
    expect(state.enqueued).toHaveLength(0);
  });

  it('queues a different selection, a reordered one, and a repeat after the job settled', async () => {
    state.jobs = [
      { id: 'live', kind: STITCH_JOB_KIND, status: 'queued', params: { stitchKey: 'a,b' } },
      { id: 'done', kind: STITCH_JOB_KIND, status: 'completed', params: { stitchKey: 'c,d' } },
    ];
    await enqueueStitch(['a', 'c']);
    await enqueueStitch(['b', 'a']);
    await enqueueStitch(['c', 'd']);
    expect(state.enqueued.map((j) => j.params.stitchKey)).toEqual(['a,c', 'b,a', 'c,d']);
  });
});

describe('runVideoStitch', () => {
  it('stitches under the job id and emits completed with the new row', async () => {
    const done = vi.fn();
    videoGenEvents.on('completed', done);
    await runVideoStitch({ jobId: 'j1', videoIds: ['a', 'b'] });
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'j1', id: 'j1' }));
  });

  it('cancel aborts the signal handed to stitchVideos and settles as failed', async () => {
    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    state.stitch = (ids, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Stitch canceled')));
    });
    const run = runVideoStitch({ jobId: 'j2', videoIds: ['a', 'b'] });
    expect(cancel('j2')).toBe(true);
    await run;
    expect(failed).toHaveBeenCalledWith({ generationId: 'j2', error: 'Canceled while running' });
    expect(cancel('j2')).toBe(false);
  });
});
