/**
 * Default page briefs, prompt and mechanical page checks for the HTML Pages bench: ask a local model for one to five creative standalone HTML pages and judge them side by side.
 *
 * The person writes each page's brief (by default generic creative guidelines that leave the subject to the model); PortOS asks the model to plan the page from it first, then to build the page from the brief and that plan, adding only fixed text that is shown beside the brief before a run. Every model in a comparison gets the same briefs so galleries compare page for page. The checks only establish that a page is a complete, self-contained document; whether it looks good is left to the person looking at the frames.
 */

/** The most pages one run may ask for. */
export const HTML_PAGES_MAX = 5;

/** The longest page brief accepted; the prompt carries it verbatim, never truncated. */
export const HTML_BRIEF_MAX_CHARS = 2000;

/**
 * The brief every page starts with: creative guidelines that leave WHAT to build to the model, so a run compares each model's own ideas rather than its take on a PortOS-chosen subject. The person can replace it with a specific brief per page.
 */
export const HTML_PAGE_DEFAULT_BRIEF = '- look stunning\n- original\n- go full creative mode';

/** The briefs the form is pre-filled with: the default brief for every page slot. */
export const HTML_PAGE_DEFAULT_BRIEFS = Object.freeze(Array.from({ length: HTML_PAGES_MAX }, () => HTML_PAGE_DEFAULT_BRIEF));

/**
 * The fixed text PortOS puts around a page brief. Exported on its own so the form can show exactly what is added, built by the same code that sends it.
 *
 * Each page is two requests to the same model: first `planBefore + brief + planAfter` asks for a detailed plan, then `before + brief + planLabel + plan + after` asks for the page built from that plan. A page whose plan step failed is asked with `before + brief + after` alone.
 */
export const htmlPagePromptParts = () => ({
  planBefore: 'You will build one standalone HTML page from the brief below. First write the detailed plan for it.\n\nBrief:\n',
  planAfter: [
    '',
    '',
    'Write the plan as a detailed prompt another developer could build the page from: the concept, the content and sections, the layout, the visual style (palette, type, motion), the interactions, and how it all fits in one self-contained file with inline CSS and JavaScript and no external resources. Check that every part can really be built that way.',
    'Reply with only the plan, no code.',
  ].join('\n'),
  before: 'Create one standalone HTML file.\n\n',
  planLabel: '\n\nBuild it from this plan:\n\n',
  after: [
    '',
    '',
    'Rules:',
    '- Implement the plan directly. Keep any additional planning brief so you can return the complete page.',
    '- Everything inline: one file with its own <style> and <script>. No external fonts, images, scripts or network requests.',
    '- Reply with only the complete HTML document, starting at <!doctype html>.',
  ].join('\n'),
});

/** The planning request for one page: the brief exactly as written, asking for a detailed plan of the page. */
export const htmlPagePlanPrompt = (brief) => {
  const { planBefore, planAfter } = htmlPagePromptParts();
  return `${planBefore}${brief}${planAfter}`;
};

/** The page request: the brief exactly as written and, when the plan step produced one, the model's plan, between the fixed parts. One request per page, so each page gets the model's full attention and token budget. */
export const htmlPagePrompt = (brief, plan = null) => {
  const { before, planLabel, after } = htmlPagePromptParts();
  return `${before}${brief}${plan ? `${planLabel}${plan}` : ''}${after}`;
};

/** The plan out of a planning reply: a reasoning block a model wrote inline is dropped so only the plan is shown and sent on. Empty when the reply held no plan. */
export const extractHtmlPagePlan = (text) => {
  const reply = String(text || '').replace(/^\s*<think>[\s\S]*?<\/think>/i, '').trim();
  // A reasoning block cut off before it closed holds no plan.
  return /^<think>/i.test(reply) ? '' : reply;
};

// ---- scoring ----------------------------------------------------------------

/** Smallest document that can plausibly be a designed page rather than a stub. */
const HTML_MIN_BYTES = 1200;

/**
 * Pull the HTML document out of a model reply.
 *
 * Models wrap it in a fence or add a sentence of preamble even when told not to; both are format slips, not failures of the page itself, so the document is cut out rather than the whole reply being scored. A thinking model may also write its plan first and mention `<!doctype html>` or `<svg>` in it, so the LAST document start wins and prose that merely mentions tags is not a page. The page is kept exactly as written — nothing is repaired — so a truncated one still reads as truncated.
 *
 * @returns {string} the document, or '' when the reply holds no HTML at all
 */
export function extractHtmlDocument(text) {
  const raw = String(text || '');
  const fenced = /```(?:html)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n```|$)/i.exec(raw);
  const body = fenced && /<(?:!doctype|html|body|style|div|canvas|svg)\b/i.test(fenced[1]) ? fenced[1] : raw;
  // A doctype opens the document when there is one; `<html>` alone only when there is not, so the two never split a single document.
  const lastIndex = (re) => [...body.matchAll(re)].reduce((_, match) => match.index, -1);
  const doctype = lastIndex(/<!doctype html/gi);
  const start = doctype >= 0 ? doctype : lastIndex(/<html[\s>]/gi);
  if (start >= 0) return body.slice(start).trim();
  // No document start: accept a bare fragment only when the whole reply is markup, never prose that mentions a tag.
  return /^\s*<[a-z]/i.test(body) ? body.trim() : '';
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
    // A model that answers with an outline writes `<style>...</style>` and `<script>...</script>` instead of the code.
    { id: 'real-code', label: 'Real code, not "..." placeholders', ok: !/<(style|script)\b[^>]*>\s*(?:\.{3}|…)\s*<\/\1>/i.test(doc) },
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
    summary: `${complete} of ${scored.length} page${scored.length === 1 ? '' : 's'} pass every check`,
  };
}
