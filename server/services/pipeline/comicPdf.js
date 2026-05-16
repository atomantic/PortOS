/**
 * Assemble a print-ready PDF from a comic issue's rendered cover + pages.
 * Filenames come from each record's proof/final slot (or legacy `filename`
 * for records that predate the split): finalImage > proofImage > legacy
 * filename. The comic-pages filename hook stamps each slot's filename at
 * media-job completion. Pages without any rendered slot are skipped — the
 * route surfaces "X of Y rendered" to the user before download.
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { PATHS, assertSafeFilename } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { slugifyForFilename } from '../../lib/civitai.js';
import { getIssue } from './issues.js';
import { getSeries } from './series.js';
import { resolveVisualStyle } from '../../lib/visualStyles.js';

export const PAGE_SIZES = Object.freeze({
  'us-letter': { width: 612, height: 792 },
  'a4':        { width: 595.28, height: 841.89 },
  'tabloid':   { width: 792, height: 1224 },
});
export const DEFAULT_PAGE_SIZE = 'us-letter';

export const ERR_NO_RENDERED_PAGES = 'PIPELINE_COMIC_PDF_NO_PAGES';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const IMAGE_EXTS = Object.freeze(['.png', '.jpg', '.jpeg']);

// Magic-byte sniff so a .png-named file that's actually JPEG (or vice versa)
// still embeds correctly. Falls back to extension only when sniff is inconclusive.
function detectImageKind(bytes, filename) {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(PNG_MAGIC)) return 'png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_MAGIC)) return 'jpg';
  const ext = (filename || '').toLowerCase();
  if (ext.endsWith('.png')) return 'png';
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'jpg';
  return null;
}

async function readImageFromMedia(filename) {
  assertSafeFilename(filename, { extensions: IMAGE_EXTS, subject: 'comic page image' });
  return readFile(join(PATHS.images, filename));
}

async function embedImageBytes(pdf, bytes, filename) {
  const kind = detectImageKind(bytes, filename);
  if (kind === 'png') return pdf.embedPng(bytes);
  if (kind === 'jpg') return pdf.embedJpg(bytes);
  throw new ServerError(`Unsupported image format for "${filename}" — expected PNG or JPEG`, {
    status: 415, code: 'PIPELINE_COMIC_PDF_UNSUPPORTED_IMAGE',
  });
}

// White margin reads as "edition" rather than "raw print plate" and avoids
// cropping signed art on the page edges.
function fitImage(imgW, imgH, pageW, pageH, marginPt = 18) {
  const availW = pageW - marginPt * 2;
  const availH = pageH - marginPt * 2;
  const scale = Math.min(availW / imgW, availH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  return {
    x: (pageW - drawW) / 2,
    y: (pageH - drawH) / 2,
    width: drawW,
    height: drawH,
  };
}

/**
 * @returns {{ bytes: Uint8Array, pageCount: number, filename: string }}
 */
