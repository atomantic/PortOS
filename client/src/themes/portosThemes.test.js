import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_AVATAR_COLOR, DEFAULT_THEME_ID, THEMES, THEME_EFFECTS } from './portosThemes.js';

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
const MAX_COMFORTABLE_TEXT_CONTRAST = 15.5;

const REQUIRED_COLOR_TOKENS = [
  '--port-bg',
  '--port-card',
  '--port-border',
  '--port-accent',
  '--port-accent-text',
  '--port-accent-2',
  '--port-accent-2-text',
  '--port-success',
  '--port-success-text',
  '--port-warning',
  '--port-warning-text',
  '--port-error',
  '--port-error-text',
  '--port-text',
  '--port-text-muted',
  '--port-text-subtle',
  '--port-on-accent',
  '--port-on-accent-2',
  '--port-on-success',
  '--port-on-warning',
  '--port-on-error',
];

const SURFACE_TEXT_TOKENS = [
  '--port-text',
  '--port-text-muted',
  '--port-text-subtle',
  '--port-accent-text',
  '--port-accent-2-text',
  '--port-success-text',
  '--port-warning-text',
  '--port-error-text',
];

const FILLED_CONTROL_PAIRS = [
  ['--port-accent', '--port-on-accent'],
  ['--port-accent-2', '--port-on-accent-2'],
  ['--port-success', '--port-on-success'],
  ['--port-warning', '--port-on-warning'],
  ['--port-error', '--port-on-error'],
];

const TONAL_TEXT_PAIRS = [
  ['--port-accent', '--port-accent-text'],
  ['--port-accent-2', '--port-accent-2-text'],
  ['--port-success', '--port-success-text'],
  ['--port-warning', '--port-warning-text'],
  ['--port-error', '--port-error-text'],
];

const TONAL_ALPHA_STEPS = [0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3];

const minimumCardSurface = (theme) => {
  const bg = parseRgb(theme.colors['--port-bg']);
  const card = parseRgb(theme.colors['--port-card']);
  const floor = Number(theme.tokens['--port-card-min-alpha']);
  return card.map((channel, index) => floor * channel + (1 - floor) * bg[index]);
};

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

