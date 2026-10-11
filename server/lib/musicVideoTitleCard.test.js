import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TITLE_CARD_DEFAULTS, TITLE_CARD_FONT_FACES, TITLE_CARD_FONTS, normalizeTitleCard, titleCardPrefill, titleCardVisible } from './musicVideoTitleCard.js';

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
