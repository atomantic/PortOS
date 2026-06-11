import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMediaJobSse } from './useMediaJobSse';
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
