import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analyserClose = vi.fn();
const trackerStop = vi.fn();
const metronomeStop = vi.fn();
const trackStop = vi.fn();
let trackerOnUpdate = null;
let metronomeOptions = null;
let clock = 1000;
const { alignMock } = vi.hoisted(() => ({ alignMock: vi.fn(() => [{ index: 0, accepted: false }]) }));

vi.mock('../lib/audioRecorder.js', async (importActual) => {
  const actual = await importActual(); // keep the real openAnalysisMic / getSettings read-back
  return {
    ...actual,
    createStreamAnalyser: vi.fn(() => ({ analyser: {}, close: analyserClose })),
  };
});

vi.mock('../lib/pitchDetect.js', () => ({
  createPitchTracker: vi.fn((_analyser, options) => {
    trackerOnUpdate = options.onUpdate;
    return { stop: trackerStop };
  }),
}));

vi.mock('../lib/metronome.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    createMetronome: vi.fn((options) => {
      metronomeOptions = options;
      return { start: vi.fn(async () => {}), stop: metronomeStop };
    }),
  };
});

vi.mock('../lib/singToVerify.js', () => ({ alignSingToVerify: alignMock }));

import useSingToVerify, {
  VERIFY_COUNT_IN,
  VERIFY_IDLE,
  VERIFY_RECORDING,
} from './useSingToVerify.js';

const fakeStream = () => ({ getTracks: () => [{ stop: trackStop }] });

