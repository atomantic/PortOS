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
import {
  MIN_ANCHOR_CHARS,
  locateCutSpan,
  collapseBlankLines,
  planCutsForSection,
  applyCutsToText,
} from '../../lib/editorial/cutApplier.js';

// The pure cut-matching helpers now live in server/lib/editorial/cutApplier.js
// so the Writers Room polish loop (#2173) can reuse them without pulling in the
// pipeline. Re-export them here to keep this module's public surface stable for
// existing importers (manuscript route, applyCuts.test.js).
export {
  SAFE_CUT_TYPES,
  CUT_TYPES,
  MIN_ANCHOR_CHARS,
  locateCutSpan,
  collapseBlankLines,
  planCutsForSection,
  applyCutsToText,
};

// Output after input: drafted text wins over seed.
const stageTextOf = (stage) => (stage?.output?.trim() || stage?.input?.trim() || '');

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
