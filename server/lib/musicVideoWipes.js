/**
 * Music Video wipes: image-to-image transitions on a cut between two shots,
 * where the outgoing picture stays on screen while the incoming one takes over
 * (an iris, a heart, venetian blinds, a push, a DVE card flip...). A wipe never
 * moves a cut or adds time: it runs from the cut for its length, over the
 * incoming shot's first frames with that shot's clock already running, and the
 * outgoing shot holds its last frame underneath until it is gone.
 *
 * A shot sets `wipeOut` (the cut to the next shot) and/or `wipeIn` (the cut
 * from the previous one), each `{ style, lengthSec?, color? }`. A cut plays one
 * effect: the outgoing shot's choice (a wipe or a glitch, musicVideoTransitions.js)
 * wins over the incoming shot's, and a cut effect (musicVideoCutEffects.js)
 * on the outgoing shot wins over both.
 *
 * One definition serves every player. Each style is a small expression tree
 * over the pixel's position (`u`, `v` in 0..1), the frame's aspect (`a`) and
 * the wipe's progress (`p`): `compileWipeNode` runs it in JavaScript (the
 * storyboard animatic and composition documents, `createMusicVideoWipePainter`)
 * and `wipeNodeExpr` writes the same tree as an ffmpeg `geq` expression for the
 * final render (`musicVideoWipeFilter`). Both work the masks out on the same
 * small grid (`wipeMaskGrid`) and smooth it up to the frame. Shape and pattern wipes are a
 * level field: the incoming shot shows where the level is under `p` times its
 * largest value, so at the end it covers the whole frame. Move wipes place the
 * two pictures with a translate, scale and turn per frame.
 */

export const MUSIC_VIDEO_WIPE_GROUPS = Object.freeze({
  shapes: Object.freeze(['iris', 'star', 'heart', 'diamond', 'paw', 'bone']),
  patterns: Object.freeze(['blinds-h', 'blinds-v', 'checker', 'clock', 'barn-doors']),
  moves: Object.freeze(['push-left', 'push-right', 'push-up', 'push-down', 'card-flip', 'spin-in']),
});

export const MUSIC_VIDEO_WIPE_GROUP_LABELS = Object.freeze({ shapes: 'Shape wipes', patterns: 'Pattern wipes', moves: 'Move wipes' });

export const MUSIC_VIDEO_WIPES = Object.freeze(Object.values(MUSIC_VIDEO_WIPE_GROUPS).flat());

export const MUSIC_VIDEO_WIPE_LABELS = Object.freeze({
  iris: 'Iris',
  star: 'Star',
  heart: 'Heart',
  diamond: 'Diamond',
  paw: 'Paw print',
  bone: 'Dog bone',
  'blinds-h': 'Horizontal blinds',
  'blinds-v': 'Vertical blinds',
  checker: 'Checkerboard',
  clock: 'Clock',
  'barn-doors': 'Barn doors',
  'push-left': 'Push left',
  'push-right': 'Push right',
  'push-up': 'Push up',
  'push-down': 'Push down',
  'card-flip': 'Card flip',
  'spin-in': 'Spin in',
});

// The shape wipes take an edge color: a band drawn around the growing shape.
export const MUSIC_VIDEO_EDGED_WIPES = MUSIC_VIDEO_WIPE_GROUPS.shapes;

// How long a wipe runs, in seconds: the picker's choices, its bounds and the default.
export const MUSIC_VIDEO_WIPE_LENGTHS = Object.freeze([0.125, 0.25, 0.5, 1]);
export const MUSIC_VIDEO_WIPE_SEC = Object.freeze({ min: 0.04, max: 2, default: 0.25 });

const isWipe = (style) => MUSIC_VIDEO_WIPES.includes(style);
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A shot's wipe on one side (`'in'` or `'out'`) with its settings filled in,
 * `{ style, lengthSec, color? }`, or null when it has none. `color` is
 * `rrggbb` and only kept for a shape wipe.
 */
