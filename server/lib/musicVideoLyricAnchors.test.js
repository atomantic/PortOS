import { describe, expect, it } from 'vitest';
import { phoneticLipSyncSummary, singerWithin } from './musicVideoLyricAnchors.js';

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

// Spelling/timing edge cases are precise algorithm contracts rather than mock interactions.
describe('phoneticLipSyncSummary', () => {
  it('classifies punctuation and repeated consonant words while holding only sustained vowels', () => {
    const summary = phoneticLipSyncSummary([{ words: [
      { w: '"Boom!"', startSec: 0, endSec: 0.45 },
      { w: '"Boom!"', startSec: 0.5, endSec: 0.8 },
      { w: 'Phone', startSec: 0.8, endSec: 1.1 },
      { w: 'very', startSec: 1.1, endSec: 1.54 },
      { w: 'doubt', startSec: 1.1, endSec: 1.3 },
      { w: 'psychic', startSec: 1.3, endSec: 1.5 },
      { w: 'ah', startSec: 1.54, endSec: 2 },
    ] }], 0, 2);
    expect(summary).toContain('on: "\\"Boom!\\"".');
    expect(summary).toContain('on: "Phone", "very".');
    expect(summary).toContain('"\\"Boom!\\"" 0.000s–0.450s');
    expect(summary).toContain('"ah" 1.540s–2.000s');
    expect(summary).not.toContain('"very" 1.100s');
  });

  it('skips untimed, invalid, unsupported, and adjacent words without fabricating lyrics', () => {
    const cues = [{ text: 'my voice', words: [
      null, { w: 'my' }, { w: 'fire', startSec: NaN, endSec: 2 },
      { w: 'bad', startSec: 1, endSec: 1 }, { w: 'bad', startSec: 2, endSec: 1 },
      { w: 'пой', startSec: 1, endSec: 2 }, { w: '123!', startSec: 1, endSec: 2 },
      { w: 'before', startSec: 0, endSec: 1 }, { w: 'past', startSec: 2, endSec: 3 },
    ] }];
    expect(phoneticLipSyncSummary(cues, 1, 2)).toBeNull();
    expect(phoneticLipSyncSummary([{ text: 'my voice', startSec: 1, endSec: 2 }], 1, 2)).toBeNull();
  });
});
