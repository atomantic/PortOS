import { describe, it, expect } from 'vitest';
import {
  countWords,
  overflowSeverity,
  sanitizeLetteringThresholds,
  panelLetteringMetrics,
  analyzeComicLettering,
  DEFAULT_LETTERING_THRESHOLDS,
} from './letteringDensity.js';

// Build a panel of N words across a single balloon.
const balloon = (character, n) => ({ character, line: Array.from({ length: n }, (_, i) => `w${i}`).join(' ') });

describe('countWords', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords('  spaced   out  ')).toBe(2);
    expect(countWords('hyphen-ated counts once')).toBe(3);
  });
  it('returns 0 for empty / non-string', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
    expect(countWords(42)).toBe(0);
  });
});

describe('overflowSeverity', () => {
  it('scales with how far over the threshold the count runs', () => {
    expect(overflowSeverity(26, 25)).toBe('low'); // ~1.04×
    expect(overflowSeverity(35, 25)).toBe('medium'); // 1.4×
    expect(overflowSeverity(50, 25)).toBe('high'); // 2×
    expect(overflowSeverity(120, 25)).toBe('high');
  });
  it('falls back to medium for a non-positive threshold', () => {
    expect(overflowSeverity(10, 0)).toBe('medium');
    expect(overflowSeverity(10, -5)).toBe('medium');
  });
});

describe('sanitizeLetteringThresholds', () => {
  it('fills defaults and overrides valid positive numbers', () => {
    expect(sanitizeLetteringThresholds(undefined)).toEqual(DEFAULT_LETTERING_THRESHOLDS);
    expect(sanitizeLetteringThresholds({ maxWordsPerBalloon: 10 })).toMatchObject({
      maxWordsPerBalloon: 10,
      maxWordsPerPanel: DEFAULT_LETTERING_THRESHOLDS.maxWordsPerPanel,
    });
  });
  it('ignores invalid / non-positive values, keeping the default', () => {
    expect(sanitizeLetteringThresholds({ maxWordsPerBalloon: 0 }).maxWordsPerBalloon)
      .toBe(DEFAULT_LETTERING_THRESHOLDS.maxWordsPerBalloon);
    expect(sanitizeLetteringThresholds({ maxWordsPerPanel: -3 }).maxWordsPerPanel)
      .toBe(DEFAULT_LETTERING_THRESHOLDS.maxWordsPerPanel);
    expect(sanitizeLetteringThresholds({ maxWordsPerPage: 'lots' }).maxWordsPerPage)
      .toBe(DEFAULT_LETTERING_THRESHOLDS.maxWordsPerPage);
  });
});

describe('panelLetteringMetrics', () => {
  it('counts dialogue + caption + SFX words and balloon boxes', () => {
    const panel = {
      description: 'A wide shot of the room.',
      dialogue: [balloon('ANYA', 5), balloon('BORIS', 3)],
      caption: 'Later that night.\nThe rain had not stopped.',
      sfx: 'KRAKOOM',
    };
    const m = panelLetteringMetrics(panel);
    expect(m.dialogueWords).toBe(8);
    expect(m.captionWords).toBe(3 + 5); // two caption lines
    expect(m.sfxWords).toBe(1);
    expect(m.totalWords).toBe(8 + 8 + 1);
    // 2 dialogue balloons + 2 caption boxes = 4 distinct balloons.
    expect(m.balloonCount).toBe(4);
    expect(m.balloons).toHaveLength(2);
    expect(m.captionBoxes).toHaveLength(2);
  });
  it('tolerates a panel with no lettering', () => {
    const m = panelLetteringMetrics({ description: 'Silent splash.' });
    expect(m.totalWords).toBe(0);
    expect(m.balloonCount).toBe(0);
  });
  it('tolerates non-array dialogue / non-string fields', () => {
    const m = panelLetteringMetrics({ dialogue: null, caption: 42, sfx: undefined });
    expect(m.totalWords).toBe(0);
    expect(m.balloonCount).toBe(0);
  });
});

