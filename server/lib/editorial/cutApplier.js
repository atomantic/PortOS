/**
 * Editorial — pure cut-matching + application helpers (#2168 / #2173).
 *
 * Autonovel's signature editing technique: the passages an editor persona
 * marks for cutting ARE the revision plan. These pure functions locate a cut
 * quote in a block of prose and remove it, with a multi-tier matching strategy
 * so an LLM's whitespace reflow doesn't defeat an otherwise-valid cut.
 *
 * Extracted from `server/services/pipeline/applyCuts.js` so BOTH the pipeline
 * manuscript applier (per-issue stage sections) AND the Writers Room polish
 * loop (a single freeform work body) share one matcher — no side effects, no
 * pipeline coupling.
 *
 * Matching tiers:
 *   1. Exact string match — verbatim substring.
 *   2. Whitespace-normalized regex — tokens joined by \s+, handles reflow.
 *   3. Refuse ambiguous — more than 1 occurrence → manual review.
 *   4. Refuse short — < MIN_ANCHOR_CHARS chars → too risky for mechanical removal.
 */

import { SAFE_CUT_TYPES, CUT_TYPES } from './checkInfra.js';

export { SAFE_CUT_TYPES, CUT_TYPES };

// Minimum anchor length to apply mechanically — shorter quotes are too risky.
export const MIN_ANCHOR_CHARS = 25;

/**
 * Build a whitespace-tolerant regex for a quote. LLMs often reformat whitespace
 * when quoting (collapsed indentation, added line breaks), so exact match fails
 * even when the quote clearly targets a real span.
 */
export function buildWhitespaceTolerantRegex(quote) {
  const escaped = quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/\s+/g, '\\s+'), 'g');
}

/**
 * Locate a cut quote in the text. Returns { start, end, method } on success,
 * or { error: string } on failure.
 *
 * @param {string} text - The prose text.
 * @param {string} quote - The exact quote to find and cut.
 * @returns {{ start: number, end: number, method: 'exact'|'normalized' } | { error: string }}
 */
export function locateCutSpan(text, quote) {
  if (!quote || typeof quote !== 'string') {
    return { error: 'Missing or invalid quote' };
  }
  if (quote.length < MIN_ANCHOR_CHARS) {
    return { error: `Quote too short (${quote.length} < ${MIN_ANCHOR_CHARS} chars)` };
  }

  // Tier 1: exact match.
  const first = text.indexOf(quote);
  if (first !== -1) {
    // Check for ambiguity (multiple occurrences).
    const second = text.indexOf(quote, first + 1);
    if (second !== -1) {
      return { error: 'Ambiguous: quote appears multiple times' };
    }
    return { start: first, end: first + quote.length, method: 'exact' };
  }

  // Tier 2: whitespace-normalized regex.
  const re = buildWhitespaceTolerantRegex(quote);
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
    // Guard against zero-width matches.
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }

  if (matches.length === 0) {
    return { error: 'Quote not found in text' };
  }
  if (matches.length > 1) {
    return { error: 'Ambiguous: quote matches multiple locations (whitespace-normalized)' };
  }
  return { ...matches[0], method: 'normalized' };
}

/**
 * Collapse runs of blank lines into a single blank line after cuts are applied.
 * Cutting a paragraph can leave orphaned blank lines; this cleans them up.
 */
export function collapseBlankLines(text) {
  // Replace 3+ consecutive newlines with 2 (one blank line).
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Plan cuts for a block of prose. Returns an array of applicable cuts and
 * an array of refused cuts with reasons.
 *
 * @param {string} text - The prose text.
 * @param {Array<{ anchorQuote: string, subtype: string|null }>} cuts - Cuts to apply.
 * @param {{ safeTypesOnly?: boolean, allowTypes?: string[] }} opts
 * @returns {{ applicable: Array<{ quote: string, span: { start: number, end: number, method: string }, cutType: string|null }>, refused: Array<{ quote: string, reason: string, cutType: string|null }> }}
 */
export function planCutsForSection(text, cuts, { safeTypesOnly = true, allowTypes = SAFE_CUT_TYPES } = {}) {
  const applicable = [];
  const refused = [];

  for (const cut of cuts) {
    const quote = typeof cut?.anchorQuote === 'string' ? cut.anchorQuote : '';
    const cutType = CUT_TYPES.includes(cut?.subtype) ? cut.subtype : null;

    // Filter by cut type if requested.
    if (safeTypesOnly && cutType && !allowTypes.includes(cutType)) {
      refused.push({ quote, reason: `Cut type "${cutType}" is not in the safe list`, cutType });
      continue;
    }

    const result = locateCutSpan(text, quote);
    if (result.error) {
      refused.push({ quote, reason: result.error, cutType });
      continue;
    }

    // Check for overlaps with already-planned cuts.
    const overlaps = applicable.some(
      (a) => result.start < a.span.end && a.span.start < result.end,
    );
    if (overlaps) {
      refused.push({ quote, reason: 'Overlaps with another cut', cutType });
      continue;
    }

    applicable.push({ quote, span: result, cutType });
  }

  return { applicable, refused };
}

/**
 * Apply planned cuts to text, returning the modified text.
 * Cuts are applied in reverse order (highest start index first) to preserve
 * earlier indices as we remove spans.
 */
export function applyCutsToText(text, applicable) {
  let result = text;
  // Sort by start descending so we can slice without index shifting.
  const sorted = [...applicable].sort((a, b) => b.span.start - a.span.start);
  for (const cut of sorted) {
    result = result.slice(0, cut.span.start) + result.slice(cut.span.end);
  }
  return collapseBlankLines(result);
}
