import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Toast + the SSE subscription are the only seams; stub both so the hook runs
// in jsdom and we can assert which toast (if any) fired.
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: toast }));
vi.mock('./useSseProgress.js', () => ({
  useSseProgress: () => ({ latest: null, closed: false }),
  isTerminalSseFrame: () => false,
}));

import useMidiTranscription from './useMidiTranscription.js';

const runtimeMissing = () => Object.assign(new Error('MuScriptor runtime not found.'), { code: 'MIDI_RUNTIME_MISSING', status: 503 });

describe('useMidiTranscription — first-use install gate', () => {
  let startRequest;
  const makeHook = () => renderHook(() => useMidiTranscription({
    startRequest,
    eventsUrl: (id) => `/e/${id}`,
    cancelRequest: vi.fn().mockResolvedValue({}),
    onComplete: vi.fn(),
  }));

  beforeEach(() => {
    toast.error.mockClear();
    toast.info.mockClear();
    startRequest = vi.fn();
  });

  it('opens the installer (no error toast) when the kickoff reports the runtime is missing', async () => {
    startRequest.mockRejectedValueOnce(runtimeMissing());
    const { result } = makeHook();
    await act(async () => { result.current.start('song.wav'); });
    expect(result.current.installGate.open).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
    expect(startRequest).toHaveBeenCalledTimes(1);
  });

  it('re-runs the captured transcription after the install completes', async () => {
    startRequest.mockRejectedValueOnce(runtimeMissing());
    startRequest.mockResolvedValueOnce({ jobId: 'job-1' });
    const { result } = makeHook();
    await act(async () => { result.current.start('song.wav'); });
    expect(result.current.installGate.open).toBe(true);

    await act(async () => { result.current.installGate.onComplete(); });
    expect(result.current.installGate.open).toBe(false);
    // Retried with the SAME target captured at first click, and now active.
    expect(startRequest).toHaveBeenNthCalledWith(2, 'song.wav');
    expect(result.current.active).toBe(true);
  });

  it('closing the installer clears the pending target and resets the loop guard', async () => {
    startRequest.mockRejectedValue(runtimeMissing());
    const { result } = makeHook();
    await act(async () => { result.current.start('song.wav'); });
    expect(result.current.installGate.open).toBe(true);

    await act(async () => { result.current.installGate.onClose(); });
    expect(result.current.installGate.open).toBe(false);

    // A fresh click re-opens the installer (guard was reset on close).
    await act(async () => { result.current.start('song.wav'); });
    expect(result.current.installGate.open).toBe(true);
  });

  it('a real error (not a missing runtime) toasts instead of opening the installer', async () => {
    startRequest.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    const { result } = makeHook();
    await act(async () => { result.current.start('song.wav'); });
    expect(result.current.installGate.open).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('boom');
  });

  it('does not loop the installer if the runtime is still missing right after a "successful" install', async () => {
    startRequest.mockRejectedValue(runtimeMissing()); // every kickoff 503s
    const { result } = makeHook();
    await act(async () => { result.current.start('song.wav'); });
    expect(result.current.installGate.open).toBe(true);

    // Install "completes" but the retry 503s again — surface it, don't reopen.
    await act(async () => { result.current.installGate.onComplete(); });
    expect(result.current.installGate.open).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
