/**
 * Fixed themes, prompt and mechanical page checks for the HTML Pages bench: ask a local model for one to five creative standalone HTML pages and judge them side by side.
 *
 * The brief is fixed so two models' galleries compare page for page. The checks only establish that a page is a complete, self-contained document; whether it looks good is left to the person looking at the frames.
 */

/** The most pages one run may ask for; the default is what the form pre-selects. */
export const HTML_PAGES_MAX = 5;
export const HTML_PAGES_DEFAULT = 3;

/**
 * Fixed themes, in order: page N of a run is always theme N, for every model, so
 * two models' galleries are comparable page for page. They are deliberately
 * unlike each other (a simulation, a toy, a scene, an instrument, a diagram), so
 * "zero repetitive designs" is a property of the brief rather than something a
 * model has to remember across separate requests.
 */
export const HTML_PAGE_THEMES = Object.freeze([
  'Rain on Glass: a window pane in a storm, with droplets that gather and run',
  'Brass Orrery: a clockwork model of a small solar system that you can wind and slow',
  'Ant Colony: a cutaway of a living nest with foragers, tunnels and chambers',
  'Geoboard: a pegboard where the visitor stretches rubber bands into shapes',
  'The Pentatonic Parlour: an instrument you can play with the mouse or keyboard',
]);

/** The prompt for one page. One request per page, so each page gets the model's full attention and token budget. */
export const htmlPagePrompt = (theme) => [
  'Create one standalone HTML file.',
  '',
  `Theme: ${theme}.`,
  '',
  'Rules:',
  '- It must look stunning.',
  '- Go full creative mode: its own layout, palette, typography and motion. Do not use a generic template.',
  '- Make it interactive or animated, not a static poster.',
  '- Everything inline: one file with its own <style> and <script>. No external fonts, images, scripts or network requests.',
  '- Reply with only the complete HTML document, starting at <!doctype html>.',
].join('\n');

// ---- scoring ----------------------------------------------------------------

/** Smallest document that can plausibly be a designed page rather than a stub. */
const HTML_MIN_BYTES = 1200;

/**
 * Pull the HTML document out of a model reply.
 *
 * Models wrap it in a fence or add a sentence of preamble even when told not to;
 * both are format slips, not failures of the page itself, so the document is cut
 * out rather than the whole reply being scored. The page is kept exactly as
 * written — nothing is repaired — so a truncated one still reads as truncated.
 *
 * @returns {string} the document, or '' when the reply holds no HTML at all
 */
export function extractHtmlDocument(text) {
  const raw = String(text || '');
  const fenced = /```(?:html)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n```|$)/i.exec(raw);
  const body = fenced && /<(?:!doctype|html|body|style|div|canvas|svg)\b/i.test(fenced[1]) ? fenced[1] : raw;
  const start = body.search(/<!doctype html|<html[\s>]/i);
  if (start >= 0) return body.slice(start).trim();
  return /<(?:body|style|div|canvas|svg|script)\b/i.test(body) ? body.trim() : '';
}

/**
 * Mechanical checks on one generated page. These only establish that the page is
 * a complete, self-contained document, which is what the prompt asked for;
 * "stunning" is a judgement, so it is left to the gallery.
 */
export function scoreHtmlPage(html) {
  const doc = String(html || '');
  const external = /(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(doc)
    || /@import\s+(?:url\()?["']?(?:https?:)?\/\//i.test(doc)
    || /\b(?:fetch|XMLHttpRequest)\b|\bimport\s*\(/.test(doc.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
  const checks = [
    { id: 'document', label: 'Complete HTML document', ok: /<html[\s>]/i.test(doc) && /<\/html>\s*$/i.test(doc) },
    { id: 'size', label: 'More than a stub', ok: doc.length >= HTML_MIN_BYTES },
    { id: 'styled', label: 'Has its own styles', ok: /<style[\s>]/i.test(doc) },
    { id: 'interactive', label: 'Has script or animation', ok: /<script[\s>]/i.test(doc) || /@keyframes|animation\s*:/i.test(doc) },
    { id: 'self-contained', label: 'No external resources', ok: !external },
  ];
  const passed = checks.filter((c) => c.ok).length;
  return { checks, passed, total: checks.length, bytes: doc.length };
}

/**
 * Verdict for a whole run. A page passes when every mechanical check does;
 * `partial` is some pages passing, so a model that is sometimes truncated or
 * leaks an external font does not read the same as one that never produces HTML.
 *
 * @param {Array<{html:string, error?:string|null}>} pages
 */
export function scoreHtmlPages(pages) {
  const scored = (pages || []).map((page) => ({ ...scoreHtmlPage(page.html), error: page.error ?? null }));
  const complete = scored.filter((p) => p.passed === p.total).length;
  const rendered = scored.filter((p) => p.bytes > 0).length;
  const verdict = scored.length && complete === scored.length ? 'passed' : (complete > 0 ? 'partial' : 'failed');
  return {
    verdict,
    pageCount: scored.length,
    complete,
    rendered,
    pages: scored.map(({ checks, passed, total, bytes, error }) => ({ checks, passed, total, bytes, error })),
    summary: `${complete} of ${scored.length} page${scored.length === 1 ? '' : 's'} complete and self-contained`,
  };
}
