import { describe, it, expect } from 'vitest';
import { lyricSectionSpans } from './lyricSectionSpans.js';
import { parseLyricSheet } from './lyricMarkers.js';

// Uniquely catches a section starting a sung line late when headers stack above the first line (#14380).
describe('lyricSectionSpans', () => {
  it('starts Verse 1 at its first sung line when [Intro] and [Verse 1] both precede it', () => {
    const { cues, markers } = parseLyricSheet('[Intro]\n[Verse 1]\nFirst line\nSecond line\n[Chorus]\nChorus line');
    const timed = cues.map((cue, i) => ({ ...cue, id: `cue-${i}`, startSec: 20 + i * 5, endSec: 24 + i * 5 }));
    expect(lyricSectionSpans(timed, markers).map(({ label, startSec }) => [label, startSec])).toEqual([['Verse 1', 20], ['Chorus', 30]]);
  });
});
