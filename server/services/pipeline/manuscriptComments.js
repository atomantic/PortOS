/**
 * Pipeline — Manuscript Review comment store ("Finish the draft" comments)
 *
 * Leaf module owning the persisted editorial-findings comment set the user
 * works through in the manuscript editor: each comment can be jumped-to, given
 * an AI fix, edited, and accepted into the manuscript (or dismissed). Findings
 * are otherwise ephemeral — this is what makes "Finish the draft" actionable
 * across reloads.
 *
 * Stored as a sibling of the series record at
 * `data/pipeline-series/{id}/manuscript-review.json`, so it travels with the
 * series folder on share/sync without bloating the LWW-merged series
 * `index.json` (the review is an independent, larger document with its own
 * write cadence). Writes serialize on a per-series tail (single tail per shared
 * file, per AGENTS.md).
 *
 * This split breaks the former manuscriptReview <-> manuscriptFix static
 * import cycle (#5918): both manuscriptReview.js (seed/orchestration) and
 * manuscriptFix.js (fix generation/accept) import the store accessors from
 * here, and manuscriptReview.js imports only the fix SHAPERS from
 * manuscriptFix.js. Nothing in this module's dependency closure imports it
 * back — keep it that way (no imports from manuscriptReview.js or
 * manuscriptFix.js).
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { createKeyedFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { seriesStore, listSeries } from './series.js';
import { REPLACEMENT_STRATEGIES, replacementStrategyForCategory } from './arcPlanner.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';

// Storage-layout version for the review document. Bump + migrate if the
// comment shape changes in a way older peers can't read.
export const SCHEMA_VERSION = 1;

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

const REVIEW_FILE = 'manuscript-review.json';
const reviewPath = (seriesId) => join(seriesStore().recordDir(seriesId), REVIEW_FILE);

// Per-series write tail (the review file is distinct per series, so each only
// serializes against itself). One canonical single-tail queue per series id.
export const queueReviewWrite = createKeyedFileWriteQueue();

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
export function sanitizeComment(raw) {
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

export async function readReview(seriesId) {
  // `null` = file absent (distinct from a present-but-empty review).
  const raw = await readJSONFile(reviewPath(seriesId), null);
  return raw == null ? emptyReview() : sanitizeReview(raw);
}

export async function writeReview(seriesId, review) {
  await atomicWrite(reviewPath(seriesId), sanitizeReview(review));
}

/**
 * Read the persisted review for a series. Returns an empty review (never null)
 * when none has been generated yet.
 */
export async function getReview(seriesId) {
  return readReview(seriesId);
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
    // propagates to peers / re-exports to subscribed buckets (see
    // seedReviewFromFindings in manuscriptReview.js).
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
