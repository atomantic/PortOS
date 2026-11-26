/**
 * Music Video — the credits ending: an optional film-style credits page after the song (and after the
 * cutting room floor, when that is on too).
 *
 * The film credits ending after the song: `normalizeCreditsOutro`, `creditsOutroSeconds`,
 * `creditsOutroPrefill` (song, artist, Directed/Music/Produced by and album from the project, its
 * track and the track's artist) and `drawCreditsOutro` (the one canvas painter: a held card, or a roll
 * when it is taller than the frame). Browser-safe.
 *
 * The song and optional performer head the page, followed by editable credit
 * blocks (an optional heading and lines of text) and an optional closing line.
 * In the `roll` layout the block fades in and holds when it fits the frame and rolls up like a film's
 * end credits when it is taller; in the `grid` layout everything shows on one fixed frame, the credits
 * laid out in columns and sized to fit. One record on the project (`project.creditsOutro`, null =
 * never set up) turns it on and holds every line exactly as edited.
 *
 * `creditsOutroPrefill` fills a new record from the project, its track, the
 * track's artist (Create › Music › Artists: the "Name for credits", else the
 * name) and album. Nothing is filled behind the director's back: the prefill
 * is only applied when the director turns the ending on or asks to refill it.
 *
 * `drawCreditsOutro` is the one painter for the animatic and the final render
 * (inlined into the render page by toString with its font registry).
 * Every frame is a pure function of the scene's own time. Browser-safe, no imports.
 */

export const CREDITS_OUTRO_LIMITS = Object.freeze({ durationMin: 4, durationMax: 30, textMax: 80, blockTextMax: 320, linesMax: 24 });
/** `roll`: held when it fits, rolled up when taller than the frame. `grid`: everything on one fixed frame. */
export const CREDITS_OUTRO_LAYOUTS = Object.freeze(['roll', 'grid']);
export const CREDITS_OUTRO_DEFAULTS = Object.freeze({
  enabled: false, durationSec: 10, layout: 'roll', title: '', artist: '', lines: Object.freeze([]), footer: '',
});
/** The faces the page draws in (bundled OFL files, registered by each page). */
export const CREDITS_OUTRO_FONTS = Object.freeze({
  title: Object.freeze({ family: 'MV Credits Serif', file: 'playfair-display-700.woff2', weight: '700' }),
  body: Object.freeze({ family: 'MV Credits Sans', file: 'archivo-variable.woff2', weight: '100 900' }),
  condensed: Object.freeze({ family: 'MV Credits Condensed', file: 'oswald-700.woff2', weight: '700' }),
  mono: Object.freeze({ family: 'MV Credits Mono', file: 'ibm-plex-mono-500.woff2', weight: '500' }),
});
export const CREDITS_OUTRO_FONT_IDS = Object.freeze(Object.keys(CREDITS_OUTRO_FONTS));
export const CREDITS_OUTRO_COLORS = Object.freeze({ textColor: '#f4efe6', labelColor: '#b9b2a6', backgroundColor: '#000000' });
export const CREDITS_OUTRO_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
export const CREDITS_OUTRO_FACE_LOADS = Object.freeze(Object.values(CREDITS_OUTRO_FONTS).flatMap(({ family, weight }) =>
  (weight === '100 900' ? [400, 500, 600, 700] : [weight]).map((w) => `${w} 40px "${family}"`)));
/** Role suggestions the editor offers for a new line. */
export const CREDITS_OUTRO_ROLES = Object.freeze([
  'Directed by', 'Music by', 'Performed by', 'Written by', 'Produced by', 'Edited by', 'Cinematography',
  'Starring', 'Executive producer', 'Mixed by', 'Mastered by', 'From the album', 'Special thanks',
]);

const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const cleanBlock = (value, max) => typeof value === 'string'
  ? value.slice(0, max).split(/\r\n?|\n/).map((line) => cleanText(line, max)).filter(Boolean).join('\n')
  : '';

/**
 * A stored credits record from any input (null for none). Normalizes spacing
 * while preserving line breaks in credit blocks; empty blocks are dropped.
 */
