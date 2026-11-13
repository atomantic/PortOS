// Shared deterministic vector, matrix and easing helpers. Everything is a pure function of its inputs: no clocks, no Math.random.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, k) => a + (b - a) * k;
export const seg = (t, a, b) => (b > a ? clamp((t - a) / (b - a)) : (t >= b ? 1 : 0));
export const smooth = (k) => k * k * (3 - 2 * k);
export const smoother = (k) => k * k * k * (k * (6 * k - 15) + 10);
export const easeOut = (k, p = 3) => 1 - Math.pow(1 - k, p);
export const easeIn = (k, p = 3) => Math.pow(k, p);
export const easeInOut = (k, p = 3) => (k < 0.5 ? Math.pow(2 * k, p) / 2 : 1 - Math.pow(2 - 2 * k, p) / 2);
export const overshoot = (k, s = 1.7) => { const u = k - 1; return u * u * ((s + 1) * u + s) + 1; };
export const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

// Deterministic noise.
export const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123; return x - Math.floor(x); };
export const hash2 = (a, b) => hash(a * 57.31 + b * 113.97 + 0.137);
export function rng(seed) {
  let s = (Math.floor(seed) >>> 0) || 1;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash2(ix + seed * 31.7, iy), b = hash2(ix + 1 + seed * 31.7, iy), c = hash2(ix + seed * 31.7, iy + 1), d = hash2(ix + 1 + seed * 31.7, iy + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy) * 2 - 1;
}

// Vectors (arrays of 3).
export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
export const dist = (a, b) => len(sub(a, b));

// 3x3 matrices, row-major arrays of 9. A frame's matrix has the local axes as its columns.
export const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };
export const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
export const rotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
export function mul(A, B) {
  const out = new Array(9);
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return out;
}
export const mulAll = (...ms) => ms.reduce((a, b) => mul(a, b));
export const apply = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
export const transpose = (M) => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
export const col = (M, i) => [M[i], M[3 + i], M[6 + i]];
export const fromCols = (x, y, z) => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
/** A frame whose Y axis runs along `dir`, with Z kept as close to `forward` as it can be. */
export function frameAlong(dir, forward = [0, 0, 1]) {
  const y = norm(dir);
  let x = cross(y, forward);
  if (len(x) < 1e-5) x = cross(y, [1, 0, 0]);
  x = norm(x);
  const z = cross(x, y);
  return fromCols(x, y, z);
}

// A frame: origin + rotation. `at` maps a local point to the world.
export const frame = (o, R) => ({ o, R });
export const at = (f, p) => add(f.o, apply(f.R, p));
export const child = (f, offset, R = I3) => ({ o: at(f, offset), R: mul(f.R, R) });

/** Time held on `on` frames at `fps` (animation "on twos"), counted from `origin`. */
export function stepped(t, fps = 24, on = 2, origin = 0) {
  const step = on / fps;
  return origin + Math.floor((t - origin) / step + 1e-4) * step;
}

/** Piecewise track: keys [[t, value, ease?], ...]; values are numbers or equal-length arrays. */
export function track(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  let i = 1;
  while (keys[i][0] < t) i += 1;
  const [t0, a] = keys[i - 1];
  const [t1, b, ease] = keys[i];
  let k = (t - t0) / (t1 - t0);
  if (ease === 'hold') k = 0;
  else if (ease === 'linear') k = k;
  else if (ease === 'in') k = easeIn(k, 2);
  else if (ease === 'out') k = easeOut(k, 2);
  else if (ease === 'back') k = overshoot(k);
  else k = smooth(k);
  return Array.isArray(a) ? a.map((v, j) => v + (b[j] - v) * k) : a + (b - a) * k;
}

export const hex = (value) => { const n = parseInt(value.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const rgb = (c, alpha = 1) => (alpha >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`);
export const mixHex = (a, b, k) => rgb(mix(hex(a), hex(b), k));
