import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaJobSse, isMediaRunEnded } from './useMediaJobSse';
import { MockEventSource, lastEventSource as last } from '../test/mockEventSource';

beforeEach(() => {
  MockEventSource.reset();
  global.EventSource = MockEventSource;
});

afterEach(() => {
  delete global.EventSource;
});

describe('useMediaJobSse', () => {
  it('opens the per-job events URL for the given kind', () => {
    const { result } = renderHook(() => useMediaJobSse('image'));
    result.current.attach('job1', {});
    expect(last().url).toBe('/api/image-gen/job1/events');

    const { result: video } = renderHook(() => useMediaJobSse('video'));
    video.current.attach('job2', {});
    expect(last().url).toBe('/api/video-gen/job2/events');
  });

  it('dispatches non-terminal frames to their handlers', () => {
    const handlers = {
      onQueued: vi.fn(), onStarted: vi.fn(), onStage: vi.fn(),
      onStatus: vi.fn(), onProgress: vi.fn(),
    };
    const { result } = renderHook(() => useMediaJobSse('video'));
    result.current.attach('j', handlers);

    last().emit({ type: 'queued', position: 3 });
    last().emit({ type: 'started' });
    last().emit({ type: 'stage', stage: 'inference' });
    last().emit({ type: 'status', message: 'hi' });
    last().emit({ type: 'progress', progress: 0.5 });

    expect(handlers.onQueued).toHaveBeenCalledWith(expect.objectContaining({ position: 3 }));
    expect(handlers.onStarted).toHaveBeenCalledTimes(1);
    expect(handlers.onStage).toHaveBeenCalledWith(expect.objectContaining({ stage: 'inference' }));
    expect(handlers.onStatus).toHaveBeenCalledWith(expect.objectContaining({ message: 'hi' }));
    expect(handlers.onProgress).toHaveBeenCalledWith(expect.objectContaining({ progress: 0.5 }));
    expect(last().closed).toBe(false);
  });

  it('resolves with msg.result by default on complete and closes the stream', async () => {
    const { result } = renderHook(() => useMediaJobSse('image'));
    const p = result.current.attach('j', {});
    last().emit({ type: 'complete', result: { filename: 'a.png' } });
    await expect(p).resolves.toEqual({ filename: 'a.png' });
    expect(last().closed).toBe(true);
  });

  it('resolves with onComplete return value when provided', async () => {
    const { result } = renderHook(() => useMediaJobSse('image'));
    const onComplete = vi.fn(() => 'custom');
    const p = result.current.attach('j', { onComplete });
    last().emit({ type: 'complete', result: { filename: 'a.png' } });
    await expect(p).resolves.toBe('custom');
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ result: { filename: 'a.png' } }));
  });

  it('rejects with a default Error(msg.error) on error', async () => {
    const { result } = renderHook(() => useMediaJobSse('image'));
    const p = result.current.attach('j', {});
    last().emit({ type: 'error', error: 'boom' });
    await expect(p).rejects.toThrow('boom');
    expect(last().closed).toBe(true);
  });

  it('rejects with the custom Error returned from onError', async () => {
    const { result } = renderHook(() => useMediaJobSse('image'));
    const onError = vi.fn((msg) => {
      const err = new Error(msg.error);
      err.kind = msg.kind;
      return err;
    });
    const p = result.current.attach('j', { onError });
    last().emit({ type: 'error', error: 'gated', kind: 'gated_repo' });
    await expect(p).rejects.toMatchObject({ message: 'gated', kind: 'gated_repo' });
  });

  it('rejects with the cancel reason on canceled', async () => {
    const { result } = renderHook(() => useMediaJobSse('video'));
    const p = result.current.attach('j', {});
    last().emit({ type: 'canceled', reason: 'user stopped' });
    await expect(p).rejects.toThrow('user stopped');
  });

  it('rejects and notifies onConnectionError on a connection failure', async () => {
    const { result } = renderHook(() => useMediaJobSse('video'));
    const onConnectionError = vi.fn();
    const p = result.current.attach('j', { onConnectionError });
    last().fail();
    await expect(p).rejects.toThrow('Lost connection to server');
    expect(onConnectionError).toHaveBeenCalledTimes(1);
    expect(last().closed).toBe(true);
  });

  it('ignores a transient onerror (readyState CONNECTING) so the browser can auto-reconnect', async () => {
    const { result } = renderHook(() => useMediaJobSse('video'));
    const onConnectionError = vi.fn();
    const p = result.current.attach('j', { onConnectionError });

    // A transient blip — the browser will retry on its own; the stream must
    // stay open and the attach Promise must stay pending.
    last().fail(MockEventSource.CONNECTING);
    expect(onConnectionError).not.toHaveBeenCalled();
    expect(last().closed).toBe(false);

    // The reconnect eventually delivers the replayed terminal frame.
    last().emit({ type: 'complete', result: { filename: 'recovered.png' } });
    await expect(p).resolves.toEqual({ filename: 'recovered.png' });
  });

  it('ignores frames and tears down the stream when isCurrent() is false', () => {
    const onProgress = vi.fn();
    const { result } = renderHook(() => useMediaJobSse('image'));
    result.current.attach('j', { isCurrent: () => false, onProgress });
    last().emit({ type: 'progress', progress: 0.9 });
    expect(onProgress).not.toHaveBeenCalled();
    expect(last().closed).toBe(true);
  });

  it('silently ignores unparseable frames', () => {
    const onProgress = vi.fn();
    const { result } = renderHook(() => useMediaJobSse('image'));
    result.current.attach('j', { onProgress });
    expect(() => last().emitRaw('not json')).not.toThrow();
    expect(onProgress).not.toHaveBeenCalled();
    expect(last().closed).toBe(false);
  });

  it('close() tears down the active stream', () => {
    const { result } = renderHook(() => useMediaJobSse('image'));
    result.current.attach('j', {});
    expect(last().closed).toBe(false);
    result.current.close();
    expect(last().closed).toBe(true);
  });
});

