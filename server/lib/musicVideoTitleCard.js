/**
 * Music Video — the opening title card: the small credit block an MTV video
 * opens with (song title, artist, year), fading in over the opener and out
 * again. One record on the project (`project.titleCard`, null = none) drives
 * the composition live preview and the final render alike.
 *
 * The card is not part of the composition document (documents are immutable
 * versions the director may have authored); `titleCardRuntimeSource()` is a
 * page script installed beside the document — in the preview's head and in
 * every render browser (`documentRenderInitScripts`) — that draws the card on
 * its own canvas above the page, re-drawn for every seek. It follows the
 * shared lyric type (lyricType.js): cream fill with an ink outline, no plate,
 * inside the same title-safe insets, so it reads like the lyrics.
 *
 * Every frame is a pure function of song time. Browser-safe, no imports.
 */

export const TITLE_CARD_POSITIONS = Object.freeze(['lower-left', 'lower-right', 'upper-left', 'upper-right', 'lower-center', 'center']);
export const TITLE_CARD_FONTS = Object.freeze(['display', 'sans', 'serif', 'mono']);
export const TITLE_CARD_LIMITS = Object.freeze({
  textMax: 120, yearMax: 20, startMax: 600, windowMin: 0.5, fadeMax: 3, sizeMin: 50, sizeMax: 200,
});
export const TITLE_CARD_DEFAULTS = Object.freeze({
  enabled: true, title: '', artist: '', year: '', extra: '', quoteTitle: true,
  startSec: 2, endSec: 8, fadeSec: 0.8, position: 'lower-left', font: 'display', size: 100, color: '#f3ead7',
});

const clampNum = (value, min, max, fallback) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
};
const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * A stored title card from any input (null for none). Missing fields take
 * TITLE_CARD_DEFAULTS; the window keeps at least TITLE_CARD_LIMITS.windowMin.
 */
export function normalizeTitleCard(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const D = TITLE_CARD_DEFAULTS;
  const L = TITLE_CARD_LIMITS;
  const startSec = round3(clampNum(input.startSec, 0, L.startMax, D.startSec));
  const endSec = round3(Math.max(startSec + L.windowMin, clampNum(input.endSec, 0, L.startMax + 60, Math.max(D.endSec, startSec + 6))));
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : D.enabled,
    title: cleanText(input.title, L.textMax),
    artist: cleanText(input.artist, L.textMax),
    year: cleanText(input.year, L.yearMax),
    extra: cleanText(input.extra, L.textMax),
    quoteTitle: typeof input.quoteTitle === 'boolean' ? input.quoteTitle : D.quoteTitle,
    startSec,
    endSec,
    fadeSec: round3(clampNum(input.fadeSec, 0, L.fadeMax, D.fadeSec)),
    position: TITLE_CARD_POSITIONS.includes(input.position) ? input.position : D.position,
    font: TITLE_CARD_FONTS.includes(input.font) ? input.font : D.font,
    size: Math.round(clampNum(input.size, L.sizeMin, L.sizeMax, D.size)),
    color: typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toLowerCase() : D.color,
  };
}

/** True when the card would draw something (enabled, with at least one line). */
export function titleCardVisible(card) {
  return !!(card && card.enabled && [card.title, card.artist, card.year, card.extra].some((line) => String(line || '').trim()));
}

/**
 * The default window for a new card: in a couple of seconds after the song
 * starts, out half a second before the first sung line (so it never shares the
 * screen with a lyric), held 3–6 seconds. With vocals that start almost at
 * once it still holds 3 seconds from 0.5s; the panel then flags the overlap.
 */
function defaultTitleCardTiming(firstLyricSec = null) {
  const first = typeof firstLyricSec === 'number' && Number.isFinite(firstLyricSec) && firstLyricSec > 0 ? firstLyricSec : null;
  if (first == null || first >= 9) return { startSec: 2, endSec: 8 };
  const startSec = first >= 5 ? 1.5 : 0.5;
  return { startSec, endSec: round3(Math.max(startSec + 3, first - 0.5)) };
}

/** The defaults a freshly enabled card is filled from: song title (version suffix dropped), artist, year. */
export function titleCardPrefill(project, { artist = '', year = new Date().getFullYear(), firstLyricSec = null } = {}) {
  const name = typeof project?.name === 'string' ? project.name.replace(/\s+v\d+$/i, '').trim() : '';
  return normalizeTitleCard({ ...defaultTitleCardTiming(firstLyricSec), title: name, artist, year: year ? String(year) : '' });
}

