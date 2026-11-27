/**
 * Music Video — the credits ending: an optional film-style credits page after the song (and after the
 * cutting room floor, when that is on too).
 *
 * The film credits ending after the song: `normalizeCreditsOutro`, `creditsOutroSeconds`,
 * `creditsOutroPrefill` (song, artist, Directed/Music/Produced by and album from the project, its
 * track and the track's artist) and `drawCreditsOutro` (the one canvas painter: a held card, or a roll
 * when it is taller than the frame). Browser-safe.
 *
 * Supports styled visual themes (`classic`, `analog-16mm`, `mtv-broadcast`, `snapshot-print`,
 * `festival-poster`), optional accent color, optional background still image, and social handle
 * badges (YouTube, X, Instagram, TikTok, Suno, Website).
 *
 * `drawCreditsOutro` is the one painter for the animatic and the final render
 * (inlined into the render page by toString with its font registry).
 * Every frame is a pure function of the scene's own time. Browser-safe, no imports.
 */

export const CREDITS_OUTRO_LIMITS = Object.freeze({ durationMin: 4, durationMax: 30, textMax: 80, blockTextMax: 320, linesMax: 24, socialsMax: 6, handleMax: 60 });
/** `roll`: held when it fits, rolled up when taller than the frame. `grid`: everything on one fixed frame. */
export const CREDITS_OUTRO_LAYOUTS = Object.freeze(['roll', 'grid']);
/** Visual card styles for the credits ending. `classic` preserves the plain black legacy look. */
export const CREDITS_OUTRO_STYLES = Object.freeze(['classic', 'analog-16mm', 'mtv-broadcast', 'snapshot-print', 'festival-poster']);
export const CREDITS_OUTRO_SOCIAL_PLATFORMS = Object.freeze(['youtube', 'x', 'instagram', 'tiktok', 'suno', 'web']);
export const CREDITS_OUTRO_BG_IMAGE_PATTERN = /^[^/\\]+\.(?:png|jpe?g|webp)$/i;
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
export const CREDITS_OUTRO_COLORS = Object.freeze({ textColor: '#f4efe6', labelColor: '#b9b2a6', backgroundColor: '#000000', accentColor: '#f5b038' });
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
  const { durationMin, durationMax, textMax, blockTextMax, linesMax, socialsMax, handleMax } = CREDITS_OUTRO_LIMITS;
  const raw = typeof input.durationSec === 'number' && Number.isFinite(input.durationSec) ? input.durationSec : CREDITS_OUTRO_DEFAULTS.durationSec;
  const lines = (Array.isArray(input.lines) ? input.lines : [])
    .map((line) => ({ role: cleanText(line?.role, textMax), name: cleanBlock(line?.name, blockTextMax) }))
    .filter((line) => line.role || line.name)
    .slice(0, linesMax);
  const socials = (Array.isArray(input.socials) ? input.socials : [])
    .map((entry) => ({
      platform: CREDITS_OUTRO_SOCIAL_PLATFORMS.includes(entry?.platform) ? entry.platform : 'web',
      handle: cleanText(entry?.handle, handleMax),
    }))
    .filter((entry) => entry.handle)
    .slice(0, socialsMax);
  const style = CREDITS_OUTRO_STYLES.includes(input.style) ? input.style : 'classic';
  const bgImage = typeof input.backgroundImageId === 'string' && CREDITS_OUTRO_BG_IMAGE_PATTERN.test(input.backgroundImageId.trim())
    ? input.backgroundImageId.trim() : '';
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : CREDITS_OUTRO_DEFAULTS.enabled,
    durationSec: Math.round(Math.min(durationMax, Math.max(durationMin, raw)) * 10) / 10,
    layout: CREDITS_OUTRO_LAYOUTS.includes(input.layout) ? input.layout : CREDITS_OUTRO_DEFAULTS.layout,
    title: cleanText(input.title, textMax),
    artist: cleanText(input.artist, textMax),
    lines,
    footer: cleanText(input.footer, textMax),
    // Omit legacy defaults so unchanged credits retain the same render fingerprint.
    ...(style !== 'classic' ? { style } : {}),
    ...(bgImage ? { backgroundImageId: bgImage } : {}),
    ...(socials.length ? { socials } : {}),
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
  const anything = credits.title || (credits.showPerformer !== false && credits.artist) || credits.footer || credits.lines.length || (credits.socials?.length || 0);
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
 * width × height 2D context. `credits` is the normalized record. Supports
 * classic black or styled cinema frames (`analog-16mm`, `mtv-broadcast`,
 * `snapshot-print`, `festival-poster`), optional blurred/dimmed `bgImage`,
 * and vector social handle badges (YouTube, X, Instagram, TikTok, Suno, Web).
 * In from black and out to black.
 */
