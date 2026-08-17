import { describe, expect, it } from 'vitest';
import {
  analyzeMusicLyrics,
  recommendMinimaxDurationSec,
  MINIMAX_AUTO_MAX_DURATION_SEC,
  MINIMAX_AUTO_MIN_DURATION_SEC,
} from './musicDuration.js';

describe('music duration recommendations', () => {
  it('uses lyrics and section structure to leave room for an ending', () => {
    const short = analyzeMusicLyrics('[verse]\nrain on the window');
    const long = analyzeMusicLyrics('[verse]\n' + 'word '.repeat(180) + '\n[chorus]\n' + 'sing '.repeat(80) + '\n[outro]');

    expect(short.hasLyrics).toBe(true);
    expect(short.sectionCount).toBe(1);
    expect(short.hasOutro).toBe(false);
    expect(long.sectionCount).toBe(3);
    expect(long.hasOutro).toBe(true);
    expect(long.suggestedDurationSec).toBeGreaterThan(short.suggestedDurationSec);
  });

  it('recognizes inline tag text as lyrics rather than dropping it', () => {
    const result = analyzeMusicLyrics('[verse] keep this line\nplain words\n[outro] last line');

    expect(result.wordCount).toBe(7);
    expect(result.sectionCount).toBe(2);
    expect(result.hasOutro).toBe(true);
  });

  it('falls back to the engine default when there is no lyric text', () => {
    expect(recommendMinimaxDurationSec('[intro]\n[outro]')).toBe(MINIMAX_AUTO_MIN_DURATION_SEC);
    expect(recommendMinimaxDurationSec('   ')).toBe(MINIMAX_AUTO_MIN_DURATION_SEC);
  });

  it('caps the recommendation while exposing that the lyrics exceed the cap', () => {
    const result = analyzeMusicLyrics('word '.repeat(2000));

    expect(result.suggestedDurationSec).toBe(MINIMAX_AUTO_MAX_DURATION_SEC);
    expect(result.isCapped).toBe(true);
    expect(result.estimatedDurationSec).toBeGreaterThan(MINIMAX_AUTO_MAX_DURATION_SEC);
  });

  it('accepts custom engine bounds for mirrored server behavior', () => {
    const result = analyzeMusicLyrics('one two three', { minDurationSec: 12, maxDurationSec: 30 });

    expect(result.suggestedDurationSec).toBe(30);
  });
});
// @vitest-environment node
