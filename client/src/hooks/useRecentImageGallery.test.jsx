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
    const beforeCompletion = listImageGalleryPage.mock.calls.length;
    act(() => result.current.refreshRecent());
    await waitFor(() => expect(listImageGalleryPage).toHaveBeenCalledTimes(beforeCompletion + 1));
    expect(result.current.gallery).toHaveLength(67);
    expect(listImageGalleryPage).toHaveBeenLastCalledWith(
      { limit: 5, hidden: false, starred: false, summary: true }, { silent: true });
    act(() => result.current.refreshGallery());
    await waitFor(() => expect(result.current.gallery).toHaveLength(65));
    expect(listImageGalleryPage.mock.calls.every(([params]) => params.limit <= 60)).toBe(true);
    rerender(initial);
    await waitFor(() => expect(result.current.gallery).toHaveLength(5));
    const beforePreview = listImageGalleryPage.mock.calls.length;
    rerender({ ...initial, previewParam: 'image:v0.png' });
    expect(result.current.previewImage?.filename).toBe('v0.png');
    expect(listImageGalleryPage).toHaveBeenCalledTimes(beforePreview);
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

  it('retries hidden errors, deduplicates overlapping pages, and restarts the scope only after favorite saves settle', async () => {
    const first = images('hidden', 60, true);
    listImageGalleryPage.mockImplementation(async ({ limit, offset = 0, hidden, starred }) => ({
      items: !hidden ? images('visible', 5) : starred ? images('favorite', 1, true)
        : offset ? [first[59], { filename: 'last.png', hidden: true }] : first,
      total: hidden ? (starred ? 1 : 62) : 2000, hiddenTotal: 62, limit, offset,
    }));
    const { result, rerender } = renderHook(props => useRecentImageGallery(props), { initialProps: { ...initial, showHidden: true } });
    await waitFor(() => expect(result.current.gallery).toHaveLength(65));
    listImageGalleryPage.mockRejectedValueOnce(new Error('offline'));
    act(() => result.current.loadMoreHidden());
    await waitFor(() => expect(result.current.hiddenError).toBe(true));
    act(() => result.current.refreshGallery());
    await waitFor(() => expect(result.current.hiddenLoading).toBe(false));
    expect(result.current.hiddenError).toBe(false);
    act(() => result.current.loadMoreHidden());
    await waitFor(() => expect(result.current.gallery).toHaveLength(66));
    expect(result.current.gallery.filter(item => item.filename === first[59].filename)).toHaveLength(1);
    const beforeSave = listImageGalleryPage.mock.calls.length;
    rerender({ ...initial, showHidden: true, favoritesOnly: true, annotationRevision: 'image:favorite0.png', annotationPending: true });
    expect(listImageGalleryPage).toHaveBeenCalledTimes(beforeSave);
    rerender({ ...initial, showHidden: true, favoritesOnly: true, annotationRevision: 'image:favorite0.png', annotationPending: false });
    await waitFor(() => expect(result.current.gallery).toHaveLength(6));
    expect(listImageGalleryPage).toHaveBeenCalledTimes(beforeSave + 2);
    expect(listImageGalleryPage).toHaveBeenLastCalledWith(
      { limit: 60, offset: 0, hidden: true, starred: true }, { silent: true });
    expect(result.current.hasMoreHidden).toBe(false);
  });

});
