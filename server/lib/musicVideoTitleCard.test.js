import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import {
  TITLE_CARD_DEFAULTS, TITLE_CARD_FONT_FACES, TITLE_CARD_FONTS, _titleCardTestHooks, normalizeTitleCard, titleCardOutroWindow, titleCardPrefill,
  titleCardSteady, titleCardSteadySupported, titleCardVisible, titleCardWindows, titleCardRuntimeSource,
} from './musicVideoTitleCard.js';

const { titleCardAlpha, titleCardSlide, drawTitleCard } = _titleCardTestHooks;

describe('normalizeTitleCard', () => {
  it('fills defaults, clamps ranges and keeps the window open', () => {
    expect(normalizeTitleCard(null)).toBeNull();
    expect(normalizeTitleCard({})).toEqual({ ...TITLE_CARD_DEFAULTS });
    const card = normalizeTitleCard({ title: '  Example   Song Title ', startSec: 5, endSec: 4, fadeSec: 9, size: 999, position: 'nowhere', font: 'comic', color: '#ABCDEF' });
    expect(card).toMatchObject({ title: 'Example Song Title', startSec: 5, endSec: 5.5, fadeSec: 3, size: 200, position: 'lower-left', font: 'display', color: '#abcdef' });
  });

  it('keeps a known look and its colours, and drops unknown ones to the look\'s own', () => {
    expect(normalizeTitleCard({ style: 'mtv', titleColor: '#F5D33A', accentColor: '#1fc2e5' })).toMatchObject({ style: 'mtv', titleColor: '#f5d33a', accentColor: '#1fc2e5' });
    expect(normalizeTitleCard({ style: 'neon', titleColor: 'yellow', accentColor: 3 })).toMatchObject({ style: 'outline', titleColor: '', accentColor: '' });
  });

  it('counts a card as visible only when enabled with some text', () => {
    expect(titleCardVisible(normalizeTitleCard({ title: 'Song' }))).toBe(true);
    expect(titleCardVisible(normalizeTitleCard({ title: 'Song', enabled: false }))).toBe(false);
    expect(titleCardVisible(normalizeTitleCard({ title: '  ' }))).toBe(false);
  });
});

describe('end showing', () => {
  it('is off and untimed by default, keeps a timed window open, and adds a second window only when on', () => {
    const card = normalizeTitleCard({ title: 'Song', startSec: 2, endSec: 6 });
    expect(card).toMatchObject({ outro: false, outroStartSec: null, outroEndSec: null });
    expect(titleCardWindows(card)).toEqual([{ startSec: 2, endSec: 6 }]);
    const timed = normalizeTitleCard({ title: 'Song', startSec: 2, endSec: 6, outro: true, outroStartSec: 190 });
    expect(timed).toMatchObject({ outroStartSec: 190, outroEndSec: 194 });
    expect(titleCardWindows(timed)).toEqual([{ startSec: 2, endSec: 6 }, { startSec: 190, endSec: 194 }]);
    expect(normalizeTitleCard({ outroStartSec: 10, outroEndSec: 3 }).outroEndSec).toBe(10.5);
    expect(titleCardWindows({ ...timed, outro: false })).toHaveLength(1);
    expect(titleCardWindows({ ...timed, enabled: false })).toEqual([]);
  });

  it('defaults the end window to the opening one\'s length, a second before the song ends', () => {
    const card = normalizeTitleCard({ title: 'Song', startSec: 2, endSec: 6 });
    expect(titleCardOutroWindow(card, 200)).toEqual({ outroStartSec: 195, outroEndSec: 199 });
    expect(titleCardOutroWindow(card, 3)).toEqual({ outroStartSec: 0, outroEndSec: 2 });
    expect(titleCardOutroWindow(card, undefined)).toBeNull();
  });
});

