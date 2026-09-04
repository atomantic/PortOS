// @vitest-environment node

// The analysis-mic helper: what it asks the browser for, and how honestly it
// reports what the browser actually did. The rest of audioRecorder.js is Web
// Audio / MediaRecorder plumbing exercised through its component callers.

import { describe, it, expect, vi } from 'vitest';
import {
  ANALYSIS_AUDIO_CONSTRAINTS,
  hasUnwantedProcessing,
  openAnalysisMic,
  readAppliedProcessing,
} from './audioRecorder.js';

const streamWith = (settings) => ({
  getAudioTracks: () => [settings === undefined ? {} : { getSettings: () => settings }],
});

describe('openAnalysisMic', () => {
  it('requests the processing chain off with plain booleans, never { exact }', async () => {
    const getUserMedia = vi.fn(async () => streamWith({}));
    await openAnalysisMic({ getUserMedia });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    // `{ exact }` would make a browser that can't honor a stage fail the whole
    // request instead of opening a usable (if processed) mic.
    expect(Object.values(ANALYSIS_AUDIO_CONSTRAINTS).every((v) => v === false)).toBe(true);
  });

  it('returns the stream alongside the settings the browser actually applied', async () => {
    const stream = streamWith({ echoCancellation: false, noiseSuppression: true, autoGainControl: true });
    const { stream: opened, processing } = await openAnalysisMic({ getUserMedia: async () => stream });
    expect(opened).toBe(stream);
    expect(processing).toEqual({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  it('rejects like getUserMedia does, so callers keep their own catch/guards', async () => {
    const getUserMedia = vi.fn(async () => { throw new Error('Permission denied'); });
    await expect(openAnalysisMic({ getUserMedia })).rejects.toThrow('Permission denied');
  });
});

describe('readAppliedProcessing', () => {
  it('reports an unsupported getSettings as unknown, not as honored', () => {
    // A browser (or a jsdom stub) with no getSettings tells us nothing — every
    // stage must read null, or the UI would claim clean audio it can't verify.
    expect(readAppliedProcessing(streamWith(undefined))).toEqual({
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
    });
    expect(readAppliedProcessing(null)).toEqual({
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
    });
  });

  it('falls back to getTracks when the stream has no getAudioTracks', () => {
    const stream = { getTracks: () => [{ getSettings: () => ({ autoGainControl: true }) }] };
    expect(readAppliedProcessing(stream).autoGainControl).toBe(true);
  });
});

describe('hasUnwantedProcessing', () => {
  it('warns only on a stage KNOWN to be on', () => {
    expect(hasUnwantedProcessing({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })).toBe(false);
    expect(hasUnwantedProcessing({ echoCancellation: null, noiseSuppression: null, autoGainControl: null })).toBe(false);
    expect(hasUnwantedProcessing(null)).toBe(false);
    expect(hasUnwantedProcessing({ echoCancellation: null, noiseSuppression: true, autoGainControl: null })).toBe(true);
  });
});
