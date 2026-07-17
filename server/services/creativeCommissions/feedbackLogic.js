/**
 * Creative Commission feedback — pure record transforms for cross-peer
 * federation (#2686, Autonomous Creation Engine split-record federation).
 *
 * Phase 2 (#2657) stored taste reactions INLINE on the `CreativeCommission`
 * record (`commission.feedback[]`). But a commission is deliberately
 * MACHINE-LOCAL (a synced schedule would double-run on every peer — see
 * store.js), which made feedback machine-local too: a 👍/👎 rated on machine A
 * never reached machine B. This module splits feedback OUT into its own
 * federated record kind (`commissionFeedback`, sync category `commissionFeedback`,
 * PostgreSQL `commission_feedback`) so your taste carries across your machines,
 * while the commission's `schedule` (+ future home-peer pointer) stays local.
 *
 * ONE ROW PER REACTION (not an aggregate-per-commission blob): federating an
 * array as a single LWW record would let a rating on machine A clobber a
 * concurrent rating on machine B (last writer wins the whole array). Per-reaction
 * records federate independently — each converges on its own id — so both
 * machines' taste survives. Re-rating the SAME run reuses a DETERMINISTIC id
 * (`cfeedback-<runId>`) so the second reaction LWW-updates the first in place
 * (one reaction per run) rather than stacking a duplicate — sync-safe, because
 * the PortOS LWW merge never propagates a hard delete (removing the prior entry
 * from an array would resurrect on the next inbound sync).
 *
 * Storage-agnostic (no I/O) so the PostgreSQL backend (feedbackDb.js) and the
 * test/dev file backend can never drift in how an incoming reaction is sanitized
 * or LWW-merged. Mirrors writersRoom/syncLogic.js's body-less folder path.
 */

import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';

const isStr = (v) => typeof v === 'string';

// The peer-sync record kind. Exported so the feedback store / peerSync.js
// reference one source of truth instead of bare strings.
export const COMMISSION_FEEDBACK_KIND = 'commissionFeedback';

// A feedback record id is a queryable primary key (no filesystem path use), but
// we still gate it so a malformed peer payload can't plant an unaddressable row.
// `cfeedback-<runId>` for run-keyed reactions (runId is itself `run-<uuid>`) and
// `cfeedback-<uuid>` for the rare run-less reaction.
export const CFEEDBACK_ID_RE = /^cfeedback-[0-9a-z-]+$/i;

/**
 * Deterministic id for a reaction tied to a run — so re-rating that run
 * LWW-updates the SAME record instead of appending a duplicate. runIds are
 * globally-unique UUIDs (`run-<uuid>`), so the runId alone disambiguates across
 * commissions. Returns null for a missing/non-string runId (the caller then
 * mints a random id).
 */
export function deterministicFeedbackId(runId) {
  if (!isStr(runId) || !runId) return null;
  return `cfeedback-${runId}`;
}

/**
 * Normalize a raw feedback record into the canonical stored/wire shape. Returns
 * null for a non-object, an id-less/invalid-id record, or a record without a
 * usable rating ('up'/'down' or a non-zero number) — the "drop on the floor"
 * contract every sanitizer shares, so a malformed peer payload can't land. The
 * body (commissionId / runId / rating / note / tags / at) passes through
 * verbatim; the LWW key (`updatedAt`) + soft-delete trio are normalized so the
 * wire/hash shape is stable regardless of on-disk key position.
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
 * LWW merge decision for one incoming feedback record against the local copy —
 * mirrors `mergeFolderRecord` (writersRoom/syncLogic.js's body-less path):
 *   - remote sanitized here (drop-on-floor on a malformed payload → `next: null`).
 *   - No local counterpart → insert the remote verbatim (`inserted: true`).
 *   - Both present → newer `updatedAt` wins (`compareNewerWins`: epoch-ms,
 *     unparseable-loses, tie → local). Tombstones ride the same path.
 * Returns `{ next, inserted, remoteWins, changed }`; `changed` is false when the
 * winner is byte-identical to local. The whole record is LWW-overwritten (no
 * field-union), so it is hashed in full by `contentHashForRecord`.
 */
export function mergeCommissionFeedbackRecord(local, remoteRaw) {
  const remote = sanitizeCommissionFeedbackForSync(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  // Derive the local LWW key through the SAME sanitizer so the compare is
  // symmetric; fall back to the raw key defensively (local came from our own
  // store, so sanitize can't legitimately return null).
  const localKey = sanitizeCommissionFeedbackForSync(local)?.updatedAt ?? local.updatedAt;
  const remoteWins = compareNewerWins(remote.updatedAt, localKey);
  const next = remoteWins ? remote : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}

/**
 * Render a federated feedback record down to the inline `{ id, runId, rating,
 * note, tags, at }` shape `directive.js` (`renderFeedbackDigest`) and the client
 * rate UI (which keys by `runId`) already consume — so the split is invisible to
 * both. Returns null for a record the sanitizer rejects.
 */
export function toInlineFeedback(raw) {
  const rec = sanitizeCommissionFeedbackForSync(raw);
  if (!rec) return null;
  return { id: rec.id, runId: rec.runId, rating: rec.rating, note: rec.note, tags: rec.tags, at: rec.at };
}