describe('fades, slide and steady', () => {
  // Uniquely catches a stored card drawing differently after the upgrade: a fade out that
  // no longer matches the fade in, a slide nobody asked for, or an outline card lifted out of the film.
  it('draws a card stored before these fields as it did, apart from an mtv card turning steady', () => {
    const stored = { enabled: true, title: 'Example Song', startSec: 2, endSec: 8, fadeSec: 0.5 };
    const card = normalizeTitleCard(stored);
    expect(card).toMatchObject({ fadeSec: 0.5, fadeOutSec: 0.5, slideIn: 'none', slideSec: 0.8, slidePct: 12, steady: false });
    // The one fade at both ends of the window; a live page can also be handed the stored shape itself.
    for (const shape of [card, stored]) {
      expect([1.99, 2, 2.25, 2.5, 5, 7.5, 7.75, 8].map((t) => titleCardAlpha(shape, t))).toEqual([0, 0, 0.5, 1, 1, 1, 0.5, 0]);
      expect([2, 2.1, 5, 7.9].map((t) => titleCardSlide(shape, t))).toEqual([0, 0, 0, 0]);
    }
    expect(normalizeTitleCard({ ...stored, style: 'mtv' }).steady).toBe(true);
    expect(titleCardSteady({ ...stored, style: 'mtv' })).toBe(true);
    expect(titleCardSteady(stored)).toBe(false);
  });

  it('keeps the director\'s steady choice over the look\'s default, and counts only a card that draws', () => {
    expect(normalizeTitleCard({ style: 'mtv', steady: false }).steady).toBe(false);
    expect(normalizeTitleCard({ style: 'outline', steady: true }).steady).toBe(true);
    expect(titleCardSteady(normalizeTitleCard({ title: 'Example Song', steady: true }))).toBe(true);
    expect(titleCardSteady(normalizeTitleCard({ title: 'Example Song', steady: true, enabled: false }))).toBe(false);
    expect(titleCardSteady(normalizeTitleCard({ steady: true }))).toBe(false);
    expect(['document', 'blender', 'code', undefined].map((mode) => titleCardSteadySupported({ composition: { mode } }))).toEqual([true, true, true, true]);
    expect(titleCardSteadySupported({ composition: { mode: 'composed' } })).toBe(true);
  });

  // Uniquely catches the fade out following the fade in, or either fade outrunning half a short window.
  it('fades in and out over their own lengths, in both windows, each at most half the window', () => {
    const card = normalizeTitleCard({ title: 'Example Song', startSec: 10, endSec: 20, fadeSec: 2, fadeOutSec: 0.5, outro: true, outroStartSec: 30, outroEndSec: 31 });
    expect([10, 11, 12, 19.5, 19.75].map((t) => titleCardAlpha(card, t))).toEqual([0, 0.5, 1, 1, 0.5]);
    // The end window is a second long: the 2s fade in takes its first half, the fade out its last half.
    expect([30.25, 30.5, 30.75].map((t) => titleCardAlpha(card, t))).toEqual([0.5, 1, 0.5]);
    const cut = normalizeTitleCard({ title: 'Example Song', startSec: 0, endSec: 4, fadeSec: 1, fadeOutSec: 0 });
    expect([0.5, 3.99].map((t) => titleCardAlpha(cut, t))).toEqual([0.5, 1]);
    expect(normalizeTitleCard({ fadeSec: 1, fadeOutSec: 9 }).fadeOutSec).toBe(3);
  });

  // Uniquely catches a slide from the wrong side, one that overshoots or never settles, a missing
  // slide in the end window, a slide out, or a slide still running when a short window is half over.
  it('slides in from its side on an ease-out to rest, in both windows, and holds still after', () => {
    const card = normalizeTitleCard({ title: 'Example Song', startSec: 10, endSec: 20, slideIn: 'left', slideSec: 1, slidePct: 20, outro: true, outroStartSec: 30, outroEndSec: 31 });
    const at = (c, times) => times.map((t) => Number(titleCardSlide(c, t).toFixed(6)));
    // Ease-out cubic: the whole distance at the start, an eighth of it left halfway, none at the end.
    expect(at(card, [9.99, 10, 10.5, 11, 15, 19.99, 20])).toEqual([0, -0.2, -0.025, 0, 0, 0, 0]);
    // A one-second window caps the slide at its first half second.
    expect(at(card, [30, 30.25, 30.5, 30.9])).toEqual([-0.2, -0.025, 0, 0]);
    expect(at({ ...card, slideIn: 'right' }, [10, 10.5, 11, 30.25])).toEqual([0.2, 0.025, 0, 0.025]);
    expect(at({ ...card, slideIn: 'none' }, [10, 10.5, 30])).toEqual([0, 0, 0]);
    expect(at({ ...card, enabled: false }, [10])).toEqual([0]);
    // It only ever closes on its resting place.
    const steps = Array.from({ length: 21 }, (_, i) => titleCardSlide(card, 10 + i / 20));
    expect(steps.every((offset, i) => i === 0 || offset >= steps[i - 1])).toBe(true);
    expect(normalizeTitleCard({ slideIn: 'up', slideSec: 0, slidePct: 500 })).toMatchObject({ slideIn: 'none', slideSec: 0.1, slidePct: 100 });
  });

  // Uniquely catches the plate, the bar or the text left behind by the slide (each drawn at its own
  // resting place under one shared translation), or a card drawn outside its window.
  it('draws the whole block shifted by the slide, at the same resting coordinates', () => {
    const card = normalizeTitleCard({ title: 'Example Song', artist: 'Example Artist', style: 'mtv', startSec: 10, endSec: 20, fadeSec: 0, slideIn: 'left', slideSec: 1, slidePct: 20 });
    const drawn = (t) => {
      const ops = [];
      const ctx = {
        save: () => ops.push(['save']), restore: () => ops.push(['restore']),
        translate: (x, y) => ops.push(['translate', Number(x.toFixed(6)), y]),
        measureText: (text) => ({ width: text.length * 10 }),
        fillRect: (...box) => ops.push(['fillRect', ...box]),
        fillText: (text, x, y) => ops.push(['fillText', text, x, y]),
        strokeText: (text, x, y) => ops.push(['strokeText', text, x, y]),
      };
      return { shown: drawTitleCard(ctx, card, t, { width: 1920, height: 1080 }), ops };
    };
    const sliding = drawn(10);
    const resting = drawn(15);
    expect(sliding.shown).toBe(true);
    expect(sliding.ops.slice(0, 2)).toEqual([['save'], ['translate', -384, 0]]);
    // Plate, bar and both lines: the drawing a card at rest makes, after the one translation.
    expect(sliding.ops.slice(2)).toEqual(resting.ops.slice(1));
    expect(resting.ops.map(([op]) => op)).toEqual(['save', 'fillRect', 'fillRect', 'fillText', 'fillText', 'restore']);
    expect(drawn(9).shown).toBe(false);
    expect(drawn(9).ops).toEqual([]);
  });
});

