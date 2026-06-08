import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock every Web Audio / mic seam the hook touches so it runs in jsdom. We
// capture the metronome + tracker callbacks so the test can drive the count-in
// → recording → transcribe lifecycle deterministically.
const analyserClose = vi.fn();
const trackerStop = vi.fn();
const metronomeStop = vi.fn();
const trackStop = vi.fn();
let trackerOnUpdate = null;
let metroOpts = null;
const { transcribeMock } = vi.hoisted(() => ({ transcribeMock: vi.fn(() => '| C4q |') }));

vi.mock('../lib/audioRecorder.js', () => ({
  createStreamAnalyser: vi.fn(() => ({ analyser: { fftSize: 2048 }, context: {}, close: analyserClose })),
}));

vi.mock('../lib/pitchDetect.js', () => ({
  createPitchTracker: vi.fn((analyser, opts) => { trackerOnUpdate = opts.onUpdate; return { stop: trackerStop }; }),
}));

vi.mock('../lib/metronome.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    createMetronome: vi.fn((opts) => {
      metroOpts = opts;
      return { start: vi.fn(async () => {}), stop: metronomeStop };
    }),
  };
});

vi.mock('../lib/singToScore.js', () => ({ transcribePitchTrack: transcribeMock }));

import useSingToScore, { SING_IDLE, SING_COUNT_IN, SING_RECORDING } from './useSingToScore.js';

const fakeStream = () => ({ getTracks: () => [{ stop: trackStop }] });

describe('useSingToScore', () => {
  beforeEach(() => {
    analyserClose.mockClear();
    trackerStop.mockClear();
    metronomeStop.mockClear();
    trackStop.mockClear();
    transcribeMock.mockClear();
    trackerOnUpdate = null;
    metroOpts = null;
    global.navigator.mediaDevices = { getUserMedia: vi.fn(async () => fakeStream()) };
    global.performance = { now: () => 1000 };
  });

  afterEach(() => { vi.clearAllMocks(); });

  it('walks idle → count-in → recording → idle and transcribes on stop', async () => {
    const { result } = renderHook(() => useSingToScore({ tempo: 120, score: 'time: 4/4', musicKey: 'C' }));
    expect(result.current.phase).toBe(SING_IDLE);

    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe(SING_COUNT_IN);

    // Count-in completes → recording starts and the capture clock anchors.
    act(() => { metroOpts.onCountInComplete({ beat: 1 }); });
    expect(result.current.phase).toBe(SING_RECORDING);

    // A clear frame is captured into the track.
    act(() => { trackerOnUpdate({ hz: 261.6, clarity: 0.95 }); });

    act(() => { result.current.stop(); });
    expect(result.current.phase).toBe(SING_IDLE);
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    // The accumulated track (one frame) is passed to the transcriber.
    expect(transcribeMock.mock.calls[0][0]).toHaveLength(1);
    expect(result.current.result).toBe('| C4q |');
  });

  it('does not capture frames during the count-in', async () => {
    const { result } = renderHook(() => useSingToScore({ tempo: 120, score: 'time: 4/4' }));
    await act(async () => { await result.current.start(); });
    // Frame arrives before count-in completes — must be ignored.
    act(() => { trackerOnUpdate?.({ hz: 440, clarity: 0.95 }); });
    act(() => { metroOpts.onCountInComplete({ beat: 1 }); });
    act(() => { result.current.stop(); });
    expect(transcribeMock.mock.calls[0][0]).toHaveLength(0);
  });

  it('surfaces a mic-denied error and stays idle', async () => {
    global.navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw new Error('Permission denied'); });
    const { result } = renderHook(() => useSingToScore({ tempo: 120 }));
    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe(SING_IDLE);
    expect(result.current.error).toBe('Permission denied');
  });

  it('tears down mic, analyser, tracker, and metronome on unmount', async () => {
    const { result, unmount } = renderHook(() => useSingToScore({ tempo: 120, score: 'time: 4/4' }));
    await act(async () => { await result.current.start(); });
    unmount();
    expect(metronomeStop).toHaveBeenCalled();
    expect(trackerStop).toHaveBeenCalled();
    expect(analyserClose).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });
});
