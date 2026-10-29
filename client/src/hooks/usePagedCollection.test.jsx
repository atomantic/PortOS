import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePagedCollection } from './usePagedCollection';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const row = id => ({ id });

describe('usePagedCollection confirmed removal', () => {
  it('retains keyset pagination and reconciles the count without double subtraction', async () => {
    const survivor = row('survivor');
    const fetchPage = vi.fn().mockResolvedValueOnce({ items: [row('cursor-row'), survivor], total: 3, nextCursor: 'cursor-row' })
      .mockResolvedValueOnce({ items: [survivor], total: 2, nextCursor: 'survivor' })
      .mockResolvedValueOnce({ items: [survivor], total: 2, nextCursor: 'survivor' })
      .mockResolvedValueOnce({ items: [row('older')], total: 2, nextCursor: null });
    const { result } = renderHook(() => usePagedCollection(fetchPage));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => result.current.removeItem('cursor-row'));
    await act(async () => result.current.removeItem('cursor-row'));
    expect(result.current.items).toEqual([survivor]);
    expect(result.current.items[0]).toBe(survivor);
    expect(result.current.total).toBe(2);
    expect(result.current.nextCursor).toBe('cursor-row');
    expect(result.current.loading).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    await act(async () => result.current.loadMore());
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-row' }));
    expect(result.current.items.map(item => item.id)).toEqual(['survivor', 'older']);
    expect(result.current.hasMore).toBe(false);
  });

  it('rejects pre-delete refreshes and preserves queued socket arrivals and older pages', async () => {
    const stale = deferred();
    const fresh = deferred();
    const last = deferred();
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [row('removed'), row('survivor'), row('older')], total: 4, nextCursor: 'older' })
      .mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise).mockReturnValueOnce(last.promise);
    const { result } = renderHook(() => usePagedCollection(fetchPage));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => { void result.current.refreshFirst(); });
    const staleSignal = fetchPage.mock.calls[1][0].signal;
    act(() => { void result.current.refreshFirst(); }); // a completion arrives during the read
    act(() => { void result.current.removeItem('removed'); });
    expect(staleSignal.aborted).toBe(true);
    expect(result.current.items.map(item => item.id)).toEqual(['survivor', 'older']);
    expect(result.current.total).toBe(4);
    await act(async () => fresh.resolve({ items: [row('new'), row('survivor')], total: 4, nextCursor: 'survivor' }));
    expect(fetchPage).toHaveBeenCalledTimes(4); // queued completion is still serviced
    await act(async () => stale.resolve({ items: [row('removed')], total: 99, nextCursor: null }));
    expect(result.current.items.map(item => item.id)).toEqual(['new', 'survivor', 'older']);
    expect(result.current.total).toBe(4);
    await act(async () => last.resolve({ items: [row('newest'), row('new'), row('survivor')], total: 5, nextCursor: 'survivor' }));
    expect(result.current.items.map(item => item.id)).toEqual(['newest', 'new', 'survivor', 'older']);
    expect(result.current.nextCursor).toBe('older');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('replays an interrupted next page at its cursor and keeps retry state usable on failure', async () => {
    const stale = deferred();
    const replacement = deferred();
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [row('removed'), row('survivor')], total: 3, nextCursor: 'boundary' })
      .mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise)
      .mockResolvedValueOnce({ items: [row('older')], total: 2, nextCursor: null });
    const { result } = renderHook(() => usePagedCollection(fetchPage));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => { void result.current.loadMore(); });
    act(() => { void result.current.removeItem('removed'); });
    expect(fetchPage.mock.calls.slice(1).map(([request]) => request.cursor)).toEqual(['boundary', 'boundary']);
    await act(async () => replacement.reject(new Error('Page unavailable')));
    await act(async () => stale.resolve({ items: [row('removed')], total: 3, nextCursor: null }));
    expect(result.current.items.map(item => item.id)).toEqual(['survivor']);
    expect(result.current.loading).toBe(false);
    expect(result.current.error.message).toBe('Page unavailable');
    await act(async () => result.current.loadMore());
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'boundary' }));
    expect(result.current.items.map(item => item.id)).toEqual(['survivor', 'older']);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});


