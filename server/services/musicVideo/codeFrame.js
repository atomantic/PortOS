/**
 * Seekable frame contract for a code-rendered music video (#9076).
 *
 * `drawCodeFrame` is the host painter: one section function, then karaoke.
 * Its source is embedded in the preview and render page, so it must not close
 * over module state — every input arrives on the argument, and the helpers it
 * calls are emitted beside it. Seeking the same `t` twice paints the same
 * pixels. Jitter, when a section uses it, is keyed to `env.frame`.
 *
 * Request handlers never call this painter. The preview runs it in a
 * sandboxed iframe and the file render runs it in the composition browser,
 * both with network globals removed first. The node sampler below passes its
 * own `compile` so a test does not evaluate section source against this
 * process's globals.
 */
import vm from 'node:vm';

export const CODE_FPS = 24;
export const CODE_SAFE_INSET = 0.1;
export const CODE_EARLY_DIM_SEC = 0.4;

const FONT_STACKS = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' };

/** How one lyric word looks at time `t`. The highlight never starts early. */
function wordAppearance(word, t) {
  const start = word.startSec;
  const end = typeof word.endSec === 'number' && word.endSec > start ? word.endSec : start + 0.35;
  const dimAt = Math.max(0, start - CODE_EARLY_DIM_SEC);
  if (!(t >= dimAt)) return { opacity: 0, highlight: false };
  if (t < start) return { opacity: 0.45, highlight: false };
  if (t < end) return { opacity: 1, highlight: true };
  return { opacity: 0.72, highlight: false };
}

function lineEnd(line) {
  const words = line.words || [];
  const last = words[words.length - 1];
  if (last && typeof last.endSec === 'number' && last.endSec > (last.startSec ?? 0)) return last.endSec;
  if (typeof line.endSec === 'number' && line.endSec > (line.startSec ?? 0)) return line.endSec;
  return (line.startSec ?? 0) + 0.5;
}

/** A line is on screen from 0.4s before its first word through its end. */
function lineActive(line, t) {
  const start = line.words?.[0]?.startSec ?? line.startSec ?? 0;
  return t >= start - CODE_EARLY_DIM_SEC && t < lineEnd(line);
}

/**
 * Paint one frame. `sources` maps a section id to `function render(ctx, env)`.
 * A missing or throwing section still leaves the palette and the lyric line.
 */
export function drawCodeFrame({ ctx, song, palette, sources, t, width, height, fps, compile }) {
  const duration = song.durationSec;
  const time = Math.min(Math.max(0, t), Math.max(0, duration));
  const frame = Math.max(0, Math.floor(time * fps + 1e-9));
  const sections = song.sections || [];
  let section = sections[sections.length - 1] || { id: 'song', startSec: 0, endSec: duration, label: 'Song' };
  for (const candidate of sections) {
    if (time >= candidate.startSec && time < candidate.endSec) { section = candidate; break; }
  }
  const inset = CODE_SAFE_INSET;
  const safe = { x: width * inset, y: height * inset, w: width * (1 - 2 * inset), h: height * (1 - 2 * inset) };
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);
  const localT = time - (section.startSec || 0);
  const karaoke = (song.lyrics || []).filter((line) => lineActive(line, time)).map((line) => ({
    ...line,
    words: (line.words || []).map((word) => {
      const appearance = wordAppearance(word, time);
      // The line is already on screen, so every word stays readable. Only the
      // highlight is withheld until startSec, and the brighter anticipation
      // is the 0.4s wordAppearance window.
      return { ...word, ...appearance, opacity: appearance.opacity > 0 ? appearance.opacity : 0.4 };
    }),
  }));
  const env = { t: time, localT, frame, width, height, song, palette, section, safe, karaoke };
  const source = sources && sources[section.id];
  if (typeof source === 'string' && source) {
    const restore = lockClock();
    try {
      if (!drawCodeFrame.compiled) drawCodeFrame.compiled = new Map();
      const key = source;
      let fn = drawCodeFrame.compiled.get(key);
      if (!fn) {
        fn = compile(source);
        drawCodeFrame.compiled.set(key, fn);
      }
      fn(ctx, env);
    } catch { /* the host lyric pass below still runs */ } finally { restore(); }
  } else {
    ctx.fillStyle = palette.accent;
    const band = 8 + (frame % 4);
    ctx.fillRect(safe.x, safe.y, band, band);
  }
  paintKaraoke(ctx, { palette, safe, karaoke });
  return { frame, sectionId: section.id, karaoke };
}

function lockClock() {
  const math = Math.random;
  const now = Date.now;
  const perfObj = globalThis.performance;
  const perfNow = perfObj ? perfObj.now : undefined;
  Math.random = () => { throw new Error('Math.random is disabled'); };
  Date.now = () => { throw new Error('Date.now is disabled'); };
  if (perfObj) perfObj.now = () => { throw new Error('performance.now is disabled'); };
  return () => {
    Math.random = math;
    Date.now = now;
    if (perfObj) perfObj.now = perfNow;
  };
}

