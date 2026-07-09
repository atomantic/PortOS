/**
 * Pipeline prose-export routes (#2181) — download a prose series as a compiled
 * manuscript (Markdown), an ePub, or a print-interior PDF. Each artifact is
 * assembled on demand and streamed straight to the response — no on-disk
 * artifact, so a re-export always reflects the freshest manuscript. All three
 * 409 (ERR_NO_PROSE) when no issue has drafted prose yet.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import {
  buildManuscriptFile,
  buildEpub,
  buildProsePdf,
} from '../../services/pipeline/proseExport.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Stream a Buffer/Uint8Array body with download headers.
const sendBinary = (res, { bytes, filename, contentType }) => {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
};

// Compiled manuscript — Markdown with front matter, volume breaks, chapter headings.
router.get('/series/:id/export/manuscript.md', asyncHandler(async (req, res) => {
  const { text, filename } = await buildManuscriptFile(req.params.id)
    .catch((err) => { throw mapServiceError(err); });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(text);
}));

// ePub — OCF container (XHTML chapters + OPF manifest + cover), packaged in-repo.
router.get('/series/:id/export/book.epub', asyncHandler(async (req, res) => {
  const { bytes, filename } = await buildEpub(req.params.id)
    .catch((err) => { throw mapServiceError(err); });
  sendBinary(res, { bytes, filename, contentType: 'application/epub+zip' });
}));

// Print-interior PDF — trade-format interior (trim size, margins, running heads).
router.get('/series/:id/export/interior.pdf', asyncHandler(async (req, res) => {
  const { bytes, filename } = await buildProsePdf(req.params.id)
    .catch((err) => { throw mapServiceError(err); });
  sendBinary(res, { bytes, filename, contentType: 'application/pdf' });
}));

export default router;
