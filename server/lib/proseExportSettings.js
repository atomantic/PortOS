/**
 * proseExportSettings.js — per-series prose-export settings sanitizer + presets.
 *
 * A prose series can be exported as a compiled manuscript (Markdown), an ePub,
 * or a print-interior PDF (issue #2181). The knobs that shape those artifacts —
 * trim size, interior font, and title-page fields — live on the series record
 * under `exportSettings`. This is the pure sanitizer for that sub-object
 * (mirrors `sanitizeStyleGuide`): it returns `null` when nothing meaningful is
 * set so a series that never configured export keeps its on-disk + wire shape
 * unchanged, and existing series.json files migrate forward without a writer
 * pass (first save backfills).
 */

// Trade-paperback trim sizes, in PDF points (1pt = 1/72"). The keys are stable
// wire values; the labels are UI-only (kept on the client). us-trade (6"×9") is
// the default fiction trade size.
export const TRIM_SIZES = Object.freeze({
  'us-trade':    { width: 432,   height: 648 },    // 6" × 9"
  'digest':      { width: 396,   height: 612 },    // 5.5" × 8.5"
  'mass-market': { width: 306,   height: 486 },    // 4.25" × 6.75"
  'us-letter':   { width: 612,   height: 792 },    // 8.5" × 11"
  'a5':          { width: 419.53, height: 595.28 }, // A5
});
export const DEFAULT_TRIM_SIZE = 'us-trade';

// Interior body fonts — the pdf-lib StandardFonts a print interior can use
// without embedding a font file. Times is the traditional book-interior serif.
export const INTERIOR_FONTS = Object.freeze(['times', 'helvetica', 'courier']);
export const DEFAULT_INTERIOR_FONT = 'times';

const TITLE_MAX = 200;
const SUBTITLE_MAX = 300;
const AUTHOR_MAX = 120;
const COPYRIGHT_MAX = 500;
const DEDICATION_MAX = 2000;

const trimTo = (val, max) => (typeof val === 'string' ? val.trim().slice(0, max) : '');

/**
 * Sanitize the optional `series.exportSettings` field. Returns `null` when the
 * settings carry no non-default content (so a series that only accepted the
 * defaults doesn't persist an empty husk). `trimSize`/`interiorFont` are always
 * validated against their allow-lists; the title-page fields are free text,
 * bounded. Legacy-tolerant: absent → `null`.
 */
export function sanitizeProseExportSettings(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const trimSize = TRIM_SIZES[raw.trimSize] ? raw.trimSize : null;
  const interiorFont = INTERIOR_FONTS.includes(raw.interiorFont) ? raw.interiorFont : null;
  const titlePageTitle = trimTo(raw.titlePageTitle, TITLE_MAX);
  const titlePageSubtitle = trimTo(raw.titlePageSubtitle, SUBTITLE_MAX);
  const titlePageAuthor = trimTo(raw.titlePageAuthor, AUTHOR_MAX);
  const copyright = trimTo(raw.copyright, COPYRIGHT_MAX);
  const dedication = trimTo(raw.dedication, DEDICATION_MAX);
  if (
    trimSize == null && interiorFont == null && !titlePageTitle && !titlePageSubtitle
    && !titlePageAuthor && !copyright && !dedication
  ) {
    return null;
  }
  return {
    trimSize, interiorFont, titlePageTitle, titlePageSubtitle, titlePageAuthor, copyright, dedication,
  };
}

/**
 * Resolve the effective export settings a build uses: the stored sub-object
 * merged over the defaults, with the series' own name/author filling any blank
 * title-page fields. Always returns a fully-populated object (never null), so
 * the packagers never branch on absent config.
 */
export function resolveExportSettings(series) {
  const stored = sanitizeProseExportSettings(series?.exportSettings) || {};
  return {
    trimSize: stored.trimSize || DEFAULT_TRIM_SIZE,
    interiorFont: stored.interiorFont || DEFAULT_INTERIOR_FONT,
    titlePageTitle: stored.titlePageTitle || series?.name || 'Untitled',
    titlePageSubtitle: stored.titlePageSubtitle || series?.logline || '',
    titlePageAuthor: stored.titlePageAuthor || series?.author || '',
    copyright: stored.copyright || '',
    dedication: stored.dedication || '',
  };
}
