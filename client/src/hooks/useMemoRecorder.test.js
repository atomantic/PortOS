import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { acquireAudioSession } from '../lib/audioContext.js';
import useMemoRecorder from './useMemoRecorder.js';

const { startMemoRecording } = vi.hoisted(() => ({ startMemoRecording: vi.fn() }));
vi.mock('../lib/audioRecorder.js', () => ({ startMemoRecording }));

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

describe('useMemoRecorder', () => {
  beforeEach(() => {
    startMemoRecording.mockReset();
    navigator.audioSession = { type: 'auto' };
  });

  afterEach(() => { delete navigator.audioSession; });

  it('cancels a recorder that arrives after unmount', async () => {
    const pending = deferred();
    const handle = { stream: {}, cancel: vi.fn() };
    startMemoRecording.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useMemoRecorder());

    let startPromise;
    act(() => { startPromise = result.current.start(); });
    unmount();
    await act(async () => { pending.resolve(handle); await startPromise; });

    expect(handle.cancel).toHaveBeenCalledTimes(1);
  });

  it('opens once across repeated starts and releases its audio session after stop', async () => {
    const pending = deferred();
    const release = acquireAudioSession('play-and-record');
    const handle = {
      stream: {},
      cancel: vi.fn(release),
      stop: vi.fn(async () => { release(); return { audioBase64: 'example' }; }),
    };
    startMemoRecording.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useMemoRecorder());

    let first;
    act(() => {
      first = result.current.start();
      result.current.start();
    });
    expect(result.current.starting).toBe(true);
    expect(startMemoRecording).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(handle); await first; });
    expect(result.current.recording).toBe(true);
    expect(navigator.audioSession.type).toBe('play-and-record');

    await act(async () => { await result.current.stop(); });
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(navigator.audioSession.type).toBe('auto');
  });
});
