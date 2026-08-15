// The React lifecycle around one arbitrated iOS audio-session claim. jsdom has
// no `navigator.audioSession`, so the tests stub the shape Safari 16.4+ exposes
// and read the declared type back off it — the same seam the drum/score player
// suites use.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { acquireAudioSession } from '../lib/audioContext.js';
import useAudioSessionClaim from './useAudioSessionClaim.js';

const sessionType = () => globalThis.navigator.audioSession.type;

describe('useAudioSessionClaim', () => {
  beforeEach(() => { vi.stubGlobal('navigator', { audioSession: { type: 'auto' } }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('declares the type on claim and goes back to auto on release', () => {
    const { result } = renderHook(() => useAudioSessionClaim('playback'));
    expect(sessionType()).toBe('auto');

    act(() => { result.current.claim(); });
    expect(sessionType()).toBe('playback');

    act(() => { result.current.release(); });
    expect(sessionType()).toBe('auto');
  });

  it('is idempotent on release, so every teardown path can call it', () => {
    const { result } = renderHook(() => useAudioSessionClaim('play-and-record'));
    act(() => { result.current.claim(); });
    act(() => { result.current.release(); result.current.release(); });
    expect(sessionType()).toBe('auto');
  });

  // One slot per instance: a re-entered play/capture that claims again must not
  // strand the previous holder in the arbiter — a stranded holder pins the
  // document for the rest of the SPA session, with no release left to call.
  it('drops its previous claim when it claims again', () => {
    const { result } = renderHook(() => useAudioSessionClaim('playback'));
    act(() => { result.current.claim(); result.current.claim(); });
    act(() => { result.current.release(); });
    expect(sessionType()).toBe('auto');
  });

  // The backstop for a lifecycle that ends without its normal teardown — a
  // per-mount AudioContext close()d out from under an in-flight play never
  // fires the `onended` that would otherwise release.
  it('releases a still-held claim on unmount', () => {
    const { result, unmount } = renderHook(() => useAudioSessionClaim('playback'));
    act(() => { result.current.claim(); });
    expect(sessionType()).toBe('playback');
    unmount();
    expect(sessionType()).toBe('auto');
  });

  // Two instances hold independently — the arbiter tracks holders, not a count
  // per type — and capture outranks playback while both are live.
  it('yields to a play-and-record holder and takes playback back on its release', () => {
    const { result } = renderHook(() => useAudioSessionClaim('playback'));
    act(() => { result.current.claim(); });
    const releaseMic = acquireAudioSession('play-and-record');
    expect(sessionType()).toBe('play-and-record');
    releaseMic();
    expect(sessionType()).toBe('playback');
    act(() => { result.current.release(); });
    expect(sessionType()).toBe('auto');
  });

  it('is a no-op where navigator.audioSession does not exist', () => {
    vi.stubGlobal('navigator', {});
    const { result, unmount } = renderHook(() => useAudioSessionClaim('playback'));
    act(() => { result.current.claim(); result.current.release(); });
    expect(() => unmount()).not.toThrow();
  });
});
