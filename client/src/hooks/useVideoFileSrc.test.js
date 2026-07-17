import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const listVideoHistory = vi.fn();
vi.mock('../services/apiImageVideo.js', () => ({
  listVideoHistory: (...args) => listVideoHistory(...args),
}));

const { useVideoFileSrc } = await import('./useVideoFileSrc.js');

// Obviously-fake entries. The two shapes that matter: a timeline render, whose
// filename is unrelated to its id, and a clip render, whose filename happens to
// be `<id>.mp4`.
const HISTORY = [
  { id: 'final-1', filename: 'timeline-abcd1234-1700000000000.mp4' },
  { id: 'scene-1', filename: 'scene-1.mp4' },
];

beforeEach(() => {
  listVideoHistory.mockReset();
  listVideoHistory.mockResolvedValue(HISTORY);
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
    expect(listVideoHistory).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(result.current.resolving).toBe(true); // synchronous, not after commit
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.src).toBe('/data/videos/timeline-abcd1234-1700000000000.mp4');
  });

  it('never fetches while disabled — the grid must stay light', () => {
    renderHook(() => useVideoFileSrc('final-1', { enabled: false }));
    expect(listVideoHistory).not.toHaveBeenCalled();
  });

  it('does not fetch without a jobId', () => {
    const { result } = renderHook(() => useVideoFileSrc(null));
    expect(listVideoHistory).not.toHaveBeenCalled();
    expect(result.current.resolving).toBe(false);
    expect(result.current.src).toBeNull();
  });

  it('settles with a null src for an id missing from history (deleted media)', async () => {
    const { result } = renderHook(() => useVideoFileSrc('gone-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    // Null, not a guess — the caller falls back to ScenePreview's own
    // reconstruction + missing-media UI.
    expect(result.current.src).toBeNull();
  });

  it('settles instead of latching when the lookup fails', async () => {
    listVideoHistory.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useVideoFileSrc('final-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.src).toBeNull();
  });

  it('tolerates a non-array history payload', async () => {
    listVideoHistory.mockResolvedValue({ oops: true });
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

  it('requests silently — the caller owns the failure UI', async () => {
    const { result } = renderHook(() => useVideoFileSrc('final-1'));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(listVideoHistory).toHaveBeenCalledWith({ silent: true });
  });
});
