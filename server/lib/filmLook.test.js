import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  FILM_LOOK_CONTROLS, FILM_LOOK_PRESETS, describeFilmLook, filmLookFilterMarkup, filmLookMotionLayers, filmLookPreset, filmLookRuntimeSource,
  isFilmLookNeutral, normalizeFilmLook, sameFilmLook, scaleFilmLook,
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
    expect(filmLookSchema.safeParse({ version: 3 }).success).toBe(false);
    expect(normalizeFilmLook({ version: 3, grain: 0.5 })).toBeNull();
  });

  it('scales a look toward clean: effects shrink, shaping values stay, and the amount is clamped', () => {
    const vhs = filmLookPreset('vhs');
    expect(isFilmLookNeutral(scaleFilmLook(vhs, 0))).toBe(true);
    expect(sameFilmLook(scaleFilmLook(vhs, 1), vhs)).toBe(true);
    const fifth = scaleFilmLook(vhs, 0.2);
    for (const control of FILM_LOOK_CONTROLS) {
      if (control.type || control.modifier) expect(fifth[control.id]).toBe(vhs[control.id]);
      // A scaled value lands on its control's step, like any normalized value.
      else expect(Math.abs(fifth[control.id] - vhs[control.id] * 0.2)).toBeLessThanOrEqual(control.step / 2 + 1e-9);
    }
    expect(sameFilmLook(scaleFilmLook(vhs, 3), vhs)).toBe(true);
    expect(isFilmLookNeutral(scaleFilmLook(vhs, -1))).toBe(true);
    expect(scaleFilmLook(null, 0.5)).toBeNull();
  });
});

