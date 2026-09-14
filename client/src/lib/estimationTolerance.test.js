import { describe, expect, it } from 'vitest';

import { estimationToleranceText } from './estimationTolerance.js';

// Rounding a value to `n` significant figures must never push it outside the
// band the copy claims — and `n - 1` figures must genuinely miss it, or the
// drill is demanding more precision than it says.
const roundToSigFigs = (value, figures) => {
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(value))) - figures + 1);
  return Math.round(value / magnitude) * magnitude;
};

const figuresClaimedBy = (text) => Number(text.match(/(\d+) significant figure/)[1]);

describe('estimationToleranceText', () => {
  it('states the grading rule and the precision it implies', () => {
    expect(estimationToleranceText(10)).toBe('Within 10% counts — 2 significant figures is close enough');
  });

  it('singularizes a one-figure target', () => {
    expect(estimationToleranceText(50)).toBe('Within 50% counts — 1 significant figure is close enough');
  });

  it.each([
    [50, 1], // the 1↔2 boundary: 1 sig fig is worst-case 50% off
    [20, 2],
    [5, 2], // the 2↔3 boundary: 2 sig figs is worst-case 5% off
    [3, 3],
  ])('%i%% tolerance claims %i significant figure(s)', (tolerancePct, expected) => {
    expect(figuresClaimedBy(estimationToleranceText(tolerancePct))).toBe(expected);
  });

  it.each([50, 20, 10, 5, 3, 1])('the figures claimed for a %i%% band are exactly enough', (tolerancePct) => {
    const figures = figuresClaimedBy(estimationToleranceText(tolerancePct));
    const band = (value) => Math.abs(value * (tolerancePct / 100));

    // Scale-free: one value near 1, one large, both just past a rounding
    // midpoint where the relative error of rounding is worst.
    for (const value of [1 + Math.pow(10, 1 - figures) / 2, 285825]) {
      expect(Math.abs(roundToSigFigs(value, figures) - value)).toBeLessThanOrEqual(band(value));
    }

    if (figures > 1) {
      const tooCoarse = figures - 1;
      const value = 1 + Math.pow(10, 1 - tooCoarse) / 2;
      expect(Math.abs(roundToSigFigs(value, tooCoarse) - value)).toBeGreaterThan(band(value));
    }
  });

  it('falls back to the shipped 10% band when the drill carried no usable tolerance', () => {
    // A drill generated without an explicit tolerance omits the key, and both
    // graders default it to 10 — the copy has to say the same number.
    for (const value of [undefined, null, '', -5, NaN, 'wide']) {
      expect(estimationToleranceText(value)).toBe('Within 10% counts — 2 significant figures is close enough');
    }
  });

  it('honors a 0% band as exact match rather than reading it as unset', () => {
    // `resolveEstimationTolerancePct` is deliberately not a `|| DEFAULT`: a 0
    // tolerance means the server grades exact-match, so the copy must not
    // promise a 10% band the ✓/✗ will not honor.
    expect(estimationToleranceText(0)).toBe('Within 0% counts — 6 significant figures is close enough');
  });
});
