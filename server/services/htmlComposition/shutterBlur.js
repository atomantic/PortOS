// Shutter motion blur for HTML compositions (#9077): average sub-frames spread
// over a centred fraction of the frame interval, in linear light, optionally
// refining the sample set until the average stops changing.

// 'auto' refines 1 → 3 → 9 → 27 → 81. Tripling keeps every earlier sample: the
// centre of each third of a stratum is that stratum's own centre, so a level
// only renders the 2n new offsets. 81 stays under the issue's 108 cap.
const AUTO_MAX_SAMPLES = 81;
const BLOCK = 8;

/** Offsets, as fractions of the shutter, of `n` stratified samples centred on 0. */
const shutterOffsets = n => Array.from({ length: n }, (_, k) => (k + 0.5) / n - 0.5);

/** The offsets a refinement from `n` to `3n` samples adds (the old ones are reused). */
const refinementOffsets = n => shutterOffsets(3 * n).filter((_, k) => k % 3 !== 1);

const TO_LINEAR = Float32Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const LINEAR_STEPS = 4096;
const TO_SRGB = Uint8Array.from({ length: LINEAR_STEPS + 1 }, (_, i) => {
  const c = i / LINEAR_STEPS;
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
});

/** A linear-light running sum over packed 8-bit sRGB frames of one size. */
function createAccumulator(length) {
  const sum = new Float32Array(length);
  let count = 0;
  return {
    get count() { return count; },
    add(rgb) {
      if (rgb.length !== length) throw new Error('Sub-frame size changed mid-frame');
      for (let i = 0; i < length; i++) sum[i] += TO_LINEAR[rgb[i]];
      count++;
    },
    average() {
      const out = Buffer.allocUnsafe(length);
      const scale = LINEAR_STEPS / count;
      for (let i = 0; i < length; i++) out[i] = TO_SRGB[Math.min(LINEAR_STEPS, Math.round(sum[i] * scale))];
      return out;
    },
  };
}

/**
 * Worst 8×8 block's mean absolute difference between two packed RGB frames, in
 * 0–255 levels. A block mean ignores single-pixel dither yet still catches a
 * small moving object that a whole-frame mean would dilute away.
 */
function worstBlockDifference(a, b, width, height) {
  let worst = 0;
  for (let by = 0; by < height; by += BLOCK) {
    for (let bx = 0; bx < width; bx += BLOCK) {
      let total = 0;
      let n = 0;
      for (let y = by; y < Math.min(by + BLOCK, height); y++) {
        for (let i = (y * width + bx) * 3, end = (y * width + Math.min(bx + BLOCK, width)) * 3; i < end; i++) {
          total += Math.abs(a[i] - b[i]);
          n++;
        }
      }
      worst = Math.max(worst, total / n);
    }
  }
  return worst;
}

/**
 * Render one output frame. `sample(offset)` resolves the packed RGB sub-frame
 * at `offset` shutter-fractions from the frame centre. Fixed mode averages
 * `samples` strata; auto starts from the centre and triples until successive
 * averages differ by less than `tolerance`. Resolves `{ rgb, count }`.
 */
export async function blurFrame({ samples, tolerance }, width, height, sample, centre) {
  const acc = createAccumulator(width * height * 3);
  if (samples !== 'auto') {
    for (const offset of shutterOffsets(samples)) acc.add(await sample(offset));
    return { rgb: acc.average(), count: acc.count };
  }
  acc.add(centre ?? await sample(0));
  let previous = acc.average();
  while (acc.count < AUTO_MAX_SAMPLES) {
    for (const offset of refinementOffsets(acc.count)) acc.add(await sample(offset));
    const next = acc.average();
    const converged = worstBlockDifference(previous, next, width, height) < tolerance;
    previous = next;
    if (converged) break;
  }
  return { rgb: previous, count: acc.count };
}
