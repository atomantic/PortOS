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
