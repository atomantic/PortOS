import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import useGallerySidecars from './useGallerySidecars';

const getGalleryImages = vi.fn();
vi.mock('../services/apiImageVideo', () => ({ getGalleryImages: (...a) => getGalleryImages(...a) }));

describe('useGallerySidecars', () => {
  beforeEach(() => {
    getGalleryImages.mockReset().mockResolvedValue([{ filename: 'a.png', prompt: 'the composed prompt' }]);
  });

  it('looks up the de-duplicated filenames and keys the map by filename', async () => {
    const { result } = renderHook(() => useGallerySidecars(['a.png', 'a.png']));
    await waitFor(() => expect(result.current.byFilename.get('a.png')?.prompt).toBe('the composed prompt'));
    expect(getGalleryImages).toHaveBeenCalledWith(['a.png'], { silent: true });
  });

  it('re-fetches on the contents, not on array identity', async () => {
    const { rerender } = renderHook(({ names }) => useGallerySidecars(names), {
      initialProps: { names: ['a.png'] },
    });
    await waitFor(() => expect(getGalleryImages).toHaveBeenCalledTimes(1));
    // A page derives this list inside a memo off its record — a fresh array
    // every render. Re-fetching on identity would hammer the server once per
    // keystroke on a 79-card deck.
    rerender({ names: ['a.png'] });
    expect(getGalleryImages).toHaveBeenCalledTimes(1);
    // …and a longer list asks only for what is not already held: a finished
    // render appends one filename, and re-requesting the other 78 to learn it
    // is the difference between one lookup and a whole-deck sweep per card.
    rerender({ names: ['a.png', 'b.png'] });
    await waitFor(() => expect(getGalleryImages).toHaveBeenCalledTimes(2));
    expect(getGalleryImages).toHaveBeenLastCalledWith(['b.png'], { silent: true });
  });

  it('splices one freshly written record in without a refetch', async () => {
    const { result } = renderHook(() => useGallerySidecars(['a.png']));
    await waitFor(() => expect(result.current.byFilename.size).toBe(1));
    act(() => result.current.setSidecar({ filename: 'a-clean.png', prompt: 'cleaned' }));
    expect(result.current.byFilename.get('a-clean.png')?.prompt).toBe('cleaned');
    expect(getGalleryImages).toHaveBeenCalledTimes(1);
  });

  it('skips the request entirely when there is nothing to hydrate', async () => {
    const { result } = renderHook(() => useGallerySidecars([]));
    await waitFor(() => expect(result.current.byFilename.size).toBe(0));
    expect(getGalleryImages).not.toHaveBeenCalled();
  });
});
