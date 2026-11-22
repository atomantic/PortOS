/**
 * Wrap a model-generated HTML page for display in a sandboxed iframe, with a Content-Security-Policy that blocks every network request.
 *
 * Only a header is added; the page itself is shown exactly as the model wrote it. Scripts and inline styles still run, which is the point of previewing an interactive page, but fetches, remote scripts, fonts, images and form posts are refused.
 */

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
].join('; ');

const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

/** `html` with the policy inserted as early as the markup allows, leaving a doctype first so the page keeps standards mode. */
export function previewDocument(html) {
  const doc = String(html || '');
  const head = /<head(?:\s[^>]*)?>/i.exec(doc);
  if (head) return doc.slice(0, head.index + head[0].length) + META + doc.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(doc);
  if (root) return `${doc.slice(0, root.index + root[0].length)}<head>${META}</head>${doc.slice(root.index + root[0].length)}`;
  return `<!doctype html><html><head>${META}</head><body>${doc}</body></html>`;
}
