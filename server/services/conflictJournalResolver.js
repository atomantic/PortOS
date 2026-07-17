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
 * NOTE — restore-all is a FAITHFUL replace of the restorable fields, matching
 * the UI promise ("restore your whole version"). Most restorable fields already
 * patch wholesale through `update*`; the one exception is universe `categories`,
 * which `updateUniverse` normally unions per-key (so a partial PATCH of one
 * category can't wipe the others). restore-all passes `{ replaceCategories: true }`
 * so the archived snapshot's category map replaces the live one wholesale — a
 * category the live record gained since the conflict (e.g. one the user kept
 * after the LWW overwrite) is dropped, because "my whole version" didn't have it.
 *
 * merge-fields stays ADDITIVE: it overlays only the chosen fields onto the
 * CURRENT record, so a selected `categories` field unions per-key (the default
 * `update*` semantics) rather than replacing — you're merging your version of
 * that field in, not reverting the record to the snapshot.
 */

import { existsSync } from 'fs';
import { isSafeRecordId } from '../lib/validation.js';
import { conflictJournalStore, RESTORABLE_FIELDS } from '../lib/conflictJournal.js';
import { updateUniverse, ERR_NOT_FOUND as UNIVERSE_NOT_FOUND } from './universeBuilder.js';
import { updateSeries, ERR_NOT_FOUND as SERIES_NOT_FOUND } from './pipeline/series.js';
import { updateCollection, getCollection, ERR_NOT_FOUND as COLLECTION_NOT_FOUND } from './mediaCollections.js';
import { updateIssue, ERR_NOT_FOUND as ISSUE_NOT_FOUND } from './pipeline/issues.js';
import { updateProject } from './creativeDirector/local.js';
import { updateProject as updateMusicVideoProject } from './musicVideo/projects.js';
import { restoreBoard } from './moodBoard/index.js';
import { updateWork, restoreFolder, restoreExercise } from './writersRoom/local.js';
import { restoreCommissionFeedback } from './creativeCommissions/feedbackStore.js';

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
// `replace` (restore-all only) makes per-key-merged fields replace wholesale —
// currently just universe `categories` (every other restorable field already
// patches wholesale through its service).
async function applyToRecord(kind, recordId, patch, { replace = false } = {}) {
  // The target record may have been tombstoned between conflict-archive time and
  // resolution. Translate the services' not-found codes into ERR_TARGET_GONE so
  // the route maps it to a clean 409 ("discard the entry") instead of a 500.
  const translateGone = (err) => {
    if (err?.code === UNIVERSE_NOT_FOUND || err?.code === SERIES_NOT_FOUND
        || err?.code === COLLECTION_NOT_FOUND || err?.code === ISSUE_NOT_FOUND
        // Creative Director's updateProject throws a generic ServerError
        // 'NOT_FOUND' (no module-specific export) when the row is missing OR
        // tombstoned — both mean the conflict target is gone.
        || err?.code === 'NOT_FOUND') {
      throw makeErr(`The ${kind} this conflict targets no longer exists — discard the entry.`, ERR_TARGET_GONE);
    }
    throw err;
  };
  if (kind === 'universe') {
    // Mutator form bypasses the literal-patch reference-sheet preservation
    // guard — the restored snapshot is the trusted writer here. `replace`
    // (restore-all) swaps the additive per-key categories merge for a wholesale
    // replace so the restore is faithful to the snapshot.
    await updateUniverse(recordId, () => patch, { replaceCategories: replace }).catch(translateGone);
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
    // updateIssue merges `stages` per-key (mergeIssuePatch), but unlike universe
    // categories' OPEN custom-key set, `sanitizeStages` seeds a CLOSED, fixed
    // stage-id set with complete field shapes — so the archived snapshot always
    // carries every stage (and every content sub-field). The per-key overlay
    // therefore covers them all and the snapshot's value (even an empty one)
    // wins, making restore-all equivalent to a wholesale replace WITHOUT a
    // replace flag: a stage value the live record gained since the conflict is
    // overwritten. (`runHistory` is intentionally recomputed, not rolled back —
    // it tracks the live undo-history, which a faithful restore should preserve.)
    await updateIssue(recordId, patch).catch(translateGone);
  } else if (kind === 'creativeDirectorProject') {
    // updateProject does a wholesale spread (`{ ...project, ...patch }`), so the
    // restorable scalars + treatment in the snapshot patch overwrite the live
    // values faithfully — restore-all and merge-fields both apply through the
    // same path. updateProject validates `status` and rejects a tombstoned row
    // (404 → translateGone → ERR_TARGET_GONE).
    await updateProject(recordId, patch).catch(translateGone);
  } else if (kind === 'moodBoard') {
    // restoreBoard applies the snapshot's name/description/items wholesale (via
    // applyBoardRestore — the route's applyBoardPatch only touches name/description,
    // so this dedicated path is what brings items[] back), so restore-all and
    // merge-fields both apply faithfully through the same call. It validates +
    // rejects a tombstoned row (404 → translateGone → ERR_TARGET_GONE).
    await restoreBoard(recordId, patch).catch(translateGone);
  } else if (kind === 'musicVideoProject') {
    // updateProject does a wholesale spread (applyProjectPatch → touch), so the
    // restorable scalars + scenes[] in the snapshot patch overwrite the live
    // values faithfully — restore-all and merge-fields both apply through the
    // same path. It validates `status` and rejects a missing/tombstoned row with
    // the generic ServerError 'NOT_FOUND' (→ translateGone → ERR_TARGET_GONE).
    await updateMusicVideoProject(recordId, patch).catch(translateGone);
  } else if (kind === 'writersRoomWork') {
    // updateWork applies the snapshot's title/kind/status/folderId/imageStyle/
    // liveMode (the RESTORABLE_FIELDS set) through its allow-list + the liveMode
    // partial merge, so restore-all and merge-fields both apply faithfully. It
    // throws the generic ServerError 'NOT_FOUND' for a missing/tombstoned work
    // (caught by translateGone → ERR_TARGET_GONE). The draft-version structure
    // and prose bodies are not restorable here (they're file-primary + lineage-
    // managed) — RESTORABLE_FIELDS.writersRoomWork omits them.
    await updateWork(recordId, patch).catch(translateGone);
  } else if (kind === 'writersRoomFolder') {
    // restoreFolder merges the snapshot's name/parentId/sortOrder (the
    // RESTORABLE_FIELDS set) and bumps updatedAt so the restore wins the next LWW
    // and re-pushes. A missing/tombstoned folder 404s (→ translateGone →
    // ERR_TARGET_GONE). Body-less, so there are no file-primary structures to restore.
    await restoreFolder(recordId, patch).catch(translateGone);
  } else if (kind === 'writersRoomExercise') {
    // restoreExercise merges the snapshot's sprint fields (appendedText + config)
    // and stamps updatedAt so the restored sprint wins the next LWW. A
    // missing/tombstoned exercise 404s (→ ERR_TARGET_GONE).
    await restoreExercise(recordId, patch).catch(translateGone);
  } else if (kind === 'commissionFeedback') {
    // restoreCommissionFeedback merges the snapshot's rating/note/tags, un-tombstones,
    // and bumps updatedAt so the restore wins the next LWW and re-pushes. It returns
    // null (not throw) for a missing record — translate that to ERR_TARGET_GONE so
    // the route serves a clean 409 (#2686).
    const restored = await restoreCommissionFeedback(recordId, patch).catch(translateGone);
    if (!restored) throw makeErr(`The ${kind} this conflict targets no longer exists — discard the entry.`, ERR_TARGET_GONE);
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
    // Faithful restore: replace the keyed fields (universe categories) wholesale.
    await applyToRecord(entry.recordKind, entry.recordId, pick(snapshot, allowed), { replace: true });
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
