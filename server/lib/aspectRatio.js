/**
 * Describe a pixel canvas as the ratio phrase a prompt can use: `aspectRatioTerms(w, h)` and `aspectRatioPhrase(w,
 * h)` → `"5:7 portrait"` / `"16:9 landscape"` / `"1:1 square"`.
 *
 * Derive prompt framing from the canvas with this rather than restating it, so the two cannot drift. Pure.
 *
 * The reduction is a bounded continued-fraction approximation, not a plain GCD:
 * 1096:1536 reduces exactly to 137:192, useless as a phrase; bounded it lands on 5:7.
 */

// Largest value either side of the ratio may take: above every real print/screen
// format (2:3, 5:7, 11:19, 16:9, 4:3, 21:9), below where a ratio stops reading as a shape.
const DEFAULT_MAX_TERM = 24;

const isPositiveSize = (value) => Number.isFinite(value) && value > 0;

/**
 * The smallest whole-number ratio within `maxTerm` that describes `width:height`.
 * Returns `null` for a non-positive or non-finite edge.
 *
 * @returns {{ width: number, height: number }|null}
 */
export function aspectRatioTerms(width, height, { maxTerm = DEFAULT_MAX_TERM } = {}) {
  if (!isPositiveSize(width) || !isPositiveSize(height)) return null;

  // Continued-fraction expansion; keeps the last convergent whose terms both fit the
  // bound. Seeds are the standard 1/0 and 0/1.
  let value = width / height;
  let previous = { width: 0, height: 1 };
  let best = { width: 1, height: 0 };

  // 40 terms exceeds a double's useful precision; the bound ends the walk far sooner.
  for (let step = 0; step < 40; step += 1) {
    const whole = Math.floor(value);
    const next = {
      width: whole * best.width + previous.width,
      height: whole * best.height + previous.height,
    };
    if (next.width > maxTerm || next.height > maxTerm) break;
    previous = best;
    best = next;
    const remainder = value - whole;
    if (remainder <= Number.EPSILON) break;
    value = 1 / remainder;
  }

  // First convergent already exceeds the bound (e.g. 4096x64): use the exact reduced ratio.
  if (best.width < 1 || best.height < 1) {
    const roundedWidth = Math.round(width);
    const roundedHeight = Math.round(height);
    // A sub-pixel edge rounds to zero and `0:0` would read as a SQUARE, which is false.
    if (roundedWidth < 1 || roundedHeight < 1) return null;
    const divisor = greatestCommonDivisor(roundedWidth, roundedHeight);
    return { width: roundedWidth / divisor, height: roundedHeight / divisor };
  }
  return best;
}

function greatestCommonDivisor(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

/**
 * The ratio phrase for a canvas. Empty string when it cannot be described, so an
 * interpolating prompt says nothing about framing rather than something false.
 */
export function aspectRatioPhrase(width, height, options) {
  const terms = aspectRatioTerms(width, height, options);
  if (!terms) return '';
  const orientation = terms.width === terms.height ? 'square'
    : terms.width < terms.height ? 'portrait'
      : 'landscape';
  return `${terms.width}:${terms.height} ${orientation}`;
}
