/**
 * Music Video — the opening title card: the small credit block an MTV video
 * opens with (song title, artist, year), fading in over the opener (optionally
 * sliding in from one side as it does) and out again in place. One record on
 * the project (`project.titleCard`, null = none) drives the composition live
 * preview and the final render alike.
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
 * A `steady` card is a broadcast graphic: it is drawn over the film look and
 * the shots' timed effects, so gate weave, flicker and grain never move or
 * modulate it. A card that is not steady sits in the film, under the look,
 * like the lyrics. Each surface that draws the card decides how (the runtime
 * below for pages; services/musicVideo/blender/titleCard.js for a Blender film).
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
/** The side the card slides in FROM as it fades in (`none` = it fades in where it rests). */
export const TITLE_CARD_SLIDES = Object.freeze(['none', 'left', 'right']);
/** The `mtv` look's title and bar colours when the card names none. */
export const TITLE_CARD_MTV_COLORS = Object.freeze({ title: '#f5d33a', accent: '#1fc2e5' });
export const TITLE_CARD_LIMITS = Object.freeze({
  textMax: 120, yearMax: 20, startMax: 600, windowMin: 0.5, fadeMax: 3, sizeMin: 50, sizeMax: 200, outroMax: 3600,
  slideSecMin: 0.1, slideSecMax: 3, slidePctMin: 1, slidePctMax: 100,
});
export const TITLE_CARD_DEFAULTS = Object.freeze({
  enabled: true, title: '', artist: '', year: '', extra: '', quoteTitle: true,
  startSec: 2, endSec: 8, fadeSec: 0.8, fadeOutSec: 0.8, position: 'lower-left', font: 'display', size: 100, color: '#f3ead7',
  style: 'outline', titleColor: '', accentColor: '',
  outro: false, outroStartSec: null, outroEndSec: null,
  slideIn: 'none', slideSec: 0.8, slidePct: 12, steady: false,
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
 * Two defaults follow another field, so a card stored before they existed
 * draws as it did: `fadeOutSec` takes `fadeSec` (which was both fades), and
 * `steady` follows the look (the `mtv` lower third is a broadcast graphic,
 * the `outline` look reads like the lyrics and stays in the film).
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
  const fadeSec = round3(clampNum(input.fadeSec, 0, L.fadeMax, D.fadeSec));
  const style = TITLE_CARD_STYLES.includes(input.style) ? input.style : D.style;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : D.enabled,
    title: cleanText(input.title, L.textMax),
    artist: cleanText(input.artist, L.textMax),
    year: cleanText(input.year, L.yearMax),
    extra: cleanText(input.extra, L.textMax),
    quoteTitle: typeof input.quoteTitle === 'boolean' ? input.quoteTitle : D.quoteTitle,
    startSec,
    endSec,
    fadeSec,
    fadeOutSec: round3(clampNum(input.fadeOutSec, 0, L.fadeMax, fadeSec)),
    position: TITLE_CARD_POSITIONS.includes(input.position) ? input.position : D.position,
    font: TITLE_CARD_FONTS.includes(input.font) ? input.font : D.font,
    size: Math.round(clampNum(input.size, L.sizeMin, L.sizeMax, D.size)),
    color: hexOr(input.color, D.color),
    style,
    // '' = the look's own colour (the text colour, or the mtv yellow title / cyan bar).
    titleColor: hexOr(input.titleColor, ''),
    accentColor: hexOr(input.accentColor, ''),
    outro: typeof input.outro === 'boolean' ? input.outro : D.outro,
    outroStartSec,
    outroEndSec,
    slideIn: TITLE_CARD_SLIDES.includes(input.slideIn) ? input.slideIn : D.slideIn,
    slideSec: round3(clampNum(input.slideSec, L.slideSecMin, L.slideSecMax, D.slideSec)),
    slidePct: round3(clampNum(input.slidePct, L.slidePctMin, L.slidePctMax, D.slidePct)),
    steady: typeof input.steady === 'boolean' ? input.steady : style === 'mtv',
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

/** True when the card draws something and is drawn over the film look rather than under it. */
export function titleCardSteady(card) {
  return titleCardVisible(card) && (typeof card.steady === 'boolean' ? card.steady : card.style === 'mtv');
}

/**
 * Whether `project`'s render style can draw its card over the film look. A
 * composed cut cannot: its card is baked into the encode on a timebase the
 * cold open and frame holds shift, and its film look pass runs over the result.
 */
export const titleCardSteadySupported = (project) => project?.composition?.mode !== 'composed';

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

/* The four functions below are inlined into sandboxed pages by toString()
 * (titleCardRuntimeSource), so each must stay self-contained: no references
 * to module scope, only to each other by name. */

/**
 * The card's opacity at song time t: a linear fade in over `fadeSec` and out
 * over `fadeOutSec` (`fadeSec` when the card has none), each at most half the
 * window, inside its window or its end window (0 outside).
 */
function titleCardAlpha(card, t) {
  if (!card || !card.enabled) return 0;
  const fadeOutSec = typeof card.fadeOutSec === 'number' ? card.fadeOutSec : card.fadeSec;
  const inWindow = (startSec, endSec) => {
    if (!(t >= startSec) || !(t < endSec)) return 0;
    const half = (endSec - startSec) / 2;
    const fadeIn = Math.min(Math.max(0, card.fadeSec || 0), half);
    const fadeOut = Math.min(Math.max(0, fadeOutSec || 0), half);
    return Math.max(0, Math.min(1, fadeIn > 0 ? (t - startSec) / fadeIn : 1, fadeOut > 0 ? (endSec - t) / fadeOut : 1));
  };
  const outro = card.outro && typeof card.outroStartSec === 'number' && typeof card.outroEndSec === 'number'
    ? inWindow(card.outroStartSec, card.outroEndSec) : 0;
  return Math.max(inWindow(card.startSec, card.endSec), outro);
}

/**
 * The card's sideways offset at song time t, as a signed fraction of the frame
 * width: it starts `slidePct` percent to the side it comes from (negative for
 * `left`) and eases out (cubic) to its resting place over `slideSec`, at most
 * half the window. Both windows slide in; nothing slides out. 0 for a card that
 * does not slide, outside its windows, and once the slide is done.
 */
function titleCardSlide(card, t) {
  if (!card || !card.enabled || (card.slideIn !== 'left' && card.slideIn !== 'right')) return 0;
  const distance = Math.min(100, Math.max(0, Number(card.slidePct) || 0)) / 100;
  const inWindow = (startSec, endSec) => {
    if (!(t >= startSec) || !(t < endSec)) return null;
    const slide = Math.min(Math.max(0, Number(card.slideSec) || 0), (endSec - startSec) / 2);
    const remaining = slide > 0 ? 1 - Math.min(1, (t - startSec) / slide) : 0;
    return remaining * remaining * remaining * distance;
  };
  const opening = inWindow(card.startSec, card.endSec);
  const end = card.outro && typeof card.outroStartSec === 'number' && typeof card.outroEndSec === 'number'
    ? inWindow(card.outroStartSec, card.outroEndSec) : null;
  // Windows that overlap show the card where the more settled one has it.
  const offset = opening == null ? end : end == null ? opening : Math.min(opening, end);
  if (!offset) return 0;
  return card.slideIn === 'left' ? -offset : offset;
}

/**
 * The card's lines placed on a width × height frame: `[{ text, font, px, x, y,
 * align, outline, fill }]` (y is the alphabetic baseline). In the `outline`
 * look the title is the first, larger line and artist, year and the extra line
 * follow; in the `mtv` look the artist leads, then the title, the extra
 * line and the year, and the block is inset by its plate's padding. A block
 * wider than its zone shrinks as a whole, so the card never runs off frame.
 * These are resting positions: the slide (titleCardSlide) moves the drawn block
 * and is not in them. `measure(text, font)` returns a width in pixels. Pure.
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
  // The whole block (plate, bar and text) slides as one. A card at rest makes the calls it always made.
  const slide = titleCardSlide(card, t);
  if (slide) ctx.translate(slide * width, 0);
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

// The unit suite checks the motion the pages inline, without a browser.
export const _titleCardTestHooks = Object.freeze({ titleCardAlpha, titleCardSlide, drawTitleCard });

/**
 * A browser script that draws a card over the page it runs in: installed in
 * the composition live preview and in the final render's browsers before the
 * document's own scripts. It exposes `window.__portosTitleCard`:
 *
 *   apply(card)   put a (normalized) card on the page, or null to clear it
 *   draw(t)       redraw for song time t
 *   layout()      the lines at their resting places on the render frame (for checks)
 *   card          the card currently applied
 *   layer         the canvas while it shows the card, else null
 *
 * It wraps `globalThis.portosComposition.seek(t)` (chaining any accessor an
 * earlier init script installed, such as the film look's) so the card is drawn
 * for the frame before the document paints, after its faces have loaded. The
 * canvas is fixed over the viewport, fitted to the render's aspect.
 *
 * The film look is a filter (and, while a preview plays, a transform and
 * overlay layers) on the page's ROOT element, so no ordinary descendant can
 * escape it: a card that is not steady sits under it like the lyrics do. A
 * `steady` card's canvas joins the top layer instead (`popover="manual"`),
 * which the root's filter and transform do not reach, and a page screenshot or
 * screencast still captures. A frame read from another canvas does not include
 * it: such a producer composites `layer` itself (filmLookFinish.js).
 *
 * `fonts` maps a bundled family (TITLE_CARD_FONT_FACES) to its data URL; each is
 * registered with `document.fonts` up front and loads only when the card uses it.
 * `untilSec` (song seconds) stops the card being drawn from that time on, for a
 * page that plays past the end of the song.
 */
// A background page can defer document.fonts.load until Chrome's resource
// timeout (minutes). After this, the frame draws with the fallback and later
// frames do not wait again. A timed-out face stays on the fallback for this page.
const TITLE_CARD_FONT_WAIT_MS = 2000;

export function titleCardRuntimeSource(card = null, { fonts = {}, untilSec = null } = {}) {
  const faces = Object.entries(fonts).filter(([family, src]) => typeof family === 'string' && /^data:font\/woff2;base64,[a-z0-9+/=]+$/i.test(src));
  return `(() => {
  ${titleCardAlpha.toString()}
  ${titleCardSlide.toString()}
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
  const UNTIL = ${typeof untilSec === 'number' && Number.isFinite(untilSec) ? untilSec : 'Infinity'};
  const showing = () => !!card && t < UNTIL && titleCardAlpha(card, t) > 0;
  const steady = () => !!card && (typeof card.steady === 'boolean' ? card.steady : card.style === 'mtv');
  // Move the canvas into the top layer or back out of it. A browser without popovers keeps it an ordinary layer.
  const topLayer = (on) => {
    if (typeof canvas.showPopover !== 'function') return;
    try {
      if (on) {
        if (canvas.getAttribute('popover') !== 'manual') canvas.setAttribute('popover', 'manual');
        if (!canvas.matches(':popover-open')) canvas.showPopover();
      } else if (canvas.hasAttribute('popover')) {
        if (canvas.matches(':popover-open')) canvas.hidePopover();
        canvas.removeAttribute('popover');
      }
    } catch {
      // A closed popover is display:none; without the attribute the card still draws, under the look.
      canvas.removeAttribute('popover');
    }
  };
  const fonts = new Map();
  const fallbackFonts = new Set();
  const frame = () => {
    const r = globalThis.PORTOS_MV && globalThis.PORTOS_MV.render;
    return { width: (r && r.width) || innerWidth || 1920, height: (r && r.height) || innerHeight || 1080 };
  };
  // Resolves once the card's faces are loaded, or after ${TITLE_CARD_FONT_WAIT_MS}ms so a
  // deferred font fetch cannot hold the frame. null when they already are
  // (the seek stays synchronous).
  const ready = () => {
    if (!card || !card.enabled || !document.fonts || !document.fonts.load) return null;
    if (fallbackFonts.has(card.font)) card = { ...card, font: 'sans' };
    const fontChoice = card.font;
    const { width, height } = frame();
    const wanted = titleCardLayout(card, { width, height, measure: () => 0 }).map((line) => line.font);
    const pending = [];
    for (const font of wanted) {
      if (!fonts.has(font)) {
        const entry = { done: false };
        entry.promise = Promise.race([
          document.fonts.load(font).then(() => true, () => false),
          new Promise((resolve) => setTimeout(resolve, ${TITLE_CARD_FONT_WAIT_MS})).then(() => false),
        ]).then((loaded) => {
          entry.done = true;
          if (!loaded) {
            fallbackFonts.add(fontChoice);
            if (card && card.font === fontChoice) card = { ...card, font: 'sans' };
          }
        });
        fonts.set(font, entry);
      }
      const entry = fonts.get(font);
      if (!entry.done) pending.push(entry.promise);
    }
    return pending.length ? Promise.all(pending) : null;
  };
  const draw = () => {
    if (!document.body) return;
    // A hidden card leaves the top layer too: an open popover with nothing on it is still a layer.
    if (!showing()) { if (canvas) { topLayer(false); canvas.style.display = 'none'; } return; }
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
    const over = steady();
    // The second line undoes the browser's own [popover] box (inset, auto margin, a border, padding, a Canvas ground, scrolling).
    canvas.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;'
      + 'left:' + (vw - width * s) / 2 + 'px;top:' + (vh - height * s) / 2 + 'px;width:' + width * s + 'px;height:' + height * s + 'px'
      + (over ? ';right:auto;bottom:auto;background:transparent;overflow:visible' : '');
    topLayer(over);
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
    get layer() { return canvas && canvas.isConnected && canvas.style.display !== 'none' ? canvas : null; },
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
