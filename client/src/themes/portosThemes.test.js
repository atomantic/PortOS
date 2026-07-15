import { describe, it, expect } from 'vitest';
import { THEMES } from './portosThemes.js';

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
