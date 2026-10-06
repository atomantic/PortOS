/**
 * Music Video cover art: one square image for the song's release (Spotify via
 * DistroKid, Suno). A photo or still, cropped square, with the title set by
 * code on a split-flap row along the bottom (one capital per tile, like a
 * departure board), a thin accent rule above it, and an accent tag top right.
 * Lettering is set here rather than drawn by an image model, so it stays crisp.
 *
 * Pure apart from the files it reads and writes; `sharp` is loaded lazily so
 * the many suites that reach the publish services never pay for it.
 */

export const COVER_ART_SIZE = 3000;
export const COVER_ART_ACCENT = '#ff6a2b';
// Lines longer than this wrap at a word; tiles shrink to fit the longest line.
const MAX_LINE = 14;

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** The title in capitals, broken into split-flap lines of at most MAX_LINE characters (at most 3). */
function coverTitleLines(title) {
  const words = String(title || '').toUpperCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + word.length <= MAX_LINE) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word.slice(0, MAX_LINE * 2));
  }
  return lines.slice(0, 3);
}

/** The overlay as SVG: split-flap title rows, the accent rule above them, and the tag top right. */
function coverOverlaySvg({ title, tag = '', accent = COVER_ART_ACCENT, size = COVER_ART_SIZE }) {
  const lines = coverTitleLines(title);
  const margin = Math.round(size * 0.04);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const gap = size * 0.006;
  const tileW = Math.min(size * 0.085, (size - 2 * margin - gap * (longest - 1)) / longest);
  const tileH = tileW * 1.38;
  const lineGap = tileH * 0.14;
  const font = "'Menlo','DejaVu Sans Mono','Liberation Mono',monospace";
  const parts = [];
  let y = size - margin - lines.length * tileH - (lines.length - 1) * lineGap;
  const ruleY = y - tileH * 0.28;
  parts.push(`<rect x="${margin}" y="${ruleY.toFixed(1)}" width="${size - 2 * margin}" height="${(size * 0.004).toFixed(1)}" fill="${accent}"/>`);
  for (const line of lines) {
    const rowW = line.length * tileW + (line.length - 1) * gap;
    let x = (size - rowW) / 2;
    for (const ch of line) {
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${tileW.toFixed(1)}" height="${tileH.toFixed(1)}" rx="${(tileW * 0.09).toFixed(1)}" fill="#111" fill-opacity="0.9"/>`);
      if (ch !== ' ') {
        parts.push(`<text x="${(x + tileW / 2).toFixed(1)}" y="${(y + tileH * 0.72).toFixed(1)}" font-family="${font}" font-weight="700" font-size="${(tileH * 0.66).toFixed(1)}" fill="#f4f1ea" text-anchor="middle">${escapeXml(ch)}</text>`);
      }
      // The flap's split: a hairline across the middle of every tile.
      parts.push(`<rect x="${x.toFixed(1)}" y="${(y + tileH / 2 - size * 0.0008).toFixed(1)}" width="${tileW.toFixed(1)}" height="${(size * 0.0016).toFixed(1)}" fill="#000" fill-opacity="0.75"/>`);
      x += tileW + gap;
    }
    y += tileH + lineGap;
  }
  const tagText = String(tag || '').trim().slice(0, 24);
  if (tagText) {
    const fontSize = size * 0.032;
    const padX = fontSize * 0.55;
    const w = tagText.length * fontSize * 0.62 + padX * 2;
    const h = fontSize * 1.55;
    const x = size - margin - w;
    parts.push(`<rect x="${x.toFixed(1)}" y="${margin}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${accent}"/>`);
    parts.push(`<text x="${(x + w / 2).toFixed(1)}" y="${(margin + h * 0.7).toFixed(1)}" font-family="'Helvetica Neue','Arial','DejaVu Sans',sans-serif" font-weight="800" font-size="${fontSize.toFixed(1)}" fill="#1a1a1a" text-anchor="middle">${escapeXml(tagText)}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${parts.join('')}</svg>`;
}

/**
 * Write `out` (a JPEG): `source` cropped to its largest square at `focusX`
 * (0 = left edge, 1 = right edge), scaled to `size`, with the overlay on top.
 */
export async function composeCoverArt({ source, out, title, tag = '', accent = COVER_ART_ACCENT, focusX = 0.5, size = COVER_ART_SIZE }, deps = {}) {
  const sharp = deps.sharp || (await import('sharp')).default;
  const meta = await sharp(source).metadata();
  const side = Math.min(meta.width, meta.height);
  const fx = Math.min(1, Math.max(0, Number.isFinite(focusX) ? focusX : 0.5));
  const left = Math.round((meta.width - side) * fx);
  const top = Math.round((meta.height - side) / 2);
  const overlay = Buffer.from(coverOverlaySvg({ title, tag, accent, size }));
  await sharp(source)
    .rotate()
    .extract({ left, top, width: side, height: side })
    .resize(size, size, { kernel: 'lanczos3' })
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toFile(out);
  return { width: size, height: size };
}