function drawCreditsOutro(ctx, { width, height, t, durationSec, credits, bgImage = null }) {
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const D = Math.max(1, Number(durationSec) || 10);
  const p = clamp(t / D);
  const c = credits || {};
  const style = c.style || 'classic';
  const accent = c.accentColor || '#f5b038';
  const isPrint = style === 'snapshot-print';
  const textCol = c.textColor || (isPrint ? '#1b1815' : '#f4efe6');
  const labelCol = c.labelColor || (isPrint ? '#6c6257' : '#b9b2a6');
  const bgCol = c.backgroundColor || (style === 'analog-16mm' ? '#0b0907' : style === 'mtv-broadcast' ? '#080b12' : '#000000');

  const hexRgb = (hex) => {
    const cleanHex = String(hex || '#f5b038').replace('#', '');
    if (cleanHex.length !== 6) return '245,176,56';
    return [0, 2, 4].map((i) => parseInt(cleanHex.slice(i, i + 2), 16)).join(',');
  };
  const accentRgb = hexRgb(accent);
  const fontStack = (choice) => {
    const fallback = { title: '"Playfair Display", Georgia, "Times New Roman", serif', body: '"Helvetica Neue", Arial, sans-serif', mono: 'monospace' };
    return `"${CREDITS_OUTRO_FONTS[choice].family}", ${fallback[choice] || 'sans-serif'}`;
  };
  const titleFace = c.titleFont || (style === 'mtv-broadcast' ? 'mono' : 'title');
  const bodyFace = c.bodyFont || (style === 'mtv-broadcast' || style === 'analog-16mm' ? 'mono' : 'body');
  const weightFor = (choice, weight) => choice === 'body' ? weight : CREDITS_OUTRO_FONTS[choice].weight;
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  const roundRectPath = (rx, ry, rw, rh, r) => {
    const rad = Math.min(r, rw / 2, rh / 2);
    ctx.beginPath();
    ctx.moveTo(rx + rad, ry);
    ctx.lineTo(rx + rw - rad, ry);
    ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rad);
    ctx.lineTo(rx + rw, ry + rh - rad);
    ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rad, ry + rh);
    ctx.lineTo(rx + rad, ry + rh);
    ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rad);
    ctx.lineTo(rx, ry + rad);
    ctx.quadraticCurveTo(rx, ry, rx + rad, ry);
    ctx.closePath();
  };

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = bgCol;
  ctx.fillRect(0, 0, width, height);

  // Optional background still with gentle Ken Burns drift and dark atmospheric scrim.
  if (bgImage && bgImage.naturalWidth > 0 && bgImage.naturalHeight > 0) {
    ctx.save();
    const drift = 1.02 + 0.04 * p;
    const scale = Math.max(width / bgImage.naturalWidth, height / bgImage.naturalHeight) * drift;
    const dw = bgImage.naturalWidth * scale;
    const dh = bgImage.naturalHeight * scale;
    ctx.globalAlpha = isPrint ? 0.34 : 0.44;
    ctx.drawImage(bgImage, (width - dw) / 2, (height - dh) / 2, dw, dh);
    ctx.restore();
    const scrim = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.12, width / 2, height / 2, Math.max(width, height) * 0.72);
    scrim.addColorStop(0, 'rgba(0,0,0,0.52)');
    scrim.addColorStop(1, 'rgba(0,0,0,0.88)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, width, height);
  }

  // Style backdrops & framing chrome.
  const minDim = Math.min(width, height);
  if (style === 'analog-16mm') {
    // Warm optical corner light leak drifting gently across the darkroom card.
    const glowX = width * (0.12 + 0.04 * Math.sin(p * Math.PI));
    const glowY = height * (0.18 + 0.03 * Math.cos(p * Math.PI));
    const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, width * 0.62);
    glow.addColorStop(0, `rgba(${accentRgb},0.22)`);
    glow.addColorStop(0.45, `rgba(${accentRgb},0.07)`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    // Subtle 16mm sprocket rails along left and right edges.
    const railW = Math.round(width * 0.046);
    const holeW = Math.round(railW * 0.44);
    const holeH = Math.round(holeW * 1.45);
    const step = Math.round(holeH * 1.95);
    ctx.fillStyle = 'rgba(244,239,230,0.08)';
    for (let sy = Math.round(height * 0.06); sy < height * 0.94 - holeH; sy += step) {
      roundRectPath(Math.round((railW - holeW) / 2), sy, holeW, holeH, 4);
      ctx.fill();
      roundRectPath(width - railW + Math.round((railW - holeW) / 2), sy, holeW, holeH, 4);
      ctx.fill();
    }
    // Thin inner archival frame border & corner edge markings.
    const insetX = Math.round(railW * 1.35);
    const insetY = Math.round(height * 0.065);
    ctx.strokeStyle = `rgba(${accentRgb},0.28)`;
    ctx.lineWidth = Math.max(1, minDim / 720);
    ctx.strokeRect(insetX, insetY, width - insetX * 2, height - insetY * 2);
    ctx.font = `500 ${Math.round(minDim * 0.017)}px ${fontStack('mono')}`;
    ctx.fillStyle = `rgba(${accentRgb},0.55)`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText('16MM · 24FPS', insetX + 14, insetY - 10);
    ctx.textAlign = 'right';
    ctx.fillText('ROLL END · FIN', width - insetX - 14, insetY - 10);
  } else if (style === 'mtv-broadcast') {
    const glow = ctx.createRadialGradient(width * 0.25, height * 0.5, 0, width * 0.25, height * 0.5, width * 0.72);
    glow.addColorStop(0, `rgba(${accentRgb},0.16)`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    // Faint retro broadcast scanlines.
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    const gap = Math.max(3, Math.round(height / 180));
    for (let sy = 0; sy < height; sy += gap) ctx.fillRect(0, sy, width, 1);
    const padX = Math.round(width * 0.075);
    const padY = Math.round(height * 0.085);
    ctx.font = `500 ${Math.round(minDim * 0.018)}px ${fontStack('mono')}`;
    ctx.fillStyle = 'rgba(244,239,230,0.45)';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    ctx.fillText('STEREO · FIN', width - padX, padY);
  } else if (style === 'snapshot-print') {
    const cardW = Math.round(width * 0.78);
    const cardH = Math.round(height * 0.8);
    const cardX = Math.round((width - cardW) / 2);
    const cardY = Math.round((height - cardH) / 2);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = Math.round(minDim * 0.06);
    ctx.shadowOffsetY = Math.round(minDim * 0.018);
    ctx.fillStyle = c.backgroundColor && c.backgroundColor !== '#000000' ? c.backgroundColor : '#f4ece0';
    roundRectPath(cardX, cardY, cardW, cardH, Math.round(minDim * 0.012));
    ctx.fill();
    ctx.restore();
    // Subtle inner archival hairline + corner crop marks.
    const inner = Math.round(minDim * 0.028);
    ctx.strokeStyle = `rgba(${accentRgb},0.48)`;
    ctx.lineWidth = Math.max(1, minDim / 720);
    ctx.strokeRect(cardX + inner, cardY + inner, cardW - inner * 2, cardH - inner * 2);
  } else if (style === 'festival-poster') {
    const glow = ctx.createRadialGradient(width / 2, height * 0.35, 0, width / 2, height * 0.5, width * 0.65);
    glow.addColorStop(0, `rgba(${accentRgb},0.14)`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    const oX = Math.round(width * 0.06);
    const oY = Math.round(height * 0.075);
    const iGap = Math.round(minDim * 0.014);
    ctx.strokeStyle = `rgba(${accentRgb},0.35)`;
    ctx.lineWidth = Math.max(1, minDim / 720);
    ctx.strokeRect(oX, oY, width - oX * 2, height - oY * 2);
    ctx.strokeStyle = 'rgba(244,239,230,0.16)';
    ctx.strokeRect(oX + iGap, oY + iGap, width - (oX + iGap) * 2, height - (oY + iGap) * 2);
  }

  // Vector icon painter for social badges (YouTube, X, Instagram, TikTok, Suno, Web).
  const drawSocialIcon = (platform, cx, cy, sz, col) => {
    ctx.save();
    ctx.translate(cx, cy);
    const r = sz / 2;
    if (platform === 'youtube') {
      const rw = sz * 1.24;
      const rh = sz * 0.86;
      roundRectPath(-rw / 2, -rh / 2, rw, rh, rh * 0.28);
      ctx.fillStyle = '#e11d2a';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-sz * 0.16, -sz * 0.22);
      ctx.lineTo(sz * 0.28, 0);
      ctx.lineTo(-sz * 0.16, sz * 0.22);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    } else if (platform === 'x') {
      // Crisp geometric X mark (double-bar primary diagonal + secondary stroke).
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1.5, sz * 0.11);
      ctx.lineCap = 'round';
      const d = r * 0.78;
      ctx.beginPath();
      ctx.moveTo(-d, -d);
      ctx.lineTo(d * 0.55, d);
      ctx.moveTo(-d * 0.55, -d);
      ctx.lineTo(d, d);
      ctx.moveTo(d * 0.88, -d);
      ctx.lineTo(-d * 0.88, d);
      ctx.stroke();
    } else if (platform === 'instagram') {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1.5, sz * 0.1);
      roundRectPath(-r * 0.82, -r * 0.82, sz * 0.82, sz * 0.82, r * 0.38);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.36, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(r * 0.44, -r * 0.44, r * 0.1, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    } else if (platform === 'tiktok') {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1.6, sz * 0.12);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(-r * 0.2, r * 0.36, r * 0.32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(r * 0.12, r * 0.36);
      ctx.lineTo(r * 0.12, -r * 0.68);
      ctx.quadraticCurveTo(r * 0.22, -r * 0.3, r * 0.62, -r * 0.26);
      ctx.stroke();
    } else if (platform === 'suno') {
      ctx.fillStyle = col;
      const heights = [0.38, 0.72, 1, 0.68, 0.4];
      const bw = Math.max(2, sz * 0.12);
      const gap = sz * 0.08;
      const totalW = heights.length * bw + (heights.length - 1) * gap;
      heights.forEach((h, i) => {
        const bh = sz * 0.8 * h;
        roundRectPath(-totalW / 2 + i * (bw + gap), -bh / 2, bw, bh, bw / 2);
        ctx.fill();
      });
    } else {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1.4, sz * 0.09);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.76, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.36, r * 0.76, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r * 0.74, 0);
      ctx.lineTo(r * 0.74, 0);
      ctx.stroke();
    }
    ctx.restore();
  };

  // The block, top to bottom, in units of `px` (the role size).
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
  const socials = (Array.isArray(c.socials) ? c.socials : []).filter((s) => s && clean(s.handle));
  if (items.length && cells.length) items.push({ kind: 'gap', h: 1.6 });
  cells.forEach((cell, i) => {
    if (i) items.push({ kind: 'gap', h: 1.1 });
    items.push(...cell);
  });
  const footer = clean(c.footer);
  if (socials.length) items.push({ kind: 'gap', h: 1.5 }, { kind: 'socials', socials, h: 2.1 });
  if (footer) items.push({ kind: 'gap', h: 1.6 }, { kind: 'footer', text: footer, h: 1.4 });

  const fontFor = (kind, px) => {
    const size = (v) => `${Math.floor(px * v * 100) / 100}px`;
    if (kind === 'title') return `${weightFor(titleFace, 700)} ${size(2.15)} ${fontStack(titleFace)}`;
    if (kind === 'social') return `500 ${size(0.95)} ${fontStack('mono')}`;
    const [weight, scale] = kind === 'artist' ? [600, 1.45] : kind === 'name' ? [500, 1.38] : [400, 0.9];
    return `${weightFor(bodyFace, weight)} ${size(scale)} ${fontStack(bodyFace)}`;
  };
  const tracking = (kind) => (kind === 'by' || kind === 'role' ? 0.22 : kind === 'artist' ? 0.12 : 0);
  const measure = (item, px) => {
    if (!item || item.kind === 'socials') return 0;
    ctx.font = fontFor(item.kind, px);
    const chars = item.text.length;
    return ctx.measureText(item.text).width + chars * px * tracking(item.kind);
  };

  const paintSocialsRow = (list, anchorX, centerY, px, align = 'center') => {
    if (!list.length) return;
    ctx.save();
    ctx.font = fontFor('social', px);
    const iconSz = Math.max(14, px * 0.95);
    const padX = px * 0.72;
    const iconGap = px * 0.45;
    const pillH = px * 1.68;
    const gapX = px * 0.75;
    const pills = list.map((s) => {
      const label = clean(s.handle);
      const textW = ctx.measureText(label).width;
      return { platform: s.platform, label, w: padX * 2 + iconSz * 1.15 + iconGap + textW };
    });
    const totalW = pills.reduce((sum, pill) => sum + pill.w, 0) + Math.max(0, pills.length - 1) * gapX;
    let curX = align === 'left' ? anchorX : anchorX - totalW / 2;
    const topY = centerY - pillH / 2;
    for (const pill of pills) {
      roundRectPath(curX, topY, pill.w, pillH, pillH / 2);
      ctx.fillStyle = isPrint ? 'rgba(27,24,21,0.06)' : 'rgba(244,239,230,0.07)';
      ctx.fill();
      ctx.strokeStyle = isPrint ? 'rgba(27,24,21,0.22)' : `rgba(${accentRgb},0.38)`;
      ctx.lineWidth = Math.max(1, minDim / 720);
      ctx.stroke();
      drawSocialIcon(pill.platform, curX + padX + iconSz * 0.55, centerY, iconSz, textCol);
      ctx.fillStyle = textCol;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(pill.label, curX + padX + iconSz * 1.15 + iconGap, centerY + px * 0.04);
      curX += pill.w + gapX;
    }
    ctx.restore();
  };

  const safeW = width * (isPrint ? 0.66 : 0.78);
  const safeH = height * (isPrint ? 0.68 : 0.76);
  const fadeIn = Math.min(0.8, D * 0.15);
  const fadeOut = Math.min(0.8, D * 0.15);
  const paint = (item, x, base, px, align = 'center') => {
    ctx.font = fontFor(item.kind, px);
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    const isStyledTitle = item.kind === 'title' && (style === 'mtv-broadcast' || style === 'analog-16mm');
    ctx.fillStyle = isStyledTitle
      ? accent
      : item.kind === 'role' || item.kind === 'by' || item.kind === 'footer'
        ? labelCol : textCol;
    const spacing = tracking(item.kind) * px;
    if (spacing && 'letterSpacing' in ctx) {
      ctx.letterSpacing = `${spacing}px`;
      ctx.fillText(item.text, align === 'center' ? x + spacing / 2 : x, base);
      ctx.letterSpacing = '0px';
    } else {
      ctx.fillText(item.text, x, base);
    }
  };

  // Decorative divider rule under the title block for styled themes.
  const drawTitleRule = (centerX, ruleY, ruleW, align = 'center') => {
    if (style === 'classic') return;
    const rx = align === 'left' ? centerX : centerX - ruleW / 2;
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.85;
    roundRectPath(rx, ruleY, ruleW, Math.max(2, Math.round(minDim / 260)), 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  if (style === 'mtv-broadcast' && c.layout === 'grid') {
    // Editorial left-aligned broadcast lockup echoing the MTV lower-third opening card.
    const leftX = Math.round(width * 0.13);
    const barW = Math.max(4, Math.round(width * 0.0045));
    const head = items.filter((item) => item.kind === 'title' || item.kind === 'by' || item.kind === 'artist');
    const foot = footer ? { kind: 'footer', text: footer, h: 1.4 } : null;
    const px = Math.min(minDim / 28, safeH / Math.max(8, head.length * 2.5 + 8.5));
    const blockH = (head.reduce((s, it) => s + it.h, 0) + (cells.length ? 5.6 : 0) + (socials.length ? 3.2 : 0) + (foot ? 2.6 : 0)) * px;
    let y = Math.round((height - blockH) / 2);
    // Vertical cobalt/accent broadcast bar beside the entire lockup.
    ctx.fillStyle = accent;
    roundRectPath(leftX - barW * 4, y + px * 0.3, barW, blockH - px * 0.6, barW / 2);
    ctx.fill();
    for (const item of head) {
      paint(item, leftX, y + item.h * px * 0.72, px, 'left');
      y += item.h * px;
    }
    if (head.length && (cells.length || socials.length)) {
      drawTitleRule(leftX, y + px * 0.45, Math.round(width * 0.16), 'left');
      y += px * 1.5;
    }
    if (cells.length) {
      const cols = Math.min(3, cells.length);
      const colW = (width * 0.74) / cols;
      const rowsN = Math.ceil(cells.length / cols);
      for (let row = 0; row < rowsN; row++) {
        const rowCells = cells.slice(row * cols, (row + 1) * cols);
        let rowMaxH = 0;
        rowCells.forEach((cell, col) => {
          const cx = leftX + col * colW;
          let top = y;
          for (const item of cell) {
            paint(item, cx, top + item.h * px * 0.72, px, 'left');
            top += item.h * px;
          }
          rowMaxH = Math.max(rowMaxH, top - y);
        });
        y += rowMaxH + px * 1.1;
      }
    }
    if (socials.length) {
      y += px * 0.5;
      paintSocialsRow(socials, leftX, y + px * 0.9, px, 'left');
      y += px * 2.4;
    }
    if (foot) paint(foot, leftX, y + px * 1.1, px, 'left');
  } else if (c.layout === 'grid') {
    const head = items.filter((item) => item.kind === 'title' || item.kind === 'by' || item.kind === 'artist');
    const foot = footer ? { kind: 'footer', text: footer, h: 1.4 } : null;
    const per = (item) => (item ? measure(item, 100) / 100 : 0);
    const headUnits = head.reduce((sum, item) => sum + item.h, 0);
    const headWide = Math.max(0, ...head.map(per), per(foot));
    const cellWide = Math.max(0, ...cells.flatMap((cell) => cell.map(per)));
    const CELL_H = 3.4;
    const ROW_GAP = 1.1;
    const maxCols = Math.max(1, Math.min(cells.length, height > width ? 2 : 4));
    const minCols = Math.min(2, maxCols);
    const socialsUnits = socials.length ? 3.2 : 0;
    let best = null;
    for (let cols = minCols; cols <= maxCols; cols++) {
      const rowsN = cells.length ? Math.ceil(cells.length / cols) : 0;
      const rowHeights = Array.from({ length: rowsN }, (_, row) => Math.max(CELL_H, ...cells.slice(row * cols, (row + 1) * cols)
        .map((cell) => cell.reduce((sum, item) => sum + item.h, cell[0]?.kind === 'name' ? 0.75 : 0))));
      const units = headUnits + (head.length && rowsN ? 1.8 : 0) + rowHeights.reduce((sum, h) => sum + h, 0)
        + Math.max(0, rowsN - 1) * ROW_GAP + socialsUnits + (foot ? 2 + foot.h : 0);
      const fits = [safeH / Math.max(1, units), minDim / 30];
      if (headWide > 0) fits.push(safeW / headWide);
      if (cellWide > 0) fits.push((safeW / cols) * 0.9 / cellWide);
      const size = Math.min(...fits);
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
    if (head.length && (best.rowHeights.length || socials.length)) {
      drawTitleRule(width / 2, y + 0.55 * px, Math.round(Math.min(safeW * 0.24, px * 6.5)));
      y += 1.8 * px;
    }
    const colW = safeW / best.cols;
    best.rowHeights.forEach((rowHeight, row) => {
      const rowCells = cells.slice(row * best.cols, (row + 1) * best.cols);
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
    if (socials.length) {
      paintSocialsRow(socials, width / 2, y + 1.8 * px, px);
      y += socialsUnits * px;
    }
    if (foot) paint(foot, width / 2, y + 2 * px + foot.h * px * 0.72, px);
  } else {
    const unitsTall = items.reduce((sum, item) => sum + item.h, 0);
    let px = minDim / 34;
    const wordy = items.filter((item) => item.text);
    const widest = Math.max(1, ...wordy.map((item) => measure(item, px)));
    if (widest > safeW) px *= safeW / widest;
    const blockH = unitsTall * px;
    const rolls = blockH > safeH;
    const top = rolls
      ? height - (height + blockH) * clamp(t / D)
      : (height - blockH) / 2;
    let y = top;
    for (const item of items) {
      if (item.kind === 'socials') {
        paintSocialsRow(item.socials, width / 2, y + item.h * px * 0.5, px);
        y += item.h * px;
        continue;
      }
      const base = y + item.h * px * 0.72;
      y += item.h * px;
      if (!item.text || base < -px * 3 || base > height + px * 3) continue;
      paint(item, width / 2, base, px);
      if (item.kind === 'title') drawTitleRule(width / 2, y + px * 0.15, Math.round(px * 5));
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
