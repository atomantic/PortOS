/**
 * Pipeline — Manuscript Review ("Finish the draft" comments)
 *
 * Persists the editorial findings from the manuscript-completeness pass as a
 * Word-style comment set the user works through in the manuscript editor:
 * each comment can be jumped-to, given an AI fix, edited, and accepted into the
 * manuscript (or dismissed). Findings are otherwise ephemeral — this is what
 * makes "Finish the draft" actionable across reloads.
 *
 * Stored as a sibling of the series record at
 * `data/pipeline-series/{id}/manuscript-review.json`, so it travels with the
 * series folder on share/sync without bloating the LWW-merged series
 * `index.json` (the review is an independent, larger document with its own
 * write cadence). Writes serialize on a per-series tail (single tail per shared
 * file, per CLAUDE.md).
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { createKeyedFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { seriesStore, listSeries } from './series.js';
import { collectManuscriptSections, REPLACEMENT_STRATEGIES, replacementStrategyForCategory } from './arcPlanner.js';
import { shapeAnchoredEdit, fixFromEdits } from './manuscriptFix.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';

// Storage-layout version for the review document. Bump + migrate if the
// comment shape changes in a way older peers can't read.
const SCHEMA_VERSION = 1;

export const COMMENT_STATUSES = Object.freeze(['open', 'accepted', 'dismissed']);
const STATUS_SET = new Set(COMMENT_STATUSES);

// Why a dismissal was made (#1605). A plain dismiss (`dismissReason: null`)
// means "won't fix" — the finding is real but the user is leaving it. A
// `false-positive` reason means "this check is wrong here" — it feeds the
// per-check quality view so broken checks are tracked instead of silently
// re-surfacing the same bad finding every run. Only meaningful when
// `status === 'dismissed'`. Optional + additive, so the synced review doc stays
// backward-compatible with older peers (who simply ignore the field).
export const DISMISS_REASONS = Object.freeze(['false-positive']);
const DISMISS_REASON_SET = new Set(DISMISS_REASONS);

// Re-run modes for seedReviewFromFindings — see its doc comment. Exported so the
// route's Zod enum validates against the same source (mirrors COMMENT_STATUSES).
export const REVIEW_RUN_MODES = Object.freeze(['merge', 'fresh']);

const REVIEW_FILE = 'manuscript-review.json';
const reviewPath = (seriesId) => join(seriesStore().recordDir(seriesId), REVIEW_FILE);

// Per-series write tail (the review file is distinct per series, so each only
// serializes against itself). One canonical single-tail queue per series id.
const queueReviewWrite = createKeyedFileWriteQueue();

const emptyReview = () => ({ schemaVersion: SCHEMA_VERSION, comments: [] });

const clampStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function sanitizeFix(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const find = typeof raw.find === 'string' ? raw.find : '';
  const replace = typeof raw.replace === 'string' ? raw.replace : '';
  const edits = Array.isArray(raw.edits)
    ? raw.edits
      .map((e) => {
        if (!e || typeof e !== 'object') return null;
        const editFind = typeof e.find === 'string' ? e.find : '';
        const editReplace = typeof e.replace === 'string' ? e.replace : '';
        if (!editFind && !editReplace) return null;
        const out = {
          issueNumber: Number.isInteger(e.issueNumber) ? e.issueNumber : null,
          issueId: typeof e.issueId === 'string' ? e.issueId : null,
          stageId: typeof e.stageId === 'string' ? e.stageId : null,
          title: clampStr(e.title, 200),
          find: editFind,
          replace: editReplace,
          note: clampStr(e.note, 1000),
        };
        if (e.fuzzy === true) out.fuzzy = true;
        return out;
      })
      .filter(Boolean)
    : [];
  if (!find && !replace && edits.length === 0) return null;
  const out = { find, replace };
  if (edits.length) out.edits = edits;
  if (raw.fuzzy === true) out.fuzzy = true;
  return out;
}

// Snapshot of the manuscript text a fix overwrote, captured at accept-time so
// the finding can be undone back to its pre-edit state (#1609). `priorText` is
// the section's FULL stage text before the fix applied (full restore handles
// every edit shape — multi-edit, deletion, full-page rewrite — exactly, unlike
// a span-level reverse-splice); `appliedHash` is a fingerprint of the text the
// accept WROTE, so undo can detect later edits and refuse to clobber them. Only
// carried while `status === 'accepted'` (a status flip drops it, mirroring
// `dismissReason`). Optional + additive → older peers ignore it and the synced
// review doc stays backward-compatible (no schema bump needed).
function sanitizeAcceptedSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) return null;
  const sections = raw.sections
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const issueId = typeof s.issueId === 'string' && s.issueId ? s.issueId : null;
      const stageId = typeof s.stageId === 'string' && s.stageId ? s.stageId : null;
      const priorText = typeof s.priorText === 'string' ? s.priorText : null;
      if (!issueId || !stageId || priorText == null) return null;
      const out = { issueId, stageId, priorText };
      if (typeof s.appliedHash === 'string' && s.appliedHash) out.appliedHash = s.appliedHash;
      return out;
    })
    .filter(Boolean);
  if (!sections.length) return null;
  return {
    acceptedAt: typeof raw.acceptedAt === 'string' ? raw.acceptedAt : new Date().toISOString(),
    sections,
  };
}

// Shape one stored comment. Tolerant of partial/legacy records so a hand-edited
// or older-peer file round-trips without dropping fields.
function sanitizeComment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const problem = clampStr(raw.problem, 2000);
  if (!problem) return null;
  const category = clampStr(raw.category, 40) || 'other';
  const severity = ['high', 'medium', 'low'].includes(raw.severity) ? raw.severity : 'medium';
  const status = STATUS_SET.has(raw.status) ? raw.status : 'open';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `mrc-${randomUUID()}`,
    issueNumber: Number.isInteger(raw.issueNumber) ? raw.issueNumber : null,
    issueId: typeof raw.issueId === 'string' ? raw.issueId : null,
    stageId: typeof raw.stageId === 'string' ? raw.stageId : null,
    severity,
    // The check's NATIVE per-finding level (#1596), independent of any per-check
    // severity override. Carried so that clearing an override re-grades the
    // finding back to its true native level (not a guessed default). Defaults to
    // `severity` for legacy/older-peer comments written before this field (all of
    // which predate overrides, so native == severity is correct). Optional +
    // additive → the synced review doc stays backward-compatible.
    nativeSeverity: ['high', 'medium', 'low'].includes(raw.nativeSeverity) ? raw.nativeSeverity : severity,
    category,
    // Optional per-check sub-classification of the finding (#1626) — e.g.
    // `dialogue.on-the-nose` tags each finding `exposition` / `emotion-tell` /
    // `relationship-report` so the editor sees *why* a line reads on-the-nose.
    // `null` for checks that don't sub-classify, legacy records, and older peers.
    // Validated by the producing check against its own allow-list, so a stray
    // value never reaches here; the clamp is a belt-and-suspenders bound for
    // hand-edited / older-peer files. Optional + additive → the synced review doc
    // stays backward-compatible (no schema bump needed).
    subtype: clampStr(raw.subtype, 40) || null,
    location: clampStr(raw.location, 200),
    problem,
    suggestion: clampStr(raw.suggestion, 8000),
    // How `suggestion` should be read: 'full-page' = it's a complete replacement
    // document (comic-structure panel rewrite); 'delta' = it's advice. Trust a
    // valid stored value, else derive from category so legacy comments (written
    // before this field existed) and older peers still classify correctly.
    replacementStrategy: REPLACEMENT_STRATEGIES.has(raw.replacementStrategy)
      ? raw.replacementStrategy
      : replacementStrategyForCategory(category),
    anchorQuote: clampStr(raw.anchorQuote, 400),
    // Which editorial check produced this finding (#1284). `null` for findings
    // from the manuscript-completeness pass (and older peers / legacy records)
    // — those predate the registry, so they group as a single un-checked set.
    // Optional + additive, so the synced review doc stays backward-compatible.
    checkId: typeof raw.checkId === 'string' && raw.checkId ? raw.checkId : null,
    // Fingerprint of the content the editorial check analyzed when it raised this
    // finding (#1345) — the runner stamps it so the editor can flag the finding
    // `stale` once the manuscript/canon drifts. `null` for completeness-pass
    // findings, older peers, and legacy records (treated as never-stale).
    // Optional + additive, so the synced review doc stays backward-compatible.
    sourceContentHash: typeof raw.sourceContentHash === 'string' && raw.sourceContentHash ? raw.sourceContentHash : null,
    status,
    // Dismissal reason (#1605) — only carried while dismissed. A status flip
    // back to open/accepted drops it here so a re-opened finding can't keep a
    // stale `false-positive` mark. Legacy/older-peer records lack the field and
    // sanitize to `null` (a plain "won't fix" dismiss).
    dismissReason: raw.status === 'dismissed' && DISMISS_REASON_SET.has(raw.dismissReason)
      ? raw.dismissReason
      : null,
    fix: sanitizeFix(raw.fix),
    // Pre-edit snapshot for undo (#1609) — only meaningful once accepted, so a
    // re-open/dismiss flip drops it (the undo path also clears it explicitly).
    acceptedSnapshot: status === 'accepted'
      ? sanitizeAcceptedSnapshot(raw.acceptedSnapshot)
      : null,
    sourceRunId: typeof raw.sourceRunId === 'string' ? raw.sourceRunId : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

function sanitizeReview(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.comments)) return emptyReview();
  return {
    schemaVersion: SCHEMA_VERSION,
    comments: raw.comments.map(sanitizeComment).filter(Boolean),
  };
}

async function readReview(seriesId) {
  // `null` = file absent (distinct from a present-but-empty review).
  const raw = await readJSONFile(reviewPath(seriesId), null);
  return raw == null ? emptyReview() : sanitizeReview(raw);
}

async function writeReview(seriesId, review) {
  await atomicWrite(reviewPath(seriesId), sanitizeReview(review));
}

/**
 * Read the persisted review for a series. Returns an empty review (never null)
 * when none has been generated yet.
 */