describe('film look filter markup', () => {
  it('preserves legacy tone behavior and uses a monotonic shoulder/toe only for the new recipes', () => {
    const old = normalizeFilmLook({ version: 1, contrast: 0.1, grain: 0.2 });
    expect(old.version).toBe(1);
    expect(filmLookFilterMarkup(old).filter).not.toContain('type="table"');
    const look = filmLookPreset('natural-35mm');
    expect(look.version).toBe(2);
    const markup = filmLookFilterMarkup(look).filter;
    const values = /tableValues="([^"]+)"/.exec(markup)[1].split(' ').map(Number);
    expect(values).toHaveLength(256);
    expect(values[0]).toBe(0);
    expect(values[255]).toBeLessThan(1);
    expect(values[255]).toBeGreaterThan(0.8);
    expect(values.every((v, i) => i === 0 || v >= values[i - 1])).toBe(true);
    expect(values[128]).toBeCloseTo(128 / 255, 3);
    expect(markup).toContain('in2="SourceGraphic" operator="in"');
    expect(normalizeFilmLook({ ...old, shoulder: 0.5 }).version).toBe(2);
    expect(sameFilmLook({ version: 1, halation: 0.3 }, { version: 2, halation: 0.3 })).toBe(false);
  });
  it('bends each channel its own way for dye crossover while black, gray and white stay put', () => {
    const tables = (look) => [...filmLookFilterMarkup(normalizeFilmLook(look)).filter.matchAll(/tableValues="([^"]+)"/g)]
      .map((m) => m[1].split(' ').map(Number));
    const [r, g, b] = tables({ crossover: 1 });
    expect(normalizeFilmLook({ crossover: 1 }).version).toBe(2);
    for (const channel of [r, g, b]) {
      expect(channel[0]).toBe(0);
      expect(channel[255]).toBe(1);
      expect(channel.every((v, i) => i === 0 || v >= channel[i - 1])).toBe(true);
    }
    // Positive: cyan-green shadows, amber highlights; negative mirrors it.
    expect(b[50]).toBeGreaterThan(r[50]);
    expect(r[205]).toBeGreaterThan(b[205]);
    const [rn, , bn] = tables({ crossover: -1 });
    expect(rn[50]).toBeGreaterThan(bn[50]);
    // No crossover keeps the single shared response the earlier recipes drew.
    const [sr, sg, sb] = tables({ version: 2, shoulder: 0.5 });
    expect(sr).toEqual(sg);
    expect(sg).toEqual(sb);
  });

  it('keeps the version-1 light leak and fogs a version-2 leak in from the frame edge', () => {
    const v1 = filmLookFilterMarkup(normalizeFilmLook({ leak: 0.5 }), { width: 1000, height: 500 }).filter;
    expect(v1).toContain('x="620" y="-100" width="300" height="700"');
    const v2 = filmLookFilterMarkup(normalizeFilmLook({ version: 2, leak: 0.5 }), { width: 1000, height: 500 }).filter;
    expect(v2).not.toContain('x="620"');
    expect(v2).toContain('x="860"');
  });

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
  // Catches motion mode retaining the per-frame SVG chain or pause failing to restore render parity.
  it('switches the inlined page runtime between cheap reusable motion layers and the exact seek filter', () => {
    const element = () => ({
      style: { filter: '', transform: '' }, dataset: {}, children: [], isConnected: false,
      setAttribute() {},
      getContext: () => ({ fillRect() {}, createPattern() {} }),
      get lastElementChild() { return this.children.at(-1); },
      appendChild(child) { child.remove(); this.children.push(child); child.parent = this; child.parentNode = this; child.isConnected = true; },
      insertBefore(child, before) { child.remove(); this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); child.parent = this; child.parentNode = this; child.isConnected = true; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.isConnected = false; },
    });
    const root = Object.assign(element(), { clientWidth: 390, clientHeight: 219 });
    root.style.transform = 'scale(0.9)';
    const context = { document: { documentElement: root, body: root, readyState: 'complete', createElement: element, createElementNS: element }, addEventListener() {} };
    context.window = context;
    const look = filmLookPreset('vhs');
    runInNewContext(filmLookRuntimeSource(look), context);
    const api = context.__portosFilmLook;
    context.portosComposition = { fps: 30, seek: (t) => t };
    context.portosComposition.seek(0.4);
    const exact = filmLookFilterMarkup(look, { frame: 12, width: 390, height: 219 });
    expect(root.style.filter).toBe(exact.css);
    expect(root.children[0].innerHTML).toBe('<defs>' + exact.filter + '</defs>');
    api.playback(true);
    expect(root.style.filter).not.toContain('url(');
    const overlays = root.lastElementChild;
    const grain = overlays.children.find((child) => child.dataset.filmLookLayer === 'grain');
    const canvas = grain.children[0];
    const originalShift = canvas.style.transform;
    context.portosComposition.seek(0.5);
    expect(root.lastElementChild).toBe(overlays);
    expect(overlays.children.find((child) => child.dataset.filmLookLayer === 'grain')).toBe(grain);
    expect(grain.children[0]).toBe(canvas);
    expect(canvas.style.transform).not.toBe(originalShift);
    expect(overlays.style.cssText).toContain('display:contents;pointer-events:none');
    expect(overlays.children.every((child) => child.style.zIndex === '2147483647')).toBe(true);
    expect(overlays.children.every((child) => child.style.pointerEvents === 'none')).toBe(true);
    api.playback(false);
    expect(root.style.filter).toBe(exact.css);
    expect(root.style.transform).toBe('scale(0.9)');
    expect(overlays.isConnected).toBe(false);
    expect(root.lastElementChild.innerHTML).toBe('<defs>' + filmLookFilterMarkup(look, { frame: 15, width: 390, height: 219 }).filter + '</defs>');
    api.playback(true);
    api.apply(null);
    expect(root.style.filter).toBe('');
    expect(root.style.transform).toBe('scale(0.9)');
    expect(root.children).toHaveLength(0);
  });

  it('carries the markup, the starting look and the composition seek hook into a page', () => {
    const source = filmLookRuntimeSource({ grain: 0.3, preset: 'custom' });
    expect(source).toContain('function filmLookFilterMarkup');
    expect(source).toContain('"grain":0.3');
    expect(source).toContain("'portosComposition'");
    expect(source).toContain('__portosFilmLook');
    expect(filmLookRuntimeSource(null)).toContain('let look = null;');
  });
});

