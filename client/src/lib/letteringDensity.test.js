import { describe, it, expect } from 'vitest';
import {
  countWords,
  overflowSeverity,
  panelLetteringMetrics,
  analyzeComicLettering,
} from './letteringDensity';

// Mirror of server/lib/editorial/letteringDensity.js — the server test is the
// authoritative contract; this covers the client copy used by the comic-script
// stage's inline warnings so a drift in the mirror is caught here too.

const balloon = (character, n) => ({ character, line: Array.from({ length: n }, (_, i) => `w${i}`).join(' ') });

describe('letteringDensity (client mirror)', () => {
  it('countWords counts whitespace tokens, 0 for non-strings', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords(null)).toBe(0);
  });

  it('overflowSeverity scales by overflow ratio', () => {
    expect(overflowSeverity(26, 25)).toBe('low');
    expect(overflowSeverity(35, 25)).toBe('medium');
    expect(overflowSeverity(50, 25)).toBe('high');
  });

  it('panelLetteringMetrics counts dialogue + caption + SFX and balloons', () => {
    const m = panelLetteringMetrics({
      dialogue: [balloon('A', 4), balloon('B', 2)],
      caption: 'Box one.\nBox two.',
      sfx: 'BOOM',
    });
    expect(m.totalWords).toBe(6 + 4 + 1);
    expect(m.balloonCount).toBe(4); // 2 dialogue + 2 caption boxes
  });

  it('analyzeComicLettering flags an over-stuffed balloon', () => {
    const v = analyzeComicLettering([{ panels: [{ dialogue: [balloon('NARRATOR', 60)] }] }]);
    const balloonV = v.find((x) => x.kind === 'balloon-words');
    expect(balloonV.count).toBe(60);
    expect(balloonV.severity).toBe('high');
    expect(balloonV.pageNumber).toBe(1);
    expect(balloonV.panelNumber).toBe(1);
  });

  it('returns nothing for a clean page', () => {
    expect(analyzeComicLettering([{ panels: [{ dialogue: [balloon('A', 8)], caption: 'A beat.' }] }])).toEqual([]);
  });
});
