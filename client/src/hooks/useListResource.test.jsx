import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useListResource from './useListResource';

describe('useListResource', () => {
  it('reports loading, then ready with the list, and keeps a failure distinct from an empty list', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useListResource(fetcher));
    expect(result.current).toMatchObject({ items: [], state: 'loading', error: null });
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.items).toEqual([]);
    expect(result.current.error.message).toBe('offline');

    act(() => { result.current.retry(); });
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.items).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('drops a superseded response and applies local mutations without a refetch', async () => {
    const answers = [];
    const fetcher = vi.fn(() => new Promise((resolve, reject) => answers.push({ resolve, reject })));
    const { result } = renderHook(() => useListResource(fetcher));
    await waitFor(() => expect(answers).toHaveLength(1));
    act(() => { result.current.retry(); });
    await waitFor(() => expect(answers).toHaveLength(2));
    // The first run's late answer must not overwrite the retry's.
    await act(async () => { answers[0].resolve([{ id: 'stale' }]); });
    expect(result.current.state).toBe('loading');
    await act(async () => { answers[1].resolve([{ id: 'fresh' }]); });
    expect(result.current).toMatchObject({ state: 'ready', items: [{ id: 'fresh' }] });

    act(() => { result.current.setItems((items) => [...items, { id: 'imported' }]); });
    expect(result.current.items.map((i) => i.id)).toEqual(['fresh', 'imported']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('holds at loading without a request while disabled', async () => {
    const fetcher = vi.fn(async () => [1]);
    const { result, rerender } = renderHook(({ enabled }) => useListResource(fetcher, { enabled }), { initialProps: { enabled: false } });
    await act(async () => {});
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.state).toBe('loading');
    rerender({ enabled: true });
    await waitFor(() => expect(result.current).toMatchObject({ state: 'ready', items: [1] }));
  });
});
