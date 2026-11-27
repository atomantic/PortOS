/**
 * Pipeline — Manuscript Review seeding ("Finish the draft" findings)
 *
 * Merges fresh manuscript-completeness / editorial-check findings into the
 * persisted Word-style comment set. The store lives in ./manuscriptComments.js
 * (re-exported below); fix SHAPERS come from ./manuscriptFix.js, which reads/writes
 * comments through the store module, so there is no review <-> fix import cycle.
 */

import { collectManuscriptSections } from './arcPlanner.js';
import { shapeAnchoredEdit, fixFromEdits } from './manuscriptFix.js';
import { SCHEMA_VERSION, sanitizeComment, readReview, writeReview, queueReviewWrite } from './manuscriptComments.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';

export {
  DISMISS_REASONS,
  SCHEMA_VERSION,
  getReview,
  updateComment,
  mergeReviewFromSync,
  locateComment,
} from './manuscriptComments.js';

export { REVIEW_RUN_MODES } from '../../lib/pipelineSeriesConfig.js';

// Stable identity for a finding so a re-run doesn't duplicate a still-open comment.
// `checkId` is part of the key so one anchor flagged by two checks stays two findings
// and a dismissal only suppresses the check that raised it. Completeness findings
// carry no checkId ('' prefix).
const findingKey = (c) => `${c.checkId ?? ''}|${c.issueNumber ?? ''}|${c.anchorQuote}|${c.problem}`;

/**
 * Merge a fresh set of shaped completeness findings into the review.
 *
 * In BOTH modes, existing comments are carried forward and only findings not
 * already present are appended, so a `dismissed` decision keeps suppressing its finding.
 *
 * `mode` controls how the OPEN list reconciles against this run:
 *
 *  - 'merge' (default): every existing comment is left as-is, even an open one the
 *    new pass no longer surfaces.
 *
 *  - 'fresh': an existing `open` comment the new pass no longer surfaces is
 *    auto-dismissed. Clearing is a status FLIP, never a deletion: `mergeReviewFromSync`
 *    is additive LWW-per-id and never removes a comment, so a deleted one would be
 *    resurrected by the next inbound sync. `accepted`/`dismissed` comments are untouched.
 *
 * `checkId` SCOPES the 'fresh' reconciliation to one check's findings: a fresh
 * completeness run (checkId null) can't dismiss an editorial check's open
 * findings. Ignored in 'merge' mode.
 *
 * New findings resolve their issueId/stageId from the current manuscript
 * sections by issueNumber.
 */
