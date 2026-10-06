/**
 * Music Video cover art: one square image for the song's release (Spotify via
 * DistroKid, Suno). A photo or still, cropped square, with the title and the
 * artist set by code from the song's own cover design: where the title sits,
 * its typeface, weight, case, spacing and colors, and what sits behind it.
 * Each song gets its own design (coverArt.js drafts it from the song); this
 * module only renders one: the layout itself is lib/musicVideoCoverOverlay.js
 * (shared with the client's live Lettering preview), and this adds the
 * measuring and the sharp composite. Lettering is set here rather than drawn
 * by an image model, so it stays crisp.
 *
 * Pure apart from the files it reads and writes; `sharp` is loaded lazily so
 * the many suites that reach the publish services never pay for it.
 */

import {
  COVER_ART_SIZE, coverOverlaySvg, fontAttrs, normalizeCoverDesign, tagTextFor, titleLinesFor,
} from '../../lib/musicVideoCoverOverlay.js';

export {
  COVER_ART_SIZE, COVER_DESIGN_OPTIONS, DEFAULT_COVER_DESIGN, coverOverlaySvg, normalizeCoverDesign,
} from '../../lib/musicVideoCoverOverlay.js';

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export const PROBE_PX = 100;

/** Each text's rendered width at a 1px font size, by drawing it at PROBE_PX and trimming the empty canvas around it. */
export async function measureWidths(sharp, texts, font) {
  const out = new Map();
  for (const text of texts) {
    if (!text || out.has(text)) continue;
    const w = Math.ceil(text.length * PROBE_PX * 1.5) + 40;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${PROBE_PX * 2}"><text x="20" y="${PROBE_PX * 1.3}" ${font} font-size="${PROBE_PX}" fill="#fff">${escapeXml(text)}</text></svg>`;
    const { info } = await sharp(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true }).catch(() => ({ info: null }));
    if (info?.width) out.set(text, info.width / PROBE_PX);
  }
  return (text) => out.get(text);
}

/**
 * Write `out` (a JPEG): `source` cropped to its largest square at `focusX`
 * (0 = left edge, 1 = right edge), scaled to `size`, with the song's design on top.
 * `lettering: false` leaves the image bare: a finished cover designed elsewhere.
 * `fonts` are the uploaded typefaces the design may name (already registered
 * with the renderer, see coverFonts.js).
 */
export async function composeCoverArt({ source, out, title, tag = '', design = null, fonts = [], focusX = 0.5, size = COVER_ART_SIZE, lettering = true }, deps = {}) {
  const sharp = deps.sharp || (await import('sharp')).default;
  // Apply the EXIF orientation first, so the crop is measured on the upright image.
  const { data, info } = await sharp(source).rotate().toBuffer({ resolveWithObject: true });
  const side = Math.min(info.width, info.height);
  const fx = Math.min(1, Math.max(0, Number.isFinite(focusX) ? focusX : 0.5));
  const left = Math.round((info.width - side) * fx);
  const top = Math.round((info.height - side) / 2);
  let image = sharp(data)
    .extract({ left, top, width: side, height: side })
    .resize(size, size, { kernel: 'lanczos3' });
  if (lettering) {
    const d = normalizeCoverDesign(design, { fonts });
    const widths = {
      title: await measureWidths(sharp, titleLinesFor(title, d, size, fonts), fontAttrs(d, 'title', PROBE_PX, fonts)),
      tag: await measureWidths(sharp, [tagTextFor(tag, d)], fontAttrs(d, 'tag', PROBE_PX, fonts)),
    };
    image = image.composite([{ input: Buffer.from(coverOverlaySvg({ title, tag, design: d, size, widths, fonts })), top: 0, left: 0 }]);
  }
  await image
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toFile(out);
  return { width: size, height: size };
}
