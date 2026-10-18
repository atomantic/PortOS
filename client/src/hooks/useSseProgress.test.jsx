import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSseProgress, isTerminalSseFrame } from './useSseProgress';
import { MockEventSource, lastEventSource as last } from '../test/mockEventSource';

beforeEach(() => {
  MockEventSource.reset();
  global.EventSource = MockEventSource;
});

afterEach(() => {
  delete global.EventSource;
  vi.unstubAllGlobals();
});

describe('useSseProgress', () => {
  it('does not open a stream when url is null or enabled is false', () => {
    renderHook(() => useSseProgress(null));
    renderHook(() => useSseProgress('/x', { enabled: false }));
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('accumulates frames and tracks the latest', () => {
    const { result } = renderHook(() => useSseProgress('/x'));
    act(() => {
      last().emit({ type: 'progress', progress: 0.25 });
      last().emit({ type: 'progress', progress: 0.5 });
    });
    expect(result.current.frames).toHaveLength(2);
    expect(result.current.latest).toEqual({ type: 'progress', progress: 0.5 });
    expect(result.current.latestUrl).toBe('/x');
    expect(result.current.closed).toBe(false);
  });

  it.each(['complete', 'canceled', 'cancelled', 'error'])(
    'closes the stream on a terminal %s frame',
    (type) => {
      const { result } = renderHook(() => useSseProgress('/x'));
      act(() => { last().emit({ type }); });
      expect(result.current.closed).toBe(true);
      expect(result.current.isOpen).toBe(false);
      expect(last().closed).toBe(true);
    },
  );

  it('marks the stream closed on a terminal connection failure', () => {
    const { result } = renderHook(() => useSseProgress('/x'));
    act(() => { last().fail(); });
    expect(result.current.closed).toBe(true);
    expect(result.current.latest).toBeNull();
  });

  it('resets state when the url changes', () => {
    const { result, rerender } = renderHook(({ url }) => useSseProgress(url), {
      initialProps: { url: '/a' },
    });
    act(() => { last().emit({ type: 'complete' }); });
    expect(result.current.closed).toBe(true);
    rerender({ url: '/b' });
    expect(result.current.closed).toBe(false);
    expect(result.current.frames).toHaveLength(0);
    expect(result.current.latestUrl).toBeNull();
    expect(last().url).toBe('/b');
  });

  it('retains latest across a disable gap but resets closed — consumers must gate terminal handling on closed', () => {
    const { result, rerender } = renderHook(
      ({ url }) => useSseProgress(url, { enabled: !!url }),
      { initialProps: { url: '/a' } },
    );
    act(() => { last().emit({ type: 'error', error: 'boom' }); });
    expect(result.current.closed).toBe(true);
    // Stream disabled (consumer cleared its job id): closed resets, but the
    // terminal frame stays in `latest` — a consumer that re-enables and acts
    // on `latest` without checking `closed` would replay the stale terminal.
    rerender({ url: null });
    expect(result.current.closed).toBe(false);
    expect(result.current.latest).toEqual({ type: 'error', error: 'boom' });
    expect(result.current.latestUrl).toBeNull();
  });

  it('retains at most maxFrames of history, dropping the oldest, while latest is the last frame', () => {
    const { result } = renderHook(() => useSseProgress('/x', { maxFrames: 50 }));
    act(() => {
      for (let i = 1; i <= 1000; i += 1) last().emit({ type: 'progress', i });
    });
    expect(result.current.frames).toHaveLength(50);
    expect(result.current.frames[0]).toEqual({ type: 'progress', i: 951 });
    expect(result.current.frames.at(-1)).toEqual({ type: 'progress', i: 1000 });
    expect(result.current.latest).toEqual({ type: 'progress', i: 1000 });
  });

  it('defaults the cap to 200 and never writes history for a maxFrames: 0 consumer', () => {
    const capped = renderHook(() => useSseProgress('/x'));
    act(() => {
      for (let i = 0; i < 250; i += 1) last().emit({ type: 'progress', i });
    });
    expect(capped.result.current.frames).toHaveLength(200);

    const latestOnly = renderHook(() => useSseProgress('/y', { maxFrames: 0 }));
    const initialFrames = latestOnly.result.current.frames;
    act(() => {
      last().emit({ type: 'progress', i: 1 });
      last().emit({ type: 'complete' });
    });
    expect(latestOnly.result.current.frames).toBe(initialFrames);
    expect(latestOnly.result.current.frames).toHaveLength(0);
    expect(latestOnly.result.current.latest).toEqual({ type: 'complete' });
    expect(latestOnly.result.current.closed).toBe(true);
  });

  it('isTerminalSseFrame matches the terminal set and rejects others', () => {
    expect(isTerminalSseFrame({ type: 'complete' })).toBe(true);
    expect(isTerminalSseFrame({ type: 'canceled' })).toBe(true);
    expect(isTerminalSseFrame({ type: 'cancelled' })).toBe(true);
    expect(isTerminalSseFrame({ type: 'error' })).toBe(true);
    expect(isTerminalSseFrame({ type: 'progress' })).toBe(false);
    expect(isTerminalSseFrame(null)).toBe(false);
  });
});

it('reports a transient outage and recovers without ending the job stream', () => {
  const { result } = renderHook(() => useSseProgress('/reconnect'));
  act(() => last().onopen());
  expect(result.current.isOpen).toBe(true);
  act(() => last().fail(MockEventSource.CONNECTING));
  expect(result.current.isOpen).toBe(false);
  expect(result.current.closed).toBe(false);
  expect(last().closed).toBe(false);
  act(() => last().onopen());
  expect(result.current.isOpen).toBe(true);
});

describe('POST progress streams', () => {
  it('starts once in StrictMode, decodes split frames and closes at completion', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: {"type":"stage","message":"pulling"}\r\n\r\ndata: {"type":"progress","message":"café"}\n\ndata: {"type":"complete"}\n\n');
    const split = bytes.indexOf(0xc3) + 1;
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    } })));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useSseProgress('/download', { method: 'POST' }), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.closed).toBe(true));
    expect(result.current.frames).toEqual([
      { type: 'stage', message: 'pulling' }, { type: 'progress', message: 'café' }, { type: 'complete' },
    ]);
    expect(result.current.latestUrl).toBe('/download');
    expect(result.current.isOpen).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]).toEqual(['/download', expect.objectContaining({ method: 'POST' })]);
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it.each(['disconnect', 'eof', 'http'])('ends a %s failure visibly without retrying', async (failure) => {
    const fetchMock = vi.fn(async () => failure === 'http'
      ? new Response(JSON.stringify({ error: 'Unknown model' }), { status: 404 })
      : new Response(new ReadableStream({ start(controller) {
        if (failure === 'disconnect') controller.error(new Error('Network lost'));
        else controller.close();
      } })));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(() => useSseProgress('/download', { method: 'POST' }));
    await waitFor(() => expect(result.current.closed).toBe(true));
    expect(result.current.latest).toMatchObject({ type: 'error', message: expect.any(String) });
    if (failure === 'http') expect(result.current.latest.message).toBe('Unknown model');
    rerender();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('aborts on cancel, supersession and unmount, ignoring a stale response', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn((url, { signal }) => new Promise(resolve => requests.push({ url, signal, resolve }))));
    const { result, rerender, unmount } = renderHook(({ url }) => useSseProgress(url, { method: 'POST' }), { initialProps: { url: '/a' } });
    await waitFor(() => expect(requests).toHaveLength(1));
    rerender({ url: '/b' });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].signal.aborted).toBe(true);
    await act(async () => requests[0].resolve(new Response('data: {"type":"complete"}\n\n')));
    expect(result.current.latest).toBeNull();
    act(() => result.current.close());
    expect(requests[1].signal.aborted).toBe(true);
    rerender({ url: '/c' });
    await waitFor(() => expect(requests).toHaveLength(3));
    unmount();
    expect(requests[2].signal.aborted).toBe(true);
  });
});
