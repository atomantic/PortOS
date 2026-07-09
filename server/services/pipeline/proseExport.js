/**
 * proseExport.js — Prose series export (issue #2181).
 *
 * The shipping step for a prose-format series: once the quality-engine phases
 * produce publishable prose, this stitches the drafted issue prose (in arc
 * order, grouped into volume breaks) into three downloadable artifacts:
 *
 *   1. Compiled manuscript  — Markdown with front matter, volume breaks, and
 *      chapter headings. Reuses the same `collectManuscriptSections` stitching
 *      the editorial passes use (arc-ordered, drafted-prose-only), so the
 *      exported prose is the same text the editor and the LLM see; only the
 *      surrounding front matter / volume / chapter framing is added here.
 *   2. ePub                 — an OCF (zip) container: `mimetype` + container.xml
 *      + an OPF package manifest + a nav doc + per-volume XHTML chapters + CSS,
 *      plus the cover image from the existing cover stage. Packaged in-repo with
 *      `server/lib/zipWriter.js` (no epub dependency, per the dependency policy).
 *   3. Print-interior PDF   — a trade-format interior (trim size, margins,
 *      running heads, title page, chapter openers) built on the same `pdf-lib`
 *      plumbing as `volumePdf.js` / `comicPdf.js`.
 *
 * All three are assembled on demand and streamed straight to the response — no
 * on-disk artifact, so a re-export always reflects the freshest manuscript.
 *
 * The pure helpers (markdown/XHTML/OPF builders + the paginator) are exported
 * via `__testing` so the export shape is unit-tested without touching disk.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { createZip } from '../../lib/zipWriter.js';
import { slugifyForFilename } from '../../lib/civitai.js';
import { readImageFromMedia, detectImageKind } from '../../lib/pdfImageEmbed.js';
import { resolveExportSettings, TRIM_SIZES, DEFAULT_TRIM_SIZE } from '../../lib/proseExportSettings.js';
import { getSeries } from './series.js';
import { listSeasons } from './seasons.js';
import { collectManuscriptSections } from './arcPlanner.js';

export const ERR_NO_PROSE = 'PIPELINE_PROSE_EXPORT_NO_CONTENT';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------------------
// Section gathering — the shared front for all three exports.
// ---------------------------------------------------------------------------

/**
 * Collect the drafted prose sections in arc order and group them into volumes
 * by `seasonId`. Returns `{ series, sections, volumes }` where `volumes` is an
 * ordered list of `{ id, title, number, sections }`. Sections that don't map to
 * a known season (or a series with no seasons) fall into a single implicit
 * volume so nothing is dropped. Throws ERR_NO_PROSE when no issue has drafted
 * prose.
 */
export async function gatherProse(seriesId) {
  const series = await getSeries(seriesId);
  // Prose export = the `prose` stage ONLY. The default stageOrder
  // (MANUSCRIPT_STAGES) also picks up comicScript/teleplay, which would package
  // non-prose text (screenplay/comic-script markup) into an ePub/manuscript; a
  // prose series' authored artifact is its `prose` stage. `idea` is excluded
  // either way (never export an outline as finished prose).
  const sections = await collectManuscriptSections(seriesId, { stageOrder: ['prose'] });
  if (!sections.length) {
    throw makeErr(
      'No drafted prose to export — write or import prose on at least one issue first.',
      ERR_NO_PROSE,
    );
  }
  const seasons = await listSeasons(seriesId);
  const volumes = groupIntoVolumes(sections, seasons);
  return { series, sections, volumes };
}

/**
 * Group ordered sections into volumes by seasonId, preserving section order.
 * Season order comes from the series' `seasons[]` (by `number` then order of
 * appearance); an unknown/absent seasonId collapses into one trailing
 * "Unassigned" volume. When the series has zero seasons every section lands in a
 * single untitled volume. Pure — exported via __testing.
 */