function paintKaraoke(ctx, { palette, safe, karaoke }) {
  if (!karaoke.length) return;
  const stack = FONT_STACKS[palette.font] || FONT_STACKS.sans;
  const lines = karaoke.slice(-3);
  let cursor = safe.y + safe.h;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const text = (line.words || []).map((word) => word.text).join(' ');
    if (!text) continue;
    let size = Math.max(12, Math.min(64, Math.floor(safe.h * 0.09)));
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    while (size > 8) {
      ctx.font = `${size}px ${stack}`;
      if (ctx.measureText(text).width <= safe.w) break;
      size -= 1;
    }
    cursor -= size + 4;
    if (cursor < safe.y) break;
    let x = safe.x;
    for (const word of line.words || []) {
      if (!(word.opacity > 0)) continue;
      const token = `${word.text} `;
      const advance = ctx.measureText(token).width;
      if (x + advance > safe.x + safe.w + 0.5) break;
      ctx.globalAlpha = word.opacity;
      ctx.fillStyle = word.highlight ? palette.accent : palette.ink;
      ctx.fillText(word.text, x, cursor + size);
      x += advance;
    }
    ctx.globalAlpha = 1;
  }
}

function parseHex(style) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(style || ''));
  if (!match) return [0, 0, 0];
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Canvas stand-in so a seek can be compared without a browser. */
function createSoftwareCanvas(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const stack = [];
  const state = { fillStyle: '#000000', globalAlpha: 1, font: '16px sans-serif', textAlign: 'left', textBaseline: 'alphabetic' };
  const textOps = [];
  const paint = (x0, y0, w, h) => {
    const [r, g, b] = parseHex(state.fillStyle);
    const alpha = state.globalAlpha;
    const x1 = Math.max(0, Math.floor(x0));
    const y1 = Math.max(0, Math.floor(y0));
    const x2 = Math.min(width, Math.ceil(x0 + w));
    const y2 = Math.min(height, Math.ceil(y0 + h));
    for (let y = y1; y < y2; y += 1) {
      for (let x = x1; x < x2; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = Math.round(data[i] * (1 - alpha) + r * alpha);
        data[i + 1] = Math.round(data[i + 1] * (1 - alpha) + g * alpha);
        data[i + 2] = Math.round(data[i + 2] * (1 - alpha) + b * alpha);
        data[i + 3] = 255;
      }
    }
  };
  return {
    data,
    textOps,
    get fillStyle() { return state.fillStyle; },
    set fillStyle(value) { state.fillStyle = value; },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(value) { state.globalAlpha = value; },
    get font() { return state.font; },
    set font(value) { state.font = value; },
    get textAlign() { return state.textAlign; },
    set textAlign(value) { state.textAlign = value; },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(value) { state.textBaseline = value; },
    save() { stack.push({ ...state }); },
    restore() { Object.assign(state, stack.pop() || {}); },
    measureText(text) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] || 16);
      return { width: String(text).length * size * 0.55 };
    },
    fillRect: paint,
    fillText(text, x, y) {
      textOps.push({ text: String(text), x, y, font: state.font });
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] || 16);
      paint(x, y - size, Math.max(1, String(text).length * 2), Math.max(1, size * 0.7));
    },
  };
}

// Section source under test runs in a context with no process, require, or
// network. Browser pages instead provide statically declared section functions.
function sandboxCompile(source) {
  const wrapped = source.includes('function render') ? source : `function render(ctx, env) {\n${source}\n}`;
  const sandbox = {
    Math: { ...Math, random() { throw new Error('Math.random is disabled'); } },
    Date: { now() { throw new Error('Date.now is disabled'); } },
  };
  vm.createContext(sandbox);
  return vm.runInContext(
    `(function (ctx, env) {\n${wrapped}\nreturn typeof render === "function" ? render(ctx, env) : undefined;\n})`,
    sandbox,
  );
}

/** Paint `t` and return the pixel buffer plus the lyric placements. Test hook. */
export function _sampleFrame({ song, palette, sources, t, width, height, fps = CODE_FPS }) {
  const ctx = createSoftwareCanvas(width, height);
  const meta = drawCodeFrame({ ctx, song, palette, sources, t, width, height, fps, compile: sandboxCompile });
  return { data: ctx.data, textOps: ctx.textOps, ...meta, width, height };
}

/** Source emitted into the preview and render page. Same functions as this module. */
export function codeRuntimeSource() {
  return [
    `const CODE_SAFE_INSET = ${CODE_SAFE_INSET};`,
    `const CODE_EARLY_DIM_SEC = ${CODE_EARLY_DIM_SEC};`,
    `const FONT_STACKS = ${JSON.stringify(FONT_STACKS)};`,
    wordAppearance,
    lineEnd,
    lineActive,
    lockClock,
    paintKaraoke,
    drawCodeFrame,
  ].map((part) => (typeof part === 'function' ? part.toString() : part)).join('\n');
}

