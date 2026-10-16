/**
 * Film look on the GPU — the same picture `filmLookFilterMarkup` (lib/filmLook.js)
 * describes, drawn with WebGL2 fragment shaders instead of Chrome's CPU SVG
 * filter, so the footage finishing pass costs milliseconds a frame instead of
 * seconds.
 *
 * It does not re-describe the look. The renderer builds the look's SVG filter
 * with the very function every other surface uses, parses the primitives back
 * out of it and runs each one as a pass, so a change to the look reaches this
 * path by construction and an unknown primitive refuses (the caller then keeps
 * the SVG path). Each pass follows what Chrome's Skia raster backend does, not
 * just the spec, as measured against headless Chrome: premultiplied
 * 8-bit intermediates; Gaussian blur below sigma 2 and a three-box
 * approximation above, reading past the frame as transparent even for
 * edgeMode="duplicate"; feOffset snapped to whole pixels (antialiased frame
 * edges when presented directly); feComposite arithmetic without clamping
 * color to alpha; Skia's feTurbulence (the spec's lattice and
 * gradients, permuted and stored as 16-bit, sampled half a pixel past the
 * pixel centre); and the result over the page's white base, where the filter
 * leaves alpha. `filmLookFinish.js` still compares a frame against the SVG
 * filter before trusting it.
 *
 * `filmLookGpuRuntimeSource()` is the browser source: it defines
 * `globalThis.__portosFilmLookGpu.create(canvas)`. Everything it inlines by
 * `toString()` must stay self-contained (no module scope, no imports).
 */

import { filmLookFilterMarkup } from './filmLook.js';

/**
 * Skia's feTurbulence tables for a seed: the spec's random lattice
 * (`setup`/`random` of SVG 1.1 §15.25) with the gradients permuted by the
 * lattice and rounded to 16 bits, as `SkPerlinNoiseShader::PaintingData`
 * builds them. `gradients` holds 4 channels × 256 (x, y) pairs.
 * SELF-CONTAINED (inlined into the page).
 */
function turbulenceTables(seedInput) {
  const RAND_M = 2147483647, RAND_A = 16807, RAND_Q = 127773, RAND_R = 2836;
  let seed = Math.trunc(Number(seedInput) || 0);
  if (seed <= 0) seed = -(seed % (RAND_M - 1)) + 1;
  if (seed > RAND_M - 1) seed = RAND_M - 1;
  const random = () => {
    let result = RAND_A * (seed % RAND_Q) - RAND_R * Math.trunc(seed / RAND_Q);
    if (result <= 0) result += RAND_M;
    seed = result;
    return result;
  };
  const lattice = new Uint8Array(256);
  const raw = new Int32Array(4 * 256 * 2);
  for (let channel = 0; channel < 4; channel++) {
    for (let i = 0; i < 256; i++) {
      lattice[i] = i;
      raw[(channel * 256 + i) * 2] = random() % 512;
      raw[(channel * 256 + i) * 2 + 1] = random() % 512;
    }
  }
  for (let i = 255; i > 0; i--) {
    const k = lattice[i];
    const j = random() % 256;
    lattice[i] = lattice[j];
    lattice[j] = k;
  }
  const f32 = Math.fround;
  const gradients = new Float32Array(4 * 256 * 2);
  for (let channel = 0; channel < 4; channel++) {
    for (let i = 0; i < 256; i++) {
      const at = (channel * 256 + lattice[i]) * 2;
      let x = f32((raw[at] - 256) / 256);
      let y = f32((raw[at + 1] - 256) / 256);
      const length = f32(Math.sqrt(x * x + y * y));
      if (length > 0) { x = f32(x / length); y = f32(y / length); }
      gradients[(channel * 256 + i) * 2] = Math.round((x + 1) * 32767.5) * (2 / 65535) - 1;
      gradients[(channel * 256 + i) * 2 + 1] = Math.round((y + 1) * 32767.5) * (2 / 65535) - 1;
    }
  }
  return { lattice, gradients };
}

/**
 * One feTurbulence pixel as Chrome draws it, on the CPU: premultiplied RGBA in
 * [0, 1] at pixel (x, y) of the filter region. The shader computes the same
 * thing; this is the reference the unit test pins against values Chrome drew.
 */