// The single run owner: identity, stream, cancellation and unmount detach.
describe('useMediaJobSse run owner', () => {
  const deferred = () => {
    let resolve; let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const settle = (p) => p.then(() => 'resolved', (err) => err);

  it('cancel() targets only the owned job and settles the wait once', async () => {
    const cancelJob = vi.fn(async () => ({}));
    const { result } = renderHook(() => useMediaJobSse('image', { cancelJob }));
    const run = settle(result.current.start(async () => ({ jobId: 'job-a' })));
    await act(async () => {});
    expect(last().url).toBe('/api/image-gen/job-a/events');

    const cancelled = await act(async () => result.current.cancel());
    expect(cancelled).toBe(true);
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith('job-a');
    expect(last().closed).toBe(true);
    const err = await run;
    expect(isMediaRunEnded(err)).toBe(true);
    expect(err.reason).toBe('canceled');

    // Nothing left to cancel; a stale terminal frame is ignored.
    expect(await result.current.cancel()).toBe(false);
    last().emit({ type: 'complete', result: {} });
    expect(cancelJob).toHaveBeenCalledTimes(1);
  });

  it('a resumed (adopted) job is cancellable by its id', async () => {
    const cancelJob = vi.fn(async () => ({}));
    const { result } = renderHook(() => useMediaJobSse('video', { cancelJob }));
    settle(result.current.start(async () => ({ jobId: 'resumed', status: 'running' }), {}, { ifIdle: true }));
    await act(async () => {});
    await act(async () => { await result.current.cancel(); });
    expect(cancelJob).toHaveBeenCalledWith('resumed');
  });

  it('cancel before the acknowledgement cancels the eventual job exactly once and opens no stream', async () => {
    const cancelJob = vi.fn(async () => ({}));
    const ack = deferred();
    const { result } = renderHook(() => useMediaJobSse('video', { cancelJob }));
    const run = settle(result.current.start(() => ack.promise));
    await act(async () => { await result.current.cancel(); });
    expect(cancelJob).not.toHaveBeenCalled();
    expect(isMediaRunEnded(await run)).toBe(true);

    await act(async () => { ack.resolve({ generationId: 'late-job' }); });
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith('late-job');
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('unmount before the acknowledgement creates no stream, calls no handler and cancels nothing', async () => {
    const cancelJob = vi.fn(async () => ({}));
    const onAcknowledged = vi.fn();
    const onStatus = vi.fn();
    const ack = deferred();
    const { result, unmount } = renderHook(() => useMediaJobSse('video', { cancelJob }));
    const run = settle(result.current.start(() => ack.promise, { onAcknowledged, onStatus }));
    unmount();
    expect(isMediaRunEnded(await run)).toBe(true);
    await act(async () => { ack.resolve({ jobId: 'durable' }); });
    expect(MockEventSource.instances).toHaveLength(0);
    expect(onAcknowledged).not.toHaveBeenCalled();
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('unmount mid-stream closes the stream but leaves the accepted job running', async () => {
    const cancelJob = vi.fn(async () => ({}));
    const { result, unmount } = renderHook(() => useMediaJobSse('video', { cancelJob }));
    const run = settle(result.current.start(async () => ({ jobId: 'durable' })));
    await act(async () => {});
    const stream = last();
    unmount();
    expect(stream.closed).toBe(true);
    expect(isMediaRunEnded(await run)).toBe(true);
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('ifIdle yields to an active run, and a new start supersedes the old run without cancelling it', async () => {
    const cancelJob = vi.fn(async () => ({}));
    const { result } = renderHook(() => useMediaJobSse('video', { cancelJob }));
    const first = settle(result.current.start(async () => ({ jobId: 'first' })));
    await act(async () => {});
    expect(await result.current.start(async () => ({ jobId: 'resume' }), {}, { ifIdle: true })).toBeNull();

    const second = result.current.start(async () => ({ jobId: 'second' }));
    expect((await first).reason).toBe('superseded');
    await act(async () => {});
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(last().url).toBe('/api/video-gen/second/events');
    expect(cancelJob).not.toHaveBeenCalled();
    last().emit({ type: 'complete', result: { filename: 'b.mp4' } });
    await expect(second).resolves.toEqual({ filename: 'b.mp4' });
  });

  it('completes without a stream when the acknowledgement names no job (synchronous work)', async () => {
    const { result } = renderHook(() => useMediaJobSse('image'));
    const handlers = vi.fn((ack) => ({ onSync: (value) => ({ ...value, done: ack.filename }) }));
    await expect(result.current.start(async () => ({ mode: 'external', filename: 'a.png' }), handlers))
      .resolves.toEqual({ mode: 'external', filename: 'a.png', done: 'a.png' });
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('reports a failed kickoff to onKickoffError only while the run is current', async () => {
    const onKickoffError = vi.fn();
    const { result } = renderHook(() => useMediaJobSse('image'));
    await expect(result.current.start(async () => { throw new Error('POST failed'); }, {}, { onKickoffError }))
      .rejects.toThrow('POST failed');
    expect(onKickoffError).toHaveBeenCalledTimes(1);

    const failing = deferred();
    const run = settle(result.current.start(() => failing.promise, {}, { onKickoffError }));
    await act(async () => { await result.current.cancel(); });
    failing.reject(new Error('late failure'));
    expect(isMediaRunEnded(await run)).toBe(true);
    expect(onKickoffError).toHaveBeenCalledTimes(1);
  });
});
