/**
 * Wrap a model-generated HTML page for display in a sandboxed iframe, with a Content-Security-Policy that restricts resource loads.
 *
 * The policy preserves authored markup and lets inline scripts and styles run. It denies fetches, remote scripts, remote fonts, remote images and form posts.
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
