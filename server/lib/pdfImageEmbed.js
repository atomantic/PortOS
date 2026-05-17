/**
 * PDF image-embed helpers shared between the issue-level comic PDF and the
 * volume-level trade-paperback PDF. Both assemblies read PNG/JPEG files
 * from PATHS.images, embed them into a pdf-lib document, and fit each
 * image to a printable page with a small white margin.
 *
 * Caller passes its own error codes / subject strings so a failure inside
 * one assembly surfaces a distinguishable code (e.g. `_COMIC_PDF_` vs
 * `_VOLUME_PDF_`) without forcing this module to know which path called it.
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { PATHS, assertSafeFilename } from './fileUtils.js';
import { ServerError } from './errorHandler.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
export const IMAGE_EXTS = Object.freeze(['.png', '.jpg', '.jpeg']);

// Magic-byte sniff so a .png-named file that's actually JPEG (or vice versa)
// still embeds correctly. Falls back to extension only when sniff is inconclusive.
export function detectImageKind(bytes, filename) {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(PNG_MAGIC)) return 'png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_MAGIC)) return 'jpg';
  const ext = (filename || '').toLowerCase();
  if (ext.endsWith('.png')) return 'png';
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'jpg';
  return null;
}

export async function readImageFromMedia(filename, { subject }) {
  assertSafeFilename(filename, { extensions: IMAGE_EXTS, subject });
  return readFile(join(PATHS.images, filename));
}

export async function embedImageBytes(pdf, bytes, filename, { unsupportedCode }) {
  const kind = detectImageKind(bytes, filename);
  if (kind === 'png') return pdf.embedPng(bytes);
  if (kind === 'jpg') return pdf.embedJpg(bytes);
  throw new ServerError(`Unsupported image format for "${filename}" — expected PNG or JPEG`, {
    status: 415, code: unsupportedCode,
  });
}

// White margin reads as "edition" rather than "raw print plate" and avoids
// cropping signed art on the page edges.
export function fitImage(imgW, imgH, pageW, pageH, marginPt = 18) {
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