export async function getReview(seriesId) {
  return readReview(seriesId);
}

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

/**
 * Patch a single comment (status flip, attach/clear a generated fix, edit the
 * replacement text). Last-write-wins on `updatedAt`. Returns the updated
 * comment, or throws if the id is unknown.
 */
export async function updateComment(seriesId, commentId, patch) {
  return queueReviewWrite(seriesId, async () => {
    const review = await readReview(seriesId);
    const idx = review.comments.findIndex((c) => c.id === commentId);
    if (idx === -1) {
      throw Object.assign(new Error(`Comment not found: ${commentId}`), { code: 'PIPELINE_REVIEW_NOT_FOUND' });
    }
    const cur = review.comments[idx];
    const merged = { ...cur };
    if (patch.status !== undefined && STATUS_SET.has(patch.status)) merged.status = patch.status;
    // Dismissal reason (#1605). `null` is an explicit clear; a valid reason sets
    // it. sanitizeComment below drops it anyway when the resulting status isn't
    // `dismissed`, so re-opening a false-positive can't leave the mark behind.
    if (patch.dismissReason !== undefined) {
      merged.dismissReason = DISMISS_REASON_SET.has(patch.dismissReason) ? patch.dismissReason : null;
    }
    // `fix: null` is an explicit clear; absent leaves it untouched.
    if (patch.fix !== undefined) merged.fix = sanitizeFix(patch.fix);
    // Pre-edit undo snapshot (#1609). `null` is an explicit clear (the undo
    // path); absent leaves it untouched. sanitizeComment below drops it anyway
    // whenever the resulting status isn't `accepted`, so re-opening a finding
    // can't leave a stale snapshot behind.
    if (patch.acceptedSnapshot !== undefined) merged.acceptedSnapshot = patch.acceptedSnapshot;
    merged.updatedAt = new Date().toISOString();
    const next = { ...review, comments: review.comments.map((c, i) => (i === idx ? sanitizeComment(merged) : c)) };
    await writeReview(seriesId, next);
    // Sibling-doc change → fire a series `updated` event so the review
    // propagates to peers / re-exports to subscribed buckets (see seed above).
    emitRecordUpdated('series', seriesId);
    return next.comments[idx];
  });
}

