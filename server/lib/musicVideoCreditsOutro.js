/**
 * Music Video — the credits ending: an optional film-style credits page after
 * the song (and after the cutting room floor, when that is on too). It names
 * the song and who performed it, then a list of credit lines (role over name:
 * Directed by, Music by, Produced by, …) and an optional closing line, in
 * white serif and spaced capitals on black. When the block fits the frame it
 * fades in and holds; when it is taller than the frame it rolls up like a
 * film's end credits. One record on the project (`project.creditsOutro`,
 * null = never set up) turns it on and holds every line exactly as edited.
 *
 * `creditsOutroPrefill` fills a new record from the project, its track, the
 * track's artist (Create › Music › Artists: the "Name for credits", else the
 * name) and album. Nothing is filled behind the director's back: the prefill
 * is only applied when the director turns the ending on or asks to refill it.
 *
 * `drawCreditsOutro` is the one painter for the animatic and the final render
 * (inlined into the render page by toString), so it stays self-contained.
 * Every frame is a pure function of the scene's own time. Browser-safe, no imports.
 */

export const CREDITS_OUTRO_LIMITS = Object.freeze({ durationMin: 4, durationMax: 30, textMax: 80, linesMax: 24 });
export const CREDITS_OUTRO_DEFAULTS = Object.freeze({
  enabled: false, durationSec: 10, title: '', artist: '', lines: Object.freeze([]), footer: '',
});
/** The faces the page draws in (bundled OFL files, registered by each page). */
export const CREDITS_OUTRO_FONTS = Object.freeze({
  title: Object.freeze({ family: 'MV Credits Serif', file: 'playfair-display-700.woff2', weight: '700' }),
  body: Object.freeze({ family: 'MV Credits Sans', file: 'archivo-variable.woff2', weight: '100 900' }),
});
/** Role suggestions the editor offers for a new line. */
export const CREDITS_OUTRO_ROLES = Object.freeze([
  'Directed by', 'Music by', 'Performed by', 'Written by', 'Produced by', 'Edited by', 'Cinematography',
  'Starring', 'Executive producer', 'Mixed by', 'Mastered by', 'From the album', 'Special thanks',
]);

const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * A stored credits record from any input (null for none). Text is kept as
 * typed (trimmed, single-spaced); a line with neither role nor name is dropped.
 */
export function normalizeCreditsOutro(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { durationMin, durationMax, textMax, linesMax } = CREDITS_OUTRO_LIMITS;
  const raw = typeof input.durationSec === 'number' && Number.isFinite(input.durationSec) ? input.durationSec : CREDITS_OUTRO_DEFAULTS.durationSec;
  const lines = (Array.isArray(input.lines) ? input.lines : [])
    .map((line) => ({ role: cleanText(line?.role, textMax), name: cleanText(line?.name, textMax) }))
    .filter((line) => line.role || line.name)
    .slice(0, linesMax);
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : CREDITS_OUTRO_DEFAULTS.enabled,
    durationSec: Math.round(Math.min(durationMax, Math.max(durationMin, raw)) * 10) / 10,
    title: cleanText(input.title, textMax),
    artist: cleanText(input.artist, textMax),
    lines,
    footer: cleanText(input.footer, textMax),
  };
}

/** The seconds the credits add after the song (0 when off or when there is nothing to show). */
export function creditsOutroSeconds(input) {
  const credits = normalizeCreditsOutro(input);
  if (!credits?.enabled) return 0;
  const anything = credits.title || credits.artist || credits.footer || credits.lines.some((line) => line.name || line.role);
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
    title,
    artist: who,
    lines,
    footer: who && year ? `© ${year} ${who}` : '',
  });
}

/* drawCreditsOutro is inlined into the render page by toString(), so it must
 * stay self-contained: no references to module scope. */

/**
 * Paint the credits at scene time `t` (0 = its first frame) on a
 * width × height 2D context. `credits` is the normalized record. The block
 * sits centred inside the title-safe width; it holds when it fits the frame
 * and rolls up when it does not, in from black and out to black.
 */
