/**
 * Describe a pixel canvas as the aspect ratio a human (or an image model) reads
 * it as — "2:3 portrait", "5:7 portrait", "16:9 landscape", "1:1 square".
 *
 * Exists so a prompt that tells a model what shape to draw can be DERIVED from
 * the canvas it will be rendered onto, rather than restated beside it. A
 * hand-written ratio phrase is a second copy of the canvas size, and the two
 * drift the moment one of them is tuned: the deck layout prompts said "2:3
 * portrait" for months after the per-kind canvases moved to the true card trims
 * (1096x1536 and 888x1536), so every card was asked for one framing and
 * rendered at another.
 *
 * The reduction is a best rational approximation (continued fractions) bounded
 * to small whole numbers, not a plain GCD: 1096:1536 reduces exactly to
 * 137:192, which is arithmetically right and useless as a phrase. Bounded, it
 * lands on 5:7 — the poker-card trim the canvas was chosen to approximate.
 * A canvas that already reduces small (1024:1536) still reports its exact
 * ratio, because the exact convergent is reached before the bound.
 *
 * Pure.
 */

// Largest value either side of the ratio may take. 24 is above every ratio a
// real print/screen format uses (2:3, 5:7, 11:19, 16:9, 4:3, 21:9) and below
// the point where a ratio stops reading as a shape.
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

  // Continued-fraction expansion of width/height, keeping the last convergent
  // whose terms both fit the bound. `previous` is the convergent before it, as
  // the recurrence needs both. The seeds are the standard 1/0 and 0/1.
  let value = width / height;
  let previous = { width: 0, height: 1 };
  let best = { width: 1, height: 0 };

  // 40 terms is far past the point where a double's precision is meaningful;
  // the bound below almost always ends the walk within a handful.
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
    // An exact convergent — no remainder left to expand.
    if (remainder <= Number.EPSILON) break;
    value = 1 / remainder;
  }

  // Only reachable when the first convergent already exceeds the bound (an
  // extreme banner like 4096x64); fall back to the exact reduced ratio rather
  // than reporting nothing.
  if (best.width < 1 || best.height < 1) {
    const divisor = greatestCommonDivisor(Math.round(width), Math.round(height));
    return { width: Math.round(width) / divisor, height: Math.round(height) / divisor };
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
 * The ratio phrase for a canvas — `"5:7 portrait"`, `"16:9 landscape"`,
 * `"1:1 square"`. Empty string for a canvas that cannot be described, so a
 * caller interpolating it into a prompt degrades to saying nothing about
 * framing rather than to saying something false.
 */
export function aspectRatioPhrase(width, height, options) {
  const terms = aspectRatioTerms(width, height, options);
  if (!terms) return '';
  const orientation = terms.width === terms.height ? 'square'
    : terms.width < terms.height ? 'portrait'
      : 'landscape';
  return `${terms.width}:${terms.height} ${orientation}`;
}
