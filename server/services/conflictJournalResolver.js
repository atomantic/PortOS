/**
 * Resolve entries in the non-blocking conflict journal (server/lib/conflictJournal.js).
 *
 * Each entry archives a local version that LWW overwrote. Resolution:
 *   - restore-all  — re-apply the archived local snapshot's restorable fields as
 *                    a fresh edit (bumped updatedAt) so it wins LWW and
 *                    re-propagates to peers.
 *   - merge-fields — overlay only the chosen fields from the snapshot onto the
 *                    CURRENT live record (it may have moved since detection).
 *   - discard      — keep the current record; just mark the entry resolved.
 *
 * Writes ALWAYS go through the normal `update*` service path (never the record
 * file directly) so updatedAt bumps and the change propagates via the existing
 * push pipeline.
 *
 * NOTE — restore-all is an ADDITIVE overlay, not a byte-for-byte rollback.
 * updateUniverse merges some fields per-key rather than replacing them wholesale
 * (notably `categories`: a partial patch unions keys so an unrelated category
 * isn't wiped — see universeBuilder.js mergedCategories). So restoring a snapshot
 * re-applies the archived values for every restorable field, but a category the
 * snapshot lacked that the live record gained since detection is preserved, not
 * removed. This is intentional: union-on-restore can't silently destroy data the
 * journal never captured. The UI labels it "restore" (re-apply mine), not a
 * destructive "revert to exact snapshot."
 */

import { existsSync } from 'fs';
import { isSafeRecordId } from '../lib/validation.js';
import { conflictJournalStore, RESTORABLE_FIELDS } from '../lib/conflictJournal.js';
import { updateUniverse, ERR_NOT_FOUND as UNIVERSE_NOT_FOUND } from './universeBuilder.js';
import { updateSeries, ERR_NOT_FOUND as SERIES_NOT_FOUND } from './pipeline/series.js';
import { updateCollection, getCollection, ERR_NOT_FOUND as COLLECTION_NOT_FOUND } from './mediaCollections.js';
import { updateIssue, ERR_NOT_FOUND as ISSUE_NOT_FOUND } from './pipeline/issues.js';

export const ERR_NOT_FOUND = 'CONFLICT_JOURNAL_NOT_FOUND';
export const ERR_VALIDATION = 'CONFLICT_JOURNAL_VALIDATION';
// The conflict entry exists but the record it targets was tombstoned between
// archive time and resolution — distinct from ERR_NOT_FOUND (the entry itself).
export const ERR_TARGET_GONE = 'CONFLICT_TARGET_GONE';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// RESTORABLE_FIELDS (the user-authored content fields a restore/merge may write
// per kind; id/createdAt/server-owned fields are never overlaid) is owned by
// conflictJournal.js so diffSummary and this validator stay in lockstep.

const pick = (obj, fields) => {
  const out = {};
  for (const f of fields) if (obj && f in obj) out[f] = obj[f];
  return out;
};

const store = () => conflictJournalStore();

export async function listConflicts({ status = null } = {}) {
  const all = await store().loadAll();
  const filtered = status ? all.filter((e) => e.status === status) : all;
  return [...filtered].sort((a, b) => (b.detectedAt || '').localeCompare(a.detectedAt || ''));
}

export async function getConflict(id) {
  const entry = await store().loadOne(id);
  if (!entry) throw makeErr(`Conflict entry not found: ${id}`, ERR_NOT_FOUND);
  return entry;
}

