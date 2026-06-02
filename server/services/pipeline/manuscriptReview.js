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
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { seriesStore } from './series.js';
import { collectManuscriptSections } from './arcPlanner.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';

// Storage-layout version for the review document. Bump + migrate if the
// comment shape changes in a way older peers can't read.
const SCHEMA_VERSION = 1;

export const COMMENT_STATUSES = Object.freeze(['open', 'accepted', 'dismissed']);
const STATUS_SET = new Set(COMMENT_STATUSES);

const REVIEW_FILE = 'manuscript-review.json';
const reviewPath = (seriesId) => join(seriesStore().recordDir(seriesId), REVIEW_FILE);

// Per-series write tail (the review file is distinct per series, so each only
// serializes against itself). One canonical single-tail queue per series id.
const reviewQueues = new Map();
function queueReviewWrite(seriesId, fn) {
  const key = typeof seriesId === 'string' && seriesId ? seriesId : '__unknown__';
  let q = reviewQueues.get(key);
  if (!q) { q = createFileWriteQueue(); reviewQueues.set(key, q); }
  return q(fn);
}

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

// Shape one stored comment. Tolerant of partial/legacy records so a hand-edited
// or older-peer file round-trips without dropping fields.
function sanitizeComment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const problem = clampStr(raw.problem, 2000);
  if (!problem) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `mrc-${randomUUID()}`,
    issueNumber: Number.isInteger(raw.issueNumber) ? raw.issueNumber : null,
    issueId: typeof raw.issueId === 'string' ? raw.issueId : null,
    stageId: typeof raw.stageId === 'string' ? raw.stageId : null,
    severity: ['high', 'medium', 'low'].includes(raw.severity) ? raw.severity : 'medium',
    category: clampStr(raw.category, 40) || 'other',
    location: clampStr(raw.location, 200),
    problem,
    suggestion: clampStr(raw.suggestion, 8000),
    anchorQuote: clampStr(raw.anchorQuote, 400),
    status: STATUS_SET.has(raw.status) ? raw.status : 'open',
    fix: sanitizeFix(raw.fix),
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

// Stable identity for a finding so re-running completeness doesn't duplicate a
// still-open comment the user hasn't acted on yet.
const findingKey = (c) => `${c.issueNumber ?? ''}|${c.anchorQuote}|${c.problem}`;

/**
 * Merge a fresh set of shaped completeness findings into the review. ALL
 * existing comments are preserved — open ones (the user may be mid-fix, with a
 * generated replacement attached) as well as accepted/dismissed decisions. Only
 * findings not already present (by (issueNumber, anchorQuote, problem)) are
 * appended, so re-running "Finish the draft" augments the list instead of
 * piling up duplicates or wiping work in progress. New findings resolve their
 * issueId/stageId from the current manuscript sections by issueNumber.
 */
export async function seedReviewFromFindings(seriesId, findings, { runId = null } = {}) {
  const sections = await collectManuscriptSections(seriesId);
  const byNumber = new Map(sections.map((s) => [s.number, s]));
  return queueReviewWrite(seriesId, async () => {
    const review = await readReview(seriesId);
    const seenKeys = new Set(review.comments.map(findingKey));
    const now = new Date().toISOString();

    const fresh = [];
    for (const f of Array.isArray(findings) ? findings : []) {
      const candidate = sanitizeComment({ ...f, status: 'open', sourceRunId: runId, createdAt: now, updatedAt: now });
      if (!candidate) continue;
      const key = findingKey(candidate);
      if (seenKeys.has(key)) continue; // already present (open or resolved) — don't duplicate
      const section = candidate.issueNumber != null ? byNumber.get(candidate.issueNumber) : null;
      if (section) {
        candidate.issueId = section.issueId;
        candidate.stageId = section.stageId;
      }
      seenKeys.add(key);
      fresh.push(candidate);
    }

    const next = { schemaVersion: SCHEMA_VERSION, comments: [...review.comments, ...fresh] };
    await writeReview(seriesId, next);
    // The review is a sibling of the series record, so a review-only change
    // doesn't move the series `index.json` — emit a series `updated` event so
    // the peer-sync push + bucket re-export fire (both hash the review into
    // their payload). Only when something actually changed; a no-op seed
    // would just be short-circuited by the push hash anyway. Skipped on the
    // sync RECEIVE path (`mergeReviewFromSync`) to avoid an echo loop.
    if (fresh.length > 0) emitRecordUpdated('series', seriesId);
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
    // `fix: null` is an explicit clear; absent leaves it untouched.
    if (patch.fix !== undefined) merged.fix = sanitizeFix(patch.fix);
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
      if (!lc || new Date(rc.updatedAt).getTime() >= new Date(lc.updatedAt).getTime()) {
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
