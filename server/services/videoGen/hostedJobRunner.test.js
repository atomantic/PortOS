import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { cleanupTempDataRoots, mockTestIdentity } from '../../lib/mockPathsDataRoot.js';
import { SSE_CLEANUP_DELAY_MS } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { loadHistory, saveHistory } from './history.js';
import { createHostedVideoJobRunner } from './hostedJobRunner.js';

const media = vi.hoisted(() => ({
  probe: vi.fn(),
  optimize: vi.fn(),
  thumbnail: vi.fn(),
}));
vi.mock('../../lib/paths.js', async (load) => {
  const { lazyTempDataRoot, makePathsProxy } = await import('../../lib/mockPathsDataRoot.js');
  return makePathsProxy(await load(), {
    dataRoot: () => lazyTempDataRoot('portos-hosted-video-runner-'),
  });
});
vi.mock('../../lib/ffmpeg.js', () => ({
  probeVideoGeometry: media.probe,
  optimizeForStreaming: media.optimize,
  generateThumbnail: media.thumbnail,
  probeFrameCount: vi.fn(),
  probeVideoDuration: vi.fn(),
}));
vi.mock('../instanceIdentity.js', () => mockTestIdentity());
vi.mock('../peerSyncEventBus.js', () => ({ announceLocalVideoRows: () => {} }));

const bytes = Buffer.from('fixture video');
const geometry = { durationSec: 5, width: 1280, height: 720 };
const missing = { code: 'ENOENT' };

let runner;
let cancelRemote;
let abandonRemote;
let failed;
let completed;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  media.probe.mockReset().mockResolvedValue(geometry);
  media.optimize.mockReset().mockResolvedValue(undefined);
  media.thumbnail.mockReset().mockResolvedValue(null);
  cancelRemote = vi.fn(async () => {});
  abandonRemote = vi.fn(async () => {});
  runner = createHostedVideoJobRunner({ mode: 'example', provider: 'Example', cancelRemote, abandonRemote });
  failed = vi.fn();
  completed = vi.fn();
  videoGenEvents.on('failed', failed);
  videoGenEvents.on('completed', completed);
  await mkdir(PATHS.videos, { recursive: true });
  await mkdir(PATHS.uploads, { recursive: true });
  await saveHistory([]);
});

afterEach(() => {
  videoGenEvents.off('failed', failed);
  videoGenEvents.off('completed', completed);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(cleanupTempDataRoots);

function start(jobId, work, inputs = []) {
  const meta = { id: jobId, filename: `${jobId}.mp4`, prompt: 'A lighthouse at dusk' };
  const entry = { controller: new AbortController() };
  const outputPath = join(PATHS.videos, meta.filename);
  let settled;
  const descriptor = runner.start({
    meta,
    renderStartedAtMs: Date.now(),
    logDetail: 'fixture',
    run: (job) => {
      const lifecycle = runner.begin(job, entry, { inputs });
      settled = Promise.resolve().then(() => work({
        ...lifecycle,
        outputPath,
        publish: (options) => lifecycle.publish({ buffer: bytes, meta, ...options }),
      })).catch(lifecycle.fail);
      return settled;
    },
  });
  return { descriptor, entry, outputPath, settled };
}

function attach(jobId) {
  const frames = [];
  const client = {
    writeHead: vi.fn(),
    write: (frame) => frames.push(JSON.parse(frame.slice('data: '.length))),
    end: vi.fn(),
    req: { on: vi.fn() },
  };
  expect(runner.attachSseClient(jobId, client)).toBe(true);
  expect(client.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'text/event-stream' }));
  return { client, frames };
}

function expectFailed(jobId, error, extras = {}) {
  expect(failed).toHaveBeenCalledExactlyOnceWith({ generationId: jobId, error, ...extras });
  expect(completed).not.toHaveBeenCalled();
  expect(runner.getActiveJobs()).toEqual([]);
  expect(runner.cancel(jobId)).toBe(false);
  expect(attach(jobId).frames).toEqual([error === 'Canceled' ? { type: 'canceled', reason: error } : { type: 'error', error, ...extras }]);
}