export async function seedReviewFromFindings(seriesId, findings, { runId = null, mode = 'merge', checkId = null, severityOverrides = null, regradeCheckIds = null } = {}) {
  const scopeCheckId = checkId ?? null;
  // A pinned check's level is authoritative for EVERY open comment of that check.
  // Tolerant of a junk/hand-edited value — only a valid level forces a re-grade.
  const pins = severityOverrides && typeof severityOverrides === 'object' && !Array.isArray(severityOverrides)
    ? severityOverrides : null;
  // Re-grading a NON-resurfaced carried comment is scoped to the checks that ran
  // this pass; otherwise a targeted subset run would silently clear other checks'
  // pins. `null` disables the non-match re-grade, so legacy callers never mutate severities.
  const regradeScope = Array.isArray(regradeCheckIds) ? new Set(regradeCheckIds) : null;
  const sections = await collectManuscriptSections(seriesId);
  const byNumber = new Map(sections.map((s) => [s.number, s]));
  return queueReviewWrite(seriesId, async () => {
    const review = await readReview(seriesId);
    const now = new Date().toISOString();

    const candidates = [];
    for (const f of Array.isArray(findings) ? findings : []) {
      const candidate = sanitizeComment({ ...f, status: 'open', sourceRunId: runId, createdAt: now, updatedAt: now });
      if (!candidate) continue;
      // sanitizeComment drops `replace` (not part of the stored shape); stash it for the fix builders.
      if (typeof f?.replace === 'string' && f.replace) candidate.replace = f.replace;
      candidates.push(candidate);
    }
    const freshKeys = new Set(candidates.map(findingKey));
    // First candidate wins (matches the append loop's dedupe order).
    const candidateByKey = new Map();
    for (const c of candidates) { const k = findingKey(c); if (!candidateByKey.has(k)) candidateByKey.set(k, c); }

    // Pre-seeded fix from { find: anchorQuote, replace } via the manual "Generate fix"
    // shaper. Null (stays advice-only) when:
    //   - there's no `replace`, no `anchorQuote`, or no resolved section;
    //   - the anchor is only fuzzily locatable: the bulk pass has no per-comment
    //     warning, so Accept on an unappliable diff would silently fail;
    //   - the finding is a `full-page` replacement: `anchorQuote` is only the page's
    //     opening text, so splicing `replace` over it would leave the rest of the page.
    const buildSeedFix = (comment, section) => {
      if (!section || !comment.replace || !comment.anchorQuote) return null;
      if (comment.replacementStrategy === 'full-page') return null;
      const edit = shapeAnchoredEdit(section, { find: comment.anchorQuote, replace: comment.replace });
      return edit && !edit.fuzzy ? fixFromEdits([edit]) : null;
    };

    // Carry every existing comment forward; in 'fresh' mode an open comment the new
    // pass no longer surfaces is flipped to dismissed. A re-surfaced open comment
    // also gets a backfilled fix (when it has none) and a refreshed
    // `sourceContentHash`, so re-running against edited content clears the stale badge.
    let dismissedCount = 0;
    let backfilledCount = 0;
    let refreshedCount = 0;
    const carried = review.comments.map((c) => {
      if (mode === 'fresh' && c.status === 'open' && (c.checkId ?? null) === scopeCheckId && !freshKeys.has(findingKey(c))) {
        dismissedCount += 1;
        return sanitizeComment({ ...c, status: 'dismissed', updatedAt: now });
      }
      if (c.status !== 'open') return c;
      const patch = {};
      const match = candidateByKey.get(findingKey(c));
      // Effective-severity re-grade, in priority order:
      //  1. RE-SURFACED: adopt `match.severity` (the pin when set, else native).
      //  2. NOT re-surfaced but still PINNED: force the pinned level, so a pin
      //     reaches lingering opens (a pinned check can also produce zero findings).
      //  3. NOT re-surfaced and NOT pinned: fall back to stored `nativeSeverity`, so
      //     clearing a pin restores the true level. No-op for a never-pinned comment.
      // Cases 2 & 3 only apply to checks in `regradeScope`.
      const inRegradeScope = !!(regradeScope && c.checkId && regradeScope.has(c.checkId));
      const pin = inRegradeScope && pins && ['high', 'medium', 'low'].includes(pins[c.checkId]) ? pins[c.checkId] : null;
      const carriedNative = inRegradeScope && ['high', 'medium', 'low'].includes(c.nativeSeverity) ? c.nativeSeverity : null;
      const nextSeverity = (match && match.severity) ? match.severity : (pin || carriedNative);
      if (nextSeverity && nextSeverity !== c.severity) {
        patch.severity = nextSeverity;
        refreshedCount += 1;
      }
      if (match) {
        // Keep native level current so a future pin-clear restores the latest one.
        if (match.nativeSeverity && match.nativeSeverity !== (c.nativeSeverity ?? null)) {
          patch.nativeSeverity = match.nativeSeverity;
          refreshedCount += 1;
        }
        if (!c.fix) {
          const section = c.issueNumber != null ? byNumber.get(c.issueNumber) : null;
          const fix = match.replace ? buildSeedFix({ ...c, replace: match.replace }, section) : null;
          if (fix) { patch.fix = fix; backfilledCount += 1; }
        }
        if (match.sourceContentHash && match.sourceContentHash !== (c.sourceContentHash ?? null)) {
          patch.sourceContentHash = match.sourceContentHash;
          refreshedCount += 1;
        }
        // Adopt a recognized subtype, but never clobber a stored one back to null:
        // `match.subtype` is null both when the model omitted it and when it returned
        // an off-list value, and a re-run that drops the label must not erase the
        // prior good one. A different non-null subtype still updates.
        if (match.subtype != null && match.subtype !== (c.subtype ?? null)) {
          patch.subtype = match.subtype;
          refreshedCount += 1;
        }
      }
      if (Object.keys(patch).length === 0) return c;
      return sanitizeComment({ ...c, ...patch, updatedAt: now });
    });

    // Append only findings not already represented by an existing comment (any status).
    const seenKeys = new Set(review.comments.map(findingKey));
    const fresh = [];
    for (const candidate of candidates) {
      const key = findingKey(candidate);
      if (seenKeys.has(key)) continue;
      const section = candidate.issueNumber != null ? byNumber.get(candidate.issueNumber) : null;
      if (section) {
        candidate.issueId = section.issueId;
        candidate.stageId = section.stageId;
      }
      const fix = buildSeedFix(candidate, section);
      if (fix) candidate.fix = fix;
      delete candidate.replace;
      seenKeys.add(key);
      fresh.push(candidate);
    }

    const next = { schemaVersion: SCHEMA_VERSION, comments: [...carried, ...fresh] };
    await writeReview(seriesId, next);
    // The review is a sibling of the series record, so it doesn't move the series
    // `index.json`; emit `updated` so peer-sync push + bucket re-export fire. Only on
    // a real change, and never on the sync RECEIVE path (`mergeReviewFromSync`), to avoid an echo loop.
    if (fresh.length > 0 || dismissedCount > 0 || backfilledCount > 0 || refreshedCount > 0) emitRecordUpdated('series', seriesId);
    return next;
  });
}
