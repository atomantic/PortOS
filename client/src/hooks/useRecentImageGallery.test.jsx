import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRecentImageGallery } from './useRecentImageGallery';
import { listImageGalleryPage } from '../services/api';

vi.mock('../services/api', () => ({ listImageGalleryPage: vi.fn() }));
const images = (prefix, count, hidden = false) => Array.from({ length: count }, (_, i) => ({
  filename: `${prefix}${i}.png`, hidden,
}));
const initial = { favoritesOnly: false, showHidden: false, previewParam: null };

beforeEach(() => { listImageGalleryPage.mockReset(); });

describe('recent gallery request lifecycle', () => {
  it('loads five plus totals, lazily pages hidden images, and refreshes bounded windows after mutations', async () => {
    listImageGalleryPage.mockImplementation(async ({ limit, offset = 0, hidden }) => ({
      items: hidden ? images(`h${offset}-`, offset ? 2 : 60, true) : images('v', 5),
      total: hidden ? 62 : 2000, hiddenTotal: 62, limit, offset,
    }));
    const { result, rerender } = renderHook(props => useRecentImageGallery(props), { initialProps: initial });
    await waitFor(() => expect(result.current.total).toBe(2000));
    expect(listImageGalleryPage).toHaveBeenCalledTimes(1);
    expect(listImageGalleryPage).toHaveBeenLastCalledWith(
      { limit: 5, hidden: false, starred: false, summary: true }, { silent: true });
    expect(result.current.gallery).toHaveLength(5);
    expect(result.current.hiddenTotal).toBe(62);

    rerender({ ...initial, showHidden: true });
    await waitFor(() => expect(result.current.gallery).toHaveLength(65));
    act(() => result.current.loadMoreHidden());
    await waitFor(() => expect(result.current.gallery).toHaveLength(67));
    expect(listImageGalleryPage).toHaveBeenLastCalledWith(
      { limit: 60, offset: 60, hidden: true, starred: false }, { silent: true });
    expect(result.current.hasMoreHidden).toBe(false);
    act(() => result.current.refreshGallery());
    await waitFor(() => expect(result.current.gallery).toHaveLength(65));
    expect(listImageGalleryPage.mock.calls.every(([params]) => params.limit <= 60)).toBe(true);
  });

  it('rejects stale filter responses, retries failed requests and resolves an older preview without downloading the gallery', async () => {
    let finishOld;
    listImageGalleryPage.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce({ items: images('favorite', 1), total: 1, hiddenTotal: 0 });
    const { result, rerender } = renderHook(props => useRecentImageGallery(props), { initialProps: initial });
    rerender({ ...initial, favoritesOnly: true });
    await waitFor(() => expect(result.current.gallery[0]?.filename).toBe('favorite0.png'));
    await act(async () => finishOld({ items: images('stale', 5), total: 999, hiddenTotal: 0 }));
    expect(result.current.total).toBe(1);

    listImageGalleryPage.mockRejectedValueOnce(new Error('offline'));
    act(() => result.current.refreshGallery());
    await waitFor(() => expect(result.current.error).toBe(true));
    listImageGalleryPage.mockResolvedValueOnce({ items: images('favorite', 1), total: 1, hiddenTotal: 0 });
    act(() => result.current.refreshGallery());
    await waitFor(() => expect(result.current.error).toBe(false));
    listImageGalleryPage.mockResolvedValueOnce({ items: [{ filename: 'old-hidden.png', hidden: true }], total: 1 });
    rerender({ ...initial, favoritesOnly: true, previewParam: 'image:old-hidden.png' });
    await waitFor(() => expect(result.current.previewImage?.filename).toBe('old-hidden.png'));
    expect(listImageGalleryPage).toHaveBeenLastCalledWith({ limit: 1, filename: 'old-hidden.png' }, { silent: true });
  });
});
