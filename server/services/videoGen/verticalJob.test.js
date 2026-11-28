import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const state = vi.hoisted(() => ({ jobs: [], enqueued: [], size: { width: 1280, height: 720 }, run: null }));

vi.mock('../mediaJobQueue/index.js', () => ({
  listJobs: vi.fn(({ kind }) => state.jobs.filter((j) => j.kind === kind)),
  enqueueJob: vi.fn(async (job) => {
    state.enqueued.push(job);
    return { jobId: `job-${state.enqueued.length}`, position: 1, status: 'queued' };
  }),
}));
vi.mock('./events.js', () => ({ videoGenEvents: new EventEmitter() }));
vi.mock('./upscaleVideo.js', () => ({
  resolveHistoryItem: vi.fn(async (id) => ({ id, filename: 'a.mp4' })),
  resolveSourcePath: vi.fn(() => '/videos/a.mp4'),
}));
vi.mock('../../lib/ffmpeg.js', () => ({ probeVideoStreamInfo: vi.fn(async () => state.size) }));
vi.mock('./verticalReframe.js', () => ({ verticalReframeHistoryItem: vi.fn((...a) => state.run(...a)) }));

const { enqueueVertical, runVideoVertical, cancel, VERTICAL_JOB_KIND } = await import('./verticalJob.js');
const { videoGenEvents } = await import('./events.js');

beforeEach(() => {
  state.jobs = [];
  state.enqueued = [];
  state.size = { width: 1280, height: 720 };
  state.run = async (id, ratio, { id: newId }) => ({ id: newId, verticalFrom: id });
  videoGenEvents.removeAllListeners();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enqueueVertical', () => {
  it('queues a landscape clip', async () => {
    await expect(enqueueVertical('v1', '9:16')).resolves.toMatchObject({ jobId: 'job-1' });
    expect(state.enqueued[0].params).toMatchObject({ historyId: 'v1', ratio: '9:16' });
  });

  it('coalesces concurrent identical requests into one job', async () => {
    const [a, b] = await Promise.all([enqueueVertical('v1', '9:16'), enqueueVertical('v1', '9:16')]);
    expect(state.enqueued).toHaveLength(1);
    expect(b).toMatchObject({ jobId: a.jobId, deduplicated: true });
  });

  it('refuses an already-vertical clip with a 400', async () => {
    state.size = { width: 720, height: 1280 };
    await expect(enqueueVertical('v1', '9:16')).rejects.toMatchObject({ status: 400, code: 'ALREADY_VERTICAL' });
    expect(state.enqueued).toHaveLength(0);
  });

  it('returns the live job for an identical clip and ratio', async () => {
    state.jobs = [{ id: 'live', kind: VERTICAL_JOB_KIND, status: 'running', position: 1, params: { verticalKey: 'v1:9:16' } }];
    await expect(enqueueVertical('v1', '9:16')).resolves.toMatchObject({ jobId: 'live', deduplicated: true });
    await enqueueVertical('v1', '1:1');
    expect(state.enqueued).toHaveLength(1);
  });
});

describe('runVideoVertical', () => {
  it('emits completed with the new row', async () => {
    const done = vi.fn();
    videoGenEvents.on('completed', done);
    await runVideoVertical({ jobId: 'j1', historyId: 'v1', ratio: '9:16' });
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'j1', id: 'j1' }));
  });

  it('cancel aborts and settles as failed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    state.run = (id, ratio, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('x'))));
    const run = runVideoVertical({ jobId: 'j2', historyId: 'v1', ratio: '9:16' });
    expect(cancel('j2')).toBe(true);
    await run;
    expect(failed).toHaveBeenCalledWith({ generationId: 'j2', error: 'Canceled while running' });
    expect(log).toHaveBeenCalledWith('🛑 Vertical export canceled [j2]: Canceled while running');
    expect(error).not.toHaveBeenCalled();
  });

  it('logs an encode failure to stderr', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.run = async () => { throw new Error('Encode failed'); };
    await runVideoVertical({ jobId: 'j3', historyId: 'v1', ratio: '9:16' });
    expect(error).toHaveBeenCalledWith('❌ Vertical export failed [j3]: Encode failed');
  });
});