// Apply a content patch through the right service's normal update path.
async function applyToRecord(kind, recordId, patch) {
  // The target record may have been tombstoned between conflict-archive time and
  // resolution. Translate the services' not-found codes into ERR_TARGET_GONE so
  // the route maps it to a clean 409 ("discard the entry") instead of a 500.
  const translateGone = (err) => {
    if (err?.code === UNIVERSE_NOT_FOUND || err?.code === SERIES_NOT_FOUND
        || err?.code === COLLECTION_NOT_FOUND || err?.code === ISSUE_NOT_FOUND) {
      throw makeErr(`The ${kind} this conflict targets no longer exists — discard the entry.`, ERR_TARGET_GONE);
    }
    throw err;
  };
  if (kind === 'universe') {
    // Mutator form bypasses the literal-patch reference-sheet preservation
    // guard — the restored snapshot is the trusted writer here.
    await updateUniverse(recordId, () => patch).catch(translateGone);
  } else if (kind === 'series') {
    await updateSeries(recordId, patch).catch(translateGone);
  } else if (kind === 'mediaCollection') {
    // A linked collection (universeId/seriesId set) locks its `name` to the
    // owner record — updateCollection rejects a name change, and a name
    // "conflict" on such a collection is really an owner-rename cascade
    // artifact (the universe/series conflict is journaled separately). Drop
    // `name` from the patch for a linked collection so restore still applies
    // the freely-editable scalars (description, coverKey) instead of 500ing.
    // A standalone collection restores all three.
    const cur = await getCollection(recordId, { includeDeleted: true }).catch(translateGone);
    const { name: _lockedName, ...withoutName } = patch;
    const effective = (cur?.universeId || cur?.seriesId) ? withoutName : patch;
    if (Object.keys(effective).length > 0) await updateCollection(recordId, effective).catch(translateGone);
  } else if (kind === 'issue') {
    // updateIssue deep-merges `stages` per-stage (mergeIssuePatch), so a
    // restore re-applies the archived stage content without clobbering a
    // sibling stage the live record gained since detection — same additive
    // overlay semantics as universe categories (see the NOTE above).
    await updateIssue(recordId, patch).catch(translateGone);
  } else {
    throw makeErr(`Unsupported conflict kind: ${kind}`, ERR_VALIDATION);
  }
}

/**
 * Resolve a conflict entry. `action` ∈ restore-all | merge-fields | discard.
 * `fields` (merge-fields only) selects which snapshot fields to overlay.
 */
export async function resolveConflict(id, { action, fields = [] } = {}) {
  const entry = await getConflict(id);
  if (entry.status !== 'pending') throw makeErr(`Conflict already ${entry.status}`, ERR_VALIDATION);
  const allowed = RESTORABLE_FIELDS[entry.recordKind];
  if (!allowed) throw makeErr(`Unsupported conflict kind: ${entry.recordKind}`, ERR_VALIDATION);
  const snapshot = entry.localSnapshot || {};

  if (action === 'restore-all') {
    await applyToRecord(entry.recordKind, entry.recordId, pick(snapshot, allowed));
  } else if (action === 'merge-fields') {
    if (!Array.isArray(fields) || fields.length === 0) {
      throw makeErr('merge-fields requires a non-empty `fields` array', ERR_VALIDATION);
    }
    const invalid = fields.filter((f) => !allowed.includes(f));
    if (invalid.length) throw makeErr(`Not restorable: ${invalid.join(', ')}`, ERR_VALIDATION);
    await applyToRecord(entry.recordKind, entry.recordId, pick(snapshot, fields));
  } else if (action !== 'discard') {
    throw makeErr(`Unknown resolution action: ${action}`, ERR_VALIDATION);
  }

  const resolved = { ...entry, status: 'resolved', resolution: action, resolvedAt: new Date().toISOString() };
  await store().saveOne(id, resolved);
  console.log(`🪢 conflictJournal: resolved ${id.slice(0, 12)} via ${action}`);
  return resolved;
}

/** Permanently remove a journal entry (the "dismiss / clear" action). */
export async function deleteConflict(id) {
  // Validate the id BEFORE interpolating it into recordDir(id) — getConflict()
  // (which we no longer call) used to enforce this via the store's isValidId;
  // an unguarded id would make recordDir a path-traversal existence oracle.
  if (!isSafeRecordId(id)) throw makeErr(`Conflict entry not found: ${id}`, ERR_NOT_FOUND);
  // Don't gate on getConflict() — it requires a successful parse, so a corrupt
  // journal entry would 404 here and become permanently undeletable. Check raw
  // directory existence instead, then hard-delete (deleteOne is idempotent).
  if (!existsSync(store().recordDir(id))) throw makeErr(`Conflict entry not found: ${id}`, ERR_NOT_FOUND);
  await store().deleteOne(id);
  return { id, deleted: true };
}
