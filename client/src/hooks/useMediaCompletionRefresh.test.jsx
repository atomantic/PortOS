import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import socket from '../services/socket';
import { useMediaCompletionRefresh } from './useMediaCompletionRefresh';

vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
afterEach(() => vi.useRealTimers());

it('refreshes usable batch outputs after failure without treating an empty failure as new media', () => {
  vi.useFakeTimers();
  const refresh = vi.fn();
  const { unmount } = renderHook(() => useMediaCompletionRefresh({ onVideoCompleted: refresh }));
  const failed = socket.on.mock.calls.find(([event]) => event === 'video-gen:failed')[1];
  act(() => {
    failed({ error: 'No outputs' });
    failed({ results: [] });
    vi.advanceTimersByTime(250);
  });
  expect(refresh).not.toHaveBeenCalled();
  act(() => {
    failed({ results: [{ filename: 'example.mp4', seed: 0 }] });
    vi.advanceTimersByTime(250);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  unmount();
  expect(socket.off).toHaveBeenCalledWith('video-gen:failed', failed);
});