it('reconciles a delayed mutation against the current filter even with no pending read', async () => {
  const firstQuery = vi.fn().mockResolvedValue({ items: [row('removed')], total: 1, nextCursor: null });
  const secondQuery = vi.fn().mockResolvedValue({ items: [row('kept')], total: 1, nextCursor: null });
  const { result, rerender } = renderHook(({ query }) => usePagedCollection(query), { initialProps: { query: firstQuery } });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  const finishOldDelete = result.current.removeItem;
  rerender({ query: secondQuery });
  await waitFor(() => expect(result.current.items.map(item => item.id)).toEqual(['kept']));
  await act(async () => finishOldDelete('removed'));
  expect(firstQuery).toHaveBeenCalledTimes(1);
  expect(secondQuery).toHaveBeenCalledTimes(2);
  expect(result.current.items.map(item => item.id)).toEqual(['kept']);
  expect(result.current.total).toBe(1);
});


it('protects local edits and deletions during cursor reads, preserves refreshes and retries failed reconciliation', async () => {
  const stale = deferred();
  const replay = deferred();
  const refreshed = deferred();
  const saved = { id: 'edited', content: 'Saved body' };
  const fetchPage = vi.fn()
    .mockResolvedValueOnce({ items: [row('edited'), row('removed'), row('older')], nextCursor: 'boundary' })
    .mockReturnValueOnce(stale.promise).mockReturnValueOnce(replay.promise)
    .mockReturnValueOnce(refreshed.promise)
    .mockResolvedValueOnce({ items: [saved, row('newest')], nextCursor: 'edited' });
  const { result } = renderHook(() => usePagedCollection(fetchPage));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => { void result.current.loadMore(); });
  const signal = fetchPage.mock.calls[1][0].signal;
  act(() => { void result.current.refreshFirst(); });
  act(() => { void result.current.setItems(items => items.filter(item => item.id !== 'removed')
    .map(item => item.id === saved.id ? saved : item)); });
  expect(signal.aborted).toBe(true);
  expect(fetchPage.mock.calls.slice(1).map(([request]) => request.cursor)).toEqual(['boundary', 'boundary']);
  await act(async () => replay.resolve({ items: [row('oldest')], nextCursor: null }));
  expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null }));
  await act(async () => stale.resolve({ items: [row('edited'), row('removed')], nextCursor: 'wrong' }));
  expect(result.current.items).toEqual([saved, row('older'), row('oldest')]);
  await act(async () => refreshed.reject(new Error('Refresh unavailable')));
  // Idle local changes keep the failed refresh available for an explicit retry.
  act(() => { result.current.setItems([...result.current.items]); });
  expect(fetchPage).toHaveBeenCalledTimes(4);
  expect(result.current.error.message).toBe('Refresh unavailable');
  await act(async () => result.current.loadMore());
  expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null }));
  expect(result.current.items).toEqual([saved, row('newest'), row('older'), row('oldest')]);
  expect(result.current.error).toBeNull();
  expect(result.current.hasMore).toBe(false);
});

it('disposes mutation replay and queued refreshes when filters change or the collection unmounts', async () => {
  const stale = deferred();
  const replay = deferred();
  const filtered = deferred();
  const firstQuery = vi.fn().mockResolvedValueOnce({ items: [row('edited')], nextCursor: null })
    .mockReturnValueOnce(stale.promise).mockReturnValueOnce(replay.promise);
  const secondQuery = vi.fn().mockReturnValueOnce(filtered.promise);
  const { result, rerender, unmount } = renderHook(({ query }) => usePagedCollection(query), { initialProps: { query: firstQuery } });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => { void result.current.refreshFirst(); });
  act(() => { void result.current.refreshFirst(); });
  act(() => { void result.current.setItems([row('saved')]); });
  rerender({ query: secondQuery });
  expect(firstQuery.mock.calls[2][0].signal.aborted).toBe(true);
  await act(async () => {
    stale.resolve({ items: [row('stale')], nextCursor: null });
    replay.resolve({ items: [row('saved')], nextCursor: null });
  });
  expect(result.current.items).toEqual([]);
  act(() => { void result.current.refreshFirst(); });
  unmount();
  expect(secondQuery.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => filtered.resolve({ items: [row('filtered')], nextCursor: null }));
  expect(firstQuery).toHaveBeenCalledTimes(3);
  expect(secondQuery).toHaveBeenCalledTimes(1);
});
