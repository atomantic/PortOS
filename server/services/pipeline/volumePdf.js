/**
 * Assemble a print-ready trade-paperback PDF for one volume (season).
 *
 * Order: [vol front] → for each issue in arcPosition order:
 *   [issue front] → [issue pages…] → [issue back]
 * → [vol back] → optional colophon.
 *
 * Issues with `seasonId === null` are ignored (they're not in this volume).
 * Issues in the volume that lack a rendered slot for a given page/cover are
 * silently skipped — the colophon surfaces "M of N issues, P of Q pages
 * rendered" so the user can see what's still pending.
 *
 * Volume cover existence is required: a coverless volume PDF would assemble
 * silently and look like a "publisher proof" instead of a trade paperback,
 * so the route surfaces a 409 with ERR_NO_VOLUME_COVER instead.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { slugifyForFilename } from '../../lib/civitai.js';
import { pickRenderedFilename } from '../../lib/renderSlot.js';
import { readImageFromMedia, embedImageBytes, fitImage } from '../../lib/pdfImageEmbed.js';
import { getSeries } from './series.js';
import { getSeason } from './seasons.js';
import { listIssues } from './issues.js';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE } from './comicPdf.js';

export const ERR_NO_VOLUME_COVER = 'PIPELINE_VOLUME_PDF_NO_COVER';
export const ERR_NO_RENDERED_ISSUES = 'PIPELINE_VOLUME_PDF_NO_RENDERED_ISSUES';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const READ_OPTS = { subject: 'volume page image' };
const EMBED_OPTS = { unsupportedCode: 'PIPELINE_VOLUME_PDF_UNSUPPORTED_IMAGE' };

/**
 * @returns {{ bytes: Uint8Array, pageCount: number, filename: string, issueManifest: Array }}
 */
