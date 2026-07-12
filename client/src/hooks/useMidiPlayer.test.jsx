import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useMidiPlayer from './useMidiPlayer.js';
import { createMidiPlayer } from '../lib/midiPlayback.js';

vi.mock('../lib/midiPlayback.js', () => ({ createMidiPlayer: vi.fn() }));

// One fake player per createMidiPlayer call, capturing the onEnded wiring.
const makeFakePlayer = () => {
  let playing = false;
  return {
    play: vi.fn(() => { playing = true; return Promise.resolve(); }),
    pause: vi.fn(() => { playing = false; }),
    stop: vi.fn(() => { playing = false; }),
    seek: vi.fn(),
    position: vi.fn(() => 1.25),
    duration: vi.fn(() => 10),
    isPlaying: () => playing,
  };
};

describe('useMidiPlayer', () => {
  let players;
  beforeEach(() => {
    players = [];
    createMidiPlayer.mockReset();
    createMidiPlayer.mockImplementation((data, opts) => {
      const p = { ...makeFakePlayer(), onEnded: opts?.onEnded, data };
      players.push(p);
      return p;
    });
  });

  const DATA = { durationSec: 10, notes: [{ midi: 60, startSec: 0, durationSec: 1 }] };

  it('is inert without data (no player, toggle is a no-op)', () => {
    const { result } = renderHook(() => useMidiPlayer(null));
    expect(createMidiPlayer).not.toHaveBeenCalled();
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(false);
    expect(result.current.getPosition()).toBe(0);
  });

  it('toggle plays, then pauses; getPosition reads the player', async () => {
    const { result } = renderHook(() => useMidiPlayer(DATA));
    await act(async () => result.current.toggle());
    expect(players[0].play).toHaveBeenCalledTimes(1);
    expect(result.current.playing).toBe(true);
    expect(result.current.getPosition()).toBe(1.25);
    await act(async () => result.current.toggle());
    expect(players[0].pause).toHaveBeenCalledTimes(1);
    expect(result.current.playing).toBe(false);
  });

  it('resets the playing flag when the player reports ended', async () => {
    const { result } = renderHook(() => useMidiPlayer(DATA));
    await act(async () => result.current.toggle());
    expect(result.current.playing).toBe(true);
    act(() => players[0].onEnded());
    expect(result.current.playing).toBe(false);
  });

  it('tears the player down (stop) when the data changes, and builds a new one', async () => {
    const NEXT = { durationSec: 5, notes: [] };
    const { result, rerender } = renderHook(({ data }) => useMidiPlayer(data), {
      initialProps: { data: DATA },
    });
    await act(async () => result.current.toggle());
    rerender({ data: NEXT });
    expect(players[0].stop).toHaveBeenCalled();
    expect(result.current.playing).toBe(false);
    expect(createMidiPlayer).toHaveBeenCalledTimes(2);
    expect(players[1].data).toBe(NEXT);
  });

  it('stops the player on unmount', async () => {
    const { result, unmount } = renderHook(() => useMidiPlayer(DATA));
    await act(async () => result.current.toggle());
    unmount();
    expect(players[0].stop).toHaveBeenCalled();
  });

  it('resets the playing flag when play() rejects (autoplay policy edge)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useMidiPlayer(DATA));
    players[0].play.mockImplementation(() => Promise.reject(new Error('denied')));
    await act(async () => { result.current.toggle(); });
    expect(result.current.playing).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('seek forwards to the player', async () => {
    const { result } = renderHook(() => useMidiPlayer(DATA));
    act(() => result.current.seek(3.5));
    expect(players[0].seek).toHaveBeenCalledWith(3.5);
  });
});