describe('titleCardPrefill', () => {
  it('fills the song title without its version suffix, the artist and the year', () => {
    expect(titleCardPrefill({ name: 'Example Song Title v3' }, { artist: 'Example Artist', year: 2026 }))
      .toMatchObject({ enabled: true, title: 'Example Song Title', artist: 'Example Artist', year: '2026' });
  });

  it('times a new card to leave the screen before the first sung line', () => {
    const window = (firstLyricSec) => {
      const { startSec, endSec } = titleCardPrefill({ name: 'Song' }, { firstLyricSec });
      return [startSec, endSec];
    };
    expect(window(null)).toEqual([2, 8]);
    expect(window(30)).toEqual([2, 8]);
    expect(window(7)).toEqual([1.5, 6.5]);
    // Vocals almost at once: still a readable 3s hold (the panel then flags the overlap).
    expect(window(2)).toEqual([0.5, 3.5]);
  });
});

describe('title card fonts', () => {
  it('keeps a timed-out font on the fallback after the late font loads and later seeks redraw', async () => {
    vi.useFakeTimers();
    try {
      let loaded;
      const loading = new Promise((resolve) => { loaded = resolve; });
      const sandbox = { document: { body: null, fonts: { load: () => loading } }, setTimeout,
        innerWidth: 640, innerHeight: 360, portosComposition: { seek() {} } };
      sandbox.window = sandbox;
      runInContext(titleCardRuntimeSource({ title: 'Example Song', font: 'oswald' }), createContext(sandbox));
      const card = sandbox.__portosTitleCard;
      const firstSeek = sandbox.portosComposition.seek(3);
      await vi.advanceTimersByTimeAsync(1999);
      expect(card.card.font).toBe('oswald');
      await vi.advanceTimersByTimeAsync(1);
      await firstSeek;
      expect(card.card.font).toBe('sans');
      loaded([]);
      await sandbox.portosComposition.seek(4);
      expect(card.card.font).toBe('sans');
      await card.apply({ ...card.card, font: 'oswald' });
      expect(card.card.font).toBe('sans');
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps a bundled font choice, and the panel\'s swatch copies match the files renders embed', () => {
    expect(normalizeTitleCard({ font: 'oswald' }).font).toBe('oswald');
    expect(normalizeTitleCard({ font: 'comic' }).font).toBe('display');
    for (const id of Object.keys(TITLE_CARD_FONT_FACES)) expect(TITLE_CARD_FONTS).toContain(id);
    const copies = [
      ...Object.values(TITLE_CARD_FONT_FACES).map(({ file }) => [`../services/musicVideo/titleCardFonts/${file}`, file]),
      ['../services/musicVideo/documentTemplates/shared/fonts/archivo-variable.woff2', 'archivo-variable.woff2'],
      ['../services/musicVideo/documentTemplates/shared/fonts/ibm-plex-mono-500.woff2', 'ibm-plex-mono-500.woff2'],
    ];
    for (const [source, copy] of copies) {
      expect(readFileSync(new URL(`../../client/public/fonts/title-card/${copy}`, import.meta.url)).equals(readFileSync(new URL(source, import.meta.url)))).toBe(true);
    }
  });
});