describe('film look motion layers', () => {
  // Uniquely catches an SVG filter coming back into the playing picture (a browser re-runs it over
  // every decoded video frame: 30 fps → under 1 on a phone after #11215) and the stages leaving the render's order.
  it('turns the look into CSS filter functions and blended overlays, with the noise as tiles shifted per frame', () => {
    const look = normalizeFilmLook({ defocus: 0.3, halation: 0.4, contrast: -0.2, fade: 0.3, saturation: 0.15, warmth: 0.2, cast: 0.2, castColor: '#b9c04a', grain: 0.6, grainSize: 0.5, tapeNoise: 0.5, vignette: 0.4, leak: 0.3, weave: 0.5 });
    const motion = filmLookMotionLayers(look, { frame: 12, width: 390, height: 219 });
    expect(motion.filter).toMatch(/^blur\([\d.]+px\) brightness\([\d.]+\) contrast\([\d.]+\) saturate\(1\.15\)$/);
    expect(motion.filter).not.toContain('url(');
    expect(motion.transform).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\)$/);
    expect(motion.overlays.map((layer) => [layer.key, layer.kind, layer.blend])).toEqual([
      ['warmth', 'flat', 'soft-light'], ['cast', 'flat', 'soft-light'], ['grain', 'tile', 'overlay'], ['tape', 'tile', 'soft-light'], ['vignette', 'gradient', 'normal'], ['leak', 'gradient', 'screen'],
    ]);
    const grain = motion.overlays.find((layer) => layer.key === 'grain');
    expect(grain).toMatchObject({ opacity: 0.6, size: [256, 256] });
    expect(decodeURIComponent(grain.image)).toContain('<feTurbulence type="fractalNoise"');
    expect(decodeURIComponent(grain.image)).toContain('stitchTiles="stitch"');
    expect(motion.overlays.find((layer) => layer.key === 'cast')).toMatchObject({ color: '#b9c04a', opacity: 0.2 });
    expect(motion.overlays.find((layer) => layer.key === 'tape')).toMatchObject({ opacity: 0.4, size: [390, 128] });
    expect(motion.overlays.find((layer) => layer.key === 'vignette').gradient).toContain('rgba(0,0,0,0.4) 100%');
    // The tone transfer matches the render's: brightness(b) then contrast(k) = slope·v + intercept.
    const [, b, k] = /brightness\(([\d.]+)\) contrast\(([\d.]+)\)/.exec(motion.filter).map(Number);
    const c = 1 - 0.2 * 0.8; const s = 1 - 0.28 * 0.3;
    expect(b * k).toBeCloseTo(c * s, 3);
    expect((1 - k) / 2).toBeCloseTo(s * ((1 - c) / 2) + 0.2 * 0.3, 3);
    // Frames shift the tiles and drift the leak; the tile images stay the same, so they rasterize once.
    const next = filmLookMotionLayers(look, { frame: 13, width: 390, height: 219 });
    const grainNext = next.overlays.find((layer) => layer.key === 'grain');
    expect(grainNext.shift).not.toEqual(grain.shift);
    expect(grainNext.image).toBe(grain.image);
    expect(next.transform).not.toBe(motion.transform);
    expect(filmLookMotionLayers(look, { frame: 12, width: 390, height: 219 })).toEqual(motion);
  });

  it('carries only what a look uses, and is null for a neutral one', () => {
    const flat = filmLookMotionLayers({ saturation: -0.4 }, {});
    expect(flat).toEqual({ filter: 'saturate(0.6)', transform: null, overlays: [] });
    expect(filmLookMotionLayers({ grain: 0.3 }, {}).filter).toBeNull();
    expect(filmLookMotionLayers(filmLookPreset('none'), {})).toBeNull();
    expect(filmLookMotionLayers(null)).toBeNull();
  });
});

