import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { FILM_LOOK_PRESETS, filmLookFilterMarkup, filmLookPreset } from './filmLook.js';
import { _filmLookGpuTestHooks, filmLookGpuRuntimeSource } from './filmLookGpu.js';

const { blurKernel, parseFilmLookFilter, turbulencePixel, turbulenceTables, needsSmpte170mConversion } = _filmLookGpuTestHooks;

// Bytes headless Chromium 141 drew for a lone <feTurbulence> (64×48, sRGB,
// userSpaceOnUse), read back from an unpremultiplied PNG screenshot over a
// transparent page: [x, y, [r, g, b, a]].
const CHROME_TURBULENCE = [
  { seed: 41, baseFrequency: [0.8938, 0.8938], numOctaves: 2, fractal: true,
    samples: [[0, 0, [117, 123, 138, 126]], [1, 0, [131, 142, 108, 111]], [7, 3, [71, 131, 131, 111]], [31, 17, [151, 164, 142, 154]], [63, 47, [101, 95, 154, 147]], [20, 40, [112, 108, 112, 166]]] },
  { seed: 5, baseFrequency: [0.05, 0.05], numOctaves: 2, fractal: true,
    samples: [[0, 0, [146, 114, 143, 112]], [1, 0, [161, 109, 156, 108]], [7, 3, [218, 84, 183, 103]], [31, 17, [147, 90, 144, 193]], [63, 47, [174, 161, 156, 95]], [20, 40, [134, 125, 123, 118]]] },
  { seed: 281, baseFrequency: [0.0015, 0.45], numOctaves: 1, fractal: true,
    samples: [[0, 0, [114, 86, 175, 134]], [1, 0, [114, 86, 175, 134]], [7, 3, [140, 115, 125, 118]], [31, 17, [143, 143, 143, 116]], [63, 47, [128, 184, 150, 136]], [20, 40, [132, 177, 84, 85]]] },
  { seed: 9, baseFrequency: [0.1, 0.07], numOctaves: 3, fractal: false,
    samples: [[0, 0, [96, 21, 35, 96]], [1, 0, [112, 17, 63, 137]], [7, 3, [98, 51, 24, 130]], [31, 17, [158, 16, 77, 63]], [63, 47, [70, 21, 44, 87]], [20, 40, [17, 73, 65, 59]]] },
];