/* The three functions below are inlined into sandboxed pages by toString()
 * (titleCardRuntimeSource), so each must stay self-contained: no references
 * to module scope, only to each other by name. */

/** The card's opacity at song time t: a linear fade in and out inside its window (0 outside). */
function titleCardAlpha(card, t) {
  if (!card || !card.enabled || !(t >= card.startSec) || !(t < card.endSec)) return 0;
  const fade = Math.min(Math.max(0, card.fadeSec || 0), (card.endSec - card.startSec) / 2);
  if (fade <= 0) return 1;
  return Math.max(0, Math.min(1, (t - card.startSec) / fade, (card.endSec - t) / fade));
}

/**
 * The card's lines placed on a width × height frame: `[{ text, font, px, x, y,
 * align, outline }]` (y is the alphabetic baseline). The title is the first,
 * larger line; artist, year and the extra line follow. A block wider than its
 * zone shrinks as a whole, so the card never runs off frame. `measure(text,
 * font)` returns a width in pixels. Pure.
 */
function titleCardLayout(card, { width, height, measure }) {
  const stacks = {
    display: ['"MV Archivo", "Arial Black", Impact, sans-serif', 800, 600],
    sans: ['"Helvetica Neue", Helvetica, Arial, sans-serif', 700, 400],
    serif: ['Georgia, "Times New Roman", serif', 700, 400],
    mono: ['"MV Mono", Menlo, Consolas, monospace', 500, 500],
  };
  const [family, titleWeight, metaWeight] = stacks[card.font] || stacks.display;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const title = clean(card.title);
  const rows = [];
  if (title) rows.push({ text: card.quoteTitle ? `“${title}”` : title, title: true });
  for (const key of ['artist', 'year', 'extra']) if (clean(card[key])) rows.push({ text: clean(card[key]), title: false });
  if (!rows.length) return [];
  const unit = Math.min(width, height) / 1080;
  const scale = (Number(card.size) || 100) / 100;
  const insetX = Math.max(72 * unit, width * 0.06);
  const insetY = Math.max(72 * unit, height * 0.07);
  const position = card.position || 'lower-left';
  const centered = position === 'center' || position === 'lower-center';
  const portrait = height > width;
  const maxW = centered || portrait ? width - 2 * insetX : width * 0.62;
  const fontOf = (row, px) => `${row.title ? titleWeight : metaWeight} ${Math.floor(px * 100) / 100}px ${family}`;
  const baseOf = (row) => (row.title ? 50 : 36) * unit * scale;
  const widest = Math.max(...rows.map((row) => measure(row.text, fontOf(row, baseOf(row)))));
  const fit = widest > maxW && widest > 0 ? maxW / widest : 1;
  const sized = rows.map((row) => ({ ...row, px: baseOf(row) * fit }));
  const lineH = (row) => row.px * (row.title ? 1.18 : 1.3);
  const blockH = sized.reduce((sum, row) => sum + lineH(row), 0);
  let top;
  if (position === 'center') top = (height - blockH) / 2;
  else if (position.startsWith('upper')) top = insetY;
  else top = height - insetY - blockH;
  const align = centered ? 'center' : position.endsWith('right') ? 'right' : 'left';
  const x = align === 'left' ? insetX : align === 'right' ? width - insetX : width / 2;
  const out = [];
  let y = top;
  for (const row of sized) {
    y += lineH(row);
    // The baseline sits a little above the line box's foot, leaving room for descenders.
    out.push({ text: row.text, font: fontOf(row, row.px), px: row.px, x, y: y - row.px * (row.title ? 0.24 : 0.3), align, outline: Math.max(2, row.px * (row.title ? 0.15 : 0.12)) });
  }
  return out;
}

/** Draw the card at song time t onto a 2D context (nothing outside its window). */
function drawTitleCard(ctx, card, t, { width, height }) {
  const alpha = titleCardAlpha(card, t);
  if (!(alpha > 0)) return false;
  const measure = (text, font) => { ctx.font = font; return ctx.measureText(text).width; };
  const lines = titleCardLayout(card, { width, height, measure });
  if (!lines.length) return false;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  for (const line of lines) {
    ctx.font = line.font;
    ctx.textAlign = line.align;
    ctx.lineWidth = line.outline;
    ctx.strokeStyle = '#141217';
    ctx.strokeText(line.text, line.x, line.y);
    ctx.fillStyle = card.color || '#f3ead7';
    ctx.fillText(line.text, line.x, line.y);
  }
  ctx.restore();
  return true;
}

