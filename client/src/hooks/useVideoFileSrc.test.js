import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const getVideoHistoryItem = vi.fn();
vi.mock('../services/apiImageVideo.js', () => ({
  getVideoHistoryItem: (...args) => getVideoHistoryItem(...args),
}));

const { useVideoFileSrc } = await import('./useVideoFileSrc.js');

// Obviously-fake entries. The two shapes that matter: a timeline render, whose
// filename is unrelated to its id, and a clip render, whose filename happens to
// be `<id>.mp4`.
const HISTORY = {
  'final-1': { id: 'final-1', filename: 'timeline-abcd1234-1700000000000.mp4' },
  'scene-1': { id: 'scene-1', filename: 'scene-1.mp4' },
};

// Stand-in for the real by-id endpoint: `request()` throws an Error carrying
// `.status` on a non-2xx, so an unknown id REJECTS with a 404 rather than
// resolving to undefined. The hook must treat that as "no file", not as a bug.
const notFound = () => Object.assign(new Error('Not found'), { status: 404, code: 'NOT_FOUND' });

beforeEach(() => {
  getVideoHistoryItem.mockReset();
  getVideoHistoryItem.mockImplementation(async (id) => HISTORY[id] || Promise.reject(notFound()));
});

describe('useVideoFileSrc', () => {
  it('resolves a timeline id to its real, unrelated filename', async () => {
    const { result } = renderHook(() => useVideoFileSrc('final-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.src).toBe('/data/videos/timeline-abcd1234-1700000000000.mp4');
  });

  it('reports `resolving` synchronously on the first render, before any effect runs', async () => {
    // The regression this guards: an effect-set flag is false on the first
    // render, so a caller gating autoplay would mount a player for one frame
    // against the unresolved path and fire a doomed request.
    const { result } = renderHook(() => useVideoFileSrc('final-1'));
    expect(result.current.resolving).toBe(true);
    expect(result.current.src).toBeNull();
    await act(async () => {}); // settle the in-flight lookup
  });

  it('reports `resolving` synchronously the moment `enabled` flips true', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useVideoFileSrc('final-1', { enabled }),
      { initialProps: { enabled: false } },
    );
    expect(result.current.resolving).toBe(false);
    expect(getVideoHistoryItem).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(result.current.resolving).toBe(true); // synchronous, not after commit
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.src).toBe('/data/videos/timeline-abcd1234-1700000000000.mp4');
  });

  it('never fetches while disabled — the grid must stay light', () => {
    renderHook(() => useVideoFileSrc('final-1', { enabled: false }));
    expect(getVideoHistoryItem).not.toHaveBeenCalled();
  });

  it('does not fetch without a jobId', () => {
    const { result } = renderHook(() => useVideoFileSrc(null));
    expect(getVideoHistoryItem).not.toHaveBeenCalled();
    expect(result.current.resolving).toBe(false);
    expect(result.current.src).toBeNull();
  });

  it('settles with a null src when the endpoint 404s the id (deleted media)', async () => {
    const { result } = renderHook(() => useVideoFileSrc('gone-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    // Null, not a guess — the caller falls back to ScenePreview's own
    // reconstruction + missing-media UI. A 404 arrives as a REJECTION from
    // request(), so this also pins that the hook doesn't leave `resolving` latched.
    expect(result.current.src).toBeNull();
  });

  it('settles instead of latching when the lookup fails', async () => {
    getVideoHistoryItem.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useVideoFileSrc('final-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.src).toBeNull();
  });

  it('tolerates an entry that carries no usable filename', async () => {
    // A hand-edited/partially-written history row. Null, not `/data/videos/undefined`.
    getVideoHistoryItem.mockResolvedValue({ id: 'final-1', filename: '   ' });
    const { result } = renderHook(() => useVideoFileSrc('final-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.src).toBeNull();
  });

  it('re-resolves when the jobId changes', async () => {
    const { result, rerender } = renderHook(({ id }) => useVideoFileSrc(id), {
      initialProps: { id: 'final-1' },
    });
    await waitFor(() => expect(result.current.src).toBe('/data/videos/timeline-abcd1234-1700000000000.mp4'));

    rerender({ id: 'scene-1' });
    // Must not keep serving the previous id's file while the new one resolves.
    expect(result.current.src).toBeNull();
    await waitFor(() => expect(result.current.src).toBe('/data/videos/scene-1.mp4'));
  });

  it('recovers a transiently-failed lookup via retry()', async () => {
    // The regression: a settled failure used to be permanent, so a 5xx blip
    // stranded a timeline final on the reconstructed URL that cannot exist for
    // it — and ScenePreview's Retry only re-requested that same wrong URL.
    getVideoHistoryItem.mockRejectedValueOnce(new Error('transient 503'));
    const { result } = renderHook(() => useVideoFileSrc('final-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.src).toBeNull();

    act(() => { result.current.retry(); });
    expect(result.current.resolving).toBe(true); // synchronously re-armed
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.src).toBe('/data/videos/timeline-abcd1234-1700000000000.mp4');
    expect(getVideoHistoryItem).toHaveBeenCalledTimes(2);
  });

  it('keeps retry() stable across renders', async () => {
    const { result, rerender } = renderHook(() => useVideoFileSrc('final-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    const first = result.current.retry;
    rerender();
    expect(result.current.retry).toBe(first);
  });

  it('requests silently — the caller owns the failure UI', async () => {
    const { result } = renderHook(() => useVideoFileSrc('final-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(getVideoHistoryItem).toHaveBeenCalledWith('final-1', { silent: true });
  });

  it('asks for exactly the one id — never the whole history list (#4165)', async () => {
    // The regression this locks: three surfaces used to download every render
    // the install has ever produced just to read one filename.
    const { result } = renderHook(() => useVideoFileSrc('scene-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(getVideoHistoryItem).toHaveBeenCalledTimes(1);
    expect(getVideoHistoryItem.mock.calls[0][0]).toBe('scene-1');
  });
});
