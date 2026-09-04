/**
 * Pipeline — Manuscript Review seeding ("Finish the draft" findings)
 *
 * Orchestration over the manuscriptComments.js comment store: merges fresh
 * manuscript-completeness / editorial-check findings into the persisted
 * Word-style comment set the user works through in the manuscript editor.
 *
 * The store itself (schema, sanitizers, persistence, accessors) lives in
 * ./manuscriptComments.js and is re-exported below for existing importers; the
 * fix SHAPERS come from ./manuscriptFix.js, which reads/writes comments
 * through the store module — so the former review <-> fix static import cycle
 * is broken (#5918).
 */

import { collectManuscriptSections } from './arcPlanner.js';
import { shapeAnchoredEdit, fixFromEdits } from './manuscriptFix.js';
import { SCHEMA_VERSION, sanitizeComment, readReview, writeReview, queueReviewWrite } from './manuscriptComments.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';

// Store accessors re-exported for existing importers (routes, seriesReview,
// editorialScore, readerPanel, sync receive paths, tests).
export {
  COMMENT_STATUSES,
  DISMISS_REASONS,
  SCHEMA_VERSION,
  getReview,
  getComment,
  updateComment,
  mergeReviewFromSync,
  locateComment,
} from './manuscriptComments.js';

// Re-run modes for seedReviewFromFindings — see its doc comment. Exported so the
// route's Zod enum validates against the same source (mirrors COMMENT_STATUSES).
export const REVIEW_RUN_MODES = Object.freeze(['merge', 'fresh']);

// Stable identity for a finding so re-running completeness (or an editorial
// check) doesn't duplicate a still-open comment the user hasn't acted on yet.
// `checkId` is part of the key so the same anchor flagged by two different
// checks stays as two distinct findings, and a dismissed finding only stays
// suppressed for the check that raised it. Completeness findings carry no
// checkId (→ '' prefix), so their existing dedup is unchanged.
const findingKey = (c) => `${c.checkId ?? ''}|${c.issueNumber ?? ''}|${c.anchorQuote}|${c.problem}`;

/**
 * Merge a fresh set of shaped completeness findings into the review.
 *
 * In BOTH modes, existing comments are carried forward and only findings not
 * already present (by (issueNumber, anchorQuote, problem)) are appended — so
 * re-running augments the list instead of piling up duplicates or wiping work
 * in progress, and a `dismissed` decision keeps suppressing its finding.
 *
 * `mode` controls how the OPEN list reconciles against this run:
 *
 *  - 'merge' (default): every existing comment is left exactly as-is. A prior
 *    open comment the new pass no longer surfaces still lingers as open.
 *
 *  - 'fresh': an existing `open` comment the new pass no longer surfaces is
 *    auto-dismissed, so the open list reflects this run's findings (still-found
 *    opens stay open; newly-absent ones move to dismissed; genuinely-new ones
 *    are appended). Clearing is a status FLIP, never a deletion — a deletion
 *    would not propagate across synced peers (`mergeReviewFromSync` is additive
 *    LWW-per-id and never removes a comment), so an omitted comment would be
 *    resurrected on the next inbound sync. A flip to `dismissed` rides the same
 *    LWW path and converges. `accepted`/`dismissed` comments are untouched.
 *
 * `checkId` SCOPES the 'fresh' reconciliation to one check's findings: only open
 * comments whose `checkId` matches are eligible for auto-dismissal. The
 * completeness pass seeds with no checkId (its findings carry `checkId: null`),
 * so a fresh completeness run reconciles ONLY the null-checkId space and can't
 * dismiss an editorial-check's open findings (e.g. `prose.info-dumping`), which
 * carry a different checkId. Ignored in 'merge' mode (nothing is auto-dismissed).
 *
 * New findings resolve their issueId/stageId from the current manuscript
 * sections by issueNumber.
 */
