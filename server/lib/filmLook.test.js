import { describe, expect, it } from 'vitest';
import {
  FILM_LOOK_CONTROLS, FILM_LOOK_PRESETS, describeFilmLook, filmLookFilterMarkup, filmLookPreset, filmLookRuntimeSource,
  isFilmLookNeutral, normalizeFilmLook,
} from './filmLook.js';
import { filmLookSchema } from './filmLookValidation.js';

describe('film look settings', () => {
  it('normalizes any input to one bounded record and tells a neutral look from an active one', () => {
    expect(normalizeFilmLook(null)).toBeNull();
    expect(normalizeFilmLook('vhs')).toBeNull();
    const look = normalizeFilmLook({ preset: 'nope', grain: 4, exposure: -9, halationColor: 'red', grainColor: 'yes', bogus: 1, defocus: 0.123456 });
    expect(look).toMatchObject({ version: 1, preset: 'custom', grain: 1, exposure: -1, halationColor: '#ff5a1f', grainColor: false, defocus: 0.12 });
    expect(look).not.toHaveProperty('bogus');
    expect(Object.keys(look).sort()).toEqual(['preset', 'version', ...FILM_LOOK_CONTROLS.map((c) => c.id)].sort());
    expect(isFilmLookNeutral(null)).toBe(true);
    expect(isFilmLookNeutral(filmLookPreset('none'))).toBe(true);
    // Grain size alone shapes nothing; a tint alone shapes nothing.
    expect(isFilmLookNeutral({ grainSize: 0.9, castColor: '#00ff00' })).toBe(true);
    expect(isFilmLookNeutral({ grain: 0.1 })).toBe(false);
  });

  it('every preset is a valid, complete look the schema accepts, and the first real one reads as the 80s reference', () => {
    for (const preset of FILM_LOOK_PRESETS) {
      const look = filmLookPreset(preset.id);
      expect(look.preset).toBe(preset.id);
      expect(filmLookSchema.safeParse(look).success, preset.id).toBe(true);
      expect(isFilmLookNeutral(look)).toBe(preset.id === 'none');
    }
    const words = describeFilmLook(filmLookPreset('neon-rain'));
    expect(words).toMatch(/halation/);
    expect(words).toMatch(/grain/);
    expect(describeFilmLook(filmLookPreset('none'))).toBe('');
    // Prompt words follow the slider, and a modifier's words only appear with its effect.
    expect(describeFilmLook({ saturation: -1 })).toMatch(/monochrome/);
    expect(describeFilmLook({ grainSize: 1 })).toBe('');
  });

  it('refuses unknown keys and out-of-range values at the schema', () => {
    expect(filmLookSchema.safeParse({ grain: 0.5, sharpen: 1 }).success).toBe(false);
    expect(filmLookSchema.safeParse({ grain: 1.5 }).success).toBe(false);
    expect(filmLookSchema.safeParse({ castColor: 'green' }).success).toBe(false);
    expect(filmLookSchema.safeParse({ preset: 'polaroid', grain: 0.5, grainColor: true }).success).toBe(true);
  });
});

describe('film look filter markup', () => {
  it('is self-contained, inactive for a neutral look, and a pure function of the frame', () => {
    // The preview and render pages receive this function by toString(): a module-scope reference would throw here.
    const standalone = new Function(`return (${filmLookFilterMarkup.toString()});`)();
    expect(standalone(filmLookPreset('vhs'), { frame: 3 }).filter).toBe(filmLookFilterMarkup(filmLookPreset('vhs'), { frame: 3 }).filter);

    expect(filmLookFilterMarkup(filmLookPreset('none'), { frame: 1 }).active).toBe(false);
    expect(filmLookFilterMarkup(null).active).toBe(false);

    const look = filmLookPreset('super8');
    const a = filmLookFilterMarkup(look, { frame: 10, width: 1920, height: 1080 });
    const again = filmLookFilterMarkup(look, { frame: 10, width: 1920, height: 1080 });
    const b = filmLookFilterMarkup(look, { frame: 11, width: 1920, height: 1080 });
    expect(a.active).toBe(true);
    expect(a.filter).toBe(again.filter);
    expect(a.filter).not.toBe(b.filter);
    expect(a.css).toBe('url(#portos-film-look)');
    expect(a.svg).toContain(`id="portos-film-look"`);
    // Time-free looks draw the same filter at every frame, so a still is one bake.
    const still = normalizeFilmLook({ defocus: 0.5, fade: 0.5, vignette: 0.5 });
    expect(filmLookFilterMarkup(still, { frame: 0 }).filter).toBe(filmLookFilterMarkup(still, { frame: 500 }).filter);
  });

  it('scales radii with the filtered element so a phone preview, the render and a 4K still read alike', () => {
    const look = normalizeFilmLook({ defocus: 0.5 });
    const phone = /stdDeviation="([\d.]+)"/.exec(filmLookFilterMarkup(look, { width: 390, height: 219 }).filter)[1];
    const render = /stdDeviation="([\d.]+)"/.exec(filmLookFilterMarkup(look, { width: 1920, height: 1080 }).filter)[1];
    expect(Number(render) / Number(phone)).toBeCloseTo(1920 / 390, 1);
  });

  it('only emits the primitives a control turns on', () => {
    const grainOnly = filmLookFilterMarkup(normalizeFilmLook({ grain: 0.4 }), {}).filter;
    expect(grainOnly).toContain('feTurbulence');
    expect(grainOnly).not.toContain('feGaussianBlur');
    const glowOnly = filmLookFilterMarkup(normalizeFilmLook({ halation: 0.4, halationColor: '#00ff00' }), {}).filter;
    expect(glowOnly).toContain('feGaussianBlur');
    expect(glowOnly).not.toContain('feTurbulence');
    expect(glowOnly).toContain('0 1 0 0 0'); // the halation tint row for pure green
  });
});

describe('film look runtime', () => {
  it('carries the markup, the starting look and the composition seek hook into a page', () => {
    const source = filmLookRuntimeSource({ grain: 0.3, preset: 'custom' });
    expect(source).toContain('function filmLookFilterMarkup');
    expect(source).toContain('"grain":0.3');
    expect(source).toContain("'portosComposition'");
    expect(source).toContain('__portosFilmLook');
    expect(filmLookRuntimeSource(null)).toContain('let look = null;');
  });
});