export function groupIntoVolumes(sections, seasons = []) {
  const seasonById = new Map((seasons || []).map((s) => [s.id, s]));
  const buckets = new Map(); // seasonId|'__none__' → { season, sections }
  for (const sec of sections) {
    const key = sec.seasonId && seasonById.has(sec.seasonId) ? sec.seasonId : '__none__';
    if (!buckets.has(key)) buckets.set(key, { season: seasonById.get(sec.seasonId) || null, sections: [] });
    buckets.get(key).sections.push(sec);
  }
  // Order volumes by the season list's order; the implicit "__none__" bucket
  // always sorts last.
  const ordered = [];
  for (const s of (seasons || [])) {
    if (buckets.has(s.id)) ordered.push(buckets.get(s.id));
  }
  if (buckets.has('__none__')) ordered.push(buckets.get('__none__'));
  // A series whose sections all landed in __none__ and had no season match →
  // just that one bucket. Number volumes sequentially for display.
  return ordered.map((b, idx) => ({
    id: b.season?.id || `__vol-${idx + 1}`,
    number: b.season?.number || idx + 1,
    title: b.season?.title || (ordered.length > 1 ? `Volume ${idx + 1}` : ''),
    sections: b.sections,
  }));
}

// ---------------------------------------------------------------------------
// 1) Compiled manuscript (Markdown)
// ---------------------------------------------------------------------------

/**
 * Build the compiled-manuscript Markdown string: YAML front matter (title /
 * author / date), then each volume as a `# Volume` break, then each issue as a
 * `## Chapter` heading followed by its prose. Single-volume series omit the
 * volume break. Pure over `{ series, volumes }` — exported via __testing.
 */