/**
 * Sync-orchestrator entry: merge a remote peer's review into local state,
 * last-write-wins per comment on `updatedAt`. Mirrors `mergeIssuesFromSync`.
 */
export async function mergeReviewFromSync(seriesId, remoteReview) {
  const remote = sanitizeReview(remoteReview);
  return queueReviewWrite(seriesId, async () => {
    const local = await readReview(seriesId);
    const byId = new Map(local.comments.map((c) => [c.id, c]));
    for (const rc of remote.comments) {
      const lc = byId.get(rc.id);
      // Strict-newer (`>`) so an equal-clock echo is a skip, matching the
      // `mergeIssuesFromSync` LWW guard. With `>=`, a peer re-sending a comment
      // we already hold at the same timestamp re-adopts + re-writes it every
      // sync cycle (write amplification + non-convergence) — the same bug
      // catalogSync.js fixed this release.
      if (!lc || new Date(rc.updatedAt).getTime() > new Date(lc.updatedAt).getTime()) {
        byId.set(rc.id, rc);
      }
    }
    const next = { schemaVersion: SCHEMA_VERSION, comments: [...byId.values()] };
    await writeReview(seriesId, next);
    return next;
  });
}

// Internal: used by manuscriptFix to read a single comment without a full
// round-trip ceremony. Returns null when absent.
export async function getComment(seriesId, commentId) {
  const review = await readReview(seriesId);
  return review.comments.find((c) => c.id === commentId) || null;
}

/**
 * Locate a finding/comment across ALL series by its (globally-unique) comment
 * id. Findings live per-series in each series' manuscript-review.json, so a
 * deep-link that carries only a commentId (e.g. one shared from elsewhere) has
 * to resolve the owning series before the editor can open it (#1608). Returns
 * `{ seriesId, comment }` for the first series whose review contains the id, or
 * `null` when no series owns it. Comment ids are UUID-based (`randomUUID`) so a
 * match is unambiguous; deleted series are skipped (listSeries default).
 */
export async function locateComment(commentId) {
  if (typeof commentId !== 'string' || !commentId) return null;
  const series = await listSeries();
  for (const s of series) {
    const comment = await getComment(s.id, commentId);
    if (comment) return { seriesId: s.id, comment };
  }
  return null;
}
