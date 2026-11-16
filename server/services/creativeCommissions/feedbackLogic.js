/**
 * Creative Commission feedback: pure record transforms for cross-peer federation (#2686).
 *
 * A commission is MACHINE-LOCAL (a synced schedule would double-run on every peer; see store.js), so
 * feedback is split into its own federated kind (`commissionFeedback`, PostgreSQL `commission_feedback`)
 * and taste carries across machines.
 *
 * ONE ROW PER REACTION: federating an array as one LWW record would let a rating on machine A clobber a
 * concurrent one on B. Re-rating the SAME run reuses the deterministic id `cfeedback-<runId>` so it
 * LWW-updates in place; removing an array entry would resurrect on the next sync, since LWW never
 * propagates a hard delete.
 *
 * No I/O, so the PostgreSQL backend (feedbackDb.js) and the file backend can't drift in sanitizing or
 * merging. Mirrors writersRoom/syncLogic.js's body-less folder path.
 */

import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';
import { isStr } from '../../lib/textUtils.js';

// The peer-sync record kind, one source of truth for the store and peerSync.js.
export const COMMISSION_FEEDBACK_KIND = 'commissionFeedback';

// Gated so a malformed peer payload can't plant an unaddressable row: `cfeedback-<runId>` or `cfeedback-<uuid>` for run-less reactions.
export const CFEEDBACK_ID_RE = /^cfeedback-[0-9a-z-]+$/i;

/**
 * Deterministic id for a run-tied reaction, so re-rating LWW-updates the SAME record. runIds are globally
 * unique (`run-<uuid>`). Null for a missing runId (the caller mints a random id).
 */
export function deterministicFeedbackId(runId) {
  if (!isStr(runId) || !runId) return null;
  return `cfeedback-${runId}`;
}

/**
 * Normalize a raw feedback record into the canonical stored/wire shape. Returns null for a non-object, an
 * invalid id, or no usable rating ('up'/'down' or a non-zero number), so a malformed peer payload can't land.
 * The LWW key (`updatedAt`) and soft-delete trio are normalized so the wire/hash shape is stable.
 */
export function sanitizeCommissionFeedbackForSync(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isStr(raw.id) || !CFEEDBACK_ID_RE.test(raw.id)) return null;
  const isUp = raw.rating === 'up' || (typeof raw.rating === 'number' && raw.rating > 0);
  const isDown = raw.rating === 'down' || (typeof raw.rating === 'number' && raw.rating < 0);
  if (!isUp && !isDown) return null;
  const rating = typeof raw.rating === 'number' ? raw.rating : (isUp ? 'up' : 'down');
  const createdAt = isStr(raw.createdAt) ? raw.createdAt
    : (isStr(raw.at) ? raw.at : new Date().toISOString());
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  const { deleted, deletedAt } = sanitizeSoftDeleteFields(raw);
  return {
    id: raw.id,
    commissionId: isStr(raw.commissionId) ? raw.commissionId : null,
    runId: isStr(raw.runId) ? raw.runId : null,
    rating,
    note: isStr(raw.note) ? raw.note : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter(isStr).slice(0, 20) : [],
    at: isStr(raw.at) ? raw.at : createdAt,
    createdAt,
    updatedAt,
    deleted,
    deletedAt,
  };
}

/**
 * LWW merge decision for one incoming feedback record against the local copy (mirrors `mergeFolderRecord`):
 * the remote is sanitized first (malformed -> `next: null`); no local copy -> insert; both present -> newer
 * `updatedAt` wins (`compareNewerWins`; tie -> local). Tombstones ride the same path.
 * Returns `{ next, inserted, remoteWins, changed }`; the whole record is overwritten (no field-union).
 */
export function mergeCommissionFeedbackRecord(local, remoteRaw) {
  const remote = sanitizeCommissionFeedbackForSync(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  // Derive the local LWW key through the SAME sanitizer so the compare is symmetric.
  const localKey = sanitizeCommissionFeedbackForSync(local)?.updatedAt ?? local.updatedAt;
  const remoteWins = compareNewerWins(remote.updatedAt, localKey);
  const next = remoteWins ? remote : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}

/**
 * Render a federated feedback record down to the inline `{ id, runId, rating, note, tags, at }` shape
 * `directive.js` (`renderFeedbackDigest`) and the client rate UI already consume. Null if the sanitizer rejects it.
 */
export function toInlineFeedback(raw) {
  const rec = sanitizeCommissionFeedbackForSync(raw);
  if (!rec) return null;
  return { id: rec.id, runId: rec.runId, rating: rec.rating, note: rec.note, tags: rec.tags, at: rec.at };
}
