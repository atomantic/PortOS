import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../services/api', () => ({
  getSeriesEditorial: vi.fn(),
  getSeriesEditorialStatus: vi.fn(),
  analyzeSeriesEditorial: vi.fn(),
  cancelSeriesEditorial: vi.fn(),
  pipelineEditorialSseUrl: (id) => `/sse/${id}`,
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn() } }));
vi.mock('./usePipelineProgress', () => ({ usePipelineProgress: vi.fn() }));

import { getSeriesEditorial, getSeriesEditorialStatus } from '../services/api';
import { usePipelineProgress } from './usePipelineProgress';
import { useSeriesEditorial } from './useSeriesEditorial';

const withDrafts = { coverage: { analyzed: 1, total: 2, withContent: 2, stale: 0, noContent: 0 }, roadmap: [] };
const noDrafts = { coverage: { analyzed: 0, total: 1, withContent: 0, stale: 0, noContent: 1 }, roadmap: [] };

let sse;
beforeEach(() => {
  vi.clearAllMocks();
  sse = { latest: null, closed: false };
  usePipelineProgress.mockImplementation(() => sse);
  getSeriesEditorialStatus.mockResolvedValue({ active: false });
});

describe('useSeriesEditorial load failures', () => {
  it('reports a rejected first read as loadError, not as a series with no drafts', async () => {
    getSeriesEditorial.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useSeriesEditorial('s1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError.message).toBe('boom');
    expect(result.current.aggregate).toBeNull();
    expect(result.current.noDraftedContent).toBe(false);
  });

  it('keeps a successful empty aggregate gated as no drafted content', async () => {
    getSeriesEditorial.mockResolvedValue(noDrafts);
    const { result } = renderHook(() => useSeriesEditorial('s1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBeNull();
    expect(result.current.noDraftedContent).toBe(true);
  });

  it('keeps the loaded aggregate when a reload fails, and clears the error on a good retry', async () => {
    getSeriesEditorial.mockResolvedValueOnce(withDrafts);
    const { result } = renderHook(() => useSeriesEditorial('s1'));
    await waitFor(() => expect(result.current.aggregate).toBe(withDrafts));

    getSeriesEditorial.mockRejectedValueOnce(new Error('offline'));
    await act(() => result.current.reload());
    expect(result.current.loadError.message).toBe('offline');
    expect(result.current.aggregate).toBe(withDrafts);
    expect(result.current.noDraftedContent).toBe(false);

    getSeriesEditorial.mockResolvedValueOnce(noDrafts);
    await act(() => result.current.reload());
    expect(result.current.loadError).toBeNull();
    expect(result.current.aggregate).toBe(noDrafts);
  });

  it('keeps the aggregate when the reload after the stream closes fails', async () => {
    getSeriesEditorial.mockResolvedValueOnce(withDrafts);
    getSeriesEditorialStatus.mockResolvedValue({ active: true });
    const { result, rerender } = renderHook(() => useSeriesEditorial('s1'));
    await waitFor(() => expect(result.current.running).toBe(true));

    getSeriesEditorial.mockRejectedValueOnce(new Error('offline'));
    sse = { latest: null, closed: true };
    rerender();
    await waitFor(() => expect(result.current.running).toBe(false));
    await waitFor(() => expect(result.current.loadError).not.toBeNull());
    expect(result.current.aggregate).toBe(withDrafts);
  });
});

describe('useSeriesEditorial series switch', () => {
  it('never subscribes the next series to the previous series run', async () => {
    getSeriesEditorial.mockResolvedValue(withDrafts);
    getSeriesEditorialStatus.mockResolvedValueOnce({ active: true }).mockResolvedValue({ active: false });
    const { result, rerender } = renderHook(({ id }) => useSeriesEditorial(id), { initialProps: { id: 's1' } });
    await waitFor(() => expect(result.current.running).toBe(true));
    usePipelineProgress.mockClear();

    rerender({ id: 's2' });
    expect(result.current.running).toBe(false);
    const forS2 = usePipelineProgress.mock.calls.filter(([, ids]) => ids[0] === 's2');
    expect(forS2.length).toBeGreaterThan(0);
    expect(forS2.every(([, , opts]) => opts.enabled === false)).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('does not show the previous series data when the new series read fails', async () => {
    getSeriesEditorial.mockResolvedValueOnce(withDrafts).mockRejectedValueOnce(new Error('boom'));
    const { result, rerender } = renderHook(({ id }) => useSeriesEditorial(id), { initialProps: { id: 's1' } });
    await waitFor(() => expect(result.current.aggregate).toBe(withDrafts));
    rerender({ id: 's2' });
    await waitFor(() => expect(result.current.loadError).not.toBeNull());
    expect(result.current.aggregate).toBeNull();
  });
});