export async function seedReviewFromFindings(seriesId, findings, { runId = null, mode = 'merge', checkId = null, severityOverrides = null, regradeCheckIds = null } = {}) {
  const scopeCheckId = checkId ?? null;
  // Per-check severity overrides (#1596): a pinned check's level is authoritative
  // for EVERY open comment of that check, so we re-grade carried open comments
  // (re-surfaced or not) to the pinned level below. Tolerant of a junk/hand-edited
  // value — only a valid level forces a re-grade.
  const pins = severityOverrides && typeof severityOverrides === 'object' && !Array.isArray(severityOverrides)
    ? severityOverrides : null;
  // The pin/native severity re-grade of a NON-resurfaced carried comment is
  // scoped to the checks that actually RAN this pass (#1596). Without this scope
  // a targeted subset run — or the completeness seed, which carries every
  // comment — would re-grade comments for checks it didn't run and silently
  // clear their active pins. `null` (no scope passed) disables the non-match
  // re-grade entirely, so legacy/external seed callers never mutate severities.
  const regradeScope = Array.isArray(regradeCheckIds) ? new Set(regradeCheckIds) : null;
  const sections = await collectManuscriptSections(seriesId);
  const byNumber = new Map(sections.map((s) => [s.number, s]));
  return queueReviewWrite(seriesId, async () => {
    const review = await readReview(seriesId);
    const now = new Date().toISOString();

    // Shape incoming findings up front so we can both dedupe against them and
    // (in fresh mode) reconcile existing open comments against what's still found.
    const candidates = [];
    for (const f of Array.isArray(findings) ? findings : []) {
      const candidate = sanitizeComment({ ...f, status: 'open', sourceRunId: runId, createdAt: now, updatedAt: now });
      if (!candidate) continue;
      // `replace` (the with-edits in-place rewrite) isn't part of the stored
      // comment shape, so sanitizeComment drops it — stash it on the candidate so
      // the append + backfill paths below can build the comment's `fix` from it.
      if (typeof f?.replace === 'string' && f.replace) candidate.replace = f.replace;
      candidates.push(candidate);
    }
    const freshKeys = new Set(candidates.map(findingKey));
    // Look up a re-surfaced finding (and its `replace`) by key, so an EXISTING
    // open comment with no fix can be backfilled when a with-edits re-run finds
    // it again. First candidate wins (matches the append loop's dedupe order).
    const candidateByKey = new Map();
    for (const c of candidates) { const k = findingKey(c); if (!candidateByKey.has(k)) candidateByKey.set(k, c); }

    // Build the pre-seeded fix for a finding from { find: anchorQuote, replace }
    // via the same shaper the manual "Generate fix" path uses, so the editor
    // shows the diff + Accept with no per-comment fix call. Returns null (→ stays
    // advice-only, falls back to manual fix generation) when:
    //   - there's no `replace`, no `anchorQuote`, or no resolved section;
    //   - the anchor can't be located even whitespace-tolerantly (shapeAnchoredEdit
    //     flags `fuzzy`): the bulk pass has no per-comment warning, so an
    //     unappliable fix would present a diff whose Accept silently fails;
    //   - the finding is a `full-page` (comic-structure) replacement: there the
    //     `anchorQuote` is only the malformed page's OPENING text while `replace`
    //     is the complete rewritten page, so splicing `replace` over just the
    //     anchor would leave the rest of the page behind. The manual fix path
    //     handles full-page substitution correctly; defer to it.
    const buildSeedFix = (comment, section) => {
      if (!section || !comment.replace || !comment.anchorQuote) return null;
      if (comment.replacementStrategy === 'full-page') return null;
      const edit = shapeAnchoredEdit(section, { find: comment.anchorQuote, replace: comment.replace });
      return edit && !edit.fuzzy ? fixFromEdits([edit]) : null;
    };

    // Carry every existing comment forward. In 'fresh' mode, an open comment the
    // new pass no longer surfaces is flipped to dismissed (a synced status
    // change, not a deletion — see the doc comment). Accepted/dismissed are
    // always left untouched. For a still-open comment re-surfaced by this run we
    // also: backfill a fix onto one that has none yet (so enabling "generate
    // edits" on a series whose notes came from an earlier findings-only run still
    // drafts them); and refresh its `sourceContentHash` to the current run's, so
    // re-running a check against edited content clears the stale badge (#1345).
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
      // Effective-severity re-grade (#1596), in priority order:
      //  1. A RE-SURFACED finding carries the run's EFFECTIVE severity in
      //     `match.severity` (the pin when set, else the native level). Adopt it.
      //  2. NOT re-surfaced but the check is still PINNED → force the pinned level
      //     so a pin reaches lingering opens too (LLM 'merge' mode preserves a
      //     non-resurfaced open; a pinned check can also produce zero findings).
      //  3. NOT re-surfaced and NOT pinned → fall back to the comment's stored
      //     `nativeSeverity`, so CLEARING a pin re-grades even a non-resurfaced
      //     open back to its true native level (not a guessed default). For a
      //     never-pinned comment native == severity, so this is a no-op (no churn).
      // Cases 2 & 3 (non-match re-grade) only apply to checks that ran this pass
      // (`regradeScope`), so an unrelated check's pin is never silently cleared.
      const inRegradeScope = !!(regradeScope && c.checkId && regradeScope.has(c.checkId));
      const pin = inRegradeScope && pins && ['high', 'medium', 'low'].includes(pins[c.checkId]) ? pins[c.checkId] : null;
      const carriedNative = inRegradeScope && ['high', 'medium', 'low'].includes(c.nativeSeverity) ? c.nativeSeverity : null;
      const nextSeverity = (match && match.severity) ? match.severity : (pin || carriedNative);
      if (nextSeverity && nextSeverity !== c.severity) {
        patch.severity = nextSeverity;
        refreshedCount += 1;
      }
      if (match) {
        // Keep the stored native level current so a future pin-clear restores the
        // latest run's native severity, not a stale one.
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
        // Adopt the run's subtype (#1626) so a finding first raised before the
        // on-the-nose check sub-classified its output gains the label on the next
        // run without the user having to clear it — the finding key is unchanged,
        // so the merge path (not the append path) is the only place it can land.
        // Only ADOPT a recognized (non-null) subtype; never clobber a stored
        // classification back to null. `match.subtype` is null both when the model
        // omitted the field AND when it returned an off-list value (checkRegistry's
        // mapLlmFindings collapses both to null), so a non-deterministic re-run
        // that drops/garbles the label must NOT erase the prior good one — that's
        // the "absent vs intentionally empty" rule (there is no model signal for
        // "this line is no longer this subtype"). A genuinely different non-null
        // subtype still updates (a real re-classification).
        if (match.subtype != null && match.subtype !== (c.subtype ?? null)) {
          patch.subtype = match.subtype;
          refreshedCount += 1;
        }
      }
      if (Object.keys(patch).length === 0) return c;
      return sanitizeComment({ ...c, ...patch, updatedAt: now });
    });

    // Append only findings not already represented by an existing comment (any
    // status) — re-reported findings don't duplicate, dismissed stay suppressed.
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
      // `replace` is consumed into `fix` (or dropped) — it's not part of the
      // stored comment shape (sanitizeComment ignores unknown keys, but be tidy).
      delete candidate.replace;
      seenKeys.add(key);
      fresh.push(candidate);
    }

    const next = { schemaVersion: SCHEMA_VERSION, comments: [...carried, ...fresh] };
    await writeReview(seriesId, next);
    // The review is a sibling of the series record, so a review-only change
    // doesn't move the series `index.json` — emit a series `updated` event so
    // the peer-sync push + bucket re-export fire (both hash the review into
    // their payload). Only when something actually changed — appended findings,
    // opens auto-dismissed by a 'fresh' re-run, OR fixes backfilled onto existing
    // opens. Skipped on the sync RECEIVE path (`mergeReviewFromSync`) to avoid
    // an echo loop.
    if (fresh.length > 0 || dismissedCount > 0 || backfilledCount > 0 || refreshedCount > 0) emitRecordUpdated('series', seriesId);
    return next;
  });
}
