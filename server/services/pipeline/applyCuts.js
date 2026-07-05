/**
 * Pipeline — Mechanical Cut Applier (#2168)
 *
 * Applies adversarial-cut findings to manuscript text with a multi-tier matching
 * strategy. Autonovel's signature editing technique: the cuts the LLM identified
 * ARE the revision plan. Safe cut types (OVER-EXPLAIN, REDUNDANT) can be batch-
 * applied with no human review; other types remain advisory findings.
 *
 * Matching tiers:
 *   1. Exact string match — verbatim substring.
 *   2. Whitespace-normalized regex — tokens joined by \s+, handles reflow.
 *   3. Refuse ambiguous — more than 1 occurrence → manual review.
 *   4. Refuse short — < 25 chars → too risky for mechanical removal.
 *
 * Applied through the serialized stage-write path (updateStagesWithLatest) with
 * runHistory snapshot for undo, same as manuscriptFix.js.
 */

import { randomUUID } from 'crypto';
import { updateStagesWithLatest } from './issues.js';
import { collectManuscriptSections } from './arcPlanner.js';
import { SAFE_CUT_TYPES, CUT_TYPES } from '../../lib/editorial/checkRegistry.js';

export { SAFE_CUT_TYPES, CUT_TYPES };

// Minimum anchor length to apply mechanically — shorter quotes are too risky.
export const MIN_ANCHOR_CHARS = 25;

// Output after input: drafted text wins over seed.
const stageTextOf = (stage) => (stage?.output?.trim() || stage?.input?.trim() || '');

/**
 * Build a whitespace-tolerant regex for a quote. LLMs often reformat whitespace
 * when quoting (collapsed indentation, added line breaks), so exact match fails
 * even when the quote clearly targets a real span.
 */
function buildWhitespaceTolerantRegex(quote) {
  const escaped = quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/\s+/g, '\\s+'), 'g');
}

/**
 * Locate a cut quote in the text. Returns { start, end, method } on success,
 * or { error: string } on failure.
 *
 * @param {string} text - The manuscript section text.
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
 * Plan cuts for a single section. Returns an array of applicable cuts and
 * an array of refused cuts with reasons.
 *
 * @param {string} text - The section's manuscript text.
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

/**
 * Dry-run preview of cuts. Returns the impact without applying.
 *
 * @param {string} seriesId
 * @param {Array<{ id: string, anchorQuote: string, subtype: string|null, issueNumber?: number, issueId?: string, stageId?: string }>} comments
 * @param {{ safeTypesOnly?: boolean, allowTypes?: string[], minFatPercent?: number }} opts
 * @returns {Promise<{ preview: Array<{ issueNumber: number, issueId: string, stageId: string, before: string, after: string, applied: number, refused: number, refusedDetails: Array }>, totalApplied: number, totalRefused: number }>}
 */
export async function previewCuts(seriesId, comments, { safeTypesOnly = true, allowTypes = SAFE_CUT_TYPES } = {}) {
  const sections = await collectManuscriptSections(seriesId);
  const byIssue = new Map();
  for (const s of sections) {
    const key = `${s.issueId}:${s.stageId}`;
    if (!byIssue.has(key)) byIssue.set(key, s);
  }

  // Group comments by section.
  const commentsBySection = new Map();
  for (const c of comments) {
    const key = c.issueId && c.stageId
      ? `${c.issueId}:${c.stageId}`
      : (c.issueNumber != null
        ? sections.find((s) => s.number === c.issueNumber)?.let?.((s) => `${s.issueId}:${s.stageId}`)
        : null);
    if (!key) continue;
    if (!commentsBySection.has(key)) commentsBySection.set(key, []);
    commentsBySection.get(key).push(c);
  }

  const preview = [];
  let totalApplied = 0;
  let totalRefused = 0;

  for (const [key, sectionComments] of commentsBySection) {
    const section = byIssue.get(key);
    if (!section) continue;

    const { applicable, refused } = planCutsForSection(section.content || '', sectionComments, {
      safeTypesOnly,
      allowTypes,
    });

    const after = applicable.length > 0 ? applyCutsToText(section.content || '', applicable) : section.content;

    preview.push({
      issueNumber: section.number,
      issueId: section.issueId,
      stageId: section.stageId,
      before: section.content || '',
      after,
      applied: applicable.length,
      refused: refused.length,
      refusedDetails: refused,
    });

    totalApplied += applicable.length;
    totalRefused += refused.length;
  }

  return { preview, totalApplied, totalRefused };
}

