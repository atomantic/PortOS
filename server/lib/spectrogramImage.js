/**
 * Spectrogram picture of PCM audio — an RGB pixel buffer on a log-frequency
 * axis, for handing a model an image of what its painted canvas (#8464)
 * actually sounds like. Pure: returns raw pixels; the caller encodes them
 * (musicWaveform.js uses sharp).
 *
 *   spectrogramPixels(pcm, { sampleRate, width, height, minHz, maxHz })
 *     → { width, height, pixels: Uint8Array(width × height × 3) }
 *
 * Time runs left → right, frequency bottom → top (log), and brightness is
 * the level in dB over a fixed 80 dB range below the loudest cell.
 */

const FFT_SIZE = 2048;
const DB_RANGE = 80;

/** In-place iterative radix-2 FFT over separate real/imag arrays. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

// Dark → violet → orange → pale yellow, readable by a vision model at a glance.
const STOPS = [[0, 0, 4], [87, 16, 110], [188, 55, 84], [249, 142, 9], [252, 255, 164]];
function colorAt(v) {
  const x = Math.min(1, Math.max(0, v)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  return STOPS[i].map((c, k) => Math.round(c + (STOPS[i + 1][k] - c) * f));
}

export function spectrogramPixels(pcm, {
  sampleRate = 44100, width = 1024, height = 384, minHz = 20, maxHz = 16000,
} = {}) {
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  const bins = FFT_SIZE / 2;
  // Row → fractional FFT bin on the log axis (row 0 is the top = maxHz).
  const rowBin = Array.from({ length: height }, (_, row) => {
    const hz = minHz * (maxHz / minHz) ** (1 - row / Math.max(1, height - 1));
    return Math.min(bins - 1, (hz / sampleRate) * FFT_SIZE);
  });
  const levels = new Float32Array(width * height);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const mags = new Float64Array(bins);
  let loudest = -Infinity;
  for (let col = 0; col < width; col += 1) {
    const centre = Math.floor(((col + 0.5) / width) * pcm.length);
    const start = centre - FFT_SIZE / 2;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const s = start + i;
      re[i] = s >= 0 && s < pcm.length ? pcm[s] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k += 1) mags[k] = Math.hypot(re[k], im[k]);
    for (let row = 0; row < height; row += 1) {
      const x = rowBin[row];
      const k = Math.floor(x);
      const mag = mags[k] + ((mags[k + 1] ?? mags[k]) - mags[k]) * (x - k);
      const db = 20 * Math.log10(mag + 1e-9);
      levels[row * width + col] = db;
      if (db > loudest) loudest = db;
    }
  }
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < levels.length; i += 1) {
    const [r, g, b] = colorAt(1 - (loudest - levels[i]) / DB_RANGE);
    pixels[i * 3] = r;
    pixels[i * 3 + 1] = g;
    pixels[i * 3 + 2] = b;
  }
  return { width, height, pixels };
}