function drawCreditsOutro(ctx, { width, height, t, durationSec, credits, fonts = {} }) {
  const serif = fonts.title || '"MV Credits Serif", "Playfair Display", Georgia, "Times New Roman", serif';
  const sans = fonts.body || '"MV Credits Sans", "Helvetica Neue", Arial, sans-serif';
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const D = Math.max(1, Number(durationSec) || 10);
  const c = credits || {};
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  // The block, top to bottom, in units of `px` (the role size): each item has
  // its height and how it draws.
  const items = [];
  const title = clean(c.title);
  const artist = clean(c.artist);
  if (title) items.push({ kind: 'title', text: `“${title}”`, h: 2.6 });
  if (artist) items.push({ kind: 'by', text: 'PERFORMED BY', h: 1.5 }, { kind: 'artist', text: artist.toUpperCase(), h: 2 });
  const lines = Array.isArray(c.lines) ? c.lines : [];
  if (items.length && lines.length) items.push({ kind: 'gap', h: 1.6 });
  lines.forEach((line, i) => {
    if (i) items.push({ kind: 'gap', h: 1.1 });
    if (clean(line.role)) items.push({ kind: 'role', text: clean(line.role).toUpperCase(), h: 1.5 });
    if (clean(line.name)) items.push({ kind: 'name', text: clean(line.name), h: 1.9 });
  });
  const footer = clean(c.footer);
  if (footer) items.push({ kind: 'gap', h: 2 }, { kind: 'footer', text: footer, h: 1.4 });
  const fontFor = (kind, px) => {
    const size = (v) => `${Math.floor(px * v * 100) / 100}px`;
    if (kind === 'title') return `700 ${size(2.1)} ${serif}`;
    if (kind === 'artist') return `600 ${size(1.45)} ${sans}`;
    if (kind === 'name') return `500 ${size(1.4)} ${sans}`;
    return `400 ${size(0.9)} ${sans}`;
  };
  const tracking = (kind) => (kind === 'by' || kind === 'role' ? 0.22 : kind === 'artist' ? 0.12 : 0);
  const measure = (item, px) => {
    ctx.font = fontFor(item.kind, px);
    const chars = item.text.length;
    return ctx.measureText(item.text).width + chars * px * tracking(item.kind);
  };

  const safeW = width * 0.8;
  const unitsTall = items.reduce((sum, item) => sum + item.h, 0);
  // Sized for a readable card: a role line is ~1/34 of the frame's short side, shrunk so the widest line fits.
  let px = Math.min(width, height) / 34;
  const wordy = items.filter((item) => item.text);
  const widest = Math.max(1, ...wordy.map((item) => measure(item, px)));
  if (widest > safeW) px *= safeW / widest;
  const blockH = unitsTall * px;
  const safeH = height * 0.8;
  const rolls = blockH > safeH;
  // A held card is centred; a roll carries the block from below the frame to above it across the scene.
  const fadeIn = Math.min(0.8, D * 0.15);
  const fadeOut = Math.min(0.8, D * 0.15);
  const top = rolls
    ? height - (height + blockH) * clamp(t / D)
    : (height - blockH) / 2;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  let y = top;
  for (const item of items) {
    const base = y + item.h * px * 0.72;
    y += item.h * px;
    if (!item.text || base < -px * 3 || base > height + px * 3) continue;
    ctx.font = fontFor(item.kind, px);
    ctx.fillStyle = item.kind === 'role' || item.kind === 'by' || item.kind === 'footer' ? '#b9b2a6' : '#f4efe6';
    const spacing = tracking(item.kind) * px;
    if (spacing && 'letterSpacing' in ctx) {
      ctx.letterSpacing = `${spacing}px`;
      // Letter spacing trails the last glyph; shift by half a gap to stay centred.
      ctx.fillText(item.text, width / 2 + spacing / 2, base);
      ctx.letterSpacing = '0px';
    } else {
      ctx.fillText(item.text, width / 2, base);
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