export function buildManuscriptMarkdown({ series, volumes }, settings) {
  const cfg = settings || resolveExportSettings(series);
  const lines = [];
  lines.push('---');
  lines.push(`title: ${yamlValue(cfg.titlePageTitle)}`);
  if (cfg.titlePageSubtitle) lines.push(`subtitle: ${yamlValue(cfg.titlePageSubtitle)}`);
  if (cfg.titlePageAuthor) lines.push(`author: ${yamlValue(cfg.titlePageAuthor)}`);
  lines.push(`date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('---');
  lines.push('');
  if (cfg.dedication) {
    lines.push(`> ${cfg.dedication.replace(/\n/g, '\n> ')}`);
    lines.push('');
  }
  const multiVolume = volumes.length > 1;
  for (const vol of volumes) {
    if (multiVolume) {
      lines.push(`# ${vol.title || `Volume ${vol.number}`}`);
      lines.push('');
    }
    for (const sec of vol.sections) {
      const heading = sec.title ? `Chapter ${sec.number} — ${sec.title}` : `Chapter ${sec.number}`;
      lines.push(`## ${heading}`);
      lines.push('');
      lines.push((sec.content || '').trim());
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const yamlValue = (v) => {
  const s = String(v ?? '');
  // Quote when the value could confuse a YAML parser (colons, leading specials).
  return /[:#\-\[\]{}&*!|>'"%@`]/.test(s) ? JSON.stringify(s) : s;
};

export async function buildManuscriptFile(seriesId) {
  const { series, volumes } = await gatherProse(seriesId);
  const settings = resolveExportSettings(series);
  const markdown = buildManuscriptMarkdown({ series, volumes }, settings);
  return {
    text: markdown,
    filename: `${slugifyForFilename(series.name || 'series')}-manuscript.md`,
  };
}

// ---------------------------------------------------------------------------
// 2) ePub (OCF container)
// ---------------------------------------------------------------------------

const escapeXml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Render one section's plain-text prose into XHTML paragraphs. Blank-line-
// separated blocks become <p>; single newlines inside a block become <br/>.
export function proseToXhtmlBody(content) {
  const blocks = String(content || '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return '<p></p>';
  return blocks.map((b) => `<p>${escapeXml(b).replace(/\n/g, '<br/>')}</p>`).join('\n');
}

// One XHTML chapter document for a whole volume (its chapters stacked). A
// volume-title header is emitted only for multi-volume books.
export function buildChapterXhtml(vol, { multiVolume }) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<!DOCTYPE html>');
  parts.push('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">');
  parts.push(`<head><title>${escapeXml(vol.title || `Volume ${vol.number}`)}</title>`);
  parts.push('<link rel="stylesheet" type="text/css" href="style.css"/></head>');
  parts.push('<body>');
  if (multiVolume) parts.push(`<h1 class="volume-title">${escapeXml(vol.title || `Volume ${vol.number}`)}</h1>`);
  for (const sec of vol.sections) {
    const heading = sec.title ? `Chapter ${sec.number} — ${sec.title}` : `Chapter ${sec.number}`;
    parts.push(`<section epub:type="chapter" id="ch-${escapeXml(sec.issueId)}">`);
    parts.push(`<h2 class="chapter-title">${escapeXml(heading)}</h2>`);
    parts.push(proseToXhtmlBody(sec.content));
    parts.push('</section>');
  }
  parts.push('</body></html>');
  return parts.join('\n');
}

// The OPF package document (EPUB 3): metadata + manifest + spine.
export function buildOpf({ settings, volumes, coverImage, bookId }) {
  const items = [];
  const spine = [];
  items.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  items.push('<item id="style" href="style.css" media-type="text/css"/>');
  if (coverImage) {
    items.push(`<item id="cover-image" href="${escapeXml(coverImage.name)}" media-type="${coverImage.mediaType}" properties="cover-image"/>`);
  }
  volumes.forEach((vol, idx) => {
    const id = `vol${idx + 1}`;
    items.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
  });
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">');
  lines.push('<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">');
  lines.push(`<dc:identifier id="book-id">${escapeXml(bookId)}</dc:identifier>`);
  lines.push(`<dc:title>${escapeXml(settings.titlePageTitle)}</dc:title>`);
  lines.push('<dc:language>en</dc:language>');
  if (settings.titlePageAuthor) lines.push(`<dc:creator>${escapeXml(settings.titlePageAuthor)}</dc:creator>`);
  if (settings.titlePageSubtitle) lines.push(`<dc:description>${escapeXml(settings.titlePageSubtitle)}</dc:description>`);
  lines.push(`<meta property="dcterms:modified">${modified}</meta>`);
  if (coverImage) lines.push('<meta name="cover" content="cover-image"/>');
  lines.push('</metadata>');
  lines.push(`<manifest>${items.join('')}</manifest>`);
  lines.push(`<spine>${spine.join('')}</spine>`);
  lines.push('</package>');
  return lines.join('\n');
}

// The EPUB 3 nav document (table of contents).
export function buildNavXhtml({ settings, volumes }) {
  const multiVolume = volumes.length > 1;
  const lis = [];
  volumes.forEach((vol, idx) => {
    const href = `vol${idx + 1}.xhtml`;
    const label = multiVolume ? (vol.title || `Volume ${vol.number}`) : (settings.titlePageTitle || 'Text');
    lis.push(`<li><a href="${href}">${escapeXml(label)}</a></li>`);
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
    `<head><title>${escapeXml(settings.titlePageTitle)}</title></head>`,
    '<body>',
    '<nav epub:type="toc" id="toc"><h1>Contents</h1>',
    `<ol>${lis.join('')}</ol>`,
    '</nav>',
    '</body></html>',
  ].join('\n');
}

const EPUB_CSS = `body { font-family: serif; line-height: 1.5; margin: 5%; }
h1.volume-title { text-align: center; margin: 2em 0; page-break-before: always; }
h2.chapter-title { text-align: center; margin: 2em 0 1em; page-break-before: always; }
p { margin: 0; text-indent: 1.5em; }
p:first-of-type { text-indent: 0; }
`;

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

// Resolve the series cover image (if any) into `{ name, mediaType, bytes }` for
// the ePub manifest. `series.coverImage` is a plain filename string (stamped by
// the cover filename hooks / setSeriesCoverImage). Returns null when there's no
// rendered cover — the ePub is still valid without one.
async function resolveCoverImage(series) {
  const filename = typeof series?.coverImage === 'string' && series.coverImage ? series.coverImage : null;
  if (!filename) return null;
  const bytes = await readImageFromMedia(filename, { subject: 'series cover image' }).catch(() => null);
  if (!bytes) return null;
  const kind = detectImageKind(bytes, filename);
  if (!kind) return null;
  const mediaType = kind === 'png' ? 'image/png' : 'image/jpeg';
  const ext = kind === 'png' ? 'png' : 'jpg';
  return { name: `cover.${ext}`, mediaType, bytes };
}

/**
 * Build the ePub as a Buffer. The OCF spec requires the `mimetype` entry to be
 * first and stored (uncompressed) — everything else is deflated. Returns
 * `{ bytes, filename }`.
 */
export async function buildEpub(seriesId) {
  const { series, volumes } = await gatherProse(seriesId);
  const settings = resolveExportSettings(series);
  const bookId = `urn:portos:series:${series.id}`;
  const coverImage = await resolveCoverImage(series);
  const multiVolume = volumes.length > 1;

  // OCF requires `mimetype` to be the FIRST entry, stored (uncompressed). It is
  // first in this list, and its 20-byte payload never shrinks under deflate, so
  // `createZip`'s "keep deflate only when smaller" rule stores it — satisfying
  // the spec while the bulkier text entries below still compress.
  const entries = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: buildOpf({ settings, volumes, coverImage, bookId }) },
    { name: 'OEBPS/nav.xhtml', data: buildNavXhtml({ settings, volumes }) },
    { name: 'OEBPS/style.css', data: EPUB_CSS },
    ...volumes.map((vol, idx) => ({ name: `OEBPS/vol${idx + 1}.xhtml`, data: buildChapterXhtml(vol, { multiVolume }) })),
  ];
  if (coverImage) entries.push({ name: `OEBPS/${coverImage.name}`, data: coverImage.bytes });
  const bytes = createZip(entries, { compress: true });

  return {
    bytes,
    filename: `${slugifyForFilename(series.name || 'series')}.epub`,
  };
}

// ---------------------------------------------------------------------------
// 3) Print-interior PDF
// ---------------------------------------------------------------------------

// Greedy word-wrap a paragraph to `maxWidth` at `size` using pdf-lib font
// metrics. Returns an array of lines. Pure over the font (exported via
// __testing with a stub `widthOfTextAtSize`).
export function wrapText(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const PDF_FONT_MAP = {
  times: { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold, italic: StandardFonts.TimesRomanItalic },
  helvetica: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold, italic: StandardFonts.HelveticaOblique },
  courier: { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold, italic: StandardFonts.CourierOblique },
};

/**
 * Build the print-interior PDF as a Uint8Array. Trade-format interior: title
 * page → per-volume/-chapter body with running heads (author verso, title
 * recto) and page numbers, wrapping the prose to the text block. Reuses the
 * `pdf-lib` plumbing from volumePdf.js. Returns `{ bytes, pageCount, filename }`.
 */
export async function buildProsePdf(seriesId) {
  const { series, volumes } = await gatherProse(seriesId);
  const settings = resolveExportSettings(series);
  const trim = TRIM_SIZES[settings.trimSize] || TRIM_SIZES[DEFAULT_TRIM_SIZE];
  const { width: pageW, height: pageH } = trim;

  const pdf = await PDFDocument.create();
  pdf.setTitle(settings.titlePageTitle);
  if (settings.titlePageAuthor) pdf.setAuthor(settings.titlePageAuthor);
  if (settings.titlePageSubtitle) pdf.setSubject(settings.titlePageSubtitle);
  pdf.setProducer('PortOS');

  const fontKey = PDF_FONT_MAP[settings.interiorFont] ? settings.interiorFont : 'times';
  const font = await pdf.embedFont(PDF_FONT_MAP[fontKey].regular);
  const fontBold = await pdf.embedFont(PDF_FONT_MAP[fontKey].bold);

  const margin = 54; // 0.75"
  const bodySize = 11;
  const lineHeight = bodySize * 1.4;
  const textW = pageW - margin * 2;
  const topY = pageH - margin;
  const bottomY = margin + 24; // reserve room for the page-number footer
  const runningHead = settings.titlePageTitle;
  const author = settings.titlePageAuthor;

  let pageNo = 0;
  let pageCount = 0;

  // --- Title page (no running head / number) ---
  const title = pdf.addPage([pageW, pageH]);
  pageCount += 1;
  {
    let cy = pageH * 0.62;
    const centered = (text, sz, f) => {
      const w = f.widthOfTextAtSize(text, sz);
      title.drawText(text, { x: (pageW - w) / 2, y: cy, size: sz, font: f, color: rgb(0, 0, 0) });
      cy -= sz * 1.6;
    };
    centered(settings.titlePageTitle, 24, fontBold);
    if (settings.titlePageSubtitle) centered(settings.titlePageSubtitle, 13, font);
    cy -= 24;
    if (settings.titlePageAuthor) centered(settings.titlePageAuthor, 14, font);
    if (settings.dedication) {
      cy = pageH * 0.25;
      for (const dl of wrapText(settings.dedication, font, 11, textW * 0.8)) {
        const w = font.widthOfTextAtSize(dl, 11);
        title.drawText(dl, { x: (pageW - w) / 2, y: cy, size: 11, font, color: rgb(0.3, 0.3, 0.3) });
        cy -= 11 * 1.4;
      }
    }
    if (settings.copyright) {
      const w = font.widthOfTextAtSize(settings.copyright, 8);
      title.drawText(settings.copyright.slice(0, 120), { x: (pageW - w) / 2, y: margin + 8, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
    }
  }

  const multiVolume = volumes.length > 1;
  let page = null;
  let y = 0;

  const footer = (p, n) => {
    const s = String(n);
    const w = font.widthOfTextAtSize(s, 9);
    p.drawText(s, { x: (pageW - w) / 2, y: margin, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
  };
  const header = (p, text) => {
    if (!text) return;
    const w = font.widthOfTextAtSize(text, 8);
    p.drawText(text, { x: (pageW - w) / 2, y: pageH - margin + 6, size: 8, font, color: rgb(0.5, 0.5, 0.5) });
  };
  const newPage = () => {
    // Running head alternates: verso (even page number) = author, recto = title.
    pageNo += 1;
    page = pdf.addPage([pageW, pageH]);
    pageCount += 1;
    footer(page, pageNo);
    header(page, pageNo % 2 === 0 ? author : runningHead);
    y = topY;
  };
  const ensureSpace = (needed) => {
    if (!page || y - needed < bottomY) newPage();
  };

  for (const vol of volumes) {
    if (multiVolume) {
      newPage();
      y = pageH * 0.5;
      const vt = vol.title || `Volume ${vol.number}`;
      const w = fontBold.widthOfTextAtSize(vt, 20);
      page.drawText(vt, { x: (pageW - w) / 2, y, size: 20, font: fontBold, color: rgb(0, 0, 0) });
      y = bottomY; // force a fresh page for the first chapter
    }
    for (const sec of vol.sections) {
      // Chapter opener starts on a fresh page.
      newPage();
      y = pageH * 0.72;
      const heading = sec.title ? `Chapter ${sec.number} — ${sec.title}` : `Chapter ${sec.number}`;
      for (const hl of wrapText(heading, fontBold, 16, textW)) {
        const w = fontBold.widthOfTextAtSize(hl, 16);
        page.drawText(hl, { x: (pageW - w) / 2, y, size: 16, font: fontBold, color: rgb(0, 0, 0) });
        y -= 16 * 1.4;
      }
      y -= lineHeight;
      const paras = String(sec.content || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      for (const para of paras) {
        const wrapped = wrapText(para, font, bodySize, textW);
        for (let i = 0; i < wrapped.length; i += 1) {
          ensureSpace(lineHeight);
          // First-line indent for continued paragraphs (not the chapter's first).
          const indent = i === 0 ? 18 : 0;
          page.drawText(wrapped[i], { x: margin + indent, y, size: bodySize, font, color: rgb(0, 0, 0) });
          y -= lineHeight;
        }
        y -= lineHeight * 0.3; // paragraph gap
      }
    }
  }

  const bytes = await pdf.save();
  return {
    bytes,
    pageCount,
    filename: `${slugifyForFilename(series.name || 'series')}-interior.pdf`,
  };
}

export const __testing = {
  groupIntoVolumes,
  buildManuscriptMarkdown,
  proseToXhtmlBody,
  buildChapterXhtml,
  buildOpf,
  buildNavXhtml,
  wrapText,
};