describe('useSingToVerify', () => {
  beforeEach(() => {
    analyserClose.mockClear();
    trackerStop.mockClear();
    metronomeStop.mockClear();
    trackStop.mockClear();
    alignMock.mockClear();
    trackerOnUpdate = null;
    metronomeOptions = null;
    clock = 1000;
    global.performance = { now: () => clock };
    global.navigator.mediaDevices = { getUserMedia: vi.fn(async () => fakeStream()) };
    // Safari 16.4+ only — jsdom has no `navigator.audioSession`, so the iOS
    // session tests below stub the shape the arbiter writes to.
    global.navigator.audioSession = { type: 'auto' };
  });

  afterEach(() => { vi.clearAllMocks(); delete global.navigator.audioSession; });

  it('captures from the selected start bar and aligns rows on stop', async () => {
    const { result } = renderHook(() => useSingToVerify({
      tempo: 120,
      score: 'time: 4/4\n| C4q D4q |',
    }));
    expect(result.current.phase).toBe(VERIFY_IDLE);

    await act(async () => { await result.current.start(2); });
    expect(result.current.phase).toBe(VERIFY_COUNT_IN);
    act(() => metronomeOptions.onCountInComplete());
    expect(result.current.phase).toBe(VERIFY_RECORDING);

    clock = 1100;
    act(() => trackerOnUpdate({ hz: 261.6, clarity: 0.98 }));
    clock = 1600;
    act(() => result.current.stop());

    expect(alignMock).toHaveBeenCalledWith(
      expect.any(Object),
      [{ tMs: 100, hz: 261.6, clarity: 0.98 }],
      expect.objectContaining({ bpm: 120, startBar: 2, captureEndMs: 600 }),
    );
    expect(result.current.rows).toEqual([{ index: 0, accepted: false }]);
  });

  it('opens the mic with browser processing off and reports what actually stuck', async () => {
    // Safari honors the AEC request but keeps AGC on — the exact case the
    // report exists for, since the tuner cannot tell from the samples alone.
    const settings = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
    navigator.mediaDevices.getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: trackStop, getSettings: () => settings }],
    }));
    const { result } = renderHook(() => useSingToVerify({
      tempo: 120,
      score: 'time: 4/4\n| C4q |',
    }));

    await act(async () => { await result.current.start(1); });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(result.current.micProcessing).toEqual(settings);
  });

  it('reports an unknown processing stage as null rather than as honored', async () => {
    // Firefox omits keys it does not implement. Collapsing absent into false
    // would let it claim clean audio it never promised.
    navigator.mediaDevices.getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: trackStop, getSettings: () => ({ echoCancellation: false }) }],
    }));
    const { result } = renderHook(() => useSingToVerify({
      tempo: 120,
      score: 'time: 4/4\n| C4q |',
    }));

    await act(async () => { await result.current.start(1); });

    expect(result.current.micProcessing).toEqual({
      echoCancellation: false,
      noiseSuppression: null,
      autoGainControl: null,
    });
  });
  it('tears down mic stream, analyser, tracker, and metronome on unmount', async () => {
    const { result, unmount } = renderHook(() => useSingToVerify({
      tempo: 120,
      score: 'time: 4/4\n| C4q |',
    }));
    await act(async () => { await result.current.start(1); });
    unmount();
    expect(metronomeStop).toHaveBeenCalled();
    expect(trackerStop).toHaveBeenCalled();
    expect(analyserClose).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });

  it('allows only one microphone request while permission is pending', async () => {
    let resolveStream;
    navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));
    const { result } = renderHook(() => useSingToVerify({
      tempo: 120,
      score: 'time: 4/4\n| C4q |',
    }));

    let firstStart;
    act(() => {
      firstStart = result.current.start(1);
      result.current.start(1);
    });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStream(fakeStream());
      await firstStart;
    });
    expect(result.current.phase).toBe(VERIFY_COUNT_IN);
  });

  it('reports unavailable microphone APIs without getting stuck', async () => {
    global.navigator.mediaDevices = undefined;
    const { result } = renderHook(() => useSingToVerify({
      tempo: 120,
      score: 'time: 4/4\n| C4q |',
    }));

    await act(async () => { await result.current.start(1); });
    expect(result.current.error).toMatch(/secure browser connection/i);
    await act(async () => { await result.current.start(1); });
    expect(result.current.error).toMatch(/secure browser connection/i);
  });

  it('cancels an active capture without aligning stale rows', async () => {
    const { result } = renderHook(() => useSingToVerify({
      tempo: 120,
      score: 'time: 4/4\n| C4q |',
    }));
    await act(async () => { await result.current.start(1); });

    act(() => result.current.cancel());

    expect(result.current.phase).toBe(VERIFY_IDLE);
    expect(alignMock).not.toHaveBeenCalled();
    expect(metronomeStop).toHaveBeenCalled();
    expect(trackerStop).toHaveBeenCalled();
    expect(analyserClose).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });

  it('stops a permission-pending stream when capture is cancelled', async () => {
    let resolveStream;
    navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));
    const { result } = renderHook(() => useSingToVerify({
      tempo: 120,
      score: 'time: 4/4\n| C4q |',
    }));

    let startPromise;
    act(() => { startPromise = result.current.start(1); });
    act(() => result.current.cancel());
    await act(async () => {
      resolveStream(fakeStream());
      await startPromise;
    });

    expect(trackStop).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe(VERIFY_IDLE);
  });

  // `playback` REFUSES capture on iOS, and the transport-driven players declare
  // it document-wide, so this hook has to claim `play-and-record` around its own
  // getUserMedia rather than relying on nothing else having claimed first (#4131).
  describe('iOS audio session', () => {
    const opts = { tempo: 120, score: 'time: 4/4\n| C4q |' };

    it('claims play-and-record for the mic window and hands it back on stop', async () => {
      const { result } = renderHook(() => useSingToVerify(opts));
      await act(async () => { await result.current.start(1); });
      expect(navigator.audioSession.type).toBe('play-and-record');

      act(() => result.current.stop());
      expect(navigator.audioSession.type).toBe('auto');
    });

    it('hands the session back on cancel', async () => {
      const { result } = renderHook(() => useSingToVerify(opts));
      await act(async () => { await result.current.start(1); });
      act(() => result.current.cancel());
      expect(navigator.audioSession.type).toBe('auto');
    });

    it('hands the session back when the mic is denied', async () => {
      navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw new Error('Permission denied'); });
      const { result } = renderHook(() => useSingToVerify(opts));
      await act(async () => { await result.current.start(1); });
      expect(result.current.error).toBe('Permission denied');
      expect(navigator.audioSession.type).toBe('auto');
    });

    // A cancel during the permission prompt, then a fresh start: the superseded
    // request must NOT release on its way out — cancel() already released its
    // claim, and the slot now belongs to the newer start, which is still live.
    it('keeps the newer start\'s claim when a superseded request settles', async () => {
      let resolveStream;
      navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((resolve) => { resolveStream = resolve; }));
      const { result } = renderHook(() => useSingToVerify(opts));

      let stalePromise;
      act(() => { stalePromise = result.current.start(1); });
      act(() => result.current.cancel());
      expect(navigator.audioSession.type).toBe('auto');

      navigator.mediaDevices.getUserMedia = vi.fn(async () => fakeStream());
      await act(async () => { await result.current.start(1); });
      expect(navigator.audioSession.type).toBe('play-and-record');

      await act(async () => { resolveStream(fakeStream()); await stalePromise; });
      expect(navigator.audioSession.type).toBe('play-and-record');

      act(() => result.current.stop());
      expect(navigator.audioSession.type).toBe('auto');
    });

    it('hands the session back on unmount mid-capture', async () => {
      const { result, unmount } = renderHook(() => useSingToVerify(opts));
      await act(async () => { await result.current.start(1); });
      unmount();
      expect(navigator.audioSession.type).toBe('auto');
    });
  });
});
