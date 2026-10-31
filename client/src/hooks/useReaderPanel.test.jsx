import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../services/api', () => ({
  getReaderPanel: vi.fn(),
  getReaderPanelStatus: vi.fn(),
  runReaderPanel: vi.fn(),
  cancelReaderPanel: vi.fn(),
  readerPanelSseUrl: (id) => `/sse/${id}`,
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn() } }));
vi.mock('./usePipelineProgress', () => ({ usePipelineProgress: vi.fn() }));

import { getReaderPanel, getReaderPanelStatus } from '../services/api';
import { usePipelineProgress } from './usePipelineProgress';
import { useReaderPanel } from './useReaderPanel';

const panel = { status: 'complete', personas: [{ persona: 'a' }], disagreements: {} };

let sse;
beforeEach(() => {
  vi.clearAllMocks();
  sse = { latest: null, closed: false };
  usePipelineProgress.mockImplementation(() => sse);
  getReaderPanelStatus.mockResolvedValue({ active: false });
});

describe('useReaderPanel load failures', () => {
  it('reports a rejected read as loadError rather than an empty panel', async () => {
    getReaderPanel.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useReaderPanel('s1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError.message).toBe('boom');
    expect(result.current.panel).toBeNull();
  });

  it('treats a successful empty read as no error', async () => {
    getReaderPanel.mockResolvedValue(null);
    const { result } = renderHook(() => useReaderPanel('s1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBeNull();
    expect(result.current.panel).toBeNull();
  });

  it('keeps the panel on screen when the reload after the stream closes fails', async () => {
    getReaderPanel.mockResolvedValueOnce(panel);
    getReaderPanelStatus.mockResolvedValue({ active: true });
    const { result, rerender } = renderHook(() => useReaderPanel('s1'));
    await waitFor(() => expect(result.current.running).toBe(true));

    getReaderPanel.mockRejectedValueOnce(new Error('offline'));
    sse = { latest: null, closed: true };
    rerender();
    await waitFor(() => expect(result.current.running).toBe(false));
    await waitFor(() => expect(result.current.loadError).not.toBeNull());
    expect(result.current.panel).toBe(panel);

    getReaderPanel.mockResolvedValueOnce(panel);
    await act(() => result.current.reload());
    expect(result.current.loadError).toBeNull();
  });
});

describe('useReaderPanel series switch', () => {
  it('never subscribes the next series to the previous series run', async () => {
    getReaderPanel.mockResolvedValue(panel);
    getReaderPanelStatus.mockResolvedValueOnce({ active: true }).mockResolvedValue({ active: false });
    const { result, rerender } = renderHook(({ id }) => useReaderPanel(id), { initialProps: { id: 's1' } });
    await waitFor(() => expect(result.current.running).toBe(true));
    usePipelineProgress.mockClear();

    rerender({ id: 's2' });
    expect(result.current.running).toBe(false);
    const forS2 = usePipelineProgress.mock.calls.filter(([, ids]) => ids[0] === 's2');
    expect(forS2.length).toBeGreaterThan(0);
    expect(forS2.every(([, , opts]) => opts.enabled === false)).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});