export function sceneWipe(scene, side) {
  const wipe = scene?.[side === 'in' ? 'wipeIn' : 'wipeOut'];
  if (!wipe || !isWipe(wipe.style)) return null;
  const length = Number(wipe.lengthSec);
  return {
    style: wipe.style,
    lengthSec: Number.isFinite(length) && length > 0 ? Math.min(MUSIC_VIDEO_WIPE_SEC.max, Math.max(MUSIC_VIDEO_WIPE_SEC.min, length)) : MUSIC_VIDEO_WIPE_SEC.default,
    ...(MUSIC_VIDEO_EDGED_WIPES.includes(wipe.style) && typeof wipe.color === 'string' && HEX.test(wipe.color) ? { color: wipe.color.slice(1).toLowerCase() } : {}),
  };
}

/** A wipe's progress (0..1, exclusive) on its frame `index` of `frames`: the cut frame already shows a little of the incoming shot. */
export const wipeProgress = (index, frames) => (index + 1) / (frames + 1);

/**
 * The wipes on a cut timeline. `pieces` are its sections in order,
 * `{ sceneId, startFrame, endFrame, partner?, wipeIn?, wipeOut?, transitionOut?, cutEffect? }`
 * on one frame grid (`wipeIn`/`wipeOut` as `sceneWipe` returns them). A wipe plays
 * on the cut out of a shot's last piece into the next shot's first; an intercut
 * partner piece on either side carries none, and neither does the video's
 * first or last frame. Returns `[{ index, cutFrame, frames, style, color? }]`
 * with `index` the outgoing piece; `frames` never runs past the incoming piece.
 */