/**
 * Apply cuts to manuscript sections. Writes through the serialized stage-write
 * path with runHistory snapshots for undo.
 *
 * @param {string} seriesId
 * @param {Array<{ id: string, anchorQuote: string, subtype: string|null, issueNumber?: number, issueId?: string, stageId?: string }>} comments
 * @param {{ safeTypesOnly?: boolean, allowTypes?: string[] }} opts
 * @returns {Promise<{ applied: number, refused: number, sections: Array<{ issueId: string, stageId: string, issueNumber: number }>, refusedDetails: Array }>}
 */
export async function applyCuts(seriesId, comments, { safeTypesOnly = true, allowTypes = SAFE_CUT_TYPES } = {}) {
  const sections = await collectManuscriptSections(seriesId);
  const byIssue = new Map();
  for (const s of sections) {
    const key = `${s.issueId}:${s.stageId}`;
    if (!byIssue.has(key)) byIssue.set(key, s);
  }

  // Group comments by section.
  const commentsBySection = new Map();
  for (const c of comments) {
    let key = null;
    if (c.issueId && c.stageId) {
      key = `${c.issueId}:${c.stageId}`;
    } else if (c.issueNumber != null) {
      const s = sections.find((sec) => sec.number === c.issueNumber);
      if (s) key = `${s.issueId}:${s.stageId}`;
    }
    if (!key) continue;
    if (!commentsBySection.has(key)) commentsBySection.set(key, []);
    commentsBySection.get(key).push(c);
  }

  const updates = [];
  const allRefused = [];
  let totalApplied = 0;

  for (const [key, sectionComments] of commentsBySection) {
    const section = byIssue.get(key);
    if (!section) continue;

    const { applicable, refused } = planCutsForSection(section.content || '', sectionComments, {
      safeTypesOnly,
      allowTypes,
    });

    allRefused.push(...refused.map((r) => ({ ...r, issueNumber: section.number })));

    if (applicable.length === 0) continue;

    const newText = applyCutsToText(section.content || '', applicable);
    totalApplied += applicable.length;

    updates.push({
      issueId: section.issueId,
      stageId: section.stageId,
      issueNumber: section.number,
      computeFn: (cur) => {
        // Verify the text hasn't changed since we planned.
        if (stageTextOf(cur) !== section.content) {
          console.warn(`⚠️ applyCuts: skipping issue ${section.number} — text changed mid-apply`);
          return null;
        }
        return { output: newText, status: 'edited', lastRunId: `cut-${randomUUID()}` };
      },
    });
  }

  // Apply all updates through the serialized path.
  const appliedSections = [];
  if (updates.length > 0) {
    const results = await updateStagesWithLatest(
      seriesId,
      updates.map((u) => ({ issueId: u.issueId, stageId: u.stageId, computeFn: u.computeFn })),
      { snapshotPrior: true },
    );
    for (let i = 0; i < results.length; i += 1) {
      if (results[i].stage) {
        appliedSections.push({
          issueId: updates[i].issueId,
          stageId: updates[i].stageId,
          issueNumber: updates[i].issueNumber,
        });
      }
    }
  }

  console.log(`✂️ applyCuts: applied=${totalApplied} refused=${allRefused.length} sections=${appliedSections.length}`);

  return {
    applied: totalApplied,
    refused: allRefused.length,
    sections: appliedSections,
    refusedDetails: allRefused,
  };
}

/**
 * Filter comments to only those that are adversarial-cut findings (have a
 * cut-type subtype) and are still open.
 */
export function filterCutComments(comments) {
  return (Array.isArray(comments) ? comments : []).filter((c) => {
    if (c.status !== 'open') return false;
    // Must have a cutType subtype (one of CUT_TYPES).
    return CUT_TYPES.includes(c.subtype);
  });
}

/**
 * Filter comments to only safe-to-apply cut types.
 */
export function filterSafeCutComments(comments) {
  return filterCutComments(comments).filter((c) => SAFE_CUT_TYPES.includes(c.subtype));
}
