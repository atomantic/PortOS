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
 * its own canvas above the page, re-drawn for every seek. Two looks:
 *   - `outline` follows the shared lyric type (lyricType.js): cream fill with
 *     an ink outline, no plate, title first, so it reads like the lyrics;
 *   - `mtv` is the classic 80s lower third: artist over the quoted title in
 *     its own colour, then the extra line and year, on a dark plate with a
 *     coloured bar down its leading edge.
 * Both sit inside the same title-safe insets and shrink to fit the frame.
 * Optionally (`outro`) the same card shows again at the end of the video, in
 * its own window (`outroStartSec`–`outroEndSec`, absolute song time).
 * Text is drawn exactly as typed (no forced case).
 *
 * Fonts: four system/lyric stacks plus bundled OFL faces (TITLE_CARD_FONT_FACES,
 * files in services/musicVideo/titleCardFonts/). The runtime registers the
 * bundled faces from data URLs its caller passes in, so the card draws the same
 * face on every page it rides on, whatever that page itself declares.
 *
 * Every frame is a pure function of song time. Browser-safe, no imports.
 */

export const TITLE_CARD_POSITIONS = Object.freeze(['lower-left', 'lower-right', 'upper-left', 'upper-right', 'lower-center', 'center']);
/**
 * Bundled title-card faces (SIL OFL 1.1, latin subsets from Fontsource): font id
 * → the family the runtime registers and the file it is loaded from. The
 * layout's font stacks name the same families.
 */
export const TITLE_CARD_FONT_FACES = Object.freeze({
  oswald: Object.freeze({ family: 'MV Title Oswald', file: 'oswald-700.woff2' }),
  audiowide: Object.freeze({ family: 'MV Title Audiowide', file: 'audiowide-400.woff2' }),
  orbitron: Object.freeze({ family: 'MV Title Orbitron', file: 'orbitron-700.woff2' }),
  righteous: Object.freeze({ family: 'MV Title Righteous', file: 'righteous-400.woff2' }),
  pacifico: Object.freeze({ family: 'MV Title Pacifico', file: 'pacifico-400.woff2' }),
  playfair: Object.freeze({ family: 'MV Title Playfair', file: 'playfair-display-700.woff2' }),
});
export const TITLE_CARD_FONTS = Object.freeze(['display', 'sans', 'serif', 'mono', ...Object.keys(TITLE_CARD_FONT_FACES)]);
export const TITLE_CARD_STYLES = Object.freeze(['outline', 'mtv']);
/** The `mtv` look's title and bar colours when the card names none. */
export const TITLE_CARD_MTV_COLORS = Object.freeze({ title: '#f5d33a', accent: '#1fc2e5' });
export const TITLE_CARD_LIMITS = Object.freeze({
  textMax: 120, yearMax: 20, startMax: 600, windowMin: 0.5, fadeMax: 3, sizeMin: 50, sizeMax: 200, outroMax: 3600,
});
export const TITLE_CARD_DEFAULTS = Object.freeze({
  enabled: true, title: '', artist: '', year: '', extra: '', quoteTitle: true,
  startSec: 2, endSec: 8, fadeSec: 0.8, position: 'lower-left', font: 'display', size: 100, color: '#f3ead7',
  style: 'outline', titleColor: '', accentColor: '',
  outro: false, outroStartSec: null, outroEndSec: null,
});

const clampNum = (value, min, max, fallback) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
};
const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const round3 = (n) => Math.round(n * 1000) / 1000;
const hexOr = (value, fallback) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback);

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
  // The end showing keeps its window once timed; untimed (null) it shows nowhere.
  const timedOutro = typeof input.outroStartSec === 'number' && Number.isFinite(input.outroStartSec);
  const outroStartSec = timedOutro ? round3(clampNum(input.outroStartSec, 0, L.outroMax, 0)) : null;
  const outroEndSec = timedOutro
    ? round3(Math.max(outroStartSec + L.windowMin, clampNum(input.outroEndSec, 0, L.outroMax + 60, outroStartSec + (endSec - startSec))))
    : null;
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
    color: hexOr(input.color, D.color),
    style: TITLE_CARD_STYLES.includes(input.style) ? input.style : D.style,
    // '' = the look's own colour (the text colour, or the mtv yellow title / cyan bar).
    titleColor: hexOr(input.titleColor, ''),
    accentColor: hexOr(input.accentColor, ''),
    outro: typeof input.outro === 'boolean' ? input.outro : D.outro,
    outroStartSec,
    outroEndSec,
  };
}

/**
 * The windows the card shows in: the opening one, then the end one when it is
 * on and timed. `[{ startSec, endSec }]`, empty for a hidden card.
 */
