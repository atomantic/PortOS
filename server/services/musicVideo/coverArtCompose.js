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
  COVER_ART_SIZE, YOUTUBE_THUMBNAIL_SIZE, coverOverlaySvg, fontAttrs, normalizeCoverDesign, tagTextFor, titleLinesFor,
} from '../../lib/musicVideoCoverOverlay.js';

export {
  COVER_ART_SIZE, COVER_DESIGN_OPTIONS, DEFAULT_COVER_DESIGN, YOUTUBE_THUMBNAIL_SIZE, coverOverlaySvg, normalizeCoverDesign,
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

const unitRange = (v, fallback = 0.5) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : fallback));

/**
 * Write `out` (a JPEG): `source` cropped to the largest `width`×`height` frame
 * it holds, at `focusX` / `focusY` along whichever side has room to spare
 * (0 = left/top, 1 = right/bottom), scaled to that size, with the song's
 * design on top laid out for `frame` (lib/musicVideoCoverOverlay.js).
 * `lettering: false` leaves the image bare. `fonts` are the uploaded typefaces
 * the design may name (already registered with the renderer, see coverFonts.js).
 */
async function composeLetteredImage({ source, out, title, tag = '', design = null, fonts = [], focusX = 0.5, focusY = 0.5, width, height, frame = 'cover', lettering = true, quality = 92 }, deps = {}) {
  const sharp = deps.sharp || (await import('sharp')).default;
  // Apply the EXIF orientation first, so the crop is measured on the upright image.
  const { data, info } = await sharp(source).rotate().toBuffer({ resolveWithObject: true });
  const scale = Math.min(info.width / width, info.height / height);
  const cropW = Math.min(info.width, Math.round(width * scale));
  const cropH = Math.min(info.height, Math.round(height * scale));
  let image = sharp(data)
    .extract({ left: Math.round((info.width - cropW) * unitRange(focusX)), top: Math.round((info.height - cropH) * unitRange(focusY)), width: cropW, height: cropH })
    .resize(width, height, { kernel: 'lanczos3' });
  if (lettering) {
    const d = normalizeCoverDesign(design, { fonts });
    const box = { width, height };
    const widths = {
      title: await measureWidths(sharp, titleLinesFor(title, d, box, fonts, frame), fontAttrs(d, 'title', PROBE_PX, fonts)),
      tag: await measureWidths(sharp, [tagTextFor(tag, d, frame)], fontAttrs(d, 'tag', PROBE_PX, fonts)),
    };
    image = image.composite([{ input: Buffer.from(coverOverlaySvg({ title, tag, design: d, size: box, frame, widths, fonts })), top: 0, left: 0 }]);
  }
  await image
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toFile(out);
  return { width, height };
}

/** The square release cover: `source` cropped square at `focusX`, scaled to `size`. */
export const composeCoverArt = ({ size = COVER_ART_SIZE, ...rest }, deps = {}) => composeLetteredImage({ ...rest, width: size, height: size, frame: 'cover' }, deps);

/**
 * A YouTube thumbnail: `source` cropped 16:9, the title set large on one side
 * and clear of the duration badge, no artist name. YouTube refuses one over
 * 2 MB, which a 1280x720 JPEG at this quality stays well under.
 */
export const composeYoutubeThumbnail = (opts, deps = {}) => composeLetteredImage({ ...opts, ...YOUTUBE_THUMBNAIL_SIZE, frame: 'thumbnail', quality: 90 }, deps);
