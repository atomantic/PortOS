import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useModelInputPreview } from './useModelInputPreview';

afterEach(() => vi.useRealTimers());

describe('useModelInputPreview', () => {
  // Typing fires one request after the pause, and an older answer arriving
  // late must never replace the preview of what the form says now.
  it('asks once per pause and keeps only the newest answer', async () => {
    vi.useFakeTimers();
    const resolvers = [];
    const fetchPreview = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    const { result, rerender } = renderHook(({ body }) => useModelInputPreview(fetchPreview, body), { initialProps: { body: { prompt: 'a' } } });

    rerender({ body: { prompt: 'a fox' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(fetchPreview).toHaveBeenCalledTimes(1);
    expect(fetchPreview).toHaveBeenLastCalledWith({ prompt: 'a fox' }, { silent: true });

    rerender({ body: { prompt: 'a red fox' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { resolvers[1]({ sentPrompt: 'a red fox' }); });
    await act(async () => { resolvers[0]({ sentPrompt: 'a fox' }); });
    expect(result.current.preview).toEqual({ sentPrompt: 'a red fox' });
    rerender({ body: { prompt: 'another character' } });
    expect(result.current.preview).toBeNull();
  });

  it('reports a refusal as the error to show', async () => {
    vi.useFakeTimers();
    const fetchPreview = vi.fn(async () => { throw new Error('Codex Imagegen is disabled'); });
    const { result } = renderHook(() => useModelInputPreview(fetchPreview, { prompt: 'a fox' }));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(result.current).toEqual({ preview: null, error: 'Codex Imagegen is disabled' });
  });

  it('invalidates saved previews and drops old context responses when the library revision changes', async () => {
    vi.useFakeTimers();
    const resolvers = [];
    const fetchPreview = vi.fn(() => new Promise(resolve => resolvers.push(resolve)));
    const { result, rerender } = renderHook(({ revision }) => useModelInputPreview(fetchPreview,
      { mediaKey: 'source.png', feedback: 'Keep identity' }, { revision }), { initialProps: { revision: 'old' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    rerender({ revision: 'new' });
    expect(result.current.preview).toBeNull();
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { resolvers[1]({ sentPrompt: 'new age and guides' }); });
    await act(async () => { resolvers[0]({ sentPrompt: 'old age and guides' }); });
    expect(result.current.preview).toEqual({ sentPrompt: 'new age and guides' });
    expect(fetchPreview).toHaveBeenCalledTimes(2);
    expect(fetchPreview).toHaveBeenLastCalledWith({ mediaKey: 'source.png', feedback: 'Keep identity' }, { silent: true });
  });

  it('hides the preview when disabled and drops an in-flight refusal', async () => {
    vi.useFakeTimers();
    let rejectPreview;
    const fetchPreview = vi.fn(() => new Promise((_resolve, reject) => { rejectPreview = reject; }));
    const { result, rerender } = renderHook(
      ({ enabled }) => useModelInputPreview(fetchPreview, { prompt: 'a fox' }, { enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => { vi.advanceTimersByTime(500); });
    rerender({ enabled: false });
    expect(result.current).toEqual({ preview: null, error: null });
    await act(async () => { rejectPreview(new Error('stale refusal')); });
    rerender({ enabled: true });
    expect(result.current).toEqual({ preview: null, error: null });
  });
});