// Uniquely catches a weave/flicker speed that re-times the picture instead of
// reshaping its drift, a saved look changing when it predates the speeds, and
// the cheap playing layers drifting at a different speed from the exact filter.
describe('continuous film motion speed', () => {
  const offset = (look, frame) => /<feOffset [^>]*dx="([^"]+)" dy="([^"]+)"/.exec(filmLookFilterMarkup(normalizeFilmLook(look), { frame }).filter).slice(1);
  const slope = (look, frame) => /slope="([^"]+)"/.exec(filmLookFilterMarkup(normalizeFilmLook(look), { frame }).filter)[1];

  it('keeps a look saved before the speeds drawing what it always drew', () => {
    // Pinned from the renderer before the speed controls existed.
    expect(offset({ weave: 0.4 }, 7)).toEqual(['2.1564', '-0.4225']);
    expect(slope({ flicker: 0.5 }, 7)).toBe('1.0406');
    expect(normalizeFilmLook({ weave: 0.4 })).toMatchObject({ weaveRate: 1, flickerRate: 1 });
  });

  it('scales time, not the song: half speed reaches frame n\'s drift on frame 2n, in the filter and the playing layers', () => {
    expect(offset({ weave: 0.4, weaveRate: 0.5 }, 20)).toEqual(offset({ weave: 0.4 }, 10));
    expect(offset({ weave: 0.4, weaveRate: 2 }, 5)).toEqual(offset({ weave: 0.4 }, 10));
    expect(filmLookMotionLayers({ weave: 0.4, weaveRate: 0.5 }, { frame: 20 }).transform).toBe(filmLookMotionLayers({ weave: 0.4 }, { frame: 10 }).transform);
    // A slow flicker holds each frame's exposure at every other frame and glides between them.
    expect(slope({ flicker: 0.5, flickerRate: 0.5 }, 14)).toBe(slope({ flicker: 0.5 }, 7));
    const between = Number(slope({ flicker: 0.5, flickerRate: 0.5 }, 15));
    const [a, b] = [slope({ flicker: 0.5 }, 7), slope({ flicker: 0.5 }, 8)].map(Number).sort((x, y) => x - y);
    expect(between).toBeGreaterThanOrEqual(a);
    expect(between).toBeLessThanOrEqual(b);
    expect(filmLookMotionLayers({ flicker: 0.5, flickerRate: 0.5 }, { frame: 14 }).filter).toBe(filmLookMotionLayers({ flicker: 0.5 }, { frame: 7 }).filter);
  });

  it('is off at zero strength whatever the speed, keeps the speed through the strength slider, and bounds it at the schema', () => {
    expect(isFilmLookNeutral({ weaveRate: 3, flickerRate: 0.1 })).toBe(true);
    expect(filmLookFilterMarkup(normalizeFilmLook({ weave: 0, weaveRate: 2 })).active).toBe(false);
    expect(scaleFilmLook({ weave: 0.6, weaveRate: 0.5 }, 0.5)).toMatchObject({ weave: 0.3, weaveRate: 0.5 });
    expect(filmLookSchema.safeParse({ weave: 0.3, weaveRate: 0.6, flicker: 0.2, flickerRate: 0.5 }).success).toBe(true);
    expect(filmLookSchema.safeParse({ weaveRate: 0 }).success).toBe(false);
    expect(filmLookSchema.safeParse({ flickerRate: 2 }).success).toBe(false);
  });

  it('starts a home movie gently: slow weave and a breathing flicker, never a strobe', () => {
    const look = filmLookPreset('home-movie');
    expect(look.weave).toBeGreaterThan(0);
    expect(look.weaveRate).toBeLessThan(1);
    expect(look.flicker).toBeLessThanOrEqual(0.2);
    expect(look.flickerRate).toBeLessThan(1);
  });
});
