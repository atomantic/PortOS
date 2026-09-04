// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  BORDER_ALPHA,
  SURFACES,
  WASH_ALPHA,
  blend,
  chipBackdrop,
  chipColors,
  contrastRatio,
  ensureReadable,
  hslToRgb,
  parseColor,
  relativeLuminance,
  rgbToHsl,
} from './chipContrast.js';
import { THEMES } from '../themes/portosThemes.js';

// The GitHub default palette that motivated this module, plus the two hues that
// were already marginal on night themes and one near-black that only night
// breaks on.
const FORGE_COLORS = {
  plan: '#fef2c0',
  'effort:medium': '#c5def5',
  'area:devtools': '#bfd4f2',
  enhancement: '#a2eeef',
  'needs-input': '#d4c5f9',
  'repo-study': '#fbca04',
  ux: '#d93f0b',
  bug: '#d73a4a',
  'model:light': '#0e8a16',
  'model:medium': '#1d76db',
  'good first issue': '#7057ff',
  midnight: '#0b0b23',
  white: '#ffffff',
  black: '#000000',
};

// What the rendered chip text actually sits on, from a hex string.
const backdropFor = (color, mode) => chipBackdrop(parseColor(color), mode);

describe('parseColor', () => {
  it('parses #rrggbb', () => {
    expect(parseColor('#1d76db')).toEqual({ r: 0x1d, g: 0x76, b: 0xdb });
  });

  it('parses #rgb shorthand by doubling each nibble', () => {
    expect(parseColor('#f0a')).toEqual({ r: 255, g: 0, b: 170 });
  });

  it('parses bare hex — what the GitHub API returns before appIssues.js prefixes it', () => {
    expect(parseColor('d73a4a')).toEqual(parseColor('#d73a4a'));
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseColor('  #D73A4A ')).toEqual(parseColor('#d73a4a'));
  });

  it('parses rgb() and rgba(), dropping alpha', () => {
    expect(parseColor('rgb(29, 118, 219)')).toEqual({ r: 29, g: 118, b: 219 });
    expect(parseColor('rgba(29 118 219 / 0.5)')).toEqual({ r: 29, g: 118, b: 219 });
  });

  it('returns null for values it cannot reason about, rather than guessing', () => {
    // A named color or hsl() would need a lookup/second parser; the caller's
    // neutral-chip fallback is the honest answer.
    for (const bad of [null, undefined, 42, '', '   ', 'rebeccapurple', 'hsl(210 50% 40%)', '#12345', 'rgb(1, 2)']) {
      expect(parseColor(bad)).toBeNull();
    }
  });
});

describe('relativeLuminance / contrastRatio', () => {
  it('anchors black at 0 and white at 1', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 6);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6);
  });

  it('gives black-on-white the WCAG maximum of 21', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 4);
  });

  it('is symmetric and bottoms out at 1 for identical colors', () => {
    const a = { r: 29, g: 118, b: 219 };
    const b = { r: 234, g: 228, b: 219 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
    expect(contrastRatio(a, a)).toBeCloseTo(1, 10);
  });
});

describe('blend', () => {
  it('at alpha 1 is the foreground and at alpha 0 the background', () => {
    const fg = { r: 255, g: 0, b: 0 };
    const bg = { r: 0, g: 0, b: 255 };
    expect(blend(fg, bg, 1)).toEqual(fg);
    expect(blend(fg, bg, 0)).toEqual(bg);
  });

  it('lands halfway at alpha 0.5', () => {
    expect(blend({ r: 200, g: 100, b: 0 }, { r: 0, g: 0, b: 100 }, 0.5))
      .toEqual({ r: 100, g: 50, b: 50 });
  });
});

