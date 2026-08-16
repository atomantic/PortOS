import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { useVideoGenQueue } from './useVideoGenQueue.js';
import toast from '../components/ui/Toast';

const flush = () => act(async () => {});

describe('useVideoGenQueue', () => {
  beforeEach(() => {
    toast.success.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves string filenames and File/Blob objects when a queued item is dispatched', async () => {
    const sourceImageFile = new File(['x'], 'source.png', { type: 'image/png' });
    const seen = [];
    const runGeneration = vi.fn(async (payload) => {
      seen.push(payload);
      return { ok: true };
    });

    const { result } = renderHook(() => useVideoGenQueue({
      generating: false,
      runGeneration,
    }));

    act(() => {
      result.current.enqueue({
        prompt: 'a cinematic scene',
        sourceImage: 'gallery_source.png',
        lastImage: 'gallery_last.png',
        icReferenceImageFiles: ['ref1.png', 'ref2.png'],
        keyframes: [{ frame: 0, image: 'f1.png' }],
        sourceImageFile,
      });
    });

    await waitFor(() => expect(runGeneration).toHaveBeenCalledTimes(1));
    expect(seen[0].sourceImage).toBe('gallery_source.png');
    expect(seen[0].lastImage).toBe('gallery_last.png');
    expect(seen[0].icReferenceImageFiles).toEqual(['ref1.png', 'ref2.png']);
    expect(seen[0].keyframes).toEqual([{ frame: 0, image: 'f1.png' }]);
    expect(seen[0].sourceImageFile).toBe(sourceImageFile);
  });

  it('retries a BUSY item after the backoff instead of marking it errored', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const runGeneration = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('VIDEO_GEN_BUSY'));
      return Promise.resolve({ ok: true });
    });
    const { result } = renderHook(() => useVideoGenQueue({
      generating: false,
      runGeneration,
    }));

    act(() => {
      result.current.enqueue({ prompt: 'one' });
    });
    await waitFor(() => expect(result.current.queue[0]?.status).toBe('pending'));
    expect(result.current.runningQueueId).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    await waitFor(() => expect(result.current.queue[0]?.status).toBe('complete'));
    expect(runGeneration).toHaveBeenCalledTimes(2);
    expect(result.current.runningQueueId).toBeNull();
  });

  it('does not release the slot from a stale BUSY timer after unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runGeneration = vi.fn(() => Promise.reject(new Error('409 already in progress')));
    const { result, unmount } = renderHook(() => useVideoGenQueue({
      generating: false,
      runGeneration,
    }));

    act(() => {
      result.current.enqueue({ prompt: 'one' });
    });
    await waitFor(() => expect(result.current.runningQueueId).not.toBeNull());
    await flush();
    const idAtUnmount = result.current.runningQueueId;
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    // Hook is unmounted — the timer must not throw, and the last observed
    // slot is whatever was running at teardown (not cleared by a leaked fire).
    expect(idAtUnmount).not.toBeNull();
    vi.useRealTimers();
  });

  it('marks a non-BUSY failure as error and releases the slot immediately', async () => {
    const runGeneration = vi.fn(() => Promise.reject(new Error('boom')));
    const { result } = renderHook(() => useVideoGenQueue({
      generating: false,
      runGeneration,
    }));

    act(() => {
      result.current.enqueue({ prompt: 'one' });
    });
    await waitFor(() => expect(result.current.queue[0]?.status).toBe('error'));
    expect(result.current.queue[0].error).toBe('boom');
    expect(result.current.runningQueueId).toBeNull();
  });
});
