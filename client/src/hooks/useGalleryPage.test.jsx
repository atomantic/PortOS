import { beforeEach, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock('../services/apiImageVideo', () => ({ listImageGalleryPage: fetchPage }));
import { useGalleryPage } from './useGalleryPage';
beforeEach(() => vi.resetAllMocks());

it('restarts favorites after annotation changes and discards an in-flight older page', async () => {
  let finishOldPage;
  fetchPage.mockResolvedValueOnce({ items: [{ filename: 'unstarred.png' }], total: 2, limit: 1, offset: 0 });
  const { result, rerender } = renderHook(({ revision, paused }) => useGalleryPage({ starred: true, limit: 1 }, { revision, paused }), { initialProps: { revision: 'before', paused: false } });
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  fetchPage.mockReturnValueOnce(new Promise(resolve => { finishOldPage = resolve; }));
  act(() => result.current.loadMore());
  await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
  rerender({ revision: 'after', paused: true });
  expect(result.current.items).toEqual([]);
  fetchPage.mockResolvedValueOnce({ items: [{ filename: 'still-starred.png' }], total: 1, limit: 1, offset: 0 });
  rerender({ revision: 'after', paused: false });
  await waitFor(() => expect(result.current.items).toEqual([{ filename: 'still-starred.png' }]));
  await act(async () => finishOldPage({ items: [{ filename: 'stale.png' }], total: 2, offset: 1, limit: 1 }));
  expect(result.current.items).toEqual([{ filename: 'still-starred.png' }]);
  expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }), { silent: true });
});

it('keeps a retained multi-page window during refresh failure and retries compact pages atomically', async () => {
  let rows = Array.from({ length: 180 }, (_, n) => ({ filename: `${n}.png` }));
  const respond = async ({ offset = 0, limit }) => ({ items: rows.slice(offset, offset + limit), total: rows.length, offset });
  fetchPage.mockImplementation(respond);
  const { result } = renderHook(() => useGalleryPage({ compact: true }, { preserveLoadedOnRefresh: true }));
  await waitFor(() => expect(result.current.items).toHaveLength(60));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(120));
  rows = rows.slice(1);
  fetchPage.mockImplementationOnce(respond).mockRejectedValueOnce(new Error('Second page offline'));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.error).toBe('Second page offline'));
  expect(result.current.items).toHaveLength(120);
  expect(result.current.items[0].filename).toBe('0.png');
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.items[0].filename).toBe('1.png'));
  expect(result.current.items).toHaveLength(120);
  expect(fetchPage.mock.calls.every(([request]) => request.limit === 60 && request.compact)).toBe(true);
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(179));
  expect(result.current.items.at(-1).filename).toBe('179.png');
});

it('retains the prior tail when completion prepends a new record during a long session', async () => {
  let rows = Array.from({ length: 180 }, (_, n) => ({ filename: `${n}.png` }));
  fetchPage.mockImplementation(async ({ offset = 0, limit }) => ({ items: rows.slice(offset, offset + limit), total: rows.length, offset }));
  const { result } = renderHook(() => useGalleryPage({}, { preserveLoadedOnRefresh: true }));
  await waitFor(() => expect(result.current.items).toHaveLength(60));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(120));
  rows = [{ filename: 'new.png' }, ...rows.slice(0, -1)];
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.items[0].filename).toBe('new.png'));
  expect(result.current.items.some(item => item.filename === '119.png')).toBe(true);
  expect(fetchPage.mock.calls.every(([request]) => request.limit === 60)).toBe(true);
});

it('crosses an entirely new first page to retain the prior window and stops after a removed boundary', async () => {
  let rows = Array.from({ length: 600 }, (_, n) => ({ filename: `${n}.png` }));
  fetchPage.mockImplementation(async ({ offset = 0, limit }) => ({ items: rows.slice(offset, offset + limit), total: rows.length, offset }));
  const { result } = renderHook(() => useGalleryPage({}, { preserveLoadedOnRefresh: true }));
  await waitFor(() => expect(result.current.items).toHaveLength(60));
  rows = [...Array.from({ length: 60 }, (_, n) => ({ filename: `new-${n}.png` })), ...rows];
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.items).toHaveLength(120));
  expect(result.current.items.at(-1).filename).toBe('59.png');
  rows = rows.filter(row => row.filename !== '59.png');
  fetchPage.mockClear();
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.items.at(-1).filename).toBe('120.png'));
  expect(fetchPage).toHaveBeenCalledTimes(3);
  expect(result.current.hasMore).toBe(true);
});


it('refreshes a retained favorites window after annotations change while filter changes reset it', async () => {
  let rows = Array.from({ length: 180 }, (_, n) => ({ filename: `${n}.png` }));
  let finishFirst;
  fetchPage.mockImplementation(async ({ offset = 0, limit }) => ({ items: rows.slice(offset, offset + limit), total: rows.length, offset }));
  const { result, rerender } = renderHook(({ revision, starred, paused }) => useGalleryPage({ starred }, { revision, paused, preserveLoadedOnRefresh: true }),
    { initialProps: { revision: 'before', starred: true, paused: false } });
  await waitFor(() => expect(result.current.items).toHaveLength(60));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(120));
  rows = rows.slice(1);
  rerender({ revision: 'after', starred: true, paused: true });
  expect(result.current.items).toHaveLength(120);
  act(() => result.current.loadMore());
  fetchPage.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
  rerender({ revision: 'after', starred: true, paused: false });
  await waitFor(() => expect(finishFirst).toBeTypeOf('function'));
  expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }), { silent: true });
  expect(result.current.items).toHaveLength(120);
  await act(async () => finishFirst({ items: rows.slice(0, 60), total: rows.length, offset: 0 }));
  await waitFor(() => expect(result.current.items[0].filename).toBe('1.png'));
  expect(result.current.items).toHaveLength(120);
  rerender({ revision: 'after', starred: false, paused: true });
  expect(result.current.items).toEqual([]);
});
