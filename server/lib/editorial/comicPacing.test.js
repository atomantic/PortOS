import { describe, it, expect } from 'vitest';
import {
  isSplashPage,
  comicSpreadLayout,
  summarizeComicPages,
  analyzePanelRhythm,
  comicPageTurnSummary,
  authoredRevealSummary,
} from './comicPacing.js';

// A parsed page is `{ rawText, panels: [...] }`; build pages by panel count.
const page = (n) => ({ rawText: '', panels: Array.from({ length: n }, (_, i) => ({ description: `p${i}`, caption: '', dialogue: [], sfx: '' })) });
const pagesByCounts = (counts) => counts.map(page);

describe('isSplashPage', () => {
  it('is true only for a single-panel page', () => {
    expect(isSplashPage(page(1))).toBe(true);
    expect(isSplashPage(page(2))).toBe(false);
    expect(isSplashPage(page(0))).toBe(false);
    expect(isSplashPage(null)).toBe(false);
    expect(isSplashPage({})).toBe(false);
  });
});

describe('comicSpreadLayout', () => {
  it('places page 1 as a lone recto, then verso/recto spreads', () => {
    const layout = comicSpreadLayout(5);
    expect(layout).toEqual([
      { pageNumber: 1, side: 'recto', spread: 1, beginsSpread: true },
      { pageNumber: 2, side: 'verso', spread: 2, beginsSpread: true },
      { pageNumber: 3, side: 'recto', spread: 2, beginsSpread: false },
      { pageNumber: 4, side: 'verso', spread: 3, beginsSpread: true },
      { pageNumber: 5, side: 'recto', spread: 3, beginsSpread: false },
    ]);
  });

  it('returns [] for non-positive / non-integer counts', () => {
    expect(comicSpreadLayout(0)).toEqual([]);
    expect(comicSpreadLayout(-3)).toEqual([]);
    expect(comicSpreadLayout(2.5)).toEqual([]);
  });
});

describe('summarizeComicPages', () => {
  it('summarizes panel count, splash, side, and digests', () => {
    const summary = summarizeComicPages([page(1), page(3)]);
    expect(summary[0]).toMatchObject({ pageNumber: 1, panelCount: 1, isSplash: true, side: 'recto', beginsSpread: true });
    expect(summary[1]).toMatchObject({ pageNumber: 2, panelCount: 3, isSplash: false, side: 'verso' });
    expect(summary[1].panels).toHaveLength(3);
  });

  it('folds caption/dialogue/sfx TEXT (not just presence) into the panel digest', () => {
    const pages = [{ panels: [{ description: 'A long beat', caption: 'Later that night', dialogue: [{ character: 'JANE', line: 'It was you' }], sfx: 'BOOM' }] }];
    const [pg] = summarizeComicPages(pages);
    expect(pg.panels[0]).toContain('A long beat');
    // The actual text is surfaced — a reveal delivered in a caption/line must be
    // visible to the page-turn LLM, not hidden behind a count marker.
    expect(pg.panels[0]).toContain('caption: "Later that night"');
    expect(pg.panels[0]).toContain('JANE: "It was you"');
    expect(pg.panels[0]).toContain('sfx: BOOM');
  });

  it('neutralizes markdown fence delimiters in authored text (prompt-fence safety)', () => {
    const pages = [{ panels: [{ description: 'a ```code``` beat', caption: 'cap ```', dialogue: [], sfx: '' }] }];
    const [pg] = summarizeComicPages(pages);
    // The page layout is embedded in a ``` fenced prompt block — no raw backtick
    // run may survive, or it could close the fence early.
    expect(pg.panels[0]).not.toContain('`');
    expect(pg.panels[0]).toContain("'code'");
  });

  it('truncates long text fields and tolerates a bare-string dialogue entry', () => {
    const longLine = 'word '.repeat(40).trim(); // 199 chars
    const pages = [{ panels: [{ description: 'd', caption: '', dialogue: ['a bare line'], sfx: '' }, { description: 'e', caption: longLine, dialogue: [], sfx: '' }] }];
    const [pg] = summarizeComicPages(pages);
    expect(pg.panels[0]).toContain('dialogue: "a bare line"'); // no speaker → generic label
    expect(pg.panels[1]).toContain('…'); // caption clipped at 80 chars
  });

  it('tolerates a non-array input', () => {
    expect(summarizeComicPages(null)).toEqual([]);
  });
});

describe('analyzePanelRhythm — splashes', () => {
  it('flags splash overuse above the ratio when more than one splash', () => {
    const r = analyzePanelRhythm(pagesByCounts([1, 1, 3, 4]), { splashRatioWarn: 0.25 });
    expect(r.splashPages).toEqual([1, 2]);
    expect(r.splashRatio).toBe(0.5);
    expect(r.splashOveruse).toBe(true);
  });

  it('does not flag a lone splash as overuse', () => {
    const r = analyzePanelRhythm(pagesByCounts([1, 3, 4, 5]), { splashRatioWarn: 0.2 });
    expect(r.splashPages).toEqual([1]);
    expect(r.splashOveruse).toBe(false);
  });

  it('collects back-to-back splash runs of length >= 2', () => {
    const r = analyzePanelRhythm(pagesByCounts([1, 1, 1, 4, 1]));
    expect(r.backToBackSplashes).toEqual([{ startPage: 1, endPage: 3, length: 3 }]);
  });
});