export async function buildComicPdf(issueId, opts = {}) {
  const issue = await getIssue(issueId);
  const series = await getSeries(issue.seriesId);

  const sizeKey = PAGE_SIZES[opts.size] ? opts.size : DEFAULT_PAGE_SIZE;
  const { width: pageW, height: pageH } = PAGE_SIZES[sizeKey];
  const includeCover = opts.includeCover !== false;
  const includeColophon = opts.includeColophon !== false;

  // Read-fallback chain for each cover/page filename:
  //   1. finalImage.filename  — the hi-res print-ready render (preferred)
  //   2. proofImage.filename  — the fast layout render
  //   3. legacy `filename`    — pre-proof/final split records
  // The user can keep iterating on the proof while the final is in flight,
  // and the PDF will still assemble — just at whichever resolution is
  // currently available.
  const pickRenderedFilename = (record) => {
    if (!record) return null;
    return record.finalImage?.filename
      || record.proofImage?.filename
      || (typeof record.filename === 'string' && record.filename ? record.filename : null);
  };

  const comicPages = issue.stages?.comicPages || {};
  const cover = includeCover ? comicPages.cover : null;
  const pages = Array.isArray(comicPages.pages) ? comicPages.pages : [];

  const targets = [];
  const coverFilename = pickRenderedFilename(cover);
  if (coverFilename) targets.push(coverFilename);
  for (const p of pages) {
    const name = pickRenderedFilename(p);
    if (name) targets.push(name);
  }
  if (targets.length === 0) {
    throw makeErr('Issue has no rendered pages or cover yet', ERR_NO_RENDERED_PAGES);
  }

  // Read all files concurrently — disk I/O parallelizes cleanly; pdf-lib's
  // embed is CPU-bound on the event loop so embedding stays sequential below.
  // One bad page must not fail the whole download, so errors are captured
  // alongside the bytes and logged when the loop reaches them.
  const loaded = await Promise.all(targets.map((filename) =>
    readImageFromMedia(filename)
      .then((bytes) => ({ filename, bytes }))
      .catch((err) => ({ filename, err })),
  ));

  const pdf = await PDFDocument.create();
  if (series.name || issue.title) {
    pdf.setTitle(`${series.name || 'Untitled'} #${issue.number || 1} — ${issue.title || ''}`.trim());
  }
  if (series.logline) pdf.setSubject(series.logline);
  pdf.setProducer('PortOS');
  pdf.setCreator('PortOS pipeline');

  let pageCount = 0;
  for (const entry of loaded) {
    if (entry.err) {
      console.error(`❌ comicPdf — skipped "${entry.filename}": ${entry.err.message || entry.err}`);
      continue;
    }
    const img = await embedImageBytes(pdf, entry.bytes, entry.filename).catch((err) => {
      console.error(`❌ comicPdf — embed failed "${entry.filename}": ${err.message || err}`);
      return null;
    });
    if (!img) continue;
    const page = pdf.addPage([pageW, pageH]);
    page.drawImage(img, fitImage(img.width, img.height, pageW, pageH));
    pageCount += 1;
  }

  if (pageCount === 0) {
    throw makeErr('No usable pages — all embeds failed', ERR_NO_RENDERED_PAGES);
  }

  if (includeColophon) {
    const colophon = pdf.addPage([pageW, pageH]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const left = 72;
    let cursor = pageH - 144;
    const drawLine = (text, { size = 11, bold = false, color = rgb(0.2, 0.2, 0.2) } = {}) => {
      colophon.drawText(text, { x: left, y: cursor, size, font: bold ? fontBold : font, color });
      cursor -= size + 8;
    };
    drawLine(series.name || 'Untitled Series', { size: 22, bold: true, color: rgb(0, 0, 0) });
    drawLine(`Issue #${issue.number || 1} — ${issue.title || ''}`.trim(), { size: 14, bold: true });
    cursor -= 12;
    if (series.logline) drawLine(`Logline: ${series.logline}`, { size: 10 });
    drawLine(`Generated: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`, { size: 10 });
    const style = resolveVisualStyle(series, issue, 'comicPages');
    if (style?.name) drawLine(`Visual style: ${style.name}`, { size: 10 });
    drawLine(`Page count (rendered art): ${pageCount}`, { size: 10 });
    cursor -= 16;
    drawLine('Generated by PortOS pipeline.', { size: 9, color: rgb(0.45, 0.45, 0.45) });
    pageCount += 1;
  }

  const bytes = await pdf.save();
  return { bytes, pageCount, filename: buildPdfFilename(series, issue) };
}

function buildPdfFilename(series, issue) {
  const seriesSlug = slugifyForFilename(series.name || 'series');
  const num = String(issue.number || 1).padStart(2, '0');
  const titleSlug = issue.title ? slugifyForFilename(issue.title) : '';
  return titleSlug ? `${seriesSlug}-${num}-${titleSlug}.pdf` : `${seriesSlug}-${num}.pdf`;
}
