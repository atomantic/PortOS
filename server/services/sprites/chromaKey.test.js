import { describe, it, expect } from 'vitest';
import {
  CHROMA_KEYS, CHROMA_KEY_HEXES, MIN_HUE_SEPARATION,
  rgbToHsv, hueDistance, pickChromaKey, keyProximityWarning,
  keyChannelSplit, keyShareFn,
} from './chromaKey.js';

describe('chroma key set', () => {
  it('is exactly the three standard keys', () => {
    expect(CHROMA_KEY_HEXES).toEqual(['#FF00FF', '#00FF00', '#0000FF']);
  });

  it('key hues match their RGB definitions', () => {
    for (const key of CHROMA_KEYS) {
      const n = parseInt(key.hex.slice(1), 16);
      const { h, s, v } = rgbToHsv((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
      expect(Math.round(h)).toBe(key.hue);
      expect(s).toBe(1);
      expect(v).toBe(1);
    }
  });
});

describe('hueDistance', () => {
  it('wraps around the circle', () => {
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(0, 180)).toBe(180);
    expect(hueDistance(120, 120)).toBe(0);
  });
});

describe('pickChromaKey', () => {
  const solid = (r, g, b, count = 1000) => ({ r, g, b, count });

  it('keeps magenta for a green-clothed character (the legacy Pioneer case)', () => {
    const pick = pickChromaKey([
      solid(23, 107, 101),  // teal jacket
      solid(34, 139, 34),   // green trim
      solid(185, 120, 69),  // skin
    ]);
    expect(pick.hex).toBe('#FF00FF');
    expect(pick.warning).toBeNull();
  });

  it('moves off magenta for a pink/magenta character', () => {
    const pick = pickChromaKey([
      solid(255, 0, 255),   // magenta outfit
      solid(255, 105, 180), // pink accents
    ]);
    expect(pick.hex).toBe('#00FF00'); // green is 180° from magenta
    expect(pick.minHueDistance).toBeGreaterThanOrEqual(MIN_HUE_SEPARATION);
  });

  it('avoids green for a green character even when magenta also conflicts a little', () => {
    const pick = pickChromaKey([solid(0, 255, 0)]);
    expect(pick.hex).not.toBe('#00FF00');
  });

  it('ignores achromatic palettes (grays have no meaningful hue) and defaults to magenta', () => {
    const pick = pickChromaKey([solid(40, 40, 40), solid(200, 200, 200), solid(120, 122, 121)]);
    expect(pick.hex).toBe('#FF00FF');
    expect(pick.minHueDistance).toBe(Infinity);
    expect(pick.warning).toBeNull();
  });

  it('ignores single-pixel noise below the count floor', () => {
    const pick = pickChromaKey([
      solid(23, 107, 101, 100000), // real green clothing
      solid(255, 0, 255, 3),       // 3 stray magenta pixels
    ]);
    expect(pick.hex).toBe('#FF00FF');
  });

  it('warns when every key sits near some palette hue', () => {
    const pick = pickChromaKey([
      solid(255, 0, 255), // magenta
      solid(0, 255, 0),   // green
      solid(0, 0, 255),   // blue
    ]);
    expect(pick.warning).toMatch(/keying may clip/);
    expect(pick.minHueDistance).toBeLessThan(MIN_HUE_SEPARATION);
  });

  it('handles an empty palette', () => {
    const pick = pickChromaKey([]);
    expect(pick.hex).toBe('#FF00FF');
    expect(pick.warning).toBeNull();
  });
});

describe('keyProximityWarning', () => {
  const solid = (r, g, b, count = 1000) => ({ r, g, b, count });

  it('warns when surviving palette hues sit near the generation key', () => {
    const warning = keyProximityWarning([solid(255, 80, 230)], '#FF00FF'); // pink near magenta
    expect(warning).toMatch(/generation key #FF00FF/);
  });

  it('stays quiet for a palette far from the generation key', () => {
    expect(keyProximityWarning([solid(23, 107, 101)], '#FF00FF')).toBeNull(); // teal vs magenta
  });

  it('stays quiet for achromatic/empty palettes', () => {
    expect(keyProximityWarning([solid(40, 40, 40)], '#FF00FF')).toBeNull();
    expect(keyProximityWarning([], '#FF00FF')).toBeNull();
  });
});

describe('keyShareFn', () => {
  const magenta = [255, 0, 255];
  const split = keyChannelSplit('#FF00FF'); // highs r+b, low g

  it('scores a pure key pixel 1 and a pixel unlike the key 0', () => {
    const share = keyShareFn(magenta, split);
    expect(share(magenta)).toBe(1);       // exact key
    expect(share([0, 255, 0])).toBe(0);   // pure green — opposite of magenta
  });

  it('scores an anti-aliased blend by its key weight', () => {
    const share = keyShareFn(magenta, split);
    // 0.8·magenta + 0.2·green = (204,51,204): min((204-51)/255) = 0.6.
    expect(share([204, 51, 204])).toBeCloseTo(0.6, 5);
  });

  it('reads from a flat buffer at an arbitrary base offset', () => {
    const share = keyShareFn(magenta, split);
    const buf = [0, 0, 0, 204, 51, 204]; // key blend at pixel index 1
    expect(share(buf, 3)).toBeCloseTo(0.6, 5);
  });
});
