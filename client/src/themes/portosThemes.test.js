import { describe, it, expect } from 'vitest';
import { DEFAULT_AVATAR_COLOR, DEFAULT_THEME_ID, THEMES } from './portosThemes.js';

// WCAG 2.x relative luminance + contrast ratio, computed straight from the
// stored "R G B" token strings so the assertion proves the on-disk theme
// values themselves clear AA — see #2626 (bg-port-warning / text-port-on-warning
// fell to ~2.94:1 on white in several day themes).
const parseRgb = (value) => value.trim().split(/\s+/).map(Number);

const relativeLuminance = ([r, g, b]) => {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (a, b) => {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

const AA_SMALL_TEXT = 4.5;

describe('portosThemes warning token contrast', () => {
  const entries = Object.values(THEMES);

  it('has at least one day theme (guards the loop below from vacuously passing)', () => {
    expect(entries.some((t) => t.mode === 'day')).toBe(true);
  });

  it.each(entries.map((t) => [t.id, t]))(
    '%s: bg-port-warning / text-port-on-warning meets WCAG AA (>=4.5:1)',
    (_id, theme) => {
      const warning = parseRgb(theme.colors['--port-warning']);
      const onWarning = parseRgb(theme.colors['--port-on-warning']);
      const ratio = contrastRatio(warning, onWarning);
      expect(ratio).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    },
  );
});

describe('content cards read as raised surfaces in every theme', () => {
  const entries = Object.values(THEMES);

  // A content card's fill has to differ from the page behind it by enough to be
  // SEEN, in both day and night themes. Several themes shipped card/bg pairs
  // separated by ~1.04:1 — indistinguishable — and the common `bg-port-card/40`
  // spelling then faded even that toward the page, leaving a bordered outline
  // around nothing (the Quota Burn family cards were the report).
  //
  // 1.12:1 is not a WCAG threshold (WCAG has nothing to say about surface
  // separation); it is the empirical floor at which a filled panel reads as
  // raised on this app's palettes without turning into a hard edge.
  const SURFACE_SEPARATION = 1.12;

  it('has both day and night themes (guards the loops below from vacuously passing)', () => {
    expect(entries.some((theme) => theme.mode === 'day')).toBe(true);
    expect(entries.some((theme) => theme.mode === 'night')).toBe(true);
  });

  it.each(entries.map((theme) => [theme.id, theme]))(
    '%s: defines a card fill floor no higher than its own card alpha',
    (_id, theme) => {
      const alpha = Number(theme.tokens['--port-card-alpha']);
      const floor = Number(theme.tokens['--port-card-min-alpha']);
      expect(Number.isFinite(floor)).toBe(true);
      expect(floor).toBeGreaterThan(0);
      // A floor ABOVE the theme's own card alpha would make `bg-port-card/40`
      // render more opaque than plain `bg-port-card` — the elevation scale
      // inverted.
      expect(floor).toBeLessThanOrEqual(alpha);
    },
  );

  it.each(entries.map((theme) => [theme.id, theme]))(
    '%s: a card at its minimum fill still separates from the page background',
    (_id, theme) => {
      const bg = parseRgb(theme.colors['--port-bg']);
      const card = parseRgb(theme.colors['--port-card']);
      const floor = Number(theme.tokens['--port-card-min-alpha']);
      // The worst case a card can render at: the floor alpha composited over
      // the page background.
      const composited = card.map((channel, index) => floor * channel + (1 - floor) * bg[index]);
      expect(contrastRatio(bg, composited)).toBeGreaterThanOrEqual(SURFACE_SEPARATION);
    },
  );

  it.each(entries.map((theme) => [theme.id, theme]))(
    '%s: body text still clears AA on that minimum card fill',
    (_id, theme) => {
      // Separating the card from the page must not be paid for out of text
      // legibility — lifting a night theme's card toward its text color would
      // trade one problem for a worse one.
      const bg = parseRgb(theme.colors['--port-bg']);
      const card = parseRgb(theme.colors['--port-card']);
      const floor = Number(theme.tokens['--port-card-min-alpha']);
      const composited = card.map((channel, index) => floor * channel + (1 - floor) * bg[index]);
      expect(contrastRatio(parseRgb(theme.colors['--port-text']), composited)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
      expect(contrastRatio(parseRgb(theme.colors['--port-text-muted']), composited)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    },
  );
});

describe('DEFAULT_AVATAR_COLOR', () => {
  it('is a literal #rrggbb hex — a native <input type="color"> rejects anything else', () => {
    expect(DEFAULT_AVATAR_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('matches the default theme accent, in both hex and token form', () => {
    const theme = THEMES[DEFAULT_THEME_ID];
    expect(DEFAULT_AVATAR_COLOR).toBe(theme.accent);
    const hex = parseRgb(theme.colors['--port-accent'])
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
    expect(DEFAULT_AVATAR_COLOR).toBe(`#${hex}`);
  });
});
// @vitest-environment node