function turbulencePixel(tables, x, y, { baseFrequency = [0, 0], numOctaves = 1, fractal = true } = {}) {
  const { lattice, gradients } = tables;
  let nx = (x + 1) * baseFrequency[0];
  let ny = (y + 1) * baseFrequency[1];
  let ratio = 1;
  const sum = [0, 0, 0, 0];
  for (let octave = 0; octave < numOctaves; octave++) {
    const fx = Math.floor(nx), fy = Math.floor(ny);
    const rx = nx - fx, ry = ny - fy;
    const lx = lattice[fx & 255], ly = lattice[(fx + 1) & 255];
    const b00 = (lx + fy) & 255, b10 = (ly + fy) & 255, b01 = (lx + fy + 1) & 255, b11 = (ly + fy + 1) & 255;
    const sx = rx * rx * (3 - 2 * rx), sy = ry * ry * (3 - 2 * ry);
    for (let c = 0; c < 4; c++) {
      const g = (b) => [gradients[(c * 256 + b) * 2], gradients[(c * 256 + b) * 2 + 1]];
      const [g00x, g00y] = g(b00); const [g10x, g10y] = g(b10); const [g01x, g01y] = g(b01); const [g11x, g11y] = g(b11);
      let u = g00x * rx + g00y * ry; let v = g10x * (rx - 1) + g10y * ry;
      const a = u + (v - u) * sx;
      u = g01x * rx + g01y * (ry - 1); v = g11x * (rx - 1) + g11y * (ry - 1);
      const b = u + (v - u) * sx;
      const value = a + (b - a) * sy;
      sum[c] += (fractal ? value : Math.abs(value)) * ratio;
    }
    nx *= 2; ny *= 2; ratio *= 0.5;
  }
  const out = sum.map((value) => Math.min(1, Math.max(0, fractal ? value * 0.5 + 0.5 : value)));
  return [out[0] * out[3], out[1] * out[3], out[2] * out[3], out[3]];
}

/**
 * The 1D blur kernel used to match Chrome's filter for a standard deviation.
 * Small sigmas use the sampled Gaussian: a three-box approximation can turn
 * a visible soft focus into no blur. Larger sigmas use the spec's window
 * d = ⌊σ·3·√(2π)/4 + ½⌋ (for an even d, two boxes of d shifted against each
 * other plus one of d + 1). Past Skia's 135 limit (a 255-pixel window) Chrome blurs a downscaled copy; a sampled Gaussian stands
 * in for that. `weights[i]` applies to offset `i - origin`; `boxes` and
 * `divisor` give the same kernel as three integer box sums. Null for no blur.
 * SELF-CONTAINED (inlined into the page).
 */
