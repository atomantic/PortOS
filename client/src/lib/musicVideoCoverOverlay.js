/**
 * Cover-art lettering preview (#10345).
 *
 * Re-export of `server/lib/musicVideoCoverOverlay.js` — the one layout the
 * server renders the cover with, imported rather than copied so the live
 * Lettering preview cannot drift from the saved JPEG — plus a canvas width
 * measure standing in for the server's sharp probe.
 */
import { coverFontSpec, tagTextFor, titleLinesFor } from '../../../server/lib/musicVideoCoverOverlay.js';

export {
  COVER_ART_SIZE,
  COVER_DESIGN_OPTIONS,
  DEFAULT_COVER_DESIGN,
  coverOverlaySvg,
  coverTypefaceChoices,
  customTypeface,
  normalizeCoverDesign,
} from '../../../server/lib/musicVideoCoverOverlay.js';

const PROBE_PX = 100;

/**
 * `{ title(text), tag(text) }` for `coverOverlaySvg`: each text's width at a 1px
 * font size, measured on a canvas in the design's font stack. Null where a
 * canvas is unavailable, so the overlay falls back to the faces' average advance.
 */
export function canvasCoverWidths(design, { title, tag, size }, fonts = []) {
  const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext?.('2d');
  if (!ctx) return null;
  const measure = (kind, texts) => {
    const { family, weight, trackingEm } = coverFontSpec(design, kind, fonts);
    ctx.font = `${weight} ${PROBE_PX}px ${family}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${trackingEm * PROBE_PX}px`;
    const out = new Map(texts.filter(Boolean).map((text) => [text, ctx.measureText(text).width / PROBE_PX]));
    return (text) => out.get(text);
  };
  return {
    title: measure('title', titleLinesFor(title, design, size, fonts)),
    tag: measure('tag', [tagTextFor(tag, design)]),
  };
}
