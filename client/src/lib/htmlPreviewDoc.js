/**
 * Add a Content-Security-Policy to a sandboxed model HTML preview.
 * The policy allows inline scripts and styles while blocking fetches, remote resources and form submissions.
 */

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

export function previewDocument(html) {
  // The parser puts this meta in an implicit head before it encounters model markup.
  return `<!doctype html>${META}${String(html || '')}`;
}