function blurKernel(sigma) {
  if (!(sigma > 0.03)) return null;
  const gaussian = () => {
    const radius = Math.ceil(3 * sigma);
    const weights = new Float32Array(2 * radius + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) { weights[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += weights[i + radius]; }
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    return { weights, origin: radius };
  };
  if (sigma < 2) return gaussian();
  const window = Math.max(1, Math.floor(Math.fround(sigma * 3 * Math.sqrt(2 * Math.PI) / 4 + 0.5)));
  if (window >= 255) return gaussian();
  const box = (n) => new Float64Array(n).fill(1);
  const convolve = (a, b) => {
    const out = new Float64Array(a.length + b.length - 1);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
    return out;
  };
  const odd = (window & 1) === 1;
  const counts = convolve(convolve(box(window), box(window)), box(odd ? window : window + 1));
  const divisor = odd ? window ** 3 : window ** 3 + window ** 2;
  const weights = Float32Array.from(counts, (count) => count / divisor);
  const half = Math.floor(window / 2);
  // The same kernel as three box sums (inclusive offset ranges), which the
  // renderer runs as running sums instead of hundreds of taps.
  const boxes = odd ? [[-half, half], [-half, half], [-half, half]] : [[-half, half - 1], [-(half - 1), half], [-half, half]];
  return { weights, origin: odd ? (counts.length - 1) / 2 : 3 * half - 1, boxes, divisor };
}

/**
 * The primitives of a film look `<filter>` as plain records, in order:
 * `{ type, result, in, in2, attrs, funcs }`. Throws on a filter this renderer
 * does not reproduce (another color space or unit system, a non-full filter
 * region), so the caller falls back to the SVG path. SELF-CONTAINED.
 */
function parseFilmLookFilter(filter) {
  const attrsOf = (text) => {
    const attrs = {};
    for (const [, name, value] of String(text).matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[name] = value;
    return attrs;
  };
  const head = /^<filter\b([^>]*)>/.exec(filter);
  if (!head) throw new Error('not a filter');
  const region = attrsOf(head[1]);
  if (region['color-interpolation-filters'] !== 'sRGB' || region.primitiveUnits !== 'userSpaceOnUse'
    || region.x !== '0' || region.y !== '0' || region.width !== '100%' || region.height !== '100%') {
    throw new Error('unsupported filter region or color space');
  }
  const primitives = [];
  const pattern = /<(fe[A-Za-z]+)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  for (const [, type, attrText, , inner] of filter.slice(head[0].length).matchAll(pattern)) {
    const attrs = attrsOf(attrText);
    const funcs = {};
    if (inner) {
      for (const [, channel, funcAttrs] of inner.matchAll(/<feFunc([RGBA])\b([^>]*?)\/>/g)) funcs[channel] = attrsOf(funcAttrs);
    }
    primitives.push({ type, result: attrs.result || null, in: attrs.in || null, in2: attrs.in2 || null, attrs, funcs });
  }
  return primitives;
}

/**
 * The browser source for the renderer. Defines `globalThis.__portosFilmLookGpu`:
 *
 *   available()          WebGL2 with float render targets is present
 *   create(canvas)       a renderer drawing into `canvas` (its own WebGL2 context)
 *     .render(source, look, { frame, width, height })
 *                        draw `source` (video, image or canvas) through `look`
 *                        at song frame `frame` into the canvas
 *     .readPixels()      the last frame as top-down RGBA bytes
 *     .dispose()
 */
export function filmLookGpuRuntimeSource() {
  return `(() => {
  const markup = ${filmLookFilterMarkup.toString()};
  const turbulenceTables = ${turbulenceTables.toString()};
  const blurKernel = ${blurKernel.toString()};
  const parseFilmLookFilter = ${parseFilmLookFilter.toString()};
  const create = ${createFilmLookGpuRenderer.toString()};
  const available = () => {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      return Boolean(gl && gl.getExtension('EXT_color_buffer_float'));
    } catch { return false; }
  };
  Object.defineProperty(globalThis, '__portosFilmLookGpu', { configurable: false, writable: false,
    value: Object.freeze({ available, create: (canvas) => create(canvas, { markup, turbulenceTables, blurKernel, parseFilmLookFilter }) }) });
})();`;
}

// The WebGL2 renderer. Inlined into the page by filmLookGpuRuntimeSource, so it
// reaches its helpers only through `deps`. Every intermediate is an RGBA8
// premultiplied texture in image orientation (row 0 = top), as Skia's raster
// filters keep them; the last pass flips into the canvas.
function createFilmLookGpuRenderer(canvas, deps) {
  const { markup, turbulenceTables, blurKernel, parseFilmLookFilter } = deps;
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is unavailable');
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2 float render targets are unavailable');

  const VERTEX = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
  const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 color;
uniform vec2 size;
// Image-space pixel (row 0 = top) of this fragment in an offscreen target.
ivec2 pixel() { return ivec2(gl_FragCoord.xy); }
vec4 fetch(sampler2D image, ivec2 p) {
  if (p.x < 0 || p.y < 0 || p.x >= int(size.x) || p.y >= int(size.y)) return vec4(0.0);
  return texelFetch(image, p, 0);
}
vec4 unpremul(vec4 c) { return c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 premul(vec4 c) { c = clamp(c, 0.0, 1.0); return vec4(c.rgb * c.a, c.a); }
uniform vec4 clip;
bool clipped() { vec2 p = gl_FragCoord.xy; return p.x < clip.x || p.y < clip.y || p.x > clip.z || p.y > clip.w; }
`;
  const PROGRAMS = {
    // The source picture, flipped from texture upload order into image order.
    source: `uniform sampler2D a;
void main() { color = texelFetch(a, pixel(), 0); }`,
    flood: `uniform vec4 floodColor;
void main() { color = clipped() ? vec4(0.0) : floodColor; }`,
    offset: `uniform sampler2D a; uniform vec2 shift; uniform int sampled;
void main() {
  if (clipped()) { color = vec4(0.0); return; }
  // A downstream filter samples the translated image with transparent
  // out-of-bounds texels; clamping would invent colored edge fringes.
  if (sampled == 1) { color = fetch(a, pixel() - ivec2(floor(shift + 0.5))); return; }
  // A terminal offset is drawn directly with antialiased frame coverage.
  ivec2 q = clamp(pixel() - ivec2(floor(shift + 0.5)), ivec2(0), ivec2(size) - 1);
  vec2 lo = max(floor(gl_FragCoord.xy), shift);
  vec2 hi = min(floor(gl_FragCoord.xy) + 1.0, shift + size);
  vec2 cover = clamp(hi - lo, 0.0, 1.0);
  color = texelFetch(a, q, 0) * cover.x * cover.y;
}`,
    blur: `uniform sampler2D a; uniform sampler2D kernel; uniform int taps; uniform int origin; uniform ivec2 step;
void main() {
  if (clipped()) { color = vec4(0.0); return; }
  ivec2 p = pixel() - step * origin;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4096; i++) {
    if (i >= taps) break;
    ivec2 q = p + step * i;
    sum += texelFetch(kernel, ivec2(i, 0), 0).r * fetch(a, q);
  }
  color = sum;
}`,
    // Box sums run in image coordinates over textures that may extend past the
    // frame along the blur axis ('aOffset' = the image coordinate of texel 0),
    // because Skia's three running sums carry on past the edge between boxes.
    // A box sum of 'n' taps along 'step', starting at the fragment (unnormalized).
    boxRun: `uniform sampler2D a; uniform ivec2 aOffset; uniform ivec2 aSize; uniform ivec2 outOffset; uniform ivec2 step; uniform int n;
vec4 at(ivec2 q) { ivec2 i = q - aOffset; return (i.x < 0 || i.y < 0 || i.x >= aSize.x || i.y >= aSize.y) ? vec4(0.0) : texelFetch(a, i, 0); }
void main() {
  ivec2 p = pixel() + outOffset;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 256; i++) { if (i >= n) break; sum += at(p + step * i); }
  color = sum;
}`,
    // A box over offsets [lo, lo + k·m + r): k runs of m (from 'runs', which
    // has its own extent) plus r single taps, scaled (1, or 1/divisor last).
    boxSum: `uniform sampler2D a; uniform sampler2D runs; uniform ivec2 aOffset; uniform ivec2 aSize; uniform ivec2 runsOffset; uniform ivec2 runsSize;
uniform ivec2 outOffset; uniform ivec2 step; uniform int lo; uniform int m; uniform int k; uniform int r; uniform float scale;
vec4 at(sampler2D t, ivec2 q, ivec2 offset, ivec2 extent) { ivec2 i = q - offset; return (i.x < 0 || i.y < 0 || i.x >= extent.x || i.y >= extent.y) ? vec4(0.0) : texelFetch(t, i, 0); }
void main() {
  if (clipped()) { color = vec4(0.0); return; }
  ivec2 p = pixel() + outOffset;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 256; j++) { if (j >= k) break; sum += at(runs, p + step * (lo + j * m), runsOffset, runsSize); }
  for (int t = 0; t < 256; t++) { if (t >= r) break; sum += at(a, p + step * (lo + k * m + t), aOffset, aSize); }
  color = sum * scale;
}`,
    // A blurred flood rectangle is separable: the 8-bit row profile times the column profile.
    floodBlur: `uniform sampler2D rowProfile; uniform sampler2D columnProfile;
void main() {
  if (clipped()) { color = vec4(0.0); return; }
  ivec2 p = pixel();
  color = texelFetch(rowProfile, ivec2(p.x, 0), 0) * texelFetch(columnProfile, ivec2(p.y, 0), 0).r;
}`,
    matrix: `uniform sampler2D a; uniform mat4 m; uniform vec4 bias;
void main() {
  if (clipped()) { color = vec4(0.0); return; }
  vec4 c = unpremul(texelFetch(a, pixel(), 0));
  color = premul(m * c + bias);
}`,
    transfer: `uniform sampler2D a; uniform vec4 slope; uniform vec4 intercept;
void main() {
  if (clipped()) { color = vec4(0.0); return; }
  vec4 c = unpremul(texelFetch(a, pixel(), 0));
  color = premul(c * slope + intercept);
}`,
    composite: `uniform sampler2D a; uniform sampler2D b; uniform int op; uniform vec4 k;
void main() {
  if (clipped()) { color = vec4(0.0); return; }
  vec4 s = texelFetch(a, pixel(), 0); vec4 d = texelFetch(b, pixel(), 0);
  if (op == 0) color = s + d * (1.0 - s.a);
  else if (op == 1) color = s * d.a;
  else color = clamp(k.x * s * d + k.y * s + k.z * d + k.w, 0.0, 1.0);
}`,
    blend: `uniform sampler2D a; uniform sampler2D b; uniform int mode;
float softD(float x) { return x <= 0.25 ? ((16.0 * x - 12.0) * x + 4.0) * x : sqrt(x); }
float mixColor(float cb, float cs) {
  if (mode == 1) return cs + cb - cs * cb;
  if (mode == 2) return cb <= 0.5 ? 2.0 * cs * cb : 1.0 - 2.0 * (1.0 - cs) * (1.0 - cb);
  if (mode == 3) return cs <= 0.5 ? cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb) : cb + (2.0 * cs - 1.0) * (softD(cb) - cb);
  if (mode == 4) return cs * cb;
  return cs;
}
void main() {
  if (clipped()) { color = vec4(0.0); return; }
  vec4 s = texelFetch(a, pixel(), 0); vec4 d = texelFetch(b, pixel(), 0);
  vec3 cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0); vec3 cb = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 mixed = vec3(mixColor(cb.r, cs.r), mixColor(cb.g, cs.g), mixColor(cb.b, cs.b));
  color = clamp(vec4(s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.a * d.a * mixed, s.a + d.a - s.a * d.a), 0.0, 1.0);
}`,
    turbulence: `uniform sampler2D lattice; uniform sampler2D gradients; uniform vec2 frequency; uniform int octaves; uniform int fractal;