describe('rgbToHsl / hslToRgb', () => {
  it('round-trips saturated hues', () => {
    for (const hex of Object.values(FORGE_COLORS)) {
      const rgb = parseColor(hex);
      expect(hslToRgb(rgbToHsl(rgb))).toEqual(rgb);
    }
  });

  it('reports achromatic colors as zero-saturation', () => {
    expect(rgbToHsl({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, l: 128 / 255 });
  });
});

describe('ensureReadable', () => {
  it('leaves a color that already clears AA untouched', () => {
    const rgb = parseColor('#0b0b23');
    const backdrop = backdropFor('#0b0b23', 'day');
    expect(contrastRatio(rgb, backdrop)).toBeGreaterThanOrEqual(4.5);
    expect(ensureReadable(rgb, backdrop)).toEqual(rgb);
  });

  it('darkens on day and lightens on night — never the wrong direction', () => {
    const rgb = parseColor('#d73a4a');
    const day = ensureReadable(rgb, backdropFor('#d73a4a', 'day'));
    const night = ensureReadable(rgb, backdropFor('#d73a4a', 'night'));
    expect(relativeLuminance(day)).toBeLessThan(relativeLuminance(rgb));
    expect(relativeLuminance(night)).toBeGreaterThan(relativeLuminance(rgb));
  });

  it('preserves hue — the thing the user recognizes the label by', () => {
    for (const hex of ['#fef2c0', '#c5def5', '#0e8a16', '#7057ff']) {
      const rgb = parseColor(hex);
      for (const mode of ['day', 'night']) {
        const out = ensureReadable(rgb, backdropFor(hex, mode));
        expect(rgbToHsl(out).h).toBeCloseTo(rgbToHsl(rgb).h, 0);
      }
    }
  });

  it('moves the SMALLEST step that clears AA — one step back would fail', () => {
    const hex = '#fef2c0';
    const rgb = parseColor(hex);
    const backdrop = backdropFor(hex, 'day');
    const out = ensureReadable(rgb, backdrop);
    expect(contrastRatio(out, backdrop)).toBeGreaterThanOrEqual(4.5);
    // Step back toward the original by one 2% lightness increment.
    const { h, s, l } = rgbToHsl(out);
    const undone = hslToRgb({ h, s, l: Math.min(1, l + 0.02) });
    expect(contrastRatio(undone, backdrop)).toBeLessThan(4.5);
  });

  it('returns the extreme rather than the input when no lightness clears AA', () => {
    // Pure white against a white-washed light surface can never reach 4.5:1 on
    // day — the loop must still hand back the darkest end, not give up at white.
    const white = { r: 255, g: 255, b: 255 };
    const out = ensureReadable(white, blend(white, SURFACES.day, WASH_ALPHA));
    expect(relativeLuminance(out)).toBeLessThan(relativeLuminance(white));
  });
});

describe('chipColors', () => {
  it('returns null for a missing or unparseable color so the caller can fall back', () => {
    for (const bad of [null, undefined, '', 'rebeccapurple']) {
      expect(chipColors(bad, 'day')).toBeNull();
      expect(chipColors(bad, 'night')).toBeNull();
    }
  });

  it.each(['day', 'night'])('clears WCAG AA for every forge color on %s themes', (mode) => {
    for (const [name, hex] of Object.entries(FORGE_COLORS)) {
      const style = chipColors(hex, mode);
      const ratio = contrastRatio(parseColor(style.color), backdropFor(hex, mode));
      expect(ratio, `${name} on ${mode}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is the regression guard for the day-theme bug: the old verbatim color failed AA', () => {
    // #fef2c0 (`plan`) rendered as its own hex was ~1.1:1 on cream — invisible.
    const backdrop = backdropFor('#fef2c0', 'day');
    expect(contrastRatio(parseColor('#fef2c0'), backdrop)).toBeLessThan(1.5);
    expect(contrastRatio(parseColor(chipColors('#fef2c0', 'day').color), backdrop))
      .toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the wash and border translucent so they composite on each theme surface', () => {
    const style = chipColors('#1d76db', 'night');
    const { r, g, b } = parseColor(style.color);
    expect(style.backgroundColor).toBe(`rgba(29, 118, 219, ${WASH_ALPHA})`);
    expect(style.borderColor).toBe(`rgba(${r}, ${g}, ${b}, ${BORDER_ALPHA})`);
    expect(style.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('washes with the ORIGINAL color, not the adjusted one — the tint keeps the label hue', () => {
    const style = chipColors('#fef2c0', 'day');
    expect(style.backgroundColor).toContain('254, 242, 192');
    expect(style.color).not.toBe('#fef2c0');
  });

  it('treats an unknown mode as night, matching the theme default', () => {
    expect(chipColors('#d73a4a', undefined)).toEqual(chipColors('#d73a4a', 'night'));
  });

  it('picks opposite adjustments for the same color across modes', () => {
    const day = chipColors('#7057ff', 'day');
    const night = chipColors('#7057ff', 'night');
    expect(relativeLuminance(parseColor(day.color)))
      .toBeLessThan(relativeLuminance(parseColor(night.color)));
  });
});

// Every AA guarantee above rests on SURFACES really being the worst case per
// mode. It's derived from THEMES rather than hand-copied, so a new theme is
// covered automatically — this asserts the derivation actually holds, and that
// it covers both chip-bearing surfaces (a chip sits on the page OR on a card).
describe('SURFACES bounds every shipped theme', () => {
  const surfacesOf = (theme) => ['--port-bg', '--port-card'].map((token) => {
    const [r, g, b] = theme.colors[token].split(/\s+/).map(Number);
    return { r, g, b };
  });

  it.each(['day', 'night'])('%s themes never render a chip on a harder surface', (mode) => {
    const reference = relativeLuminance(SURFACES[mode]);
    const themes = Object.values(THEMES).filter((t) => (t.mode === 'day' ? 'day' : 'night') === mode);
    expect(themes.length).toBeGreaterThan(0);

    for (const theme of themes) {
      for (const surface of surfacesOf(theme)) {
        const lum = relativeLuminance(surface);
        // Day grades dark text, so the darkest day surface is the hardest;
        // night grades light text, so the lightest night surface is.
        const message = `${theme.id} surface luminance ${lum.toFixed(3)} vs reference ${reference.toFixed(3)}`;
        if (mode === 'day') expect(lum, message).toBeGreaterThanOrEqual(reference);
        else expect(lum, message).toBeLessThanOrEqual(reference);
      }
    }
  });
});
