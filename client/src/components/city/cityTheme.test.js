import { describe, it, expect, beforeEach } from 'vitest';
import { deriveCityPalette, applyCityBrandColors, resolveCityTimeOfDay, cityLabelColors, CITY_COLORS, getBuildingColor } from './cityConstants';
import { getTheme, THEMES } from '../../themes/portosThemes';

describe('deriveCityPalette', () => {
  it('derives the accent hex from a theme --port-accent triplet', () => {
    const phosphor = getTheme('black-ice-terminal-day');
    const p = deriveCityPalette(phosphor);
    expect(p.accent).toBe('#0a7a4a'); // 10 122 74
    expect(p.themeId).toBe('black-ice-terminal-day');
    expect(p.isDay).toBe(true);
  });

  it('exposes a dark night void and a bright day sky, both accent-tinted', () => {
    const phosphor = getTheme('black-ice-terminal-day'); // accent #0a7a4a
    const p = deriveCityPalette(phosphor);
    expect(p.nightBackground).toBe('#010c07'); // #0a7a4a * 0.1
    expect(p.dayBackground).toBe('#ddece6');   // #0a7a4a lightened 0.86 toward white
    // A day theme's default surround (loading screen) is the bright day sky.
    expect(p.isDay).toBe(true);
    expect(p.background).toBe('#ddece6');
  });

  it('defaults a night theme surround to the dark void', () => {
    const midnight = getTheme('classic-midnight'); // accent #3b82f6
    const p = deriveCityPalette(midnight);
    expect(p.isDay).toBe(false);
    expect(p.background).toBe('#060d19'); // nightBackground = #3b82f6 * 0.1
    expect(p.dayBackground).toBe('#e4eefe');
  });

  it('falls back to defaults for a missing/invalid theme', () => {
    const p = deriveCityPalette(undefined);
    expect(p.themeId).toBe('classic-midnight');
    expect(p.accent).toBe('#06b6d4'); // original cyan brand
    expect(p.background).toBe('#011215'); // night theme default -> #06b6d4 * 0.1
  });

  it('resolves time of day, following theme mode for auto/legacy and honoring explicit overrides', () => {
    // auto follows the theme mode
    expect(resolveCityTimeOfDay('auto', true)).toEqual({ daytime: true, presetKey: 'noon' });
    expect(resolveCityTimeOfDay('auto', false)).toEqual({ daytime: false, presetKey: 'sunset' });
    expect(resolveCityTimeOfDay(undefined, true)).toEqual({ daytime: true, presetKey: 'noon' });
    // legacy stored presets are treated as auto (follow the theme)
    expect(resolveCityTimeOfDay('sunset', true)).toEqual({ daytime: true, presetKey: 'noon' });
    expect(resolveCityTimeOfDay('midnight', true)).toEqual({ daytime: true, presetKey: 'noon' });
    // explicit overrides win regardless of theme mode
    expect(resolveCityTimeOfDay('day', false)).toEqual({ daytime: true, presetKey: 'noon' });
    expect(resolveCityTimeOfDay('night', true)).toEqual({ daytime: false, presetKey: 'sunset' });
  });

  it('derives a valid palette for every shipped theme (4 day + 4 night)', () => {
    const themes = Object.values(THEMES);
    const day = themes.filter((t) => t.mode === 'day');
    const night = themes.filter((t) => t.mode === 'night');
    // The City must support all 8 PortOS themes — 4 day, 4 night.
    expect(day).toHaveLength(4);
    expect(night).toHaveLength(4);

    for (const theme of themes) {
      const p = deriveCityPalette(theme);
      expect(p.themeId).toBe(theme.id);
      expect(p.isDay).toBe(theme.mode === 'day');
      // Accent is parsed to a concrete hex (never left as a raw triplet/empty).
      expect(p.accent).toMatch(/^#[0-9a-f]{6}$/);
      // Day surround is a bright sky; night surround is a near-black void — and the
      // two are always distinct so the backdrop actually swaps with time of day.
      expect(p.dayBackground).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.nightBackground).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.dayBackground).not.toBe(p.nightBackground);
      expect(p.background).toBe(p.isDay ? p.dayBackground : p.nightBackground);
    }
  });

  it('opts CRT effects in per theme family', () => {
    // terminal (Phosphor) — full CRT
    expect(deriveCityPalette(getTheme('black-ice-terminal-day')).crt)
      .toEqual({ scanlines: true, glow: true, vignette: true });
    // classic — cyber glow + vignette, but no scanlines
    expect(deriveCityPalette(getTheme('classic-midnight')).crt)
      .toEqual({ scanlines: false, glow: true, vignette: true });
    // blueprint — vignette only
    expect(deriveCityPalette(getTheme('blueprint-ops')).crt)
      .toEqual({ scanlines: false, glow: false, vignette: true });
    // glass — fully clean, no CRT
    expect(deriveCityPalette(getTheme('lumen-glass')).crt)
      .toEqual({ scanlines: false, glow: false, vignette: false });
  });
});

