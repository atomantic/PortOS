import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { parseScore } from '../lib/scoreNotation.js';

// useColorMatch owns the metronome + pitch tracker + rAF grading loop, none of
// which exist in jsdom. We mock the three Web-Audio seams and assert the parts
// that #1092 made load-bearing: start()'s boolean "did a run actually arm?"
// contract (the owner gates take-harvest on it) and stop()'s analysis return.
const trackerStop = vi.fn();
const analyserClose = vi.fn();
const metronomeStop = vi.fn();
let _lastMetronome = null;

vi.mock('../lib/audioRecorder.js', () => ({
  createStreamAnalyser: vi.fn(() => ({ analyser: { fftSize: 2048 }, context: { currentTime: 0, sampleRate: 44100 }, close: analyserClose })),
}));
vi.mock('../lib/pitchDetect.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, createPitchTracker: vi.fn(() => ({ stop: trackerStop })) };
});
vi.mock('../lib/metronome.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    createMetronome: vi.fn((opts) => {
      _lastMetronome = opts;
      // Resolve start() but never fire onCountInComplete — we only exercise the
      // arm/stop bookkeeping, not the rAF grading loop.
      return { start: vi.fn(() => Promise.resolve()), stop: metronomeStop };
    }),
  };
});

import useColorMatch from './useColorMatch.js';

const stream = () => ({ getTracks: () => [{ stop: vi.fn() }] });
const FOUR = parseScore(['time: 4/4', 'tempo: 120', '| C4q D4q E4q F4q |'].join('\n'));
const REST_ONLY = parseScore(['time: 4/4', 'tempo: 120', '| rw |'].join('\n'));

describe('useColorMatch — start()/stop() contract (#1092)', () => {
  beforeEach(() => {
    trackerStop.mockClear();
    analyserClose.mockClear();
    metronomeStop.mockClear();
    _lastMetronome = null;
  });

  it('start() returns false with no stream', () => {
    const { result } = renderHook(() => useColorMatch({ score: FOUR, stream: null, bpm: 120 }));
    let armed;
    act(() => { armed = result.current.start(); });
    expect(armed).toBe(false);
    expect(result.current.running).toBe(false);
  });

  it('start() returns false for a rest-only score (no gradable notes)', () => {
    const { result } = renderHook(() => useColorMatch({ score: REST_ONLY, stream: stream(), bpm: 120 }));
    let armed;
    act(() => { armed = result.current.start(); });
    expect(armed).toBe(false);
    expect(result.current.running).toBe(false);
  });

  it('start() returns true and begins a run for a gradable score', () => {
    const { result } = renderHook(() => useColorMatch({ score: FOUR, stream: stream(), bpm: 120 }));
    let armed;
    act(() => { armed = result.current.start(); });
    expect(armed).toBe(true);
    expect(result.current.running).toBe(true);
  });

  it('start() returns false when already running (no double-arm)', () => {
    const { result } = renderHook(() => useColorMatch({ score: FOUR, stream: stream(), bpm: 120 }));
    act(() => { result.current.start(); });
    let again;
    act(() => { again = result.current.start(); });
    expect(again).toBe(false);
  });

  it('stop() returns { summary, pitchTrack } after a run and clears running', () => {
    const { result } = renderHook(() => useColorMatch({ score: FOUR, stream: stream(), bpm: 120 }));
    act(() => { result.current.start(); });
    let analysis;
    act(() => { analysis = result.current.stop(); });
    expect(analysis).toMatchObject({
      summary: expect.objectContaining({ graded: expect.any(Number), perNote: expect.any(Array) }),
      pitchTrack: expect.any(Array),
    });
    expect(result.current.running).toBe(false);
    // No grading frames ran (onCountInComplete never fired), so nothing graded.
    expect(analysis.summary.graded).toBe(0);
    expect(analysis.pitchTrack).toEqual([]);
  });

  it('stop() returns null after unmount (no state write into the void)', () => {
    const { result, unmount } = renderHook(() => useColorMatch({ score: FOUR, stream: stream(), bpm: 120 }));
    act(() => { result.current.start(); });
    const { stop } = result.current;
    unmount();
    expect(stop()).toBeNull();
  });
});