describe('hosted video runner contract', () => {
  it('hands preparation cancellation to the render without submitting or canceling remotely', async () => {
    const jobId = 'prepare-cancel';
    const prepare = Promise.withResolvers();
    const submit = vi.fn();
    const pending = runner.prepare({ jobId }, async ({ jobId: preparedId }) => {
      await prepare.promise;
      return start(preparedId, ({ entry, finishFailure }) => {
        if (entry.aborted) return finishFailure('Canceled');
        return submit();
      });
    });
    expect(runner.cancel(jobId)).toBe('pending');
    prepare.resolve();
    const job = await pending;
    await job.settled;
    expect(submit).not.toHaveBeenCalled();
    expect(cancelRemote).not.toHaveBeenCalled();
    expectFailed(jobId, 'Canceled');
    expect(runner.cancelAll()).toBe(false);
  });

  it('refuses anonymous cancellation while two requests remain active', async () => {
    const finish = Promise.withResolvers();
    const work = async ({ finishFailure }) => {
      await finish.promise;
      return finishFailure('Canceled');
    };
    const first = start('first', work);
    const second = start('second', work);
    try {
      expect(() => runner.cancel()).toThrow('cancel requires a jobId');
      expect(first.entry.controller.signal.aborted).toBe(false);
      expect(second.entry.controller.signal.aborted).toBe(false);
      expect(cancelRemote).not.toHaveBeenCalled();
      expect(runner.getActiveJobs().map((job) => job.generationId)).toEqual(['first', 'second']);
      expect(runner.cancel('first')).toBe(true);
      expect(first.entry.controller.signal.aborted).toBe(true);
      expect(second.entry.controller.signal.aborted).toBe(false);
      expect(cancelRemote).toHaveBeenCalledExactlyOnceWith(first.entry);
    } finally {
      finish.resolve();
      await Promise.all([first.settled, second.settled]);
    }
    expect(runner.getActiveJobs()).toEqual([]);
    expect(runner.cancelAll()).toBe(false);
  });

  it('discards a canceled write before probing the output', async () => {
    const jobId = 'cancel-write';
    const job = start(jobId, async ({ publish }) => {
      const writing = publish();
      runner.cancel(jobId);
      return writing;
    });
    const { frames } = attach(jobId);
    expect(frames).toEqual([{ type: 'status', phase: 'submit', message: 'Submitting to Example…' }]);
    expect(await job.settled).toBe(false);
    expect(job.entry.controller.signal.aborted).toBe(true);
    expect(cancelRemote).toHaveBeenCalledExactlyOnceWith(job.entry);
    expect(media.probe).not.toHaveBeenCalled();
    await expect(readFile(job.outputPath)).rejects.toMatchObject(missing);
    expect(await loadHistory()).toEqual([]);
    expectFailed(jobId, 'Canceled');
    expect(frames.at(-1)).toEqual({ type: 'canceled', reason: 'Canceled' });
  });

  it('discards an output when cancellation arrives during geometry probing', async () => {
    const jobId = 'cancel-probe';
    const probing = Promise.withResolvers();
    const geometryReady = Promise.withResolvers();
    media.probe.mockImplementation((path) => {
      probing.resolve(path);
      return geometryReady.promise;
    });
    const job = start(jobId, ({ publish }) => publish());
    try {
      expect(await probing.promise).toBe(job.outputPath);
      await expect(readFile(job.outputPath)).resolves.toEqual(bytes);
      expect(runner.cancel(jobId)).toBe(true);
    } finally {
      geometryReady.resolve(geometry);
      await job.settled;
    }
    expect(await job.settled).toBe(false);
    expect(cancelRemote).toHaveBeenCalledExactlyOnceWith(job.entry);
    await expect(readFile(job.outputPath)).rejects.toMatchObject(missing);
    expect(await loadHistory()).toEqual([]);
    expectFailed(jobId, 'Canceled');
  });

  it('rechecks cancellation during staged-input cleanup and preserves paths outside the uploads root', async () => {
    const jobId = 'cancel-cleanup';
    const nested = join(PATHS.uploads, 'nested');
    const staged = join(nested, 'staged.png');
    const another = join(PATHS.uploads, 'another.png');
    const gallery = join(PATHS.data, 'gallery.png');
    const siblingDir = `${PATHS.uploads}-archive`;
    const sibling = join(siblingDir, 'archived.png');
    await mkdir(nested, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    await Promise.all([
      writeFile(staged, 'staged'), writeFile(another, 'another'),
      writeFile(gallery, 'keep gallery'), writeFile(sibling, 'keep archive'),
    ]);
    const traverse = `${PATHS.uploads}${sep}..${sep}${basename(gallery)}`;
    const canceled = vi.fn(() => runner.cancel(jobId));
    const job = start(jobId, ({ publish }) => publish({
      // The next statement in publish starts the real unlink. This microtask
      // runs during that await, before the filesystem completion can resume it.
      onMeasured: () => queueMicrotask(canceled),
    }), [staged, PATHS.uploads, another, staged, traverse, sibling, join(PATHS.uploads, 'missing.png')]);

    expect(await job.settled).toBe(false);
    expect(canceled).toHaveReturnedWith(true);
    expect(cancelRemote).toHaveBeenCalledExactlyOnceWith(job.entry);
    await expect(readFile(staged)).rejects.toMatchObject(missing);
    await expect(readFile(another)).rejects.toMatchObject(missing);
    await expect(readFile(gallery, 'utf8')).resolves.toBe('keep gallery');
    await expect(readFile(sibling, 'utf8')).resolves.toBe('keep archive');
    await expect(readFile(job.outputPath)).rejects.toMatchObject(missing);
    expect(await loadHistory()).toEqual([]);
    expectFailed(jobId, 'Canceled');
  });

  it('cancels the unread response stream on an unsuccessful download', async () => {
    const cancelBody = vi.fn();
    const stream = new ReadableStream({ cancel: cancelBody });
    const fetch = vi.fn(async () => new Response(stream, { status: 503 }));
    vi.stubGlobal('fetch', fetch);

    await expect(runner.download({ controller: new AbortController() }, 'https://example.com/video.mp4', {
      timeoutMs: 1000, label: 'Example video',
    })).rejects.toThrow('Example video download failed: HTTP 503');
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('abandons a pre-commit failure and removes the unpublished output and staged input', async () => {
    const jobId = 'pre-commit';
    const staged = join(PATHS.uploads, 'pre-commit.png');
    await writeFile(staged, 'staged');
    media.probe.mockRejectedValueOnce(new ServerError('measurement failed', { code: 'PROBE_FAILED' }));
    const job = start(jobId, ({ publish }) => publish(), [staged]);

    await job.settled;
    expect(abandonRemote).toHaveBeenCalledExactlyOnceWith(job.entry);
    expect(cancelRemote).not.toHaveBeenCalled();
    await expect(readFile(job.outputPath)).rejects.toMatchObject(missing);
    await expect(readFile(staged)).rejects.toMatchObject(missing);
    expect(await loadHistory()).toEqual([]);
    expectFailed(jobId, 'Example video generation failed: measurement failed', { code: 'PROBE_FAILED' });
  });

  it('retains committed output and history when publication notification throws', async () => {
    const jobId = 'post-commit';
    const emit = videoGenEvents.emit.bind(videoGenEvents);
    vi.spyOn(videoGenEvents, 'emit').mockImplementation((type, ...args) => {
      if (type === 'completed') throw new Error('notification failed');
      return emit(type, ...args);
    });
    const job = start(jobId, ({ publish }) => publish());

    await job.settled;
    expect(abandonRemote).toHaveBeenCalledExactlyOnceWith(job.entry);
    await expect(readFile(job.outputPath)).resolves.toEqual(bytes);
    expect(await loadHistory()).toEqual([expect.objectContaining({ id: jobId, ...geometry })]);
    expectFailed(jobId, 'Example video generation failed: notification failed');
  });

  it.each(['output', 'staged input'])('marks the media reservation and current operation unsettled when %s cleanup fails', async (stage) => {
    const jobId = `cleanup-refused-${stage.replace(' ', '-')}`;
    const staged = join(PATHS.uploads, jobId);
    const outputCleanup = stage === 'output';
    const refusedPath = outputCleanup ? join(PATHS.videos, `${jobId}.mp4`) : staged;
    // Unlinking a directory is refused on supported platforms, even as root.
    await mkdir(refusedPath);
    const mediaPermit = maintenance.admit('media', jobId);
    const currentPermit = maintenance.admit('app-operation', 'fixture');
    const otherPermit = maintenance.admit('media', 'unrelated');
    const job = currentPermit.run(() => start(jobId, ({ finishFailure, fail }) => (outputCleanup
      ? fail(new Error('provider rejected the render'))
      : finishFailure('Provider rejected the render')), [staged]));

    try {
      await job.settled;
      const rows = maintenance.operations();
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: mediaPermit.id, unsettled: true, uncertaintyStamp: expect.any(String) }),
        expect.objectContaining({ id: currentPermit.id, unsettled: true, uncertaintyStamp: expect.any(String) }),
      ]));
      expect(rows.find((row) => row.id === otherPermit.id)).not.toHaveProperty('unsettled');
      expectFailed(jobId, outputCleanup ? 'Example video generation failed: provider rejected the render' : 'Provider rejected the render');
    } finally {
      await Promise.all([mediaPermit.finish(), currentPermit.finish(), otherPermit.finish()]);
    }
  });

  it('publishes measured history, clears active requests and replays completion until SSE cleanup', async () => {
    const jobId = 'complete';
    const job = start(jobId, ({ publish }) => publish({ actualSeed: 7 }));
    expect(job.descriptor).toEqual({
      jobId, filename: `${jobId}.mp4`, path: `/data/videos/${jobId}.mp4`,
      generationId: jobId, mode: 'example', status: 'running',
    });
    expect(runner.getActiveJobs()).toMatchObject([{ generationId: jobId }]);
    const live = attach(jobId);
    expect(await job.settled).toBe(true);
    const result = { filename: job.descriptor.filename, path: job.descriptor.path, thumbnail: null };
    expect(completed).toHaveBeenCalledExactlyOnceWith({ generationId: jobId, ...result });
    expect(failed).not.toHaveBeenCalled();
    expect(runner.getActiveJobs()).toEqual([]);
    expect(runner.cancel(jobId)).toBe(false);
    expect(abandonRemote).not.toHaveBeenCalled();
    await expect(readFile(job.outputPath)).resolves.toEqual(bytes);
    expect(await loadHistory()).toEqual([expect.objectContaining({ id: jobId, ...geometry })]);

    const late = attach(jobId);
    const terminal = { type: 'complete', result: { ...result, seed: 7 } };
    expect(live.frames.at(-1)).toEqual(terminal);
    expect(late.frames).toEqual([terminal]);
    await vi.advanceTimersByTimeAsync(SSE_CLEANUP_DELAY_MS);
    expect(live.client.end).toHaveBeenCalledOnce();
    expect(late.client.end).toHaveBeenCalledOnce();
    expect(runner.attachSseClient(jobId, late.client)).toBe(false);
  });
});
