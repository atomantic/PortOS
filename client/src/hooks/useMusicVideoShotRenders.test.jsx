import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: vi.fn((event, fn) => handlers.set(event, fn)),
    off: vi.fn((event) => handlers.delete(event)),
  },
}));

vi.mock('../services/apiMusicVideo.js', () => ({
  getMusicVideoShotRenders: vi.fn(),
}));

import useMusicVideoShotRenders from './useMusicVideoShotRenders.js';
import { getMusicVideoShotRenders } from '../services/apiMusicVideo.js';

const project = {
  id: 'mv-test',
  composition: { mode: 'composed' },
  scenes: [{ sceneId: 's1' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
});

describe('useMusicVideoShotRenders', () => {
  it('stays off (null status) for non-composed composition modes', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useMusicVideoShotRenders({ ...project, composition: { mode: 'concat' } }));
      await act(async () => { await vi.advanceTimersByTimeAsync(700); });
      expect(result.current.status).toBeNull();
      expect(getMusicVideoShotRenders).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces initial read by 600ms and updates status when resolved', async () => {
    vi.useFakeTimers();
    try {
      const response = { available: true, ready: 1, total: 1, shots: [{ sceneId: 's1', state: 'rendered' }] };
      getMusicVideoShotRenders.mockResolvedValueOnce(response);

      const { result } = renderHook(() => useMusicVideoShotRenders(project));
      expect(result.current.status).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(599); });
      expect(getMusicVideoShotRenders).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(getMusicVideoShotRenders).toHaveBeenCalledWith('mv-test', { silent: true });
      expect(result.current.status).toEqual(response);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates pending in-flight reads when render inputs change', async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst;
      const firstPromise = new Promise((resolve) => { resolveFirst = resolve; });
      getMusicVideoShotRenders.mockReturnValueOnce(firstPromise);

      let currentProject = { ...project };
      const { result, rerender } = renderHook(({ p }) => useMusicVideoShotRenders(p), {
        initialProps: { p: currentProject },
      });

      // Advance 600ms so first request fires
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(getMusicVideoShotRenders).toHaveBeenCalledTimes(1);

      // Edit inputs before first request resolves
      currentProject = { ...project, scenes: [{ sceneId: 's1' }, { sceneId: 's2' }] };
      let resolveSecond;
      const secondPromise = new Promise((resolve) => { resolveSecond = resolve; });
      getMusicVideoShotRenders.mockReturnValueOnce(secondPromise);
      rerender({ p: currentProject });

      // First request resolves during the new cut's 600ms debounce
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
        resolveFirst({ available: true, ready: 1, total: 1, shots: [{ sceneId: 's1', state: 'rendered' }] });
      });

      // First request response must have been discarded
      expect(result.current.status).toBeNull();

      // Finish second debounce
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(getMusicVideoShotRenders).toHaveBeenCalledTimes(2);

      // Second request resolves
      const secondResponse = { available: true, ready: 0, total: 2, shots: [{ sceneId: 's1', state: 'stale' }, { sceneId: 's2', state: 'stale' }] };
      await act(async () => {
        resolveSecond(secondResponse);
      });
      expect(result.current.status).toEqual(secondResponse);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes a failed refresh with an error status rather than retaining old readiness, and allows retry', async () => {
    vi.useFakeTimers();
    try {
      getMusicVideoShotRenders.mockRejectedValueOnce(new Error('Backend timeout'));

      const { result } = renderHook(() => useMusicVideoShotRenders(project));

      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(getMusicVideoShotRenders).toHaveBeenCalledTimes(1);
      expect(result.current.status).toEqual({
        available: true,
        error: { message: 'Backend timeout' },
        shots: [],
        outro: null,
        ready: 0,
        total: 0,
      });

      // Retry
      const successResponse = { available: true, ready: 1, total: 1, shots: [{ sceneId: 's1', state: 'rendered' }] };
      getMusicVideoShotRenders.mockResolvedValueOnce(successResponse);

      await act(async () => {
        result.current.retry();
      });
      expect(getMusicVideoShotRenders).toHaveBeenCalledTimes(2);
      expect(result.current.status).toEqual(successResponse);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks live render events from socket and refreshes when settled', async () => {
    vi.useFakeTimers();
    try {
      getMusicVideoShotRenders.mockResolvedValue({ available: true, ready: 0, total: 1, shots: [{ sceneId: 's1', state: 'stale' }] });
      const { result } = renderHook(() => useMusicVideoShotRenders(project));
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });

      expect(handlers.has('music-video:shot-render')).toBe(true);
      const onEvent = handlers.get('music-video:shot-render');

      // Live rendering event
      act(() => {
        onEvent({ projectId: 'mv-test', sceneId: 's1', state: 'rendering', progress: 0.5 });
      });
      expect(result.current.live.s1).toMatchObject({ projectId: 'mv-test', sceneId: 's1', state: 'rendering', progress: 0.5 });

      // Settled event triggers refresh
      getMusicVideoShotRenders.mockResolvedValueOnce({ available: true, ready: 1, total: 1, shots: [{ sceneId: 's1', state: 'rendered' }] });
      await act(async () => {
        onEvent({ projectId: 'mv-test', sceneId: 's1', state: 'rendered', progress: 1.0 });
      });
      expect(result.current.live.s1).toBeUndefined();
      expect(result.current.status.ready).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a rendering entry on reconnect when the refreshed status no longer lists it as rendering', async () => {
    vi.useFakeTimers();
    try {
      getMusicVideoShotRenders.mockResolvedValue({ available: true, ready: 0, total: 1, shots: [{ sceneId: 's1', state: 'stale', rendering: false }] });
      const { result } = renderHook(() => useMusicVideoShotRenders(project));
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });

      act(() => {
        handlers.get('music-video:shot-render')({ projectId: 'mv-test', sceneId: 's1', state: 'rendering', progress: 0.4 });
      });
      expect(result.current.live.s1).toBeDefined();

      await act(async () => { handlers.get('connect')(); });
      expect(getMusicVideoShotRenders).toHaveBeenCalledTimes(2);
      expect(result.current.live.s1).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a rendering entry on reconnect when the refreshed status still reports the shot rendering', async () => {
    vi.useFakeTimers();
    try {
      getMusicVideoShotRenders.mockResolvedValue({ available: true, ready: 0, total: 1, shots: [{ sceneId: 's1', state: 'stale', rendering: false }] });
      const { result } = renderHook(() => useMusicVideoShotRenders(project));
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });

      act(() => {
        handlers.get('music-video:shot-render')({ projectId: 'mv-test', sceneId: 's1', state: 'rendering', progress: 0.4 });
      });

      getMusicVideoShotRenders.mockResolvedValueOnce({ available: true, ready: 0, total: 1, shots: [{ sceneId: 's1', state: 'stale', rendering: true }] });
      await act(async () => { handlers.get('connect')(); });
      expect(result.current.live.s1).toMatchObject({ state: 'rendering', progress: 0.4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a progress tick during the reconnect read still drops the stale rendering entry', async () => {
    vi.useFakeTimers();
    try {
      getMusicVideoShotRenders.mockResolvedValue({ available: true, ready: 0, total: 1, shots: [{ sceneId: 's1', state: 'stale', rendering: false }] });
      const { result } = renderHook(() => useMusicVideoShotRenders(project));
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });

      act(() => {
        handlers.get('music-video:shot-render')({ projectId: 'mv-test', sceneId: 's1', state: 'rendering', progress: 0.1 });
      });

      let resolveRead;
      getMusicVideoShotRenders.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
      act(() => { handlers.get('connect')(); });

      // Progress for the same render arrives while the read is pending: the render did not restart.
      act(() => {
        handlers.get('music-video:shot-render')({ projectId: 'mv-test', sceneId: 's1', state: 'rendering', progress: 0.2 });
      });
      await act(async () => { resolveRead({ available: true, ready: 0, total: 1, shots: [{ sceneId: 's1', state: 'stale', rendering: false }] }); });
      expect(result.current.live.s1).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a competing refresh that wins while the reconnect read is in flight still reconciles stale entries', async () => {
    vi.useFakeTimers();
    try {
      getMusicVideoShotRenders.mockResolvedValue({ available: true, ready: 0, total: 2, shots: [{ sceneId: 's1', state: 'stale', rendering: false }, { sceneId: 's2', state: 'stale', rendering: false }] });
      const { result } = renderHook(() => useMusicVideoShotRenders(project));
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });

      act(() => {
        handlers.get('music-video:shot-render')({ projectId: 'mv-test', sceneId: 's1', state: 'rendering', progress: 0.3 });
      });

      let resolveConnectRead;
      getMusicVideoShotRenders.mockReturnValueOnce(new Promise((resolve) => { resolveConnectRead = resolve; }));
      act(() => { handlers.get('connect')(); });

      // A terminal event for another shot starts a competing read, which wins.
      await act(async () => { handlers.get('music-video:shot-render')({ projectId: 'mv-test', sceneId: 's2', state: 'rendered', progress: 1 }); });
      // The winning read reports s1 as not rendering, so it settles the card.
      expect(result.current.live.s1).toBeUndefined();

      // The superseded connect read resolves last and applies nothing.
      await act(async () => { resolveConnectRead({ available: true, ready: 0, total: 2, shots: [{ sceneId: 's1', state: 'stale', rendering: true }] }); });
      expect(result.current.live.s1).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an optimistic start issued after the reconnect read began', async () => {
    vi.useFakeTimers();
    try {
      getMusicVideoShotRenders.mockResolvedValue({ available: true, ready: 0, total: 1, shots: [{ sceneId: 's1', state: 'stale', rendering: false }] });
      const { result } = renderHook(() => useMusicVideoShotRenders(project));
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });

      let resolveRead;
      getMusicVideoShotRenders.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
      act(() => { handlers.get('connect')(); });

      // A render the user starts while the read is pending was not visible to that read.
      act(() => { result.current.markLive('s1', { state: 'rendering', progress: 0 }); });
      await act(async () => { resolveRead({ available: true, ready: 0, total: 1, shots: [{ sceneId: 's1', state: 'stale', rendering: false }] }); });
      expect(result.current.live.s1).toMatchObject({ state: 'rendering', progress: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
