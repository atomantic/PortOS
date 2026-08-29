import { describe, expect, it } from 'vitest';
import {
  FABLELOOM_PLAYBACK_MODES, asFableLoomPlaybackMode, isFableLoomPlaybackMode,
} from './fableLoomPlayback.js';

describe('FableLoom playback modes', () => {
  it('recognizes the persisted vocabulary and defaults old or invalid nodes to decisions', () => {
    expect(FABLELOOM_PLAYBACK_MODES).toEqual(['cut', 'decision']);
    expect(isFableLoomPlaybackMode('cut')).toBe(true);
    expect(isFableLoomPlaybackMode('loop')).toBe(false);
    expect(asFableLoomPlaybackMode('cut')).toBe('cut');
    expect(asFableLoomPlaybackMode(undefined)).toBe('decision');
    expect(asFableLoomPlaybackMode('loop')).toBe('decision');
  });
});
