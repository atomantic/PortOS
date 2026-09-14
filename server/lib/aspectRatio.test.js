import { describe, it, expect } from 'vitest';
import { aspectRatioPhrase, aspectRatioTerms } from './aspectRatio.js';

describe('aspectRatioTerms', () => {
  it('reads a canvas as the small ratio it approximates, not its exact reduction', () => {
    // The reason this is a continued-fraction approximation rather than a GCD:
    // both deck canvases reduce exactly to numbers nobody can read as a shape
    // (137:192 and 37:64), while the trims they were chosen for are 5:7 and
    // 11:19. A phrase built from the exact reduction would be arithmetically
    // right and useless in a prompt.
    expect(aspectRatioTerms(1096, 1536)).toEqual({ width: 5, height: 7 });
    expect(aspectRatioTerms(888, 1536)).toEqual({ width: 11, height: 19 });
  });

  it('reports an exactly-reducible canvas exactly', () => {
    // The bound only ever stops the walk EARLY, so a ratio that is already
    // small must survive it untouched — otherwise approximating would be a
    // silent rounding of sizes that never needed it.
    expect(aspectRatioTerms(1024, 1536)).toEqual({ width: 2, height: 3 });
    expect(aspectRatioTerms(1920, 1080)).toEqual({ width: 16, height: 9 });
    expect(aspectRatioTerms(1024, 1024)).toEqual({ width: 1, height: 1 });
  });

  it('falls back to the exact reduction when the first convergent already exceeds the bound', () => {
    // An extreme banner has no small approximation at all. Reporting its true
    // ratio beats reporting nothing, since the caller interpolates the result
    // into a prompt.
    expect(aspectRatioTerms(4096, 64)).toEqual({ width: 64, height: 1 });
  });

  it('returns null rather than 0:0 when a sub-pixel edge has no describable ratio', () => {
    // The fallback rounds to whole pixels, so a canvas narrower than half a pixel
    // rounded to zero on both edges and reported `0:0` — which aspectRatioPhrase
    // then called a SQUARE. Wrong is worse than silent for a phrase that goes
    // into a render prompt.
    expect(aspectRatioTerms(0.3, 0.01)).toBeNull();
    expect(aspectRatioPhrase(0.3, 0.01)).toBe('');
  });

  it('returns null for a canvas that cannot be described', () => {
    expect(aspectRatioTerms(0, 1536)).toBeNull();
    expect(aspectRatioTerms(1024, 0)).toBeNull();
    expect(aspectRatioTerms(Number.NaN, 1536)).toBeNull();
    expect(aspectRatioTerms(undefined, undefined)).toBeNull();
  });
});

describe('aspectRatioPhrase', () => {
  it('names the orientation the ratio implies', () => {
    expect(aspectRatioPhrase(1096, 1536)).toBe('5:7 portrait');
    expect(aspectRatioPhrase(1920, 1080)).toBe('16:9 landscape');
    expect(aspectRatioPhrase(1024, 1024)).toBe('1:1 square');
  });

  it('says nothing rather than something false about an undescribable canvas', () => {
    // A caller interpolating this into a prompt drops the framing clause; it
    // must never emit a ratio built from a missing or zero edge.
    expect(aspectRatioPhrase(0, 1536)).toBe('');
    expect(aspectRatioPhrase(null, null)).toBe('');
  });
});
