import { describe, expect, it, vi } from 'vitest';

// Contract of the shared hosted job lifecycle (#16098), driven through a minimal
// adapter shaped like every hosted one (prepare → start → track → submit → poll → publish).
const m = vi.hoisted(() => ({ atomicWrite: vi.fn(async () => {}), unlink: vi.fn(async () => {}) }));
vi.mock('../../lib/fileUtils.js', async (load) => ({ ...await load(), atomicWrite: m.atomicWrite, unlinkGuarded: m.unlink }));
vi.mock('./frameGuard.js', () => ({ rejectDegenerateFrame: async () => null }));
vi.mock('../../lib/imageClean.js', () => ({ autoCleanGeneratedImage: async () => {} }));

import { imageGenEvents } from '../imageGenEvents.js';
import { createHostedImageJobRunner } from './hostedJobRunner.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

const gate = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const terminalEvent = (jobId) => new Promise((resolve) => {
  const on = (type) => (payload) => {
    if (payload.generationId !== jobId) return;
    imageGenEvents.off('failed', onFailed);
    imageGenEvents.off('completed', onCompleted);
    resolve({ type, ...payload });
  };
  const onFailed = on('failed');
  const onCompleted = on('completed');
  imageGenEvents.on('failed', onFailed);
  imageGenEvents.on('completed', onCompleted);
});

const sseClient = () => {
  const frames = [];
  return { frames, writeHead: vi.fn(), write: (frame) => frames.push(JSON.parse(frame.slice('data: '.length))), end: vi.fn(), req: { on: vi.fn() } };
};

function exampleProvider() {
  const cancelRemote = vi.fn(async () => {});
  const runner = createHostedImageJobRunner({ mode: 'example', provider: 'Example', cancelRemote });
  const gates = { prepare: gate(), submit: gate(), poll: gate() };
  const reached = { submit: gate(), poll: gate() };
  const generate = (params) => runner.prepare(params, async ({ jobId }) => {
    await gates.prepare.promise;
    const meta = runner.jobMeta({
      jobId, prompt: 'A lighthouse at dusk', inputImages: { initPath: null, referencePaths: [], paths: [] }, sentRecord: {}, modelFields: { model: 'example/model' },
    });
    return runner.start({
      meta, renderStartedAtMs: Date.now(), model: 'example/model', status: 'Submitting…',
      run: async (job) => {
        const entry = runner.track(jobId, { controller: new AbortController() });
        try {
          reached.submit.resolve();
          await gates.submit.promise;
          if (entry.aborted) return runner.finalizeCanceled(job, jobId);
          reached.poll.resolve();
          const polled = await gates.poll.promise;
          if (polled.outcome === 'canceled') return runner.finalizeCanceled(job, jobId);
          await runner.publish({ job, entry, meta, bytes: PNG, sidecarFields: {}, doneNote: 'Example' });
        } catch (err) {
          await runner.failRun(job, entry, `Example image generation failed: ${err.message}`);
        }
      },
    });
  });
  return { runner, cancelRemote, gates, reached, generate };
}

describe('hosted image job runner contract', () => {
  it('carries a cancel received while preparing onto the render handle without a remote cancel', async () => {
    const { runner, cancelRemote, gates, generate } = exampleProvider();
    const jobId = 'prepare-cancel';
    const terminal = terminalEvent(jobId);
    const pending = generate({ jobId });
    expect(runner.cancel(jobId)).toBe('pending');
    gates.prepare.resolve();
    gates.submit.resolve();
    await pending;
    expect(await terminal).toMatchObject({ type: 'failed', mode: 'example', error: 'Canceled' });
    expect(cancelRemote).not.toHaveBeenCalled();
  });

  it('cancels a submitting render remotely and finalizes it as canceled', async () => {
    const { runner, cancelRemote, gates, reached, generate } = exampleProvider();
    const jobId = 'submit-cancel';
    const terminal = terminalEvent(jobId);
    gates.prepare.resolve();
    await generate({ jobId });
    await reached.submit.promise;
    expect(runner.cancel(jobId)).toBe(true);
    gates.submit.resolve();
    expect(await terminal).toMatchObject({ type: 'failed', error: 'Canceled' });
    expect(cancelRemote).toHaveBeenCalledTimes(1);
  });

  it('cancels a polling render remotely exactly once, even when cancel is repeated', async () => {
    const { runner, cancelRemote, gates, reached, generate } = exampleProvider();
    const jobId = 'poll-cancel';
    const terminal = terminalEvent(jobId);
    gates.prepare.resolve();
    gates.submit.resolve();
    await generate({ jobId });
    await reached.poll.promise;
    expect(runner.cancelAll()).toBe(true);
    gates.poll.resolve({ outcome: 'canceled' });
    expect(await terminal).toMatchObject({ type: 'failed', error: 'Canceled' });
    expect(runner.cancel(jobId)).toBe(false);
    expect(cancelRemote).toHaveBeenCalledTimes(1);
    expect(runner.getActiveJobs()).toEqual([]);
  });

  it('finalizes an unanticipated failure: remote request abandoned, error frame replayed to a late client', async () => {
    const { runner, cancelRemote, gates, reached, generate } = exampleProvider();
    const jobId = 'poll-failure';
    const terminal = terminalEvent(jobId);
    gates.prepare.resolve();
    gates.submit.resolve();
    await generate({ jobId });
    await reached.poll.promise;
    gates.poll.reject(new Error('connection reset'));
    expect(await terminal).toMatchObject({ type: 'failed', error: 'Example image generation failed: connection reset' });
    expect(cancelRemote).toHaveBeenCalledTimes(1);
    const client = sseClient();
    expect(runner.attachSseClient(jobId, client)).toBe(true);
    expect(client.frames).toEqual([{ type: 'error', error: 'Example image generation failed: connection reset' }]);
  });

  it('publishes a completed render and replays the complete frame to a client attaching afterwards', async () => {
    const { runner, cancelRemote, gates, generate } = exampleProvider();
    const jobId = 'completes';
    const terminal = terminalEvent(jobId);
    gates.prepare.resolve();
    gates.submit.resolve();
    gates.poll.resolve({ outcome: 'completed' });
    expect(await generate({ jobId })).toMatchObject({ jobId, filename: `${jobId}.png`, mode: 'example', status: 'running' });
    expect(await terminal).toMatchObject({ type: 'completed', path: `/data/images/${jobId}.png` });
    expect(m.atomicWrite).toHaveBeenCalledWith(expect.stringContaining(`${jobId}.metadata.json`), expect.objectContaining({ id: jobId, model: 'example/model' }));
    expect(runner.getActiveJob()).toBeNull();
    const client = sseClient();
    expect(runner.attachSseClient(jobId, client)).toBe(true);
    expect(client.frames).toEqual([{ type: 'complete', result: { filename: `${jobId}.png`, path: `/data/images/${jobId}.png` } }]);
    expect(cancelRemote).not.toHaveBeenCalled();
  });
});
