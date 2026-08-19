import { describe, it, expect } from 'vitest';
import { deriveCityPalette, resolveCityTimeOfDay, cityLabelColors, tintTowardAccent, tintStructure, CITY_COLORS, getBuildingColor, getAccentColor, seededRand, smoothstepRange, cityDayMix, getTimeOfDayPreset, cityShowDetail, cityShowInteriorWindows, resolveWorldStyle, getWorldStyle, WORLD_STYLE_DEFS, WORLD_STYLES, DEFAULT_WORLD_STYLE } from './cityConstants';

const hexLum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
};
const hexChannels = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
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
    const p = deriveCityPalette(phosphor, 'cyber');
    expect(p.nightBackground).toBe('#010c07'); // #0a7a4a * 0.1
    expect(p.dayBackground).toBe('#badacc');   // #0a7a4a lightened 0.72 toward white
    // A day theme's default surround (loading screen) is the bright day sky.
    expect(p.isDay).toBe(true);
    expect(p.background).toBe('#badacc');
  });

  it('defaults a night theme surround to the dark void', () => {
    const midnight = getTheme('classic-midnight'); // accent #3b82f6
    const p = deriveCityPalette(midnight, 'cyber');
    expect(p.isDay).toBe(false);
    expect(p.background).toBe('#060d19'); // nightBackground = #3b82f6 * 0.1
    expect(p.dayBackground).toBe('#c8dcfc');
  });

  it('falls back to defaults for a missing/invalid theme', () => {
    const p = deriveCityPalette(undefined, 'cyber');
    expect(p.themeId).toBe('classic-midnight');
    expect(p.accent).toBe('#06b6d4'); // original cyan brand
    expect(p.background).toBe('#011215'); // night theme default -> #06b6d4 * 0.1
  });

  it('resolves time of day, following theme mode for auto/legacy and honoring explicit overrides', () => {
    // auto follows the theme mode
    expect(resolveCityTimeOfDay('auto', true, 'cyber')).toEqual({ daytime: true, presetKey: 'noon' });
    expect(resolveCityTimeOfDay('auto', false, 'cyber')).toEqual({ daytime: false, presetKey: 'sunset' });
    expect(resolveCityTimeOfDay(undefined, true, 'cyber')).toEqual({ daytime: true, presetKey: 'noon' });
    // legacy stored presets are treated as auto (follow the theme)
    expect(resolveCityTimeOfDay('sunset', true, 'cyber')).toEqual({ daytime: true, presetKey: 'noon' });
    expect(resolveCityTimeOfDay('midnight', true, 'cyber')).toEqual({ daytime: true, presetKey: 'noon' });
    // explicit overrides win regardless of theme mode
    expect(resolveCityTimeOfDay('day', false, 'cyber')).toEqual({ daytime: true, presetKey: 'noon' });
    expect(resolveCityTimeOfDay('night', true, 'cyber')).toEqual({ daytime: false, presetKey: 'sunset' });
  });

  it('picks the Vibes preset pair by default, and for any unrecognized style', () => {
    // The default world style is 'vibes' — an absent, legacy, or misspelled value must
    // resolve there rather than falling through to an undefined preset key.
    expect(resolveCityTimeOfDay('auto', true)).toEqual({ daytime: true, presetKey: 'vibesDay' });
    expect(resolveCityTimeOfDay('auto', false)).toEqual({ daytime: false, presetKey: 'vibesDusk' });
    expect(resolveCityTimeOfDay('day', false, 'nonsense')).toEqual({ daytime: true, presetKey: 'vibesDay' });
    expect(resolveCityTimeOfDay('night', true, undefined)).toEqual({ daytime: false, presetKey: 'vibesDusk' });
  });

  it('keeps both Vibes presets bright, so neither reads as the neon-night look', () => {
    // Every dayMix-driven surface (grid, fog, puddles, neon albedo, label ink) lerps on
    // daylightFactor. If dusk dropped low the world would silently fall back to the cyber
    // night grade under a Vibes sky.
    for (const key of ['vibesDay', 'vibesDusk']) {
      const preset = getTimeOfDayPreset(key);
      expect(preset.daylightFactor).toBeGreaterThan(0.8);
      expect(preset.isMoon).toBe(false);
      expect(cityDayMix({ timeOfDay: key })).toBeGreaterThan(0.9);
    }
  });

  it('derives a valid palette for every shipped theme (4 day + 4 night)', () => {
    const themes = Object.values(THEMES);
    const day = themes.filter((t) => t.mode === 'day');
    const night = themes.filter((t) => t.mode === 'night');
    // The City must support all 8 PortOS themes — 4 day, 4 night.
    expect(day).toHaveLength(4);
    expect(night).toHaveLength(4);

    for (const theme of themes) {
      const p = deriveCityPalette(theme, 'cyber');
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

  it('opts CRT effects in per theme family under the cyber style', () => {
    // terminal (Phosphor) — full CRT
    expect(deriveCityPalette(getTheme('black-ice-terminal-day'), 'cyber').crt)
      .toEqual({ scanlines: true, glow: true, vignette: true });
    // classic — cyber glow + vignette, but no scanlines
    expect(deriveCityPalette(getTheme('classic-midnight'), 'cyber').crt)
      .toEqual({ scanlines: false, glow: true, vignette: true });
    // blueprint — vignette only
    expect(deriveCityPalette(getTheme('blueprint-ops'), 'cyber').crt)
      .toEqual({ scanlines: false, glow: false, vignette: true });
    // glass — fully clean, no CRT
    expect(deriveCityPalette(getTheme('lumen-glass'), 'cyber').crt)
      .toEqual({ scanlines: false, glow: false, vignette: false });
  });

  it('turns the CRT overlay off entirely in the Vibes world, whatever the theme family', () => {
    // Scanlines/glow/vignette are cyber-terminal affectations; over a sunlit low-poly
    // landscape they read as a dirty screen, so no theme family opts them back in.
    for (const id of ['black-ice-terminal-day', 'classic-midnight', 'blueprint-ops', 'lumen-glass']) {
      expect(deriveCityPalette(getTheme(id), 'vibes').crt)
        .toEqual({ scanlines: false, glow: false, vignette: false });
    }
  });
});

describe('city sky visibility', () => {
  it('keeps daytime horizon bands blue enough to avoid a white sky wash', () => {
    const noon = getTimeOfDayPreset('noon', 'cyberpunk');
    const horizonLow = hexChannels(noon.horizonLow);
    const horizonHigh = hexChannels(noon.horizonHigh);

    // The lower horizon can be bright, but should not be near-white across all
    // channels; otherwise the sky dome becomes a fog overlay.
    expect(Math.max(...horizonLow) - Math.min(...horizonLow)).toBeGreaterThan(35);
    expect(Math.max(...horizonHigh) - Math.min(...horizonHigh)).toBeGreaterThan(45);
    expect(hexLum(noon.horizonLow)).toBeLessThan(205);
  });

  it('falls back to the cyber sky for legacy dreamworld settings', () => {
    const cyber = getTimeOfDayPreset('noon', 'cyberpunk');
    const noon = getTimeOfDayPreset('noon', 'dreamworld');
    expect(noon).toBe(cyber);
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

describe('tintTowardAccent / tintStructure', () => {
  // These are now pure: the accent is passed in explicitly (no shared-singleton read).
  it('shifts hue toward the accent while preserving luminance', () => {
    const base = '#0a0e16'; // a dark blue-dominant structural base
    const out = tintStructure(base, '#ff0000'); // pure red accent
    // Luminance preserved within rounding — the base stays just as dark.
    expect(hexLum(out)).toBeCloseTo(hexLum(base), 0);
    // Hue pulled toward red: the red channel rises relative to the original.
    expect(hexChannels(out)[0]).toBeGreaterThan(hexChannels(base)[0]);
  });

  it('leaves pure black untouched (no hue to tint)', () => {
    expect(tintTowardAccent('#000000', 0.2, '#22c55e')).toBe('#000000');
  });

  it('is a no-op-ish identity when the accent equals the base hue direction', () => {
    // Tinting toward itself preserves the color (luminance + channels unchanged).
    expect(hexLum(tintStructure('#0a0e16', '#0a0e16'))).toBeCloseTo(hexLum('#0a0e16'), 0);
  });

  it('returns the input unchanged for an unparseable color', () => {
    expect(tintTowardAccent('not-a-hex', 0.2, '#22c55e')).toBe('not-a-hex');
  });

  it('defaults to the static cyan brand accent when none is passed', () => {
    // The bare helper (no accent arg) tints toward the cyan brand default, so a
    // consumer that hasn't wired the palette still gets a sensible result.
    const out = tintStructure('#0a0e16');
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    expect(hexLum(out)).toBeCloseTo(hexLum('#0a0e16'), 0);
  });
});

describe('deriveCityPalette — world style', () => {
  it('reports the resolved style and its low-poly flag', () => {
    expect(deriveCityPalette(getTheme('classic-midnight'), 'cyber')).toMatchObject({ worldStyle: 'cyber', lowPoly: false });
    expect(deriveCityPalette(getTheme('classic-midnight'), 'vibes')).toMatchObject({ worldStyle: 'vibes', lowPoly: true });
    // Absent / unrecognized falls back to the default rather than an undefined style.
    expect(deriveCityPalette(getTheme('classic-midnight'))).toMatchObject({ worldStyle: 'vibes', lowPoly: true });
    expect(deriveCityPalette(getTheme('classic-midnight'), 'neon-noir')).toMatchObject({ worldStyle: 'vibes', lowPoly: true });
  });

  it('gives the Vibes world a bright surround at BOTH times of day', () => {
    // The cyber world needs darkness for its additive neon; the Vibes world has none, and
    // its "night" is a golden dusk — so neither surround may be a near-black void.
    const p = deriveCityPalette(getTheme('classic-midnight'), 'vibes');
    expect(hexLum(p.nightBackground)).toBeGreaterThan(80);
    expect(hexLum(p.dayBackground)).toBeGreaterThan(80);
  });

  it('lightens the structural body relative to the cyber world', () => {
    const theme = getTheme('classic-midnight');
    const cyber = deriveCityPalette(theme, 'cyber');
    const vibes = deriveCityPalette(theme, 'vibes');
    expect(hexLum(vibes.buildingBody)).toBeGreaterThan(hexLum(cyber.buildingBody));
  });

  it('swaps the decorative spread but keeps the theme accent leading, in both styles', () => {
    const theme = getTheme('classic-midnight');
    const cyber = deriveCityPalette(theme, 'cyber');
    const vibes = deriveCityPalette(theme, 'vibes');
    expect(vibes.neonAccents[0]).toBe(vibes.accent);
    expect(cyber.neonAccents[0]).toBe(cyber.accent);
    expect(vibes.neonAccents.slice(1)).not.toEqual(cyber.neonAccents.slice(1));
    expect(vibes.neonAccents).toHaveLength(cyber.neonAccents.length);
  });

  it('keeps status colors semantic in both styles', () => {
    const theme = getTheme('classic-midnight');
    for (const style of ['cyber', 'vibes']) {
      const p = deriveCityPalette(theme, style);
      expect(p.getBuildingColor('stopped')).toBe(CITY_COLORS.building.stopped);
      expect(p.getBuildingColor('online', true)).toBe(CITY_COLORS.building.archived);
    }
  });
});

describe('deriveCityPalette brand surfaces', () => {
  it('carries themed brand surfaces derived from the accent', () => {
    const p = deriveCityPalette(getTheme('black-ice-terminal-day'));
    expect(p.ground).toBe('#0a7a4a');
    expect(p.particles).toBe('#0a7a4a');
    expect(p.building.online).toBe('#0a7a4a');
    expect(p.neonAccents[0]).toBe('#0a7a4a');
    // online buildings follow the recolor through the palette-bound helper
    expect(p.getBuildingColor('online')).toBe('#0a7a4a');
  });

  it('leaves status colors untouched', () => {
    const p = deriveCityPalette(getTheme('black-ice-terminal-day'));
    expect(p.building.stopped).toBe('#ef4444');
    expect(p.getBuildingColor('stopped')).toBe('#ef4444');
    // not_found stays the canonical purple — the value ProcessBuilding now unifies to.
    expect(p.building.not_found).toBe('#8b5cf6');
  });

  it('re-tints the building body toward the accent, preserving its darkness', () => {
    const ORIGINAL_BODY = '#0c0c24';
    const p = deriveCityPalette(getTheme('black-ice-terminal-day'), 'cyber'); // green accent
    expect(p.buildingBody).not.toBe(ORIGINAL_BODY); // picked up the theme
    expect(hexLum(p.buildingBody)).toBeCloseTo(hexLum(ORIGINAL_BODY), 0); // still a dark body
  });

  it('is pure — never mutates the shared CITY_COLORS singleton', () => {
    deriveCityPalette(getTheme('black-ice-terminal-day'));
    // The static table keeps its cyan baseline; only the returned palette is themed.
    expect(CITY_COLORS.ground).toBe('#06b6d4');
    expect(CITY_COLORS.building.online).toBe('#06b6d4');
    expect(CITY_COLORS.neonAccents[0]).toBe('#06b6d4');
    expect(CITY_COLORS.buildingBody).toBe('#0c0c24');
    // The bare helper, reading no palette, still reports the static brand.
    expect(getBuildingColor('online')).toBe('#06b6d4');
  });

  it('does not compound across repeated derivations — each is recomputed from the accent', () => {
    const green = deriveCityPalette(getTheme('black-ice-terminal-day'));
    deriveCityPalette(getTheme('classic-midnight'));
    const greenAgain = deriveCityPalette(getTheme('black-ice-terminal-day'));
    // classic-midnight accent is 59 130 246 -> #3b82f6, never a blend of green+blue.
    expect(deriveCityPalette(getTheme('classic-midnight')).ground).toBe('#3b82f6');
    // Re-deriving the green theme yields an identical body — proof it's recomputed
    // from ORIGINAL_BUILDING_BODY, not from a previously-tinted value.
    expect(greenAgain.buildingBody).toBe(green.buildingBody);
  });

  it('binds getAccentColor to the themed neon list', () => {
    const p = deriveCityPalette(getTheme('black-ice-terminal-day'));
    // The lead neon accent tracks the theme, so an app hashing to index 0 gets it.
    expect(p.neonAccents[0]).toBe('#0a7a4a');
    // Bound helper picks from the palette's list; the bare helper picks from the
    // static list. Both are deterministic for a given app and stay in their list.
    const app = { name: 'anything' };
    expect(p.neonAccents).toContain(p.getAccentColor(app));
    expect(CITY_COLORS.neonAccents).toContain(getAccentColor(app));
  });
});

describe('seededRand', () => {
  it('is deterministic for a given seed', () => {
    const a = seededRand(42);
    const b = seededRand(42);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('produces different streams for different seeds', () => {
    const a = seededRand(42);
    const b = seededRand(137);
    expect(a()).not.toBe(b());
  });

  it('yields values in [0, 1)', () => {
    const r = seededRand(3187);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('matches the original inline LCG it replaced', () => {
    // Reference: the exact expression copy-pasted across the city components.
    let s = 77;
    const ref = () => { s = (s * 16807) % 2147483647; return (s & 0x7fffffff) / 2147483647; };
    const r = seededRand(77);
    expect([r(), r(), r()]).toEqual([ref(), ref(), ref()]);
  });
});

describe('smoothstepRange', () => {
  it('clamps below edge0 to 0 and above edge1 to 1', () => {
    expect(smoothstepRange(0.35, 1, 0.2)).toBe(0);
    expect(smoothstepRange(0.35, 1, 1)).toBe(1);
    expect(smoothstepRange(0.35, 1, 2)).toBe(1);
  });

  it('returns the Hermite midpoint at the center', () => {
    expect(smoothstepRange(0, 1, 0.5)).toBeCloseTo(0.5, 10);
  });

  it('guards against a zero-width range', () => {
    expect(smoothstepRange(0.5, 0.5, 0.4)).toBe(0);
    expect(smoothstepRange(0.5, 0.5, 0.6)).toBe(1);
  });
});

describe('cityDayMix', () => {
  it('is 1 in full daylight and 0 at night', () => {
    expect(cityDayMix({ timeOfDay: 'noon' })).toBe(1);
    expect(cityDayMix({ timeOfDay: 'sunset' })).toBe(0);
  });

  it('defaults to the night preset when unset', () => {
    expect(cityDayMix(undefined)).toBe(0);
  });
});

describe('quality-preset gates', () => {
  // Preset densities: low 0.5, medium 0.75, high 1.0, ultra 1.5.
  it('cityShowDetail turns on above the low preset', () => {
    expect(cityShowDetail({ particleDensity: 0.5 })).toBe(false);
    expect(cityShowDetail({ particleDensity: 0.75 })).toBe(true);
    expect(cityShowDetail(undefined)).toBe(true); // defaults to 1
  });

  it('cityShowInteriorWindows holds one tier above detail (high+)', () => {
    expect(cityShowInteriorWindows({ particleDensity: 0.5 })).toBe(false);
    expect(cityShowInteriorWindows({ particleDensity: 0.75 })).toBe(false);
    expect(cityShowInteriorWindows({ particleDensity: 1.0 })).toBe(true);
    expect(cityShowInteriorWindows({ particleDensity: 1.5 })).toBe(true);
    expect(cityShowInteriorWindows(undefined)).toBe(true); // defaults to 1
  });

  it('detail gates prefer the explicit effectiveTier over particleDensity', () => {
    // effectiveTier is authoritative when present — particleDensity is ignored. The
    // warm-up path expresses its detail suppression by setting effectiveTier:'low'
    // (see CityScene.renderSettings), not by clamping particleDensity.
    expect(cityShowDetail({ effectiveTier: 'low', particleDensity: 2 })).toBe(false);
    expect(cityShowDetail({ effectiveTier: 'medium', particleDensity: 0.1 })).toBe(true);
    expect(cityShowInteriorWindows({ effectiveTier: 'medium', particleDensity: 2 })).toBe(false);
    expect(cityShowInteriorWindows({ effectiveTier: 'high', particleDensity: 0.1 })).toBe(true);
    expect(cityShowInteriorWindows({ effectiveTier: 'ultra' })).toBe(true);
  });
});
// @vitest-environment node

describe('resolveWorldStyle / getWorldStyle', () => {
  it('passes through a known style', () => {
    for (const style of WORLD_STYLES) expect(resolveWorldStyle(style)).toBe(style);
  });

  it('falls back to the default for absent, legacy, or malformed values', () => {
    for (const bad of [undefined, null, '', 'CYBER', 'neon', 0, {}]) {
      expect(resolveWorldStyle(bad)).toBe(DEFAULT_WORLD_STYLE);
    }
  });

  it('always returns a real definition, even for a bad style', () => {
    for (const bad of [undefined, null, '', 'neon', 0, {}]) {
      expect(getWorldStyle(bad)).toBe(WORLD_STYLE_DEFS[DEFAULT_WORLD_STYLE]);
    }
  });

  it('gates the neon-only scene layers on the cyber style alone', () => {
    // CityScene mounts the galaxy spheremap, starfield, data rain, embers, volumetric
    // cones, and neon signage on palette.neonLayers. An absent style must NOT read as
    // cyber — that would haze the default bright world.
    expect(deriveCityPalette(undefined, 'cyber').neonLayers).toBe(true);
    expect(deriveCityPalette(undefined, 'vibes').neonLayers).toBe(false);
    expect(deriveCityPalette(undefined).neonLayers).toBe(false);
    expect(deriveCityPalette(undefined, 'nonsense').neonLayers).toBe(false);
  });

  it('every style definition is complete, so a new row cannot half-register', () => {
    for (const [id, def] of Object.entries(WORLD_STYLE_DEFS)) {
      expect(def.id).toBe(id);
      expect(def.label).toBeTruthy();
      // Both preset keys must name a real time-of-day preset, or the sky renders undefined.
      expect(getTimeOfDayPreset(def.presets.day)).toBeDefined();
      expect(getTimeOfDayPreset(def.presets.night)).toBeDefined();
      expect(CITY_COLORS.timeOfDay[def.presets.day]).toBeDefined();
      expect(CITY_COLORS.timeOfDay[def.presets.night]).toBeDefined();
      expect(typeof def.lowPoly).toBe('boolean');
      expect(typeof def.neonLayers).toBe('boolean');
      expect(typeof def.themeCrt).toBe('boolean');
      expect(def.accents.length).toBeGreaterThan(1);
      expect(def.buildingBody).toMatch(/^#[0-9a-f]{6}$/i);
      for (const band of ['inner', 'meadow', 'ridge']) {
        expect(def.terrain[band]).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('carries a style-appropriate material surface for structural meshes', () => {
    // flatShading is part of three.js's shader program cache key, so this must be a
    // concrete boolean on both styles rather than absent on one of them.
    expect(deriveCityPalette(undefined, 'vibes').surface)
      .toEqual({ flatShading: true, roughness: 0.95, metalness: 0 });
    expect(deriveCityPalette(undefined, 'cyber').surface).toEqual({ flatShading: false });
  });

  it('exposes the style terrain bands so components do not hardcode hexes', () => {
    expect(deriveCityPalette(undefined, 'vibes').terrain).toEqual(WORLD_STYLE_DEFS.vibes.terrain);
    expect(deriveCityPalette(undefined, 'cyber').terrain).toEqual(WORLD_STYLE_DEFS.cyber.terrain);
  });
});