export async function buildVolumePdf(seriesId, seasonId, opts = {}) {
  const season = await getSeason(seriesId, seasonId);
  const series = await getSeries(seriesId);

  const sizeKey = PAGE_SIZES[opts.size] ? opts.size : DEFAULT_PAGE_SIZE;
  const { width: pageW, height: pageH } = PAGE_SIZES[sizeKey];
  const includeColophon = opts.includeColophon !== false;

  const volCoverFilename = pickRenderedFilename(season.cover);
  if (!volCoverFilename) {
    throw makeErr(
      `Volume ${season.number || 1} has no rendered front cover yet — render it before compiling the volume PDF.`,
      ERR_NO_VOLUME_COVER,
    );
  }
  const volBackFilename = pickRenderedFilename(season.backCover);

  // All issues in this volume, sorted by arcPosition (with `??` fallback to
  // `number`). `||` would silently demote `arcPosition === 0` — a legitimate
  // first-position value — so use nullish coalescing.
  const all = await listIssues({ seriesId });
  const issuesInVolume = all
    .filter((iss) => iss.seasonId === seasonId)
    .sort((a, b) => (a.arcPosition ?? a.number ?? 0) - (b.arcPosition ?? b.number ?? 0));

  // Build the ordered filename list + a parallel manifest for the colophon.
  // The manifest tracks how many pages each issue contributed so the
  // colophon can surface "Issue #3 — 14 of 22 pages rendered" honestly.
  const targets = [{ filename: volCoverFilename, kind: 'vol-cover' }];
  const issueManifest = [];
  for (const iss of issuesInVolume) {
    const cp = iss.stages?.comicPages || {};
    const issueCoverFn = pickRenderedFilename(cp.cover);
    const issueBackFn = pickRenderedFilename(cp.backCover);
    const pages = Array.isArray(cp.pages) ? cp.pages : [];
    const pageFilenames = pages.map(pickRenderedFilename).filter(Boolean);

    const totalSlots = (cp.cover ? 1 : 0) + pages.length + (cp.backCover ? 1 : 0);
    const renderedSlots = (issueCoverFn ? 1 : 0) + pageFilenames.length + (issueBackFn ? 1 : 0);

    issueManifest.push({
      number: iss.number,
      title: iss.title,
      pagesRendered: pageFilenames.length,
      pagesTotal: pages.length,
      coverRendered: !!issueCoverFn,
      backCoverRendered: !!issueBackFn,
      totalSlots,
      renderedSlots,
    });

    if (issueCoverFn) targets.push({ filename: issueCoverFn, kind: 'issue-cover' });
    for (const fn of pageFilenames) targets.push({ filename: fn, kind: 'page' });
    if (issueBackFn) targets.push({ filename: issueBackFn, kind: 'issue-back' });
  }
  if (volBackFilename) targets.push({ filename: volBackFilename, kind: 'vol-back' });

  if (targets.length === 1) {
    // Only the volume front cover and nothing else — not really a volume.
    throw makeErr(
      `Volume ${season.number || 1} has no rendered issue pages yet — render at least one issue's pages first.`,
      ERR_NO_RENDERED_ISSUES,
    );
  }

  // Parallel disk reads; embed sequentially because pdf-lib is single-threaded.
  // A failed read for one image must not fail the whole download.
  const loaded = await Promise.all(targets.map(({ filename, kind }) =>
    readImageFromMedia(filename, READ_OPTS)
      .then((bytes) => ({ filename, kind, bytes }))
      .catch((err) => ({ filename, kind, err })),
  ));

  const pdf = await PDFDocument.create();
  const volTitle = season.title || `Volume ${season.number || 1}`;
  pdf.setTitle(`${series.name || 'Untitled'} — ${volTitle}`.trim());
  if (series.logline) pdf.setSubject(series.logline);
  pdf.setProducer('PortOS');
  pdf.setCreator('PortOS pipeline');

  let pageCount = 0;
  for (const entry of loaded) {
    if (entry.err) {
      console.error(`❌ volumePdf — skipped "${entry.filename}": ${entry.err.message || entry.err}`);
      continue;
    }
    const img = await embedImageBytes(pdf, entry.bytes, entry.filename, EMBED_OPTS).catch((err) => {
      console.error(`❌ volumePdf — embed failed "${entry.filename}": ${err.message || err}`);
      return null;
    });
    if (!img) continue;
    const page = pdf.addPage([pageW, pageH]);
    page.drawImage(img, fitImage(img.width, img.height, pageW, pageH));
    pageCount += 1;
  }

  if (pageCount === 0) {
    throw makeErr('No usable pages — all embeds failed', ERR_NO_RENDERED_ISSUES);
  }

  if (includeColophon) {
    const colophon = pdf.addPage([pageW, pageH]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const left = 72;
    let cursor = pageH - 96;
    const drawLine = (text, { size = 11, bold = false, color = rgb(0.2, 0.2, 0.2) } = {}) => {
      colophon.drawText(text, { x: left, y: cursor, size, font: bold ? fontBold : font, color });
      cursor -= size + 8;
    };
    drawLine(series.name || 'Untitled Series', { size: 22, bold: true, color: rgb(0, 0, 0) });
    drawLine(`Volume ${season.number || 1} — ${season.title || ''}`.trim(), { size: 14, bold: true });
    cursor -= 12;
    if (season.logline) drawLine(`Logline: ${season.logline}`, { size: 10 });
    drawLine(`Issues: ${issuesInVolume.length}    Pages: ${pageCount}    Generated: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`, { size: 10 });
    cursor -= 8;
    drawLine('Contents:', { size: 11, bold: true });
    for (const m of issueManifest) {
      // `totalSlots === 0` happens when the issue has no cover, no pages,
      // and no back cover — labeling that "complete" would imply the issue
      // is shipped when in fact there's nothing in it.
      const renderStatus = m.totalSlots === 0
        ? 'empty'
        : m.renderedSlots === m.totalSlots
          ? 'complete'
          : `${m.renderedSlots}/${m.totalSlots} rendered`;
      drawLine(`  #${m.number || '?'} — ${m.title || '(untitled)'} (${renderStatus})`, { size: 10 });
    }
    cursor -= 16;
    drawLine('Generated by PortOS pipeline.', { size: 9, color: rgb(0.45, 0.45, 0.45) });
    pageCount += 1;
  }

  const bytes = await pdf.save();
  return {
    bytes,
    pageCount,
    filename: buildVolumePdfFilename(series, season),
    issueManifest,
  };
}

function buildVolumePdfFilename(series, season) {
  const seriesSlug = slugifyForFilename(series.name || 'series');
  const num = String(season.number || 1).padStart(2, '0');
  const titleSlug = season.title ? slugifyForFilename(season.title) : '';
  return titleSlug ? `${seriesSlug}-vol-${num}-${titleSlug}.pdf` : `${seriesSlug}-vol-${num}.pdf`;
}
