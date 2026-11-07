import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: () => {},
  },
}));

const getMediaJob = vi.fn();
vi.mock('../services/apiMediaJobs', () => ({ getMediaJob: (...a) => getMediaJob(...a) }));

const useMediaJobReconnectSettle = (await import('./useMediaJobReconnectSettle.js')).default;

const reconnect = () => act(async () => { handlers.get('connect')?.(); });

describe('useMediaJobReconnectSettle (#15167)', () => {
  beforeEach(() => { handlers.clear(); getMediaJob.mockReset(); });
  afterEach(cleanup);

  it('settles a pending job that finished while the socket was down, exactly once', async () => {
    getMediaJob.mockResolvedValue({ status: 'completed', result: { path: '/data/images/a.png' } });
    const settle = vi.fn();
    renderHook(() => useMediaJobReconnectSettle(() => ['job-1'], settle));
    await reconnect();
    expect(getMediaJob).toHaveBeenCalledWith('job-1');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0]).toBe('job-1');
    expect(settle.mock.calls[0][1].result.path).toBe('/data/images/a.png');
  });

  it.each(['queued', 'running'])('leaves a %s job alone', async (status) => {
    getMediaJob.mockResolvedValue({ status });
    const settle = vi.fn();
    renderHook(() => useMediaJobReconnectSettle(() => ['job-1'], settle));
    await reconnect();
    expect(settle).not.toHaveBeenCalled();
  });

  it.each(['failed', 'canceled'])('settles a %s job', async (status) => {
    getMediaJob.mockResolvedValue({ status });
    const settle = vi.fn();
    renderHook(() => useMediaJobReconnectSettle(() => ['job-1'], settle));
    await reconnect();
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('skips a job a live socket event cleared while the fetch was in flight', async () => {
    let pending = ['job-1'];
    let resolveJob;
    getMediaJob.mockReturnValue(new Promise((resolve) => { resolveJob = resolve; }));
    const settle = vi.fn();
    renderHook(() => useMediaJobReconnectSettle(() => pending, settle));
    await reconnect();
    pending = [];
    await act(async () => { resolveJob({ status: 'completed' }); });
    expect(settle).not.toHaveBeenCalled();
  });

  it('does not fetch when nothing is pending and survives a failed fetch', async () => {
    const settle = vi.fn();
    const { rerender } = renderHook(({ ids }) => useMediaJobReconnectSettle(() => ids, settle), { initialProps: { ids: [] } });
    await reconnect();
    expect(getMediaJob).not.toHaveBeenCalled();
    getMediaJob.mockRejectedValue(new Error('404'));
    rerender({ ids: ['job-1'] });
    await reconnect();
    expect(settle).not.toHaveBeenCalled();
  });

  it('removes the connect listener on unmount', () => {
    const { unmount } = renderHook(() => useMediaJobReconnectSettle(() => [], vi.fn()));
    expect(handlers.has('connect')).toBe(true);
    unmount();
    expect(handlers.has('connect')).toBe(false);
  });
});