export function wipeCuts(pieces, { fps }) {
  const list = Array.isArray(pieces) ? pieces : [];
  const firstOf = new Map();
  const lastOf = new Map();
  list.forEach((piece, i) => {
    if (!piece || piece.partner) return;
    if (!firstOf.has(piece.sceneId)) firstOf.set(piece.sceneId, i);
    lastOf.set(piece.sceneId, i);
  });
  const out = [];
  for (let i = 0; i < list.length - 1; i++) {
    const from = list[i];
    const to = list[i + 1];
    if (!from || !to || from.partner || to.partner || from.sceneId === to.sceneId) continue;
    if (lastOf.get(from.sceneId) !== i || firstOf.get(to.sceneId) !== i + 1) continue;
    // A cut effect on the outgoing shot owns the cut, and so does its glitch out.
    if (from.cutEffect?.enabled) continue;
    const wipe = from.wipeOut || (from.transitionOut ? null : to.wipeIn);
    if (!wipe || !isWipe(wipe.style)) continue;
    const span = to.endFrame - to.startFrame;
    if (!(span > 0)) continue;
    const frames = Math.min(span, Math.max(1, Math.round((wipe.lengthSec ?? MUSIC_VIDEO_WIPE_SEC.default) * fps)));
    out.push({ index: i, cutFrame: to.startFrame, frames, style: wipe.style, ...(wipe.color ? { color: wipe.color } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The definition: expression trees. A node is a number, a variable name
// ('u', 'v', 'a', 'p') or `[op, ...args]`. Builders fold constants so a move
// that only translates carries no rotation terms.

const isNum = (n) => typeof n === 'number';
const add = (a, b) => (isNum(a) && isNum(b) ? a + b : a === 0 ? b : b === 0 ? a : ['+', a, b]);
const sub = (a, b) => (isNum(a) && isNum(b) ? a - b : b === 0 ? a : ['-', a, b]);
const mul = (a, b) => (isNum(a) && isNum(b) ? a * b : a === 0 || b === 0 ? 0 : a === 1 ? b : b === 1 ? a : ['*', a, b]);
const div = (a, b) => (isNum(a) && isNum(b) ? a / b : b === 1 ? a : ['/', a, b]);
const fn = (name) => (...args) => [name, ...args];
const [abs, min, max, mod, atan2, sqrt, floor, lt, gte, gt, when] = ['abs', 'min', 'max', 'mod', 'atan2', 'sqrt', 'floor', 'lt', 'gte', 'gt', 'if'].map(fn);
const cos = (a) => (isNum(a) ? Math.cos(a) : ['cos', a]);
const sin = (a) => (isNum(a) ? Math.sin(a) : ['sin', a]);
const minOf = (list) => list.reduce((acc, n) => min(acc, n));
const maxOf = (list) => list.reduce((acc, n) => max(acc, n));

// Position in frame-height units from the centre: x right, y down; `up` is y flipped.
const X = mul(sub('u', 0.5), 'a');
const Y = sub('v', 0.5);
const UP = mul(Y, -1);
const R = sqrt(add(mul(X, X), mul(UP, UP)));
const TAU = Math.PI * 2;
// Never reached: a point outside every part of a shape at any scale.
const FAR = 1000;

// The scale at which a point first falls inside a convex part, the part grown about the frame's centre.
// A box centred on the centre, half-widths hx, hy:
const boxGauge = (hx, hy) => max(div(abs(X), hx), div(abs(UP), hy));
// A square turned 45 degrees (a diamond) centred at (cx, cy), `h` from centre to corner; the centre must lie inside.
const diamondGauge = (cx, cy, h) => maxOf([[1, 1], [1, -1], [-1, 1], [-1, -1]]
  .map(([sx, sy]) => div(add(mul(X, sx), mul(UP, sy)), sx * cx + sy * cy + h)));
// A disk at (cx, cy), radius r: the least s > 0 with |q - s c| <= s r.
function diskGauge(cx, cy, r) {
  const A = cx * cx + cy * cy - r * r;
  const B = add(mul(X, cx), mul(UP, cy));
  const disc = sub(mul(B, B), mul(A, add(mul(X, X), mul(UP, UP))));
  const s = div(sub(B, sqrt(max(disc, 0))), A);
  // A disk around the centre always holds the point at some scale; one beside it only along its own cone.
  return A < 0 ? s : when(mul(gte(disc, 0), gt(B, 0)), s, FAR);
}

// A five-point star (points up): radius over the edge's radius in that direction.
function starLevel(inner = 0.45) {
  const m = TAU / 5;
  const [x2, y2] = [inner * Math.cos(m / 2), inner * Math.sin(m / 2)];
  const len = Math.hypot(x2 - 1, y2);
  const [nx, ny] = [y2 / len, -(x2 - 1) / len];
  const d = nx; // the edge's distance from the centre (normal . (1, 0))
  const alpha = Math.atan2(ny, nx);
  const phi = sub(m / 2, abs(sub(mod(atan2(X, UP), m), m / 2)));
  return div(mul(R, cos(sub(phi, alpha))), d);
}

// The heart: a diamond with a disk on each upper side.
function heartLevel() {
  const [cy, h] = [-0.12, 0.42];
  const r = (h * Math.SQRT2) / 2;
  return minOf([diamondGauge(0, cy, h), diskGauge(-h / 2, cy + h / 2, r), diskGauge(h / 2, cy + h / 2, r)]);
}

// A paw print: a three-lobed pad under four toes.
const pawLevel = () => minOf([
  diskGauge(0, -0.1, 0.27), diskGauge(-0.15, -0.2, 0.18), diskGauge(0.15, -0.2, 0.18),
  diskGauge(-0.37, 0.2, 0.11), diskGauge(-0.13, 0.36, 0.12), diskGauge(0.13, 0.36, 0.12), diskGauge(0.37, 0.2, 0.11),
]);

// A dog bone: a bar with two knobs on each end.
const boneLevel = () => minOf([boxGauge(0.4, 0.075), diskGauge(-0.4, 0.09, 0.11), diskGauge(-0.4, -0.09, 0.11), diskGauge(0.4, 0.09, 0.11), diskGauge(0.4, -0.09, 0.11)]);

// Moves ease in and out.
const EASED = mul(mul('p', 'p'), sub(3, mul(2, 'p')));
const layer = (src, { show = 1, tx = 0, ty = 0, sx = 1, sy = 1, rot = 0 } = {}) => ({ src, show, tx, ty, sx, sy, rot });

const LEVELS = {
  iris: () => R,
  star: () => starLevel(),
  heart: () => heartLevel(),
  diamond: () => add(abs(sub('u', 0.5)), abs(sub('v', 0.5))),
  paw: () => pawLevel(),
  bone: () => boneLevel(),
  'blinds-h': () => mod(mul('v', 8), 1),
  'blinds-v': () => mod(mul('u', 8), 1),
  checker: (aspect) => {
    const rows = 6;
    const cols = Math.max(1, Math.round(rows * aspect));
    const parity = mod(add(floor(mul('u', cols)), floor(mul('v', rows))), 2);
    return div(add(parity, mod(mul('u', cols), 1)), 2);
  },
  clock: () => div(mod(atan2(X, UP), TAU), TAU),
  'barn-doors': () => mul(abs(sub('u', 0.5)), 2),
};

const MOVES = {
  'push-left': () => [layer('out', { tx: mul(EASED, -1) }), layer('in', { tx: sub(1, EASED) })],
  'push-right': () => [layer('out', { tx: EASED }), layer('in', { tx: sub(EASED, 1) })],
  'push-up': () => [layer('out', { ty: mul(EASED, -1) }), layer('in', { ty: sub(1, EASED) })],
  'push-down': () => [layer('out', { ty: EASED }), layer('in', { ty: sub(EASED, 1) })],
  // A DVE card turning on its vertical axis: the outgoing side narrows to an edge, the incoming one opens from it.
  'card-flip': () => [
    layer('out', { show: lt(EASED, 0.5), sx: cos(mul(EASED, Math.PI)) }),
    layer('in', { show: gte(EASED, 0.5), sx: mul(cos(mul(EASED, Math.PI)), -1) }),
  ],
  // The incoming picture spins in from a point at the centre, half a turn, over the outgoing one.
  'spin-in': () => [layer('out'), layer('in', { sx: max(EASED, 0.001), sy: max(EASED, 0.001), rot: mul(sub(1, EASED), Math.PI) })],
};

/**
 * Compile an expression tree into a function of `{ u, v, a, p }`. Self-contained
 * (no outside names), so a document runtime can carry its source text.
 */
export function compileWipeNode(node) {
  const OPS = {
    '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b,
    abs: Math.abs, min: Math.min, max: Math.max, atan2: Math.atan2, cos: Math.cos, sin: Math.sin, sqrt: Math.sqrt, floor: Math.floor,
    // As ffmpeg's: never negative for a positive divisor.
    mod: (a, b) => a - b * Math.floor(a / b),
    lt: (a, b) => (a < b ? 1 : 0), gte: (a, b) => (a >= b ? 1 : 0), gt: (a, b) => (a > b ? 1 : 0),
  };
  const go = (n) => {
    if (typeof n === 'number') return () => n;
    if (typeof n === 'string') return (env) => env[n];
    const [name, ...rest] = n;
    const args = rest.map(go);
    if (name === 'if') { const [c, a, b] = args; return (env) => (c(env) ? a(env) : b(env)); }
    const f = OPS[name];
    if (!f) throw new Error(`Unknown wipe operation ${name}`);
    if (args.length === 1) { const [a] = args; return (env) => f(a(env)); }
    const [a, b] = args;
    return (env) => f(a(env), b(env));
  };
  return go(node);
}

const levelMax = new Map();
// The level's largest value over the frame, sampled on a fine grid with a little margin, so `p = 1` covers every pixel.
function largestLevel(style, aspect, level) {
  const key = `${style}:${aspect.toFixed(4)}`;
  if (levelMax.has(key)) return levelMax.get(key);
  const f = compileWipeNode(level);
  let top = 0;
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) top = Math.max(top, f({ u: i / steps, v: j / steps, a: aspect, p: 0 }));
  }
  const value = Math.round(top * 1.02 * 1e6) / 1e6;
  levelMax.set(key, value);
  return value;
}

/**
 * A style's definition for a frame of `aspect` (width / height), plain data:
 * `{ style, kind: 'level', level, top, edged }` (the incoming shot shows where
 * `level < p * top`) or `{ style, kind: 'move', layers: [{ src, show, tx, ty, sx, sy, rot }] }`
 * bottom first. Null for an unknown style.
 */
export function wipeDefinition(style, aspect = 16 / 9) {
  if (LEVELS[style]) {
    const level = LEVELS[style](aspect);
    return { style, kind: 'level', level, top: largestLevel(style, aspect, level), edged: MUSIC_VIDEO_EDGED_WIPES.includes(style) };
  }
  if (MOVES[style]) return { style, kind: 'move', layers: MOVES[style]() };
  return null;
}

// The edge band past the shape's boundary, in level units: it widens a little as the shape grows.
const EDGE_GROWTH = 1.08;
const EDGE_BASE = 0.006;

/**
 * What one pixel shows on a wipe frame: `'in'`, `'out'`, `'edge'` (the edge
 * color, when `edged`) or `'black'` (neither picture, e.g. a card on its edge).
 * `u`, `v` are the pixel centre in 0..1. A test hook: the tests check the
 * render's filter and each style's coverage against it.
 */
export function _wipePixel(definition, { u, v, p, aspect, edged = false }) {
  const env = { u, v, a: aspect, p };
  if (p >= 1) return 'in';
  if (definition.kind === 'level') {
    const level = compileWipeNode(definition.level)(env);
    const thr = p * definition.top;
    if (level < thr) return 'in';
    if (edged && definition.edged && level < thr * EDGE_GROWTH + EDGE_BASE) return 'edge';
    return 'out';
  }
  for (let i = definition.layers.length - 1; i >= 0; i--) {
    const l = definition.layers[i];
    const at = (n) => compileWipeNode(n)(env);
    if (!at(l.show)) continue;
    const [su, sv] = layerSource({ u, v, aspect, tx: at(l.tx), ty: at(l.ty), sx: at(l.sx), sy: at(l.sy), rot: at(l.rot) });
    if (su >= 0 && su < 1 && sv >= 0 && sv < 1) return l.src;
  }
  return 'black';
}

// Where a layer's source pixel comes from: the inverse of the canvas's translate, rotate, scale about the centre.
function layerSource({ u, v, aspect, tx, ty, sx, sy, rot }) {
  const dx = (u - 0.5 - tx) * aspect;
  const dy = v - 0.5 - ty;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [((dx * c + dy * s) / sx) / aspect + 0.5, (-dx * s + dy * c) / sy + 0.5];
}

// ---------------------------------------------------------------------------
// ffmpeg

const literal = (n) => {
  const s = String(Math.round(n * 1e6) / 1e6);
  return n < 0 ? `(${s})` : s;
};

/** An expression tree as an ffmpeg expression; `vars` maps variable names to expressions. */
function wipeNodeExpr(node, vars) {
  if (typeof node === 'number') return literal(node);
  if (typeof node === 'string') {
    if (!(node in vars)) throw new Error(`Unknown wipe variable ${node}`);
    return vars[node];
  }
  const [name, ...rest] = node;
  const args = rest.map((n) => wipeNodeExpr(n, vars));
  if (['+', '-', '*', '/'].includes(name)) return `(${args[0]}${name}${args[1]})`;
  return `${name}(${args.join(',')})`;
}

/**
 * The grid a wipe's masks are worked out on, smoothed up to the frame by both
 * players: a quarter of the frame's width, at most 480 cells across, so a
 * shape's edge reads the same soft line in the render and on a canvas.
 */
function wipeMaskGrid(width, height) {
  const columns = Math.max(16, Math.min(480, Math.round(width / 4)));
  return { columns, rows: Math.max(9, Math.round((columns * height) / width)) };
}

/**
 * The filters that lay a wipe over the start of the incoming shot, as
 * filter_complex entries. `outgoing` is the outgoing shot's last frame held for
 * at least `wipe.frames` frames, `incoming` the incoming shot from its first
 * frame; `out` carries the incoming shot's full length with the wipe on its
 * first `wipe.frames` frames. Masks and move maps are drawn by `geq` on the
 * small grid (`wipeMaskGrid`) and scaled up, so the per-pixel definition runs
 * on a few thousand cells a frame and the full frame only meets native filters.
 */
export function musicVideoWipeFilter(wipe, { width, height, fps, outgoing, incoming, out, key }) {
  const aspect = width / height;
  const definition = wipeDefinition(wipe?.style, aspect);
  const frames = wipe?.frames;
  if (!definition || !(frames > 0)) return null;
  const { columns, rows } = wipeMaskGrid(width, height);
  const p = `((min(N,${frames})+1)/${frames + 1})`;
  const e = (node) => wipeNodeExpr(node, { u: '((X+0.5)/W)', v: '((Y+0.5)/H)', a: literal(aspect), p });
  const span = `trim=end_frame=${frames},setpts=PTS-STARTPTS`;
  // A per-cell picture on the small grid, scaled up to the frame.
  const grid = (format, expr, label) => `color=c=black:s=${columns}x${rows}:r=${fps},${span},format=${format},geq=lum='${expr}',scale=${width}:${height}:flags=bilinear[${label}]`;
  const id = (name) => `w${name}${key}`;
  const filters = [];
  if (definition.kind === 'level') {
    const level = e(definition.level);
    const thr = `(${p}*${literal(definition.top)})`;
    const edged = definition.edged && typeof wipe.color === 'string' && HEX.test(`#${wipe.color}`);
    const outer = edged ? `(${thr}*${EDGE_GROWTH}+${EDGE_BASE})` : thr;
    // The outgoing shot stays where the level has not reached its threshold (or the edge band past it).
    filters.push(grid('gray', `255*gte(${level},${outer})`, id('mo')));
    filters.push(`[${outgoing}]${span},format=yuv420p,setsar=1[${id('o')}]`, `[${id('o')}][${id('mo')}]alphamerge[${id('oa')}]`);
    let base = incoming;
    if (edged) {
      filters.push(grid('gray', `255*gte(${level},${thr})*lt(${level},${outer})`, id('me')));
      filters.push(`color=c=0x${wipe.color}:s=${width}x${height}:r=${fps},${span},format=yuv420p[${id('c')}]`, `[${id('c')}][${id('me')}]alphamerge[${id('ca')}]`);
      filters.push(`[${incoming}][${id('ca')}]overlay=eof_action=pass[${id('e')}]`);
      base = id('e');
    }
    filters.push(`[${base}][${id('oa')}]overlay=eof_action=pass[${out}]`);
    return filters;
  }
  // A move: both pictures placed by their maps on black, the composite laid over the shot's first frames.
  filters.push(`[${incoming}]split[${id('ia')}][${id('ib')}]`);
  filters.push(`color=c=black:s=${width}x${height}:r=${fps},${span},format=yuv420p[${id('k')}]`);
  let base = id('k');
  definition.layers.forEach((l, n) => {
    const source = l.src === 'in' ? `[${id('ib')}]${span},` : `[${outgoing}]${span},`;
    const shows = isNum(l.show) ? (l.show ? '' : '0*') : `${e(l.show)}*`;
    const dx = mul(sub(sub('u', 0.5), l.tx), 'a');
    const dy = sub(sub('v', 0.5), l.ty);
    const su = add(div(div(add(mul(dx, cos(l.rot)), mul(dy, sin(l.rot))), l.sx), 'a'), 0.5);
    const sv = add(div(sub(mul(dy, cos(l.rot)), mul(dx, sin(l.rot))), l.sy), 0.5);
    const inside = `${shows}gte(${e(su)},0)*lt(${e(su)},1)*gte(${e(sv)},0)*lt(${e(sv)},1)`;
    filters.push(grid('gray', `255*${inside}`, id(`m${n}`)));
    const identity = l.tx === 0 && l.ty === 0 && l.sx === 1 && l.sy === 1 && l.rot === 0;
    if (identity) {
      filters.push(`${source}format=yuv420p,setsar=1[${id(`l${n}`)}]`);
    } else {
      filters.push(grid('gray16le', `clip(${e(su)}*${width},0,${width - 1})`, id(`x${n}`)));
      filters.push(grid('gray16le', `clip(${e(sv)}*${height},0,${height - 1})`, id(`y${n}`)));
      filters.push(`${source}format=gbrp,setsar=1[${id(`s${n}`)}]`, `[${id(`s${n}`)}][${id(`x${n}`)}][${id(`y${n}`)}]remap,format=yuv420p[${id(`l${n}`)}]`);
    }
    filters.push(`[${id(`l${n}`)}][${id(`m${n}`)}]alphamerge[${id(`la${n}`)}]`, `[${base}][${id(`la${n}`)}]overlay[${id(`b${n}`)}]`);
    base = id(`b${n}`);
  });
  filters.push(`[${id('ia')}][${base}]overlay=eof_action=pass[${out}]`);
  return filters;
}

// ---------------------------------------------------------------------------
// Canvas

/**
 * A wipe painter for the browser, self-contained so a document runtime can
 * carry its source. `definitions(style, aspect)` gives a style's definition
 * (`wipeDefinition`), `compile` is `compileWipeNode`. The returned
 * `paint(ctx, { outgoing, incoming, style, index, frames, color?, width, height })`
 * draws frame `index` of the wipe (`color` as `rrggbb` or `#rrggbb`): `outgoing` and `incoming` are drawables
 * already fitted to the frame (`width` x `height`).
 */
export function createMusicVideoWipePainter({ definitions, compile }) {
  const compiled = new Map();
  const scratch = new Map();
  const canvasOf = (key, w, h) => {
    let c = scratch.get(key);
    if (!c) { c = document.createElement('canvas'); scratch.set(key, c); }
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return c;
  };
  const definitionFor = (style, aspect) => {
    const key = `${style}:${aspect.toFixed(4)}`;
    if (!compiled.has(key)) {
      const d = definitions(style, aspect);
      if (!d) return null;
      compiled.set(key, d.kind === 'level' ? { ...d, f: compile(d.level) }
        : { ...d, layers: d.layers.map((l) => ({ ...l, at: Object.fromEntries(['show', 'tx', 'ty', 'sx', 'sy', 'rot'].map((k) => [k, compile(l[k])])) })) });
    }
    return compiled.get(key);
  };
  // The mask for the incoming shot (and the edge band) on a small grid, smoothed up to the frame.
  function masks(d, p, aspect, width, edged) {
    // The render's grid (wipeMaskGrid): a quarter of the width, at most 480 cells.
    const mw = Math.max(16, Math.min(480, Math.round(width / 4)));
    const mh = Math.max(9, Math.round(mw / aspect));
    const inMask = canvasOf('in-mask', mw, mh);
    const edgeMask = canvasOf('edge-mask', mw, mh);
    const inData = new ImageData(mw, mh);
    const edgeData = new ImageData(mw, mh);
    const thr = p * d.top;
    const env = { u: 0, v: 0, a: aspect, p };
    let anyEdge = false;
    for (let y = 0; y < mh; y++) {
      env.v = (y + 0.5) / mh;
      for (let x = 0; x < mw; x++) {
        env.u = (x + 0.5) / mw;
        const level = d.f(env);
        const i = (y * mw + x) * 4 + 3;
        if (level < thr) inData.data[i] = 255;
        else if (edged && level < thr * 1.08 + 0.006) { edgeData.data[i] = 255; anyEdge = true; }
      }
    }
    inMask.getContext('2d').putImageData(inData, 0, 0);
    if (anyEdge) edgeMask.getContext('2d').putImageData(edgeData, 0, 0);
    return { inMask, edgeMask: anyEdge ? edgeMask : null };
  }
  function masked(key, width, height, fill, mask) {
    const c = canvasOf(key, width, height);
    const g = c.getContext('2d');
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, width, height);
    fill(g);
    g.globalCompositeOperation = 'destination-in';
    g.imageSmoothingEnabled = true;
    g.drawImage(mask, 0, 0, width, height);
    g.globalCompositeOperation = 'source-over';
    return c;
  }
  return function paint(ctx, { outgoing, incoming, style, index, frames, color = null, width, height }) {
    const aspect = width / height;
    const d = definitionFor(style, aspect);
    if (!d || !(frames > 0)) return false;
    const p = (index + 1) / (frames + 1);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (d.kind === 'level') {
      const edged = !!color && d.edged;
      const { inMask, edgeMask } = masks(d, p, aspect, width, edged);
      if (outgoing) ctx.drawImage(outgoing, 0, 0, width, height);
      if (edgeMask) ctx.drawImage(masked('edge', width, height, (g) => { g.fillStyle = `#${String(color).replace(/^#/, '')}`; g.fillRect(0, 0, width, height); }, edgeMask), 0, 0);
      if (incoming) ctx.drawImage(masked('incoming', width, height, (g) => g.drawImage(incoming, 0, 0, width, height), inMask), 0, 0);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      const env = { u: 0.5, v: 0.5, a: aspect, p };
      for (const l of d.layers) {
        const src = l.src === 'in' ? incoming : outgoing;
        if (!src || !l.at.show(env)) continue;
        const sx = l.at.sx(env);
        const sy = l.at.sy(env);
        if (Math.abs(sx) < 1e-4 || Math.abs(sy) < 1e-4) continue;
        ctx.save();
        ctx.translate(width / 2 + l.at.tx(env) * width, height / 2 + l.at.ty(env) * height);
        ctx.rotate(l.at.rot(env));
        ctx.scale(sx, sy);
        ctx.drawImage(src, -width / 2, -height / 2, width, height);
        ctx.restore();
      }
    }
    ctx.restore();
    return true;
  };
}

/**
 * The painter as source text for a sandboxed document host (no network
 * import): sets `globalThis.__portosMusicVideoWipe` to `paint`.
 */
export function musicVideoWipeRuntime() {
  // The definitions are data: every style for the three frame shapes a document renders at.
  const table = {};
  for (const aspect of [16 / 9, 9 / 16, 1]) {
    for (const style of MUSIC_VIDEO_WIPES) table[`${style}:${aspect.toFixed(4)}`] = wipeDefinition(style, aspect);
  }
  return `globalThis.__portosMusicVideoWipe = (${createMusicVideoWipePainter.toString()})({ compile: ${compileWipeNode.toString()}, `
    + `definitions: (() => { const table = ${JSON.stringify(table)}; return (style, aspect) => table[style + ':' + aspect.toFixed(4)] || null; })() });`;
}

/**
 * Wipe styles for a run of `count` cuts with no style twice in a row (and,
 * while there are enough styles, none repeated within the run), starting
 * after `previous`. `styles` defaults to every wipe; `seed` varies the order.
 */
export function varyWipes(count, { styles = MUSIC_VIDEO_WIPES, previous = null, seed = 1 } = {}) {
  const pool = styles.filter(isWipe);
  if (!pool.length || !(count > 0)) return [];
  let state = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  const random = () => { state = (state * 48271) % 2147483647; return state / 2147483647; };
  const out = [];
  let deck = [];
  let last = previous;
  while (out.length < count) {
    if (!deck.length) {
      deck = [...pool];
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      // A fresh deck never opens with the style that closed the last one.
      if (deck.length > 1 && deck[0] === last) [deck[0], deck[1]] = [deck[1], deck[0]];
    }
    const next = deck.shift();
    out.push(next);
    last = next;
  }
  return out;
}
