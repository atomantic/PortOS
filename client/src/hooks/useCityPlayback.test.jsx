import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const getCitySnapshots = vi.fn();
vi.mock('../services/apiCity.js', () => ({
  getCitySnapshots: (...a) => getCitySnapshots(...a),
}));

import { useCityPlayback, PLAYBACK_SPEEDS } from './useCityPlayback.js';

const mkFrames = (n) => Array.from({ length: n }, (_, i) => ({
  ts: `2026-06-05T0${i}:00:00.000Z`,
  schemaVersion: 1,
  apps: [],
  counts: {},
}));

describe('useCityPlayback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCitySnapshots.mockResolvedValue({ total: 3, snapshots: mkFrames(3) });
  });

  it('loads the series on enter and starts at the most recent frame', async () => {
    const { result } = renderHook(() => useCityPlayback());
    await act(async () => { await result.current.enter(); });
    expect(result.current.active).toBe(true);
    expect(result.current.frameCount).toBe(3);
    expect(result.current.frameIndex).toBe(2); // newest
    expect(result.current.currentFrame.ts).toBe('2026-06-05T02:00:00.000Z');
  });

  it('flags an error (distinct from empty) when the fetch fails', async () => {
    getCitySnapshots.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useCityPlayback());
    await act(async () => { await result.current.enter(); });
    expect(result.current.error).toBe(true);
    expect(result.current.frameCount).toBe(0);
  });

  it('a real empty history is not an error', async () => {
    getCitySnapshots.mockResolvedValue({ total: 0, snapshots: [] });
    const { result } = renderHook(() => useCityPlayback());
    await act(async () => { await result.current.enter(); });
    expect(result.current.error).toBe(false);
    expect(result.current.frameCount).toBe(0);
  });

  it('filters out frames with an unsupported schemaVersion', async () => {
    getCitySnapshots.mockResolvedValue({
      snapshots: [...mkFrames(2), { ts: 'x', schemaVersion: 99, apps: [] }],
    });
    const { result } = renderHook(() => useCityPlayback());
    await act(async () => { await result.current.enter(); });
    expect(result.current.frameCount).toBe(2);
  });

  it('step clamps at both ends and pauses', async () => {
    const { result } = renderHook(() => useCityPlayback());
    await act(async () => { await result.current.enter(); });
    act(() => result.current.step(1));  // already at last → clamps
    expect(result.current.frameIndex).toBe(2);
    act(() => result.current.seek(0));
    act(() => result.current.step(-1)); // at first → clamps
    expect(result.current.frameIndex).toBe(0);
  });

  it('cycleSpeed walks the speed presets', async () => {
    const { result } = renderHook(() => useCityPlayback());
    await act(async () => { await result.current.enter(); });
    expect(result.current.speed).toBe(PLAYBACK_SPEEDS[0]);
    act(() => result.current.cycleSpeed());
    expect(result.current.speed).toBe(PLAYBACK_SPEEDS[1]);
  });

  it('exit clears active + playing', async () => {
    const { result } = renderHook(() => useCityPlayback());
    await act(async () => { await result.current.enter(); });
    act(() => result.current.exit());
    expect(result.current.active).toBe(false);
    expect(result.current.playing).toBe(false);
  });

  describe('autoplay timer', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('advances frames while playing and stops at the end', async () => {
      const { result } = renderHook(() => useCityPlayback());
      await act(async () => { await result.current.enter(); });
      // seek to start, then play
      act(() => result.current.seek(0));
      act(() => result.current.togglePlay());
      expect(result.current.playing).toBe(true);

      act(() => vi.advanceTimersByTime(1000)); // 1× → +1 frame
      expect(result.current.frameIndex).toBe(1);
      act(() => vi.advanceTimersByTime(1000));
      expect(result.current.frameIndex).toBe(2);
      // at last frame → auto-pauses, no further advance
      act(() => vi.advanceTimersByTime(2000));
      expect(result.current.frameIndex).toBe(2);
      expect(result.current.playing).toBe(false);
    });

    it('does not advance after exit (timer torn down)', async () => {
      const { result } = renderHook(() => useCityPlayback());
      await act(async () => { await result.current.enter(); });
      act(() => result.current.seek(0));
      act(() => result.current.togglePlay());
      act(() => result.current.exit());
      act(() => vi.advanceTimersByTime(5000));
      expect(result.current.frameIndex).toBe(0);
    });
  });
});
