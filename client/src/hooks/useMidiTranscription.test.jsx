import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Toast + the SSE subscription are the only seams; stub both so the hook runs
// in jsdom and we can assert which toast (if any) fired.
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: toast }));
// Controllable SSE seam — tests mutate `sseState.latest` then rerender to feed
// the hook a frame. Defaults to no frame so the install-gate tests are unaffected.
const sseState = vi.hoisted(() => ({ latest: null, closed: false }));
vi.mock('./useSseProgress.js', () => ({
  useSseProgress: () => sseState,
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
    sseState.latest = null;
    sseState.closed = false;
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

describe('useMidiTranscription — gated-repo gate', () => {
  let startRequest;
  const makeHook = () => renderHook(() => useMidiTranscription({
    startRequest,
    eventsUrl: (id) => `/e/${id}`,
    cancelRequest: vi.fn().mockResolvedValue({}),
    onComplete: vi.fn(),
  }));

  beforeEach(() => {
    toast.error.mockClear();
    sseState.latest = null;
    sseState.closed = false;
    startRequest = vi.fn().mockResolvedValue({ jobId: 'job-1' });
  });

  const gatedFrame = { type: 'error', code: 'gated_repo', repo: 'MuScriptor/muscriptor-medium', error: 'gated' };

  it('opens the token prompt (no error toast) on a gated_repo error frame', async () => {
    const { result, rerender } = makeHook();
    await act(async () => { result.current.start('song.wav'); });

    sseState.latest = gatedFrame;
    await act(async () => { rerender(); });

    expect(result.current.gatedGate.open).toBe(true);
    expect(result.current.gatedGate.repo).toBe('MuScriptor/muscriptor-medium');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('re-runs the captured transcription once a token is saved', async () => {
    const { result, rerender } = makeHook();
    await act(async () => { result.current.start('song.wav'); });

    sseState.latest = gatedFrame;
    await act(async () => { rerender(); });
    expect(result.current.gatedGate.open).toBe(true);

    // A fresh kickoff must see no in-flight frame, else it would re-trip the gate.
    sseState.latest = null;
    await act(async () => { result.current.gatedGate.onSaved(); });
    expect(result.current.gatedGate.open).toBe(false);
    expect(startRequest).toHaveBeenNthCalledWith(2, 'song.wav');
    expect(result.current.active).toBe(true);
  });

  it('closing the prompt clears the target without retrying', async () => {
    const { result, rerender } = makeHook();
    await act(async () => { result.current.start('song.wav'); });

    sseState.latest = gatedFrame;
    await act(async () => { rerender(); });
    expect(result.current.gatedGate.open).toBe(true);

    await act(async () => { result.current.gatedGate.onClose(); });
    expect(result.current.gatedGate.open).toBe(false);
    expect(startRequest).toHaveBeenCalledTimes(1);
  });

  it('a non-gated error frame still toasts', async () => {
    const { result, rerender } = makeHook();
    await act(async () => { result.current.start('song.wav'); });

    sseState.latest = { type: 'error', error: 'boom' };
    await act(async () => { rerender(); });

    expect(result.current.gatedGate.open).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('boom');
  });
});

describe('useMidiTranscription — progress stage labels + download toast', () => {
  const makeHook = () => renderHook(() => useMidiTranscription({
    startRequest: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
    eventsUrl: (id) => `/e/${id}`,
    cancelRequest: vi.fn().mockResolvedValue({}),
    onComplete: vi.fn(),
  }));

  beforeEach(() => {
    toast.info.mockClear();
    sseState.latest = null;
    sseState.closed = false;
  });

  it('exposes a human stageLabel for the current STAGE, defaulting to Transcribing…', async () => {
    const { result, rerender } = makeHook();
    await act(async () => { result.current.start('song.wav'); });

    sseState.latest = { type: 'progress', stage: 'download-model' };
    await act(async () => { rerender(); });
    expect(result.current.stageLabel).toBe('Downloading model…');

    sseState.latest = { type: 'progress', stage: 'write-midi' };
    await act(async () => { rerender(); });
    expect(result.current.stageLabel).toBe('Writing MIDI…');

    sseState.latest = { type: 'progress', stage: 'some-future-stage' };
    await act(async () => { rerender(); });
    expect(result.current.stageLabel).toBe('Transcribing…');
  });

  it('fires a one-time toast when the first-use model download begins', async () => {
    const { result, rerender } = makeHook();
    await act(async () => { result.current.start('song.wav'); });

    sseState.latest = { type: 'progress', stage: 'download-model' };
    await act(async () => { rerender(); });
    // Re-render still on the download stage must not re-toast.
    await act(async () => { rerender(); });
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info.mock.calls[0][0]).toMatch(/downloading the muscriptor model/i);
  });

  it('does not toast when the model loads from cache (load-model, no download)', async () => {
    const { result, rerender } = makeHook();
    await act(async () => { result.current.start('song.wav'); });

    sseState.latest = { type: 'progress', stage: 'load-model' };
    await act(async () => { rerender(); });
    expect(toast.info).not.toHaveBeenCalled();
  });
});