describe('cityLabelColors', () => {
  it('keeps the neon fill and adds no outline at night (dayMix 0)', () => {
    const c = cityLabelColors('#06b6d4', 0);
    expect(c.color).toBe('#06b6d4'); // untouched neon
    expect(c.outlineWidth).toBe('0.00%'); // drei reads a 0% outline as none
    expect(c.outlineOpacity).toBe(0);
  });

  it('darkens the fill toward ink and fades in a light outline by day (dayMix 1)', () => {
    const c = cityLabelColors('#06b6d4', 1);
    // Fill lands on the dark ink (a near-black tinted 22% toward the label hue),
    // i.e. clearly darker than the original neon so it reads on a bright sky.
    expect(c.color).not.toBe('#06b6d4');
    const lum = parseInt(c.color.slice(1, 3), 16) + parseInt(c.color.slice(3, 5), 16) + parseInt(c.color.slice(5, 7), 16);
    expect(lum).toBeLessThan(180); // dark ink (~140), far below the neon's ~400
    expect(c.outlineColor).toBe('#eef4ff');
    expect(c.outlineWidth).toBe('9.00%');
    expect(c.outlineOpacity).toBeCloseTo(0.85);
  });

  it('clamps out-of-range / missing dayMix', () => {
    expect(cityLabelColors('#06b6d4', 2).outlineOpacity).toBeCloseTo(0.85);
    expect(cityLabelColors('#06b6d4', -1).outlineWidth).toBe('0.00%');
    expect(cityLabelColors('#06b6d4').color).toBe('#06b6d4'); // undefined → night
  });
});

describe('applyCityBrandColors', () => {
  // Restore the cyan baseline after each test so mutation doesn't leak across the suite.
  beforeEach(() => applyCityBrandColors(deriveCityPalette(undefined)));

  it('recolors brand surfaces to the theme accent', () => {
    applyCityBrandColors(deriveCityPalette(getTheme('black-ice-terminal-day')));
    expect(CITY_COLORS.ground).toBe('#0a7a4a');
    expect(CITY_COLORS.particles).toBe('#0a7a4a');
    expect(CITY_COLORS.building.online).toBe('#0a7a4a');
    expect(CITY_COLORS.neonAccents[0]).toBe('#0a7a4a');
    // online buildings follow the recolor through the shared helper
    expect(getBuildingColor('online')).toBe('#0a7a4a');
  });

  it('leaves status colors untouched', () => {
    applyCityBrandColors(deriveCityPalette(getTheme('black-ice-terminal-day')));
    expect(CITY_COLORS.building.stopped).toBe('#ef4444');
    expect(getBuildingColor('stopped')).toBe('#ef4444');
  });

  it('recomputes from the cyan baseline rather than compounding across switches', () => {
    applyCityBrandColors(deriveCityPalette(getTheme('black-ice-terminal-day')));
    applyCityBrandColors(deriveCityPalette(getTheme('classic-midnight')));
    // classic-midnight accent is 59 130 246 -> #3b82f6, not a blend of green+blue
    expect(CITY_COLORS.ground).toBe('#3b82f6');
  });
});