export function titleCardWindows(card) {
  if (!titleCardVisible(card)) return [];
  const windows = [{ startSec: card.startSec, endSec: card.endSec }];
  if (card.outro && typeof card.outroStartSec === 'number' && typeof card.outroEndSec === 'number') {
    windows.push({ startSec: card.outroStartSec, endSec: card.outroEndSec });
  }
  return windows;
}

/**
 * The end showing's default window: as long as the opening one, ending a
 * second before the song does (never before 0). Null without a song length.
 */
export function titleCardOutroWindow(card, songDurationSec) {
  if (!card || !(typeof songDurationSec === 'number' && songDurationSec > 0)) return null;
  const endSec = round3(Math.max(TITLE_CARD_LIMITS.windowMin, songDurationSec - 1));
  return { outroStartSec: round3(Math.max(0, endSec - (card.endSec - card.startSec))), outroEndSec: endSec };
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

/** The card's opacity at song time t: a linear fade in and out inside its window, or its end window (0 outside). */
function titleCardAlpha(card, t) {
  if (!card || !card.enabled) return 0;
  const inWindow = (startSec, endSec) => {
    if (!(t >= startSec) || !(t < endSec)) return 0;
    const fade = Math.min(Math.max(0, card.fadeSec || 0), (endSec - startSec) / 2);
    if (fade <= 0) return 1;
    return Math.max(0, Math.min(1, (t - startSec) / fade, (endSec - t) / fade));
  };
  const outro = card.outro && typeof card.outroStartSec === 'number' && typeof card.outroEndSec === 'number'
    ? inWindow(card.outroStartSec, card.outroEndSec) : 0;
  return Math.max(inWindow(card.startSec, card.endSec), outro);
}

/**
 * The card's lines placed on a width × height frame: `[{ text, font, px, x, y,
 * align, outline, fill }]` (y is the alphabetic baseline). In the `outline`
 * look the title is the first, larger line and artist, year and the extra line
 * follow; in the `mtv` look the artist leads, then the title, the extra
 * line and the year, and the block is inset by its plate's padding. A block
 * wider than its zone shrinks as a whole, so the card never runs off frame.
 * `measure(text, font)` returns a width in pixels. Pure.
 */
function titleCardLayout(card, { width, height, measure }) {
  const stacks = {
    display: ['"MV Archivo", "Arial Black", Impact, sans-serif', 800, 600],
    sans: ['"Helvetica Neue", Helvetica, Arial, sans-serif', 700, 400],
    serif: ['Georgia, "Times New Roman", serif', 700, 400],
    mono: ['"MV Mono", Menlo, Consolas, monospace', 500, 500],
    // Bundled single-weight faces (TITLE_CARD_FONT_FACES), registered by the runtime.
    oswald: ['"MV Title Oswald", "Arial Narrow", sans-serif', 700, 700],
    audiowide: ['"MV Title Audiowide", "Arial Black", sans-serif', 400, 400],
    orbitron: ['"MV Title Orbitron", "Arial Black", sans-serif', 700, 700],
    righteous: ['"MV Title Righteous", "Arial Black", sans-serif', 400, 400],
    pacifico: ['"MV Title Pacifico", "Brush Script MT", cursive', 400, 400],
    playfair: ['"MV Title Playfair", Georgia, serif', 700, 700],
  };
  const [family, titleWeight, metaWeight] = stacks[card.font] || stacks.display;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const mtv = card.style === 'mtv';
  const color = card.color || '#f3ead7';
  const titleFill = card.titleColor || (mtv ? '#f5d33a' : color);
  const title = clean(card.title);
  const titleRow = title ? { text: card.quoteTitle ? `“${title}”` : title, role: 'title' } : null;
  const meta = (key) => (clean(card[key]) ? { text: clean(card[key]), role: 'meta' } : null);
  const artist = clean(card.artist) ? { text: clean(card.artist), role: mtv ? 'lead' : 'meta' } : null;
  const rows = (mtv ? [artist, titleRow, meta('extra'), meta('year')] : [titleRow, artist, meta('year'), meta('extra')]).filter(Boolean);
  if (!rows.length) return [];
  const unit = Math.min(width, height) / 1080;
  const scale = (Number(card.size) || 100) / 100;
  const insetX = Math.max(72 * unit, width * 0.06);
  const insetY = Math.max(72 * unit, height * 0.07);
  const position = card.position || 'lower-left';
  const centered = position === 'center' || position === 'lower-center';
  const portrait = height > width;
  // The mtv plate's padding (and its bar) sit inside the safe insets too.
  const base = { title: mtv ? 42 : 50, lead: 46, meta: mtv ? 32 : 36 };
  const padX = mtv ? 26 * unit * scale : 0;
  const padY = mtv ? 16 * unit * scale : 0;
  const bar = mtv ? 9 * unit * scale : 0;
  const maxW = (centered || portrait ? width - 2 * insetX : width * 0.62) - 2 * padX - bar;
  const weightOf = (row) => (row.role === 'meta' ? metaWeight : titleWeight);
  const fontOf = (row, px) => `${weightOf(row)} ${Math.floor(px * 100) / 100}px ${family}`;
  const baseOf = (row) => base[row.role] * unit * scale;
  const widest = Math.max(...rows.map((row) => measure(row.text, fontOf(row, baseOf(row)))));
  const fit = widest > maxW && widest > 0 ? maxW / widest : 1;
  const sized = rows.map((row) => ({ ...row, px: baseOf(row) * fit }));
  const lineH = (row) => row.px * (row.role === 'meta' ? 1.3 : 1.18);
  const blockH = sized.reduce((sum, row) => sum + lineH(row), 0);
  let top;
  if (position === 'center') top = (height - blockH) / 2;
  else if (position.startsWith('upper')) top = insetY + padY;
  else top = height - insetY - padY - blockH;
  const align = centered ? 'center' : position.endsWith('right') ? 'right' : 'left';
  const x = align === 'left' ? insetX + bar + padX : align === 'right' ? width - insetX - padX : width / 2;
  const out = [];
  let y = top;
  for (const row of sized) {
    y += lineH(row);
    // The baseline sits a little above the line box's foot, leaving room for descenders.
    out.push({ text: row.text, font: fontOf(row, row.px), px: row.px, x, y: y - row.px * (row.role === 'meta' ? 0.3 : 0.24), align,
      outline: mtv ? 0 : Math.max(2, row.px * (row.role === 'meta' ? 0.12 : 0.15)), fill: row.role === 'title' ? titleFill : color });
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
  if (card.style === 'mtv') {
    // The lower third's plate hugs the block; its bar runs down the leading edge.
    const unit = Math.min(width, height) / 1080;
    const scale = (Number(card.size) || 100) / 100;
    const padX = 26 * unit * scale;
    const padY = 16 * unit * scale;
    const bar = 9 * unit * scale;
    let left = Infinity; let right = -Infinity;
    for (const line of lines) {
      const w = measure(line.text, line.font);
      const x0 = line.align === 'left' ? line.x : line.align === 'right' ? line.x - w : line.x - w / 2;
      left = Math.min(left, x0); right = Math.max(right, x0 + w);
    }
    const top = lines[0].y - lines[0].px * 0.94 - padY;
    const bottom = lines[lines.length - 1].y + lines[lines.length - 1].px * 0.3 + padY;
    const plateLeft = left - padX - (lines[0].align === 'right' ? 0 : bar);
    const plateRight = right + padX + (lines[0].align === 'right' ? bar : 0);
    ctx.fillStyle = 'rgba(12, 12, 18, 0.74)';
    ctx.fillRect(plateLeft, top, plateRight - plateLeft, bottom - top);
    ctx.fillStyle = card.accentColor || '#1fc2e5';
    ctx.fillRect(lines[0].align === 'right' ? plateRight - bar : plateLeft, top, bar, bottom - top);
  }
  for (const line of lines) {
    ctx.font = line.font;
    ctx.textAlign = line.align;
    if (line.outline > 0) {
      ctx.lineWidth = line.outline;
      ctx.strokeStyle = '#141217';
      ctx.strokeText(line.text, line.x, line.y);
    }
    ctx.fillStyle = line.fill || card.color || '#f3ead7';
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
 *
 * `fonts` maps a bundled family (TITLE_CARD_FONT_FACES) to its data URL; each is
 * registered with `document.fonts` up front and loads only when the card uses it.
 */
export function titleCardRuntimeSource(card = null, { fonts = {} } = {}) {
  const faces = Object.entries(fonts).filter(([family, src]) => typeof family === 'string' && /^data:font\/woff2;base64,[a-z0-9+/=]+$/i.test(src));
  return `(() => {
  ${titleCardAlpha.toString()}
  ${titleCardLayout.toString()}
  ${drawTitleCard.toString()}
  if (typeof FontFace === 'function' && document.fonts && document.fonts.add) {
    for (const [family, src] of ${JSON.stringify(faces).replace(/</g, '\\u003c')}) {
      try { document.fonts.add(new FontFace(family, 'url(' + src + ')', { weight: '100 900' })); } catch { /* the stack's fallback draws instead */ }
    }
  }
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
    // Complete-frame producers await fonts without painting a visible layer.
    ready,
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