export function normalizeCreditsOutro(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { durationMin, durationMax, textMax, blockTextMax, linesMax } = CREDITS_OUTRO_LIMITS;
  const raw = typeof input.durationSec === 'number' && Number.isFinite(input.durationSec) ? input.durationSec : CREDITS_OUTRO_DEFAULTS.durationSec;
  const lines = (Array.isArray(input.lines) ? input.lines : [])
    .map((line) => ({ role: cleanText(line?.role, textMax), name: cleanBlock(line?.name, blockTextMax) }))
    .filter((line) => line.role || line.name)
    .slice(0, linesMax);
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : CREDITS_OUTRO_DEFAULTS.enabled,
    durationSec: Math.round(Math.min(durationMax, Math.max(durationMin, raw)) * 10) / 10,
    layout: CREDITS_OUTRO_LAYOUTS.includes(input.layout) ? input.layout : CREDITS_OUTRO_DEFAULTS.layout,
    title: cleanText(input.title, textMax),
    artist: cleanText(input.artist, textMax),
    lines,
    footer: cleanText(input.footer, textMax),
    // Omit legacy defaults so unchanged credits retain the same render fingerprint.
    ...(input.quoteTitle === false ? { quoteTitle: false } : {}),
    ...(input.showPerformer === false ? { showPerformer: false } : {}),
    ...(CREDITS_OUTRO_FONT_IDS.includes(input.titleFont) && input.titleFont !== 'title' ? { titleFont: input.titleFont } : {}),
    ...(CREDITS_OUTRO_FONT_IDS.includes(input.bodyFont) && input.bodyFont !== 'body' ? { bodyFont: input.bodyFont } : {}),
    ...Object.fromEntries(Object.entries(CREDITS_OUTRO_COLORS).flatMap(([key, fallback]) => {
      const color = typeof input[key] === 'string' && CREDITS_OUTRO_COLOR_PATTERN.test(input[key]) ? input[key].toLowerCase() : fallback;
      return color === fallback ? [] : [[key, color]];
    })),
  };
}

/** The seconds the credits add after the song (0 when off or when there is nothing to show). */
export function creditsOutroSeconds(input) {
  const credits = normalizeCreditsOutro(input);
  if (!credits?.enabled) return 0;
  const anything = credits.title || (credits.showPerformer !== false && credits.artist) || credits.footer || credits.lines.length;
  return anything ? credits.durationSec : 0;
}

/**
 * A new credits record from what PortOS knows about the video: the song title
 * (the track's, else the project name without its " vN" suffix), the artist
 * (`artist.creditName`, else `artist.name`, else the track's artist text, else
 * `fallbackArtist`), the album, and a © line for `year`. The artist is
 * credited as director too; every line stays editable. Pure.
 */
export function creditsOutroPrefill({ project = null, track = null, artist = null, album = null, fallbackArtist = '', year = new Date().getFullYear() } = {}) {
  const projectTitle = typeof project?.name === 'string' ? project.name.replace(/\s+v\d+$/i, '') : '';
  const title = cleanText(track?.title, CREDITS_OUTRO_LIMITS.textMax) || cleanText(projectTitle, CREDITS_OUTRO_LIMITS.textMax);
  const who = cleanText(artist?.creditName, CREDITS_OUTRO_LIMITS.textMax) || cleanText(artist?.name, CREDITS_OUTRO_LIMITS.textMax)
    || cleanText(track?.artist, CREDITS_OUTRO_LIMITS.textMax) || cleanText(fallbackArtist, CREDITS_OUTRO_LIMITS.textMax);
  const albumTitle = cleanText(album?.title, CREDITS_OUTRO_LIMITS.textMax);
  const lines = [
    { role: 'Directed by', name: who },
    { role: 'Music by', name: who },
    { role: 'Produced by', name: who },
    ...(albumTitle ? [{ role: 'From the album', name: albumTitle }] : []),
  ];
  return normalizeCreditsOutro({
    ...CREDITS_OUTRO_DEFAULTS,
    enabled: true,
    quoteTitle: false,
    title,
    artist: who,
    lines,
    footer: who && year ? `© ${year} ${who}` : '',
  });
}

/* Only the font registry is shared with this painter's inlined render page. */

/**
 * Paint the credits at scene time `t` (0 = its first frame) on a
 * width × height 2D context. `credits` is the normalized record. The block
 * sits centred inside the title-safe area: a grid fills one fixed frame; a
 * roll holds when it fits and rolls up when it does not. In from black and
 * out to black.
 */