int lat(int i) { return int(texelFetch(lattice, ivec2(i & 255, 0), 0).r); }
vec2 grad(int i, int channel) { return texelFetch(gradients, ivec2(i, channel), 0).rg; }
void main() {
  if (clipped()) { color = vec4(0.0); return; }
  vec2 p = vec2(pixel()) + 1.0;
  vec2 v = p * frequency;
  vec4 sum = vec4(0.0);
  float ratio = 1.0;
  for (int o = 0; o < 16; o++) {
    if (o >= octaves) break;
    vec2 fl = floor(v); vec2 fr = v - fl;
    int fx = int(fl.x); int fy = int(fl.y);
    int lx = lat(fx & 255); int ly = lat((fx + 1) & 255);
    int b00 = (lx + fy) & 255; int b10 = (ly + fy) & 255; int b01 = (lx + fy + 1) & 255; int b11 = (ly + fy + 1) & 255;
    vec2 s = fr * fr * (3.0 - 2.0 * fr);
    vec4 n;
    for (int c = 0; c < 4; c++) {
      float u = dot(grad(b00, c), fr); float w = dot(grad(b10, c), fr - vec2(1.0, 0.0));
      float A = u + (w - u) * s.x;
      u = dot(grad(b01, c), fr - vec2(0.0, 1.0)); w = dot(grad(b11, c), fr - vec2(1.0, 1.0));
      float B = u + (w - u) * s.x;
      n[c] = A + (B - A) * s.y;
    }
    sum += (fractal == 1 ? n : abs(n)) * ratio;
    v *= 2.0; ratio *= 0.5;
  }
  if (fractal == 1) sum = sum * 0.5 + 0.5;
  sum = clamp(sum, 0.0, 1.0);
  color = vec4(sum.rgb * sum.a, sum.a);
}`,
    // Onto the canvas: the filtered page over the black page background, flipped.
    present: `uniform sampler2D a;
