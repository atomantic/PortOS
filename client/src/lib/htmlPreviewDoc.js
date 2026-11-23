/**
 * Add a Content-Security-Policy to a sandboxed model HTML preview.
 * The policy allows inline scripts and styles while blocking fetches, remote resources and form submissions.
 */

import { injectPreviewHead } from '../../../server/lib/htmlPreviewHead.js';

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join('; ');

const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

/** `html` with the policy inserted as early as the markup allows, leaving a doctype first so the page keeps standards mode. */
export function previewDocument(html) {
  return injectPreviewHead(String(html || ''), META);
}
