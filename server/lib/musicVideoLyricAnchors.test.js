import { describe, expect, it } from 'vitest';
import { singerWithin } from './musicVideoLyricAnchors.js';

describe('singerWithin', () => {
  const cues = [
    { text: 'a', voice: 'A', startSec: 0, endSec: 4 },
    { text: 'b', voice: 'B', startSec: 4, endSec: 8 },
    { text: 'c', startSec: 8, endSec: 12 },
  ];
  it('names the single singer of a span and nothing for a shared or unvoiced one', () => {
    expect(singerWithin(cues, 0, 4)).toBe('A');
    expect(singerWithin(cues, 0, 8)).toBeNull();
    expect(singerWithin(cues, 8, 12)).toBeNull();
  });
});