describe('analyzePanelRhythm — crowding & monotony', () => {
  it('flags overcrowded pages above the max', () => {
    const r = analyzePanelRhythm(pagesByCounts([3, 11, 4, 12]), { maxPanelsPerPage: 9 });
    expect(r.overcrowded).toEqual([
      { pageNumber: 2, panelCount: 11 },
      { pageNumber: 4, panelCount: 12 },
    ]);
  });

  it('flags a monotony run of identical multi-panel counts', () => {
    const r = analyzePanelRhythm(pagesByCounts([4, 4, 4, 4, 6]), { monotonyRunLength: 4 });
    expect(r.monotonyRuns).toEqual([{ startPage: 1, endPage: 4, panelCount: 4, length: 4 }]);
  });

  it('does not treat a splash run as grid monotony', () => {
    const r = analyzePanelRhythm(pagesByCounts([1, 1, 1, 1]), { monotonyRunLength: 4 });
    expect(r.monotonyRuns).toEqual([]);
    expect(r.backToBackSplashes).toEqual([{ startPage: 1, endPage: 4, length: 4 }]);
  });

  it('monotonyRunLength below 2 disables the monotony scan', () => {
    const r = analyzePanelRhythm(pagesByCounts([4, 4, 4, 4]), { monotonyRunLength: 1 });
    expect(r.monotonyRuns).toEqual([]);
  });
});

describe('comicPageTurnSummary', () => {
  it('renders a per-page layout block with reveal-safe markers', () => {
    const out = comicPageTurnSummary([page(1), page(3), page(2)], 4);
    expect(out).toContain('Issue 4 page layout:');
    expect(out).toContain('Page 1 (recto, spread 1, first page after a turn (reveal-safe)) — splash');
    expect(out).toContain('Page 2 (verso, spread 2, first page after a turn (reveal-safe)) — 3 panels');
    expect(out).toContain('Page 3 (recto, spread 2) — 2 panels');
  });

  it('returns empty string for no pages', () => {
    expect(comicPageTurnSummary([])).toBe('');
  });
});

describe('authoredRevealSummary', () => {
  it('renders reveals (beats kind=reveal) and cliffhangers', () => {
    const readerMap = {
      beats: [
        { kind: 'reveal', note: 'The mentor is the villain', atArcPosition: 6 },
        { kind: 'hook', note: 'who sent the letter' },
      ],
      cliffhangers: [{ note: 'The door opens', atIssueBoundary: 2 }],
    };
    const out = authoredRevealSummary(readerMap);
    expect(out).toContain('Authored reveals');
    expect(out).toContain('The mentor is the villain (arc position 6)');
    expect(out).not.toContain('who sent the letter');
    expect(out).toContain('Authored cliffhangers');
    expect(out).toContain('The door opens (ending issue 2)');
  });

  it('returns empty string when nothing reveal-like is authored', () => {
    expect(authoredRevealSummary(null)).toBe('');
    expect(authoredRevealSummary({ beats: [{ kind: 'hook', note: 'q' }] })).toBe('');
  });

  it('includes cliffhanger BEATS (kind=cliffhanger), not just reveal beats and the cliffhangers list', () => {
    // READER_MAP_BEAT_KINDS allows a cliffhanger to be stored as a timeline beat;
    // the page-turn check handles reveals AND cliffhangers, so it must not drop it.
    const out = authoredRevealSummary({
      beats: [
        { kind: 'reveal', note: 'the mole is exposed', atArcPosition: 4 },
        { kind: 'cliffhanger', note: 'the bridge collapses', atArcPosition: 8 },
        { kind: 'emotional', note: 'a quiet goodbye' },
      ],
      cliffhangers: [],
    });
    expect(out).toContain('the mole is exposed (arc position 4)');
    expect(out).toContain('the bridge collapses [cliffhanger] (arc position 8)');
    expect(out).not.toContain('a quiet goodbye'); // emotional beats aren't page-turn-relevant
  });

  it('neutralizes markdown fence delimiters in reveal/cliffhanger notes (prompt-fence safety)', () => {
    // The summary is embedded in a ``` fenced block in the page-turn prompt, so a
    // note containing backticks must not be able to close the fence early.
    const out = authoredRevealSummary({
      beats: [{ kind: 'reveal', note: 'the ```secret``` is revealed' }],
      cliffhangers: [{ note: 'a ``` cliff' }],
    });
    expect(out).not.toContain('`');
    expect(out).toContain("'secret'");
  });
});