describe('analyzeComicLettering', () => {
  it('flags an over-stuffed balloon, scaling severity by overflow', () => {
    const pages = [{ panels: [{ dialogue: [balloon('NARRATOR', 60)] }] }];
    const v = analyzeComicLettering(pages);
    const balloonViolation = v.find((x) => x.kind === 'balloon-words');
    expect(balloonViolation).toBeTruthy();
    expect(balloonViolation.count).toBe(60);
    expect(balloonViolation.threshold).toBe(25);
    expect(balloonViolation.severity).toBe('high'); // 60/25 = 2.4×
    expect(balloonViolation.pageNumber).toBe(1);
    expect(balloonViolation.panelNumber).toBe(1);
    expect(balloonViolation.anchorQuote).toContain('w0');
  });

  it('flags an over-stuffed caption box on the per-balloon word limit', () => {
    // A single 40-word caption is under the 50-word panel limit, so only the
    // caption-words violation should fire (caption boxes count as balloons).
    const caption = Array.from({ length: 40 }, (_, i) => `c${i}`).join(' ');
    const v = analyzeComicLettering([{ panels: [{ caption }] }]);
    const captionV = v.find((x) => x.kind === 'caption-words');
    expect(captionV).toBeTruthy();
    expect(captionV.count).toBe(40);
    expect(captionV.threshold).toBe(25);
    expect(captionV.anchorQuote).toContain('c0');
    expect(v.some((x) => x.kind === 'panel-words')).toBe(false);
  });

  it('flags a panel over the total-word limit', () => {
    // Three balloons of 20 words each = 60 > 50 panel limit, but each balloon is
    // under the 25-word balloon limit, so ONLY the panel-words violation fires.
    const pages = [{ panels: [{ dialogue: [balloon('A', 20), balloon('B', 20), balloon('C', 20)] }] }];
    const v = analyzeComicLettering(pages);
    expect(v.some((x) => x.kind === 'balloon-words')).toBe(false);
    const panelV = v.find((x) => x.kind === 'panel-words');
    expect(panelV).toBeTruthy();
    expect(panelV.count).toBe(60);
    // 3 balloons also trips nothing (== limit, not >).
    expect(v.some((x) => x.kind === 'panel-balloons')).toBe(false);
  });

  it('flags too many balloons in a panel', () => {
    const pages = [{ panels: [{ dialogue: [balloon('A', 2), balloon('B', 2), balloon('C', 2), balloon('D', 2)] }] }];
    const v = analyzeComicLettering(pages);
    const balloonsV = v.find((x) => x.kind === 'panel-balloons');
    expect(balloonsV).toBeTruthy();
    expect(balloonsV.count).toBe(4);
    expect(balloonsV.threshold).toBe(3);
  });

  it('flags a page whose total lettering load overwhelms the art', () => {
    // 4 panels × 40 words = 160 > 150 page limit. Each panel (40) is under the
    // 50-word panel limit, so only the page-words violation fires.
    const panels = Array.from({ length: 4 }, () => ({ dialogue: [balloon('X', 40)] }));
    const v = analyzeComicLettering([{ panels }]);
    const pageV = v.find((x) => x.kind === 'page-words');
    expect(pageV).toBeTruthy();
    expect(pageV.count).toBe(160);
    expect(pageV.panelNumber).toBeUndefined();
    expect(v.some((x) => x.kind === 'panel-words')).toBe(false);
  });

  it('returns nothing for a well-lettered script', () => {
    const pages = [{ panels: [{ dialogue: [balloon('A', 10)], caption: 'A quiet beat.' }] }];
    expect(analyzeComicLettering(pages)).toEqual([]);
  });

  it('honors custom thresholds', () => {
    const pages = [{ panels: [{ dialogue: [balloon('A', 10)] }] }];
    // Default: clean. Tighten the balloon limit to 5 → the 10-word balloon trips.
    expect(analyzeComicLettering(pages)).toEqual([]);
    const v = analyzeComicLettering(pages, { maxWordsPerBalloon: 5 });
    expect(v.find((x) => x.kind === 'balloon-words').count).toBe(10);
  });

  it('tolerates malformed pages / panels', () => {
    expect(analyzeComicLettering(null)).toEqual([]);
    expect(analyzeComicLettering([null, { panels: null }, {}])).toEqual([]);
  });
});