describe('film look on the GPU', () => {
  it('corrects only the measured NV12 SMPTE170M primary contract', () => {
    const colorSpace = { primaries: 'smpte170m', matrix: 'smpte170m', transfer: 'bt709', fullRange: false };
    expect(needsSmpte170mConversion({ format: 'NV12', colorSpace })).toBe(true);
    for (const frame of [undefined, {}, { format: 'NV12' },
      ...['I420', 'RGBA', null].map(format => ({ format, colorSpace })),
      ...[{ primaries: 'bt709' }, { matrix: 'bt709' }, { transfer: 'smpte170m' }, { fullRange: true }, { fullRange: null }]
        .map(patch => ({ format: 'NV12', colorSpace: { ...colorSpace, ...patch } })),
    ]) expect(needsSmpte170mConversion(frame)).toBe(false);
  });

  it('reproduces the feTurbulence pixels Chrome draws for a seed, not just their statistics', () => {
    for (const { seed, samples, ...options } of CHROME_TURBULENCE) {
      const tables = turbulenceTables(seed);
      for (const [x, y, [r, g, b, a]] of samples) {
        const [pr, pg, pb, pa] = turbulencePixel(tables, x, y, options).map((value) => Math.round(value * 255));
        expect(Math.abs(pa - a), `seed ${seed} alpha @${x},${y}`).toBeLessThanOrEqual(1);
        // The PNG is unpremultiplied; compare in Chrome's premultiplied space.
        for (const [mine, theirs] of [[pr, r], [pg, g], [pb, b]]) {
          expect(Math.abs(mine - Math.round(theirs * a / 255)), `seed ${seed} @${x},${y}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('matches Chrome small-blur impulse pixels and keeps normalized large-blur box sums', () => {
    expect(blurKernel(0)).toBeNull();
    expect(blurKernel(0.03)).toBeNull();
    // Chrome 155 SVG: a white one-pixel column over black, sampled across its
    // centre after feGaussianBlur stdDeviation="sigma 0", using the hardware
    // compositor. Software compositing below instead uses the raster boxes.
    for (const [sigma, bytes] of [
      [0.7361, [0, 3, 55, 139, 55, 3, 0]],
      [0.9276, [1, 11, 61, 110, 61, 11, 1]],
    ]) {
      const kernel = blurKernel(sigma);
      expect(kernel.origin).toBe(3);
      expect(kernel.weights).toHaveLength(bytes.length);
      kernel.weights.forEach((weight, i) => expect(Math.abs(Math.round(weight * 255) - bytes[i])).toBeLessThanOrEqual(1));
    }
    expect(blurKernel(0.7361, 'box')).toBeNull();
    expect(Array.from(blurKernel(0.9276, 'box').weights, w => Math.round(w * 255))).toEqual([21, 64, 85, 64, 21]);
    // σ 2.24 → d = 4: two boxes of 4 and one of 5, centred over 80.
    const box = blurKernel(2.24, 'box');
    expect(box.divisor).toBe(80);
    expect(Array.from(box.weights, (w) => Math.round(w * 80))).toEqual([1, 3, 6, 10, 13, 14, 13, 10, 6, 3, 1]);
    expect(box.origin).toBe(5);
    for (const sigma of [3.1378, 20.46, 43.648, 110.484]) {
      const { weights, origin, boxes } = blurKernel(sigma, 'box');
      expect(weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 5);
      expect(origin * 2 + 1).toBe(weights.length);
      expect(boxes.reduce((sum, [lo]) => sum + lo, 0)).toBe(-origin);
      // The hardware compositor stays a sampled Gaussian at every sigma (a 36 px blur measured 4 dB closer than boxes).
      const sampled = blurKernel(sigma);
      expect(sampled.boxes).toBeUndefined();
      expect(sampled.weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 5);
    }
  });

  it('reads back every primitive of every preset and refuses a filter it cannot draw', () => {
    for (const { id } of FILM_LOOK_PRESETS) {
      const { filter } = filmLookFilterMarkup(filmLookPreset(id), { frame: 12, width: 1364, height: 768 });
      const primitives = parseFilmLookFilter(filter);
      expect(primitives.length, id).toBe((filter.match(/<fe(?!Func)[A-Za-z]+/g) || []).length);
    }
    const transfer = parseFilmLookFilter(filmLookFilterMarkup({ fade: 0.5 }, { frame: 0 }).filter).find((p) => p.type === 'feComponentTransfer');
    expect(Object.keys(transfer.funcs)).toEqual(['R', 'G', 'B']);
    expect(() => parseFilmLookFilter('<filter id="f" color-interpolation-filters="linearRGB"></filter>')).toThrow(/unsupported/);
  });

  it('inlines a self-contained runtime', () => {
    const window = {};
    runInNewContext(filmLookGpuRuntimeSource(), { globalThis: window, document: { createElement: () => ({ getContext: () => null }) } });
    expect(window.__portosFilmLookGpu.available()).toBe(false);
    expect(() => window.__portosFilmLookGpu.create({ getContext: () => null })).toThrow(/WebGL2/);
  });

  it('refuses an unknown blur response before allocating shader resources', () => {
    const window = {};
    let lost = false;
    const context = { filter: 'none', fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8Array(28) }) };
    runInNewContext(filmLookGpuRuntimeSource(), { globalThis: window,
      document: { createElement: () => ({ getContext: () => context }) } });
    const gl = { getExtension: name => name === 'EXT_color_buffer_float' ? {} : { loseContext: () => { lost = true; } } };
    expect(() => window.__portosFilmLookGpu.create({ getContext: () => gl })).toThrow(/keep the SVG film look/);
    expect(lost).toBe(true);
  });
});