function drawCreditsOutro(ctx, { width, height, t, durationSec, credits }) {
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const D = Math.max(1, Number(durationSec) || 10);
  const c = credits || {};
  const fontStack = (choice) => {
    const fallback = { title: '"Playfair Display", Georgia, "Times New Roman", serif', body: '"Helvetica Neue", Arial, sans-serif', mono: 'monospace' };
    return `"${CREDITS_OUTRO_FONTS[choice].family}", ${fallback[choice] || 'sans-serif'}`;
  };
  const titleFace = c.titleFont || 'title';
  const bodyFace = c.bodyFont || 'body';
  const weightFor = (choice, weight) => choice === 'body' ? weight : CREDITS_OUTRO_FONTS[choice].weight;
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = c.backgroundColor || '#000';
  ctx.fillRect(0, 0, width, height);

  // The block, top to bottom, in units of `px` (the role size): each item has
  // its height and how it draws.
  const items = [];
  const title = clean(c.title);
  const artist = c.showPerformer === false ? '' : clean(c.artist);
  if (title) items.push({ kind: 'title', text: c.quoteTitle === false ? title : `“${title}”`, h: 2.6 });
  if (artist) items.push({ kind: 'by', text: 'PERFORMED BY', h: 1.5 }, { kind: 'artist', text: artist.toUpperCase(), h: 2 });
  const lines = Array.isArray(c.lines) ? c.lines : [];
  const cells = lines.map((line) => [
    ...(clean(line.role) ? [{ kind: 'role', text: clean(line.role).toUpperCase(), h: 1.5 }] : []),
    ...clean(line.name).split('\n').filter(Boolean).map((text) => ({ kind: 'name', text, h: 1.9 })),
  ]);
  if (items.length && cells.length) items.push({ kind: 'gap', h: 1.6 });
  cells.forEach((cell, i) => {
    if (i) items.push({ kind: 'gap', h: 1.1 });
    items.push(...cell);
  });
  const footer = clean(c.footer);
  if (footer) items.push({ kind: 'gap', h: 2 }, { kind: 'footer', text: footer, h: 1.4 });
  const fontFor = (kind, px) => {
    const size = (v) => `${Math.floor(px * v * 100) / 100}px`;
    if (kind === 'title') return `${weightFor(titleFace, 700)} ${size(2.1)} ${fontStack(titleFace)}`;
    const [weight, scale] = kind === 'artist' ? [600, 1.45] : kind === 'name' ? [500, 1.4] : [400, 0.9];
    return `${weightFor(bodyFace, weight)} ${size(scale)} ${fontStack(bodyFace)}`;
  };
  const tracking = (kind) => (kind === 'by' || kind === 'role' ? 0.22 : kind === 'artist' ? 0.12 : 0);
  const measure = (item, px) => {
    ctx.font = fontFor(item.kind, px);
    const chars = item.text.length;
    return ctx.measureText(item.text).width + chars * px * tracking(item.kind);
  };

  const safeW = width * 0.8;
  const safeH = height * 0.8;
  const fadeIn = Math.min(0.8, D * 0.15);
  const fadeOut = Math.min(0.8, D * 0.15);
  const paint = (item, x, base, px) => {
    ctx.font = fontFor(item.kind, px);
    ctx.fillStyle = item.kind === 'role' || item.kind === 'by' || item.kind === 'footer'
      ? c.labelColor || '#b9b2a6' : c.textColor || '#f4efe6';
    const spacing = tracking(item.kind) * px;
    if (spacing && 'letterSpacing' in ctx) {
      ctx.letterSpacing = `${spacing}px`;
      // Letter spacing trails the last glyph; shift by half a gap to stay centred.
      ctx.fillText(item.text, x + spacing / 2, base);
      ctx.letterSpacing = '0px';
    } else {
      ctx.fillText(item.text, x, base);
    }
  };
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  if (c.layout === 'grid') {
    // One fixed frame: the heading on top, the credits in a centred grid of
    // role-over-name cells, the closing line under them. The column count is
    // whichever lets the type be largest while everything fits.
    const head = items.filter((item) => item.kind === 'title' || item.kind === 'by' || item.kind === 'artist');
    const foot = footer ? { kind: 'footer', text: footer, h: 1.4 } : null;
    const per = (item) => (item ? measure(item, 100) / 100 : 0); // width per px, as type scales linearly
    const headUnits = head.reduce((sum, item) => sum + item.h, 0);
    const headWide = Math.max(0, ...head.map(per), per(foot));
    const cellWide = Math.max(0, ...cells.flatMap((cell) => cell.map(per)));
    const CELL_H = 3.4;
    const ROW_GAP = 1.1;
    const maxCols = Math.max(1, Math.min(cells.length, height > width ? 2 : 4));
    // A grid has columns: two at least once there are two credits.
    const minCols = Math.min(2, maxCols);
    let best = null;
    for (let cols = minCols; cols <= maxCols; cols++) {
      const rowsN = cells.length ? Math.ceil(cells.length / cols) : 0;
      const rowHeights = Array.from({ length: rowsN }, (_, row) => Math.max(CELL_H, ...cells.slice(row * cols, (row + 1) * cols)
        .map((cell) => cell.reduce((sum, item) => sum + item.h, cell[0]?.kind === 'name' ? 0.75 : 0))));
      const units = headUnits + (head.length && rowsN ? 1.6 : 0) + rowHeights.reduce((sum, h) => sum + h, 0)
        + Math.max(0, rowsN - 1) * ROW_GAP + (foot ? 2 + foot.h : 0);
      const fits = [safeH / Math.max(1, units), Math.min(width, height) / 30];
      if (headWide > 0) fits.push(safeW / headWide);
      if (cellWide > 0) fits.push((safeW / cols) * 0.9 / cellWide);
      const size = Math.min(...fits);
      // On a tie (both at the size cap), the fuller grid wins: fewer empty cells.
      const empty = rowsN * cols - cells.length;
      const tie = best && Math.abs(size - best.px) < 1e-6;
      if (!best || size > best.px + 1e-6 || (tie && empty < best.empty)) best = { px: size, cols, rowHeights, units, empty };
    }
    const px = best.px;
    let y = (height - best.units * px) / 2;
    for (const item of head) {
      paint(item, width / 2, y + item.h * px * 0.72, px);
      y += item.h * px;
    }
    if (head.length && best.rowHeights.length) y += 1.6 * px;
    const colW = safeW / best.cols;
    best.rowHeights.forEach((rowHeight, row) => {
      const rowCells = cells.slice(row * best.cols, (row + 1) * best.cols);
      // A short last row is centred under the full ones.
      rowCells.forEach((cell, col) => {
        const x = width / 2 + (col - (rowCells.length - 1) / 2) * colW;
        let top = y + (cell[0]?.kind === 'name' ? 0.75 * px : 0);
        for (const item of cell) {
          paint(item, x, top + item.h * px * 0.72, px);
          top += item.h * px;
        }
      });
      y += (rowHeight + (row < best.rowHeights.length - 1 ? ROW_GAP : 0)) * px;
    });
    if (foot) paint(foot, width / 2, y + 2 * px + foot.h * px * 0.72, px);
  } else {
    const unitsTall = items.reduce((sum, item) => sum + item.h, 0);
    // Sized for a readable card: a role line is ~1/34 of the frame's short side, shrunk so the widest line fits.
    let px = Math.min(width, height) / 34;
    const wordy = items.filter((item) => item.text);
    const widest = Math.max(1, ...wordy.map((item) => measure(item, px)));
    if (widest > safeW) px *= safeW / widest;
    const blockH = unitsTall * px;
    const rolls = blockH > safeH;
    // A held card is centred; a roll carries the block from below the frame to above it across the scene.
    const top = rolls
      ? height - (height + blockH) * clamp(t / D)
      : (height - blockH) / 2;
    let y = top;
    for (const item of items) {
      const base = y + item.h * px * 0.72;
      y += item.h * px;
      if (!item.text || base < -px * 3 || base > height + px * 3) continue;
      paint(item, width / 2, base, px);
    }
  }

  // In from black, out to black.
  const dark = Math.max(1 - clamp(t / fadeIn), clamp((t - (D - fadeOut)) / fadeOut));
  if (dark > 0) {
    ctx.globalAlpha = dark;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}

export { drawCreditsOutro };