void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), int(size.y) - 1 - int(gl_FragCoord.y));
  vec4 c = texelFetch(a, p, 0);
  color = vec4(c.rgb + (1.0 - c.a), 1.0);
}`,
  };

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('film look shader: ' + gl.getShaderInfoLog(shader));
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const programs = {};
  for (const [name, body] of Object.entries(PROGRAMS)) {
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, HEADER + body));
    gl.bindAttribLocation(program, 0, 'position');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('film look program: ' + gl.getProgramInfoLog(program));
    const uniforms = {};
    for (let i = 0, count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    programs[name] = { program, uniforms };
  }
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.BLEND);
  gl.disable(gl.DITHER);

  const texture = (width, height, internal, format, type, data = null, filter = gl.NEAREST) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
    return t;
  };

  let width = 0, height = 0;
  let pool = [];
  let uploadTexture = null;
  let output = null;
  const tableCache = new Map();
  const kernelCache = new Map();
  const profileCache = new Map();
  const resize = (w, h) => {
    if (w === width && h === height) return;
    for (const target of pool) { gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.framebuffer); }
    if (uploadTexture) gl.deleteTexture(uploadTexture);
    pool = [];
    width = w; height = h;
    canvas.width = w; canvas.height = h;
    uploadTexture = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  };
  // 8-bit frame-sized targets hold primitive results; float targets (any size)
  // hold unrounded box sums.
  const acquire = (float = false, w = width, h = height) => {
    let target = pool.find((entry) => !entry.busy && entry.float === float && entry.w === w && entry.h === h);
    if (!target) {
      const t = float ? texture(w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT) : texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      target = { texture: t, framebuffer, busy: false, float, w, h };
      pool.push(target);
    }
    target.busy = true;
    return target;
  };
  const FULL = [-1, -1, 1e9, 1e9];
  // One axis of a blur from the frame-sized `input` into the 8-bit `target`: a
  // sampled kernel for small sigmas, else Skia's three boxes as exact running
  // sums in float targets, rounded to 8 bits once at the end as its integer
  // sums are. Each box's output reaches past the frame as far as the boxes
  // after it read.
  const blurAxis = (input, sigma, axis, target, region) => {
    const kernel = kernelTexture(sigma);
    const step = axis === 0 ? [1, 0] : [0, 1];
    if (!kernel.boxes) {
      run('blur', target, (u, bind) => { clipUniform(u, region); bind('a', input); bind('kernel', kernel.texture); gl.uniform1i(u.taps, kernel.taps); gl.uniform1i(u.origin, kernel.origin); gl.uniform2i(u.step, ...step); });
      return;
    }
    const length = axis === 0 ? width : height;
    const along = (value) => (axis === 0 ? [value, 0] : [0, value]);
    const dims = (span) => (axis === 0 ? [span, height] : [width, span]);
    const boxes = kernel.boxes;
    let current = { texture: input, start: 0, span: length, target: null };
    boxes.forEach(([lo, hi], index) => {
      const lastBox = index === boxes.length - 1;
      // This box's output range: what the later boxes read of it.
      const later = boxes.slice(index + 1);
      const start = later.reduce((sum, [l]) => sum + l, 0);
      const end = length + later.reduce((sum, [, h]) => sum + h, 0);
      const n = hi - lo + 1;
      // Runs of about √n taps, then about √n runs: two cheap passes per box.
      const m = n > 8 ? Math.round(Math.sqrt(n)) : 1;
      const k = n > 8 ? Math.floor(n / m) : 0;
      const r = n - k * m;
      const from = current;
      const aOffset = along(from.start), aSize = dims(from.span);
      const outStart = lastBox ? 0 : start;
      // Every run this box reads starts in [outStart + lo, end + lo + (k − 1)·m).
      const runsStart = outStart + lo;
      const runsSpan = (end - outStart) + Math.max(0, k - 1) * m;
      let runs = null;
      if (k > 0) {
        runs = acquire(true, ...dims(runsSpan));
        run('boxRun', runs, (u, bind) => { bind('a', from.texture); gl.uniform2i(u.aOffset, ...aOffset); gl.uniform2i(u.aSize, ...aSize); gl.uniform2i(u.outOffset, ...along(runsStart)); gl.uniform2i(u.step, ...step); gl.uniform1i(u.n, m); });
      }
      const out = lastBox ? target : acquire(true, ...dims(end - start));
      run('boxSum', out, (u, bind) => {
        if (lastBox) clipUniform(u, region); else gl.uniform4f(u.clip, -1e9, -1e9, 1e9, 1e9);
        bind('a', from.texture); bind('runs', runs ? runs.texture : from.texture);
        gl.uniform2i(u.aOffset, ...aOffset); gl.uniform2i(u.aSize, ...aSize);
        gl.uniform2i(u.runsOffset, ...along(runsStart)); gl.uniform2i(u.runsSize, ...dims(runsSpan));
        gl.uniform2i(u.outOffset, ...along(outStart)); gl.uniform2i(u.step, ...step);
        gl.uniform1i(u.lo, lo); gl.uniform1i(u.m, m); gl.uniform1i(u.k, k); gl.uniform1i(u.r, r);
        gl.uniform1f(u.scale, lastBox ? 1 / kernel.divisor : 1);
      });
      if (runs) runs.busy = false;
      if (from.target) from.target.busy = false;
      if (!lastBox) current = { texture: out.texture, start, span: end - start, target: out };
    });
  };
  // The row and column profiles of a blurred flood rectangle: the row one
  // rounded to 8 bits as Skia's horizontal pass stores it.
  const floodBlurProfiles = (flood, sx, sy) => {
    const profile = (length, from, to, sigma) => {
      const values = new Float32Array(length);
      const kernel = sigma > 0 ? blurKernel(sigma) : null;
      for (let i = 0; i < length; i++) {
        if (!kernel) { values[i] = i >= from && i < to ? 1 : 0; continue; }
        let sum = 0;
        for (let j = Math.max(from, i - (kernel.weights.length - 1 - kernel.origin)); j < Math.min(to, i + kernel.origin + 1); j++) sum += kernel.weights[i - j + kernel.origin];
        values[i] = sum;
      }
      return values;
    };
    const [x0, y0, x1, y1] = flood.rect;
    const row = profile(width, x0, x1, sx);
    const column = profile(height, y0, y1, sy);
    const bytes = new Uint8Array(width * 4);
    for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) bytes[x * 4 + c] = Math.round(row[x] * Math.round(255 * flood.color[c]));
    return {
      rowTexture: texture(width, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bytes),
      columnTexture: texture(height, 1, gl.R32F, gl.RED, gl.FLOAT, column),
    };
  };
  const tables = (seed) => {
    if (!tableCache.has(seed)) {
      const { lattice, gradients } = turbulenceTables(seed);
      const latticeTexture = texture(256, 1, gl.R32F, gl.RED, gl.FLOAT, Float32Array.from(lattice));
      const gradientTexture = texture(256, 4, gl.RG32F, gl.RG, gl.FLOAT, gradients);
      if (tableCache.size > 64) {
        const [oldest, value] = tableCache.entries().next().value;
        gl.deleteTexture(value.latticeTexture); gl.deleteTexture(value.gradientTexture);
        tableCache.delete(oldest);
      }
      tableCache.set(seed, { latticeTexture, gradientTexture });
    }
    return tableCache.get(seed);
  };
  const kernelTexture = (sigma) => {
    const key = String(sigma);
    if (!kernelCache.has(key)) {
      const kernel = blurKernel(sigma);
      kernelCache.set(key, kernel && { ...kernel, taps: kernel.weights.length, texture: texture(kernel.weights.length, 1, gl.R32F, gl.RED, gl.FLOAT, kernel.weights) });
    }
    return kernelCache.get(key);
  };
  const run = (name, target, setup) => {
    const { program, uniforms } = programs[name];
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(0, 0, target ? target.w : width, target ? target.h : height);
    if (uniforms.size) gl.uniform2f(uniforms.size, width, height);
    let unit = 0;
    const bind = (uniform, t) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(uniforms[uniform], unit);
      unit++;
    };
    setup(uniforms, bind);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const num = (value, fallback = 0) => { const parsed = Number.parseFloat(value); return Number.isFinite(parsed) ? parsed : fallback; };
  const hexColor = (value) => {
    let hex = String(value || '#000000').trim();
    if (/^#[0-9a-f]{3}$/i.test(hex)) hex = '#' + [...hex.slice(1)].map((digit) => digit + digit).join('');
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('unsupported flood color ' + value);
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  };
  // The pixel rectangle a primitive writes, clipped to the frame, in gl_FragCoord terms.
  const regionOf = (attrs, fallback) => {
    if (!('x' in attrs || 'y' in attrs || 'width' in attrs || 'height' in attrs)) return fallback;
    const x = num(attrs.x, fallback[0]);
    const y = num(attrs.y, fallback[1]);
    const w = 'width' in attrs ? num(attrs.width) : fallback[2] - fallback[0];
    const h = 'height' in attrs ? num(attrs.height) : fallback[3] - fallback[1];
    return [x, y, x + w, y + h];
  };
  // The whole pixels a region covers, clipped to the frame: [x0, y0, x1, y1).
  const pixelRect = (region) => [Math.max(0, Math.round(region[0])), Math.max(0, Math.round(region[1])),
    Math.min(width, Math.round(region[2])), Math.min(height, Math.round(region[3]))];
  const clipUniform = (uniforms, region) => {
    const [x0, y0, x1, y1] = pixelRect(region);
    // Inclusive bounds of the covered pixel centres.
    gl.uniform4f(uniforms.clip, x0 + 0.25, y0 + 0.25, x1 - 0.25, y1 - 0.25);
  };

  // A video goes through a 2D canvas at the frame size first. WebGL's own
  // video upload converts YUV to RGB differently from the page compositor the
  // SVG filter reads (about 30 dB apart on a plain frame), and a sized
  // texImage2D copies a video of another size unscaled instead of filling the
  // frame the way the page's object-fit does.
  let staging = null;
  const stage = (source) => {
    if (typeof HTMLVideoElement === 'undefined' || !(source instanceof HTMLVideoElement)) return source;
    staging ||= document.createElement('canvas');
    if (staging.width !== width || staging.height !== height) { staging.width = width; staging.height = height; }
    staging.getContext('2d', { alpha: false }).drawImage(source, 0, 0, width, height);
    return staging;
  };

  let lastPlanKey = null;
  let lastPlan = null;
  const render = (source, look, { frame = 0, width: w, height: h, until = Infinity } = {}) => {
    resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    const built = markup(look, { frame, width: width, height: height });
    if (built.filter !== lastPlanKey) { lastPlan = parseFilmLookFilter(built.filter); lastPlanKey = built.filter; }
    const primitives = lastPlan;
    // How many later primitives read each result, so targets return to the pool.
    const reads = new Map();
    const last = Math.min(primitives.length, until);
    for (let i = 0; i < last; i++) {
      const p = primitives[i];
      const ins = p.type === 'feFlood' || p.type === 'feTurbulence' ? [] : [p.in, p.in2].filter(Boolean);
      if (p.type !== 'feFlood' && p.type !== 'feTurbulence' && !p.in) ins.push(i === 0 ? 'SourceGraphic' : '__prev' + (i - 1));
      p._inputs = ins;
      for (const name of ins) reads.set(name, (reads.get(name) || 0) + 1);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.bindTexture(gl.TEXTURE_2D, uploadTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, stage(source));
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const frameRegion = [0, 0, width, height];
    const results = new Map();
    const sourceTarget = acquire();
    run('source', sourceTarget, (u, bind) => bind('a', uploadTexture));
    results.set('SourceGraphic', { target: sourceTarget, region: frameRegion });
    let previous = 'SourceGraphic';
    const release = (name) => {
      const left = (reads.get(name) || 0) - 1;
      reads.set(name, left);
      if (left <= 0 && results.has(name)) { results.get(name).target.busy = false; results.delete(name); }
    };
    for (let i = 0; i < last; i++) {
      const p = primitives[i];
      const inputs = p._inputs.map((name) => {
        const resolved = name.startsWith('__prev') ? previous : name;
        const found = results.get(resolved);
        if (!found) throw new Error('film look input ' + resolved + ' is missing');
        return found;
      });
      const name = p.result || '__prev' + i;
      // A primitive's region defaults to the union of its inputs' (the frame for generators).
      const fallback = inputs.length ? inputs.reduce((acc, input) => [Math.min(acc[0], input.region[0]), Math.min(acc[1], input.region[1]), Math.max(acc[2], input.region[2]), Math.max(acc[3], input.region[3])], [Infinity, Infinity, -Infinity, -Infinity]) : frameRegion;
      const region = regionOf(p.attrs, fallback);
      const target = acquire();
      let floodOf = null;
      const a = inputs[0] && inputs[0].target.texture;
      const b = inputs[1] && inputs[1].target.texture;
      const { attrs } = p;
      if (p.type === 'feFlood') {
        const [r, g, bl] = hexColor(attrs['flood-color']);
        const opacity = num(attrs['flood-opacity'], 1);
        const color = [r * opacity, g * opacity, bl * opacity, opacity];
        run('flood', target, (u) => { clipUniform(u, region); gl.uniform4f(u.floodColor, ...color); });
        floodOf = { color, rect: pixelRect(region) };
      } else if (p.type === 'feOffset') {
        run('offset', target, (u, bind) => { clipUniform(u, region); bind('a', a); gl.uniform2f(u.shift, num(attrs.dx), num(attrs.dy)); gl.uniform1i(u.sampled, i < last - 1 ? 1 : 0); });
      } else if (p.type === 'feGaussianBlur') {
        const [sx, sy = sx] = String(attrs.stdDeviation || '0').trim().split(/[\s,]+/).map((value) => num(value));
        const blurX = Boolean(kernelTexture(sx)), blurY = Boolean(kernelTexture(sy));
        if (inputs[0].flood && (blurX || blurY)) {
          const key = JSON.stringify([inputs[0].flood, sx, sy, width, height]);
          let profiles = profileCache.get(key);
          if (!profiles) {
            profiles = floodBlurProfiles(inputs[0].flood, blurX ? sx : 0, blurY ? sy : 0);
            profileCache.set(key, profiles);
            if (profileCache.size > 8) {
              const [oldest, value] = profileCache.entries().next().value;
              gl.deleteTexture(value.rowTexture); gl.deleteTexture(value.columnTexture);
              profileCache.delete(oldest);
            }
          }
          run('floodBlur', target, (u, bind) => { clipUniform(u, region); bind('rowProfile', profiles.rowTexture); bind('columnProfile', profiles.columnTexture); });
        } else if (blurX && blurY) {
          const temp = acquire();
          blurAxis(a, sx, 0, temp, FULL);
          blurAxis(temp.texture, sy, 1, target, region);
          temp.busy = false;
        } else if (blurX || blurY) blurAxis(a, blurX ? sx : sy, blurX ? 0 : 1, target, region);
        else run('offset', target, (u, bind) => { clipUniform(u, region); bind('a', a); gl.uniform2f(u.shift, 0, 0); gl.uniform1i(u.sampled, 0); });
      } else if (p.type === 'feColorMatrix') {
        let values;
        if ((attrs.type || 'matrix') === 'saturate') {
          const s = num(attrs.values, 1);
          values = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
            0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
            0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0,
            0, 0, 0, 1, 0];
        } else if ((attrs.type || 'matrix') === 'matrix') {
          values = String(attrs.values).trim().split(/[\s,]+/).map((value) => num(value));
          if (values.length !== 20) throw new Error('feColorMatrix needs 20 values');
        } else throw new Error('unsupported feColorMatrix type ' + attrs.type);
        // Column-major mat4 of the 4×5 matrix's first four columns.
        const m = [];
        for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) m.push(values[row * 5 + col]);
        run('matrix', target, (u, bind) => { clipUniform(u, region); bind('a', a); gl.uniformMatrix4fv(u.m, false, m); gl.uniform4f(u.bias, values[4], values[9], values[14], values[19]); });
      } else if (p.type === 'feComponentTransfer') {
        const slope = [1, 1, 1, 1], intercept = [0, 0, 0, 0];
        ['R', 'G', 'B', 'A'].forEach((channel, i) => {
          const fn = p.funcs[channel];
          if (!fn || (fn.type || 'identity') === 'identity') return;
          if (fn.type !== 'linear') throw new Error('unsupported transfer ' + fn.type);
          slope[i] = num(fn.slope, 1); intercept[i] = num(fn.intercept, 0);
        });
        run('transfer', target, (u, bind) => { clipUniform(u, region); bind('a', a); gl.uniform4f(u.slope, ...slope); gl.uniform4f(u.intercept, ...intercept); });
      } else if (p.type === 'feComposite') {
        const op = { over: 0, in: 1, arithmetic: 2 }[attrs.operator || 'over'];
        if (op === undefined) throw new Error('unsupported feComposite operator ' + attrs.operator);
        run('composite', target, (u, bind) => { clipUniform(u, region); bind('a', a); bind('b', b); gl.uniform1i(u.op, op); gl.uniform4f(u.k, num(attrs.k1), num(attrs.k2), num(attrs.k3), num(attrs.k4)); });
      } else if (p.type === 'feBlend') {
        const mode = { normal: 0, screen: 1, overlay: 2, 'soft-light': 3, multiply: 4 }[attrs.mode || 'normal'];
        if (mode === undefined) throw new Error('unsupported feBlend mode ' + attrs.mode);
        run('blend', target, (u, bind) => { clipUniform(u, region); bind('a', a); bind('b', b); gl.uniform1i(u.mode, mode); });
      } else if (p.type === 'feTurbulence') {
        if (attrs.stitchTiles === 'stitch') throw new Error('stitched turbulence is not supported');
        const [fx, fy = fx] = String(attrs.baseFrequency || '0').trim().split(/[\s,]+/).map((value) => num(value));
        const { latticeTexture, gradientTexture } = tables(num(attrs.seed, 0));
        run('turbulence', target, (u, bind) => {
          clipUniform(u, region); bind('lattice', latticeTexture); bind('gradients', gradientTexture);
          gl.uniform2f(u.frequency, fx, fy); gl.uniform1i(u.octaves, Math.max(0, Math.trunc(num(attrs.numOctaves, 1))));
          gl.uniform1i(u.fractal, attrs.type === 'fractalNoise' ? 1 : 0);
        });
      } else {
        throw new Error('unsupported film look primitive ' + p.type);
      }
      for (const input of p._inputs) release(input.startsWith('__prev') ? previous : input);
      results.set(name, { target, region, flood: floodOf });
      previous = name;
    }
    output = results.get(previous).target;
    run('present', null, (u, bind) => bind('a', output.texture));
    for (const [, entry] of results) entry.target.busy = false;
    results.clear();
    return { primitives: last };
  };
  const readPixels = () => {
    const bytes = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    // The default framebuffer is bottom-up; hand back image order.
    const row = width * 4;
    const flipped = new Uint8Array(bytes.length);
    for (let y = 0; y < height; y++) flipped.set(bytes.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return flipped;
  };
  const dispose = () => { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); };
  // What draws it: a GPU, or a software rasterizer such as SwiftShader.
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '').slice(0, 160);
  return { render, readPixels, dispose, renderer, get gl() { return gl; } };
}

// The pieces the renderer inlines, for unit tests against what Chrome draws.
export const _filmLookGpuTestHooks = Object.freeze({ turbulenceTables, turbulencePixel, blurKernel, parseFilmLookFilter });