/**
 * A browser script that draws a card over the page it runs in: installed in
 * the composition live preview and in the final render's browsers before the
 * document's own scripts. It exposes `window.__portosTitleCard`:
 *
 *   apply(card)   put a (normalized) card on the page, or null to clear it
 *   draw(t)       redraw for song time t
 *   layout()      the lines as placed on the render frame (for checks)
 *   card          the card currently applied
 *
 * It wraps `globalThis.portosComposition.seek(t)` (chaining any accessor an
 * earlier init script installed, such as the film look's) so the card is drawn
 * for the frame before the document paints, after its faces have loaded. The
 * canvas is fixed over the viewport, fitted to the render's aspect, and sits
 * under the film look's root filter like the lyrics do.
 */
export function titleCardRuntimeSource(card = null) {
  return `(() => {
  ${titleCardAlpha.toString()}
  ${titleCardLayout.toString()}
  ${drawTitleCard.toString()}
  let card = ${JSON.stringify(normalizeTitleCard(card)).replace(/</g, '\\u003c')};
  let t = 0;
  let canvas = null;
  const fonts = new Map();
  const frame = () => {
    const r = globalThis.PORTOS_MV && globalThis.PORTOS_MV.render;
    return { width: (r && r.width) || innerWidth || 1920, height: (r && r.height) || innerHeight || 1080 };
  };
  // Resolves once the card's faces are loaded; null when they already are (the seek stays synchronous).
  const ready = () => {
    if (!card || !card.enabled || !document.fonts || !document.fonts.load) return null;
    const { width, height } = frame();
    const wanted = titleCardLayout(card, { width, height, measure: () => 0 }).map((line) => line.font);
    const pending = [];
    for (const font of wanted) {
      if (!fonts.has(font)) {
        const entry = { done: false };
        entry.promise = document.fonts.load(font).catch(() => null).then(() => { entry.done = true; });
        fonts.set(font, entry);
      }
      const entry = fonts.get(font);
      if (!entry.done) pending.push(entry.promise);
    }
    return pending.length ? Promise.all(pending) : null;
  };
  const draw = () => {
    if (!document.body) return;
    const on = card && titleCardAlpha(card, t) > 0;
    if (!on) { if (canvas) canvas.style.display = 'none'; return; }
    const { width, height } = frame();
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.dataset.portosTitleCard = '1';
      canvas.setAttribute('aria-hidden', 'true');
    }
    if (!canvas.isConnected) document.body.appendChild(canvas);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const vw = innerWidth || width;
    const vh = innerHeight || height;
    const s = Math.min(vw / width, vh / height);
    canvas.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;'
      + 'left:' + (vw - width * s) / 2 + 'px;top:' + (vh - height * s) / 2 + 'px;width:' + width * s + 'px;height:' + height * s + 'px';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    drawTitleCard(ctx, card, t, { width, height });
  };
  const api = {
    apply(next) {
      card = next && typeof next === 'object' ? next : null;
      const wait = ready();
      return wait ? wait.then(draw) : (draw(), Promise.resolve());
    },
    draw(at) { t = Number(at) || 0; draw(); },
    /** The current card's lines as drawn on the render frame (positions, fonts, sizes). */
    layout() {
      if (!card) return [];
      const { width, height } = frame();
      const ctx = (canvas || document.createElement('canvas')).getContext('2d');
      return titleCardLayout(card, { width, height, measure: (text, font) => { ctx.font = font; return ctx.measureText(text).width; } });
    },
    get card() { return card; },
  };
  Object.defineProperty(window, '__portosTitleCard', { value: api, configurable: false, writable: false });
  const wrap = (c) => {
    if (!c || typeof c !== 'object' || typeof c.seek !== 'function' || c.__portosTitleCardWrapped) return c;
    const seek = c.seek;
    const wrapped = function(at, ...rest) {
      t = Number(at) || 0;
      const go = () => { draw(); return seek.call(this, at, ...rest); };
      const wait = ready();
      return wait ? wait.then(go) : go();
    };
    try { Object.defineProperty(c, 'seek', { value: wrapped, configurable: true, writable: true }); Object.defineProperty(c, '__portosTitleCardWrapped', { value: true }); }
    catch { return Object.assign(Object.create(c), { seek: wrapped, __portosTitleCardWrapped: true }); }
    return c;
  };
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'portosComposition');
  let own = prior && 'value' in prior ? wrap(prior.value) : undefined;
  Object.defineProperty(globalThis, 'portosComposition', { configurable: true, enumerable: true,
    get() { return prior && prior.get ? prior.get.call(globalThis) : own; },
    set(value) { const next = wrap(value); if (prior && prior.set) prior.set.call(globalThis, next); else own = next; } });
})();`;
}