describe('shared ten-theme color contract', () => {
  const entries = Object.values(THEMES);

  it('keeps five day/night variants on the same token surface', () => {
    expect(entries).toHaveLength(10);
    expect(entries.filter((theme) => theme.mode === 'day')).toHaveLength(5);
    expect(entries.filter((theme) => theme.mode === 'night')).toHaveLength(5);
    expect(new Set(entries.map((theme) => theme.family))).toEqual(new Set(['classic', 'glass', 'terminal', 'blueprint', 'kestrel']));
  });

  it.each(entries.map((theme) => [theme.id, theme]))(
    '%s: defines valid RGB values for every shared color token',
    (_id, theme) => {
      for (const token of REQUIRED_COLOR_TOKENS) {
        const value = parseRgb(theme.colors[token]);
        expect(value, token).toHaveLength(3);
        expect(value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255), token).toBe(true);
      }
    },
  );

  it.each(entries.map((theme) => [theme.id, theme]))(
    '%s: keeps surface text readable without extreme contrast',
    (_id, theme) => {
      const surfaces = [
        parseRgb(theme.colors['--port-bg']),
        parseRgb(theme.colors['--port-card']),
        minimumCardSurface(theme),
      ];
      for (const token of SURFACE_TEXT_TOKENS) {
        for (const surface of surfaces) {
          const ratio = contrastRatio(parseRgb(theme.colors[token]), surface);
          expect(ratio, `${token} on ${surface.join(' ')}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
          expect(ratio, `${token} on ${surface.join(' ')}`).toBeLessThanOrEqual(MAX_COMFORTABLE_TEXT_CONTRAST);
        }
      }
    },
  );

  it.each(entries.map((theme) => [theme.id, theme]))(
    '%s: keeps ink readable inside every filled semantic control',
    (_id, theme) => {
      for (const [fillToken, inkToken] of FILLED_CONTROL_PAIRS) {
        const ratio = contrastRatio(
          parseRgb(theme.colors[fillToken]),
          parseRgb(theme.colors[inkToken]),
        );
        expect(ratio, `${inkToken} on ${fillToken}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
        expect(ratio, `${inkToken} on ${fillToken}`).toBeLessThanOrEqual(MAX_COMFORTABLE_TEXT_CONTRAST);
      }
    },
  );

  it.each(entries.map((theme) => [theme.id, theme]))(
    '%s: keeps semantic text readable on tonal fills through 30% opacity',
    (_id, theme) => {
      const page = parseRgb(theme.colors['--port-bg']);
      const card = parseRgb(theme.colors['--port-card']);
      const minimumCard = minimumCardSurface(theme);
      for (const [fillToken, textToken] of TONAL_TEXT_PAIRS) {
        const fill = parseRgb(theme.colors[fillToken]);
        const ink = parseRgb(theme.colors[textToken]);
        for (const surface of [page, card, minimumCard]) {
          for (const alpha of TONAL_ALPHA_STEPS) {
            const tonalSurface = fill.map((channel, index) => (
              alpha * channel + (1 - alpha) * surface[index]
            ));
            const ratio = contrastRatio(ink, tonalSurface);
            expect(ratio, `${textToken} on ${fillToken}/${alpha} over ${surface.join(' ')}`)
              .toBeGreaterThanOrEqual(AA_SMALL_TEXT);
            expect(ratio, `${textToken} on ${fillToken}/${alpha} over ${surface.join(' ')}`)
              .toBeLessThanOrEqual(MAX_COMFORTABLE_TEXT_CONTRAST);
          }
        }
      }
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

describe('theme effects', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf8');

  it('every effect a theme lists is a shared effect with a CSS block keyed on the effects attribute', () => {
    for (const theme of Object.values(THEMES)) {
      for (const effect of theme.effects ?? []) {
        expect(THEME_EFFECTS, `${theme.id} lists ${effect}`).toContain(effect);
      }
    }
    for (const effect of THEME_EFFECTS) {
      expect(css).toContain(`[data-port-theme-effects~="${effect}"]`);
    }
  });

  it('is exercised by at least one theme (guards the loop above from vacuously passing)', () => {
    expect(Object.values(THEMES).some((theme) => theme.effects?.length)).toBe(true);
  });
});

// index.css scopes the stronger focus glow to an opt-in theme list, partly by
// FAMILY. `--port-focus-glow` defaults to `none`, and the rule out-specificities
// `.bg-port-accent`'s interactive shadow — so a theme that the selector matches
// without declaring the token loses its accent button's focus indicator to
// nothing. Adding a variant to a listed family is enough to trip that silently,
// which is why this is a test and not a comment.
describe('the theme-scoped focus glow only matches themes that declare it', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf8');
  // The selector prelude of the one rule whose body is `box-shadow:
  // var(--port-focus-glow)` — everything between the previous `}` and the `{`
  // that opens it. Anchored on the declaration rather than on the selector text
  // so rewording the scope list doesn't quietly stop matching.
  const rule = css.slice(0, css.indexOf('box-shadow: var(--port-focus-glow)'));
  const selector = rule.slice(rule.lastIndexOf('}') + 1, rule.lastIndexOf('{'));

  const matched = Object.values(THEMES).filter((theme) => (
    selector.includes(`[data-port-theme="${theme.id}"]`)
    || selector.includes(`[data-port-theme-family="${theme.family}"]`)
  ));

  it('finds the rule and matches at least one theme', () => {
    expect(css, 'focus-glow declaration not found in index.css').toContain('box-shadow: var(--port-focus-glow)');
    expect(matched.length).toBeGreaterThan(0);
  });

  it.each(matched.map((theme) => [theme.id, theme]))(
    '%s: declares --port-focus-glow',
    (_id, theme) => {
      expect(theme.tokens['--port-focus-glow']).toBeTruthy();
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
