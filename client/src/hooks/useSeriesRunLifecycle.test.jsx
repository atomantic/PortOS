import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSeriesRunLifecycle } from './useSeriesRunLifecycle';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';

const urlBuilder = (id) => `/api/series/${id}/progress`;

const setup = (overrides = {}) => {
  const opts = {
    fetchStatus: vi.fn().mockResolvedValue({ active: false }),
    requestCancel: vi.fn().mockResolvedValue({ canceled: true }),
    onTerminal: vi.fn(),
    onReconciled: vi.fn(),
    ...overrides,
  };
  const hook = renderHook(
    ({ scopeId }) => useSeriesRunLifecycle({ scopeId, urlBuilder, ...opts }),
    { initialProps: { scopeId: 'ser-1' } },
  );
  return { ...hook, opts };
};

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  MockEventSource.reset();
  global.EventSource = MockEventSource;
});

afterEach(() => {
  delete global.EventSource;
});

describe('useSeriesRunLifecycle', () => {
  it('settles from the saved result when the stream closes with no terminal frame and the run is gone', async () => {
    const { result, opts } = setup();
    act(() => result.current.adopt('run-1'));
    act(() => lastEventSource().fail());

    await waitFor(() => expect(result.current.active).toBe(false));
    expect(opts.fetchStatus).toHaveBeenCalledWith('ser-1', { silent: true });
    expect(opts.onReconciled).toHaveBeenCalledWith({ canceled: false });
    expect(opts.onTerminal).not.toHaveBeenCalled();
    expect(result.current.recovery).toBeNull();
  });

  it('keeps a still-active run busy as disconnected, and Reattach opens a fresh stream', async () => {
    const { result, opts } = setup({ fetchStatus: vi.fn().mockResolvedValue({ active: true }) });
    act(() => result.current.adopt('run-1'));
    act(() => lastEventSource().fail());

    await waitFor(() => expect(result.current.recovery).toBe('disconnected'));
    expect(result.current.active).toBe(true);
    expect(opts.onReconciled).not.toHaveBeenCalled();

    act(() => result.current.reattach());
    expect(result.current.recovery).toBeNull();
    expect(MockEventSource.instances).toHaveLength(2);
    act(() => lastEventSource().emit({ type: 'complete', runId: 'run-1' }));
    expect(opts.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
    expect(result.current.active).toBe(false);
  });

  it('reports an unreadable status as unknown and retries explicitly', async () => {
    const fetchStatus = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ active: false });
    const { result, opts } = setup({ fetchStatus });
    act(() => result.current.adopt('run-1'));
    act(() => lastEventSource().fail());

    await waitFor(() => expect(result.current.recovery).toBe('unknown'));
    expect(result.current.active).toBe(true);
    expect(opts.onReconciled).not.toHaveBeenCalled();

    await act(() => result.current.retryStatus());
    expect(result.current.active).toBe(false);
    expect(opts.onReconciled).toHaveBeenCalledTimes(1);
  });

  it('ignores a transient CONNECTING error — no status read, run stays attached', () => {
    const { result, opts } = setup();
    act(() => result.current.adopt('run-1'));
    act(() => lastEventSource().fail(MockEventSource.CONNECTING));

    expect(result.current.active).toBe(true);
    expect(result.current.observing).toBe(true);
    expect(opts.fetchStatus).not.toHaveBeenCalled();
  });

  it('reconciles when cancel answers canceled:false, releasing a stale busy state', async () => {
    const { result, opts } = setup({ requestCancel: vi.fn().mockResolvedValue({ canceled: false }) });
    act(() => result.current.adopt('run-1'));

    await act(() => result.current.cancel());

    expect(opts.fetchStatus).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(false);
    expect(result.current.cancelState).toBeNull();
    expect(opts.onReconciled).toHaveBeenCalledWith({ canceled: false });
  });

  it('keeps an accepted cancel pending until the terminal frame, even through a live stream', async () => {
    const { result, opts } = setup();
    act(() => result.current.adopt('run-1'));

    await act(() => result.current.cancel());
    expect(result.current.cancelState).toBe('pending');
    expect(result.current.active).toBe(true);
    expect(opts.fetchStatus).not.toHaveBeenCalled();

    act(() => lastEventSource().emit({ type: 'canceled', runId: 'run-1' }));
    expect(opts.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ type: 'canceled' }));
    expect(result.current.active).toBe(false);
    expect(result.current.cancelState).toBeNull();
  });

  it('an accepted cancel whose stream was lost settles as canceled from the status read', async () => {
    const { result, opts } = setup();
    act(() => result.current.adopt('run-1'));
    await act(() => result.current.cancel());
    act(() => lastEventSource().fail());

    await waitFor(() => expect(result.current.active).toBe(false));
    expect(opts.onReconciled).toHaveBeenCalledWith({ canceled: true });
  });

  it('a delayed status read for a settled run cannot clear the run adopted after it', async () => {
    const slow = deferred();
    const { result, opts } = setup({ fetchStatus: vi.fn().mockReturnValue(slow.promise) });
    act(() => result.current.adopt('run-1'));
    act(() => lastEventSource().fail());
    await waitFor(() => expect(result.current.recovery).toBe('checking'));

    // The user kicks off a new run before the first recovery read returns.
    act(() => result.current.adopt('run-2'));
    await act(async () => { slow.resolve({ active: false }); });

    expect(result.current.active).toBe(true);
    expect(opts.onReconciled).not.toHaveBeenCalled();
  });

  it('a delayed read for the previous series is dropped after switching series', async () => {
    const slow = deferred();
    const { result, rerender, opts } = setup({ fetchStatus: vi.fn().mockReturnValue(slow.promise) });
    act(() => result.current.adopt('run-1'));
    act(() => lastEventSource().fail());
    await waitFor(() => expect(result.current.recovery).toBe('checking'));

    rerender({ scopeId: 'ser-2' });
    expect(result.current.active).toBe(false);
    act(() => result.current.adopt('run-9'));
    await act(async () => { slow.resolve({ active: false }); });

    expect(result.current.active).toBe(true);
    expect(opts.onReconciled).not.toHaveBeenCalled();
  });

  it('a terminal frame for a different run is not mistaken for this run ending', async () => {
    const { result, opts } = setup({ fetchStatus: vi.fn().mockResolvedValue({ active: true }) });
    act(() => result.current.adopt('run-2'));
    act(() => lastEventSource().emit({ type: 'complete', runId: 'run-1' }));

    await waitFor(() => expect(result.current.recovery).toBe('disconnected'));
    expect(opts.onTerminal).not.toHaveBeenCalled();
    expect(result.current.active).toBe(true);
  });
});
