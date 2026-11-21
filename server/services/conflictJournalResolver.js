/**
 * Resolve entries in the non-blocking conflict journal (server/lib/conflictJournal.js).
 * Each entry archives a local version that LWW overwrote:
 *   - restore-all: re-apply the snapshot's restorable fields as a fresh edit (bumped updatedAt) so it wins LWW and re-propagates.
 *   - merge-fields: overlay only the chosen fields onto the CURRENT live record.
 *   - discard: keep the current record; mark the entry resolved.
 *
 * Writes ALWAYS go through the normal `update*` service path so updatedAt bumps and the push pipeline propagates.
 *
 * restore-all is a FAITHFUL replace ("restore your whole version"): universe `categories`, which
 * `updateUniverse` normally unions per-key, is replaced wholesale via `{ replaceCategories: true }`, dropping
 * categories gained since the conflict. merge-fields stays ADDITIVE, so a selected `categories` unions per-key.
 */

import { existsSync } from 'fs';
import { ABSENT_MEANS_FALSE_FIELDS, conflictJournalStore, RESTORABLE_FIELDS, WRITERS_ROOM_DRAFT_BODY_CONFLICT_KIND } from '../lib/conflictJournal.js';
import { updateUniverse, ERR_NOT_FOUND as UNIVERSE_NOT_FOUND } from './universeBuilder.js';
import { updateSeries, ERR_NOT_FOUND as SERIES_NOT_FOUND } from './pipeline/series.js';
import { updateCollection, getCollection, ERR_NOT_FOUND as COLLECTION_NOT_FOUND } from './mediaCollections.js';
import { updateIssue, ERR_NOT_FOUND as ISSUE_NOT_FOUND } from './pipeline/issues.js';
import { updateProject } from './creativeDirector/local.js';
import { updateProject as updateMusicVideoProject } from './musicVideo/projects.js';
import { restoreBoard } from './moodBoard/index.js';
import { updateWork, saveDraftBody, restoreFolder, restoreExercise } from './writersRoom/local.js';
import { restoreCommissionFeedback } from './creativeCommissions/feedbackStore.js';
import { restoreCommission } from './creativeCommissions/store.js';
import { restoreDeck } from './decks.js';
import { restoreStoryboard } from './storyboards/index.js';
import { restoreLoom } from './fableLoom/records.js';
import { codedError } from '../lib/codedError.js';
import { isSafeRecordId } from '../lib/zodCompat.js';

export const ERR_NOT_FOUND = 'CONFLICT_JOURNAL_NOT_FOUND';
export const ERR_VALIDATION = 'CONFLICT_JOURNAL_VALIDATION';
// The entry exists but its target record was tombstoned since archive time (distinct from ERR_NOT_FOUND).
export const ERR_TARGET_GONE = 'CONFLICT_TARGET_GONE';

// RESTORABLE_FIELDS is owned by conflictJournal.js so diffSummary and this validator stay in lockstep.

// `kind` is needed for ABSENT_MEANS_FALSE_FIELDS: a field persisted only when true (universe `factual`)
// is ABSENT when false, so an `in` check alone would make the clear-direction restore a silent no-op.
const pick = (obj, fields, kind) => {
  const falseWhenAbsent = ABSENT_MEANS_FALSE_FIELDS[kind] || [];
  const out = {};
  for (const f of fields) {
    if (obj && f in obj) out[f] = obj[f];
    else if (falseWhenAbsent.includes(f)) out[f] = false;
  }
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
  if (!entry) throw codedError(`Conflict entry not found: ${id}`, ERR_NOT_FOUND);
  return entry;
}

// Apply a content patch through the service's normal update path. `replace` (restore-all only) makes
// per-key-merged fields replace wholesale, currently just universe `categories`.
async function applyToRecord(kind, recordId, patch, { replace = false } = {}) {
  // The target may have been tombstoned since archive time; map the services' not-found codes to
  // ERR_TARGET_GONE so the route returns a clean 409 instead of a 500.
  const translateGone = (err) => {
    if (err?.code === UNIVERSE_NOT_FOUND || err?.code === SERIES_NOT_FOUND
        || err?.code === COLLECTION_NOT_FOUND || err?.code === ISSUE_NOT_FOUND
        // Creative Director/music-video updateProject throw a generic 'NOT_FOUND' when the row is missing or tombstoned.
        || err?.code === 'NOT_FOUND') {
      throw codedError(`The ${kind} this conflict targets no longer exists — discard the entry.`, ERR_TARGET_GONE);
    }
    throw err;
  };
  if (kind === 'universe') {
    // Mutator form bypasses the literal-patch reference-sheet guard (the snapshot is the trusted writer);
    // `replace` swaps the additive categories merge for a wholesale replace.
    await updateUniverse(recordId, () => patch, { replaceCategories: replace }).catch(translateGone);
  } else if (kind === 'series') {
    await updateSeries(recordId, patch).catch(translateGone);
  } else if (kind === 'mediaCollection') {
    // A linked collection (universeId/seriesId set) locks `name` to its owner: updateCollection rejects a
    // name change, and such a "conflict" is an owner-rename cascade artifact. Drop `name` for linked
    // collections so restore still applies the editable scalars instead of 500ing.
    const cur = await getCollection(recordId, { includeDeleted: true }).catch(translateGone);
    const { name: _lockedName, ...withoutName } = patch;
    const effective = (cur?.universeId || cur?.seriesId) ? withoutName : patch;
    if (Object.keys(effective).length > 0) await updateCollection(recordId, effective).catch(translateGone);
  } else if (kind === 'issue') {
    // updateIssue merges `stages` per-key, but `sanitizeStages` seeds a CLOSED stage-id set with complete
    // shapes, so the snapshot always carries every stage and its value wins: restore-all equals a wholesale
    // replace without a flag. (`runHistory` is intentionally recomputed, not rolled back.)
    await updateIssue(recordId, patch).catch(translateGone);
  } else if (kind === 'creativeDirectorProject') {
    // updateProject does a wholesale spread, so restorable scalars + treatment overwrite the live values.
    // It validates `status` and rejects a tombstoned row (404 -> translateGone).
    await updateProject(recordId, patch).catch(translateGone);
  } else if (kind === 'moodBoard') {
    // restoreBoard applies name/description/items wholesale (the route's applyBoardPatch skips items[]).
    // Rejects a tombstoned row (404 -> translateGone).
    await restoreBoard(recordId, patch).catch(translateGone);
  } else if (kind === 'musicVideoProject') {
    // Wholesale spread (applyProjectPatch -> touch): restorable scalars + scenes[] overwrite the live values.
    // Rejects a missing/tombstoned row with the generic 'NOT_FOUND' (-> translateGone).
    await updateMusicVideoProject(recordId, patch).catch(translateGone);
  } else if (['writersRoomCharacters', 'writersRoomPlaces', 'writersRoomObjects'].includes(kind)) {
    const { restoreWorkBible, BIBLE_CONFLICT_KINDS } = await import('./writersRoom/bibleSync.js');
    const bibleKind = Object.keys(BIBLE_CONFLICT_KINDS).find((key) => BIBLE_CONFLICT_KINDS[key] === kind);
    await restoreWorkBible(recordId, bibleKind, patch).catch(translateGone);
  } else if (kind === WRITERS_ROOM_DRAFT_BODY_CONFLICT_KIND) {
    const [workId, draftId, ...rest] = recordId.split('/');
    if (!workId || !draftId || rest.length > 0 || typeof patch.body !== 'string') {
      throw codedError('Invalid Writers Room draft-body conflict', ERR_VALIDATION);
    }
    await saveDraftBody(workId, patch.body, { draftId }).catch(translateGone);
  } else if (kind === 'writersRoomWork') {
    // updateWork applies the RESTORABLE_FIELDS set through its allow-list and liveMode partial merge.
    // Draft-version structure and prose bodies are file-primary + lineage-managed, so not restorable here.
    await updateWork(recordId, patch).catch(translateGone);
  } else if (kind === 'writersRoomFolder') {
    // Merges name/parentId/sortOrder and bumps updatedAt so the restore wins the next LWW and re-pushes.
    await restoreFolder(recordId, patch).catch(translateGone);
  } else if (kind === 'writersRoomExercise') {
    // Merges sprint fields (appendedText + config) and stamps updatedAt so the restore wins the next LWW.
    await restoreExercise(recordId, patch).catch(translateGone);
  } else if (kind === 'commissionFeedback') {
    // Merges rating/note/tags, un-tombstones, bumps updatedAt. Returns null (not throw) for a missing record; translate it to ERR_TARGET_GONE for a clean 409 (#2686).
    const restored = await restoreCommissionFeedback(recordId, patch).catch(translateGone);
    if (!restored) throw codedError(`The ${kind} this conflict targets no longer exists — discard the entry.`, ERR_TARGET_GONE);
  } else if (kind === 'creativeCommission') {
    // Merges brief fields, un-tombstones, bumps updatedAt; machine-local schedule/runs/assignment are kept. Null = missing (#2686).
    const restored = await restoreCommission(recordId, patch).catch(translateGone);
    if (!restored) throw codedError(`The ${kind} this conflict targets no longer exists — discard the entry.`, ERR_TARGET_GONE);
  } else if (kind === 'deck') {
    // Merges style-guide/identity fields, un-tombstones, bumps updatedAt. Null = hard-pruned by the tombstone sweep.
    const restored = await restoreDeck(recordId, patch).catch(translateGone);
    if (!restored) throw codedError(`The ${kind} this conflict targets no longer exists — discard the entry.`, ERR_TARGET_GONE);
  } else if (kind === 'storyboard') {
    // Overlays authored fields, un-tombstones, bumps updatedAt. Null = already hard-pruned.
    const restored = await restoreStoryboard(recordId, patch).catch(translateGone);
    if (!restored) throw codedError(`The ${kind} this conflict targets no longer exists — discard the entry.`, ERR_TARGET_GONE);
  } else if (kind === 'fableLoom') {
    // Restore through the normal loom mutation path so the edit is sanitized, timestamped, and re-pushed.
    await restoreLoom(recordId, patch).catch(translateGone);
  } else {
    throw codedError(`Unsupported conflict kind: ${kind}`, ERR_VALIDATION);
  }
}

/**
 * Resolve a conflict entry. `action` ∈ restore-all | merge-fields | discard.
 * `fields` (merge-fields only) selects which snapshot fields to overlay.
 */
export async function resolveConflict(id, { action, fields = [] } = {}) {
  const entry = await getConflict(id);
  if (entry.status !== 'pending') throw codedError(`Conflict already ${entry.status}`, ERR_VALIDATION);
  const allowed = RESTORABLE_FIELDS[entry.recordKind];
  if (!allowed) throw codedError(`Unsupported conflict kind: ${entry.recordKind}`, ERR_VALIDATION);
  const snapshot = entry.localSnapshot || {};

  if (action === 'restore-all') {
    // Faithful restore: replace the keyed fields (universe categories) wholesale.
    await applyToRecord(entry.recordKind, entry.recordId, pick(snapshot, allowed, entry.recordKind), { replace: true });
  } else if (action === 'merge-fields') {
    if (!Array.isArray(fields) || fields.length === 0) {
      throw codedError('merge-fields requires a non-empty `fields` array', ERR_VALIDATION);
    }
    const invalid = fields.filter((f) => !allowed.includes(f));
    if (invalid.length) throw codedError(`Not restorable: ${invalid.join(', ')}`, ERR_VALIDATION);
    await applyToRecord(entry.recordKind, entry.recordId, pick(snapshot, fields, entry.recordKind));
  } else if (action !== 'discard') {
    throw codedError(`Unknown resolution action: ${action}`, ERR_VALIDATION);
  }

  const resolved = { ...entry, status: 'resolved', resolution: action, resolvedAt: new Date().toISOString() };
  await store().saveOne(id, resolved);
  console.log(`🪢 conflictJournal: resolved ${id.slice(0, 12)} via ${action}`);
  return resolved;
}

/** Permanently remove a journal entry (the "dismiss / clear" action). */
export async function deleteConflict(id) {
  // Validate the id BEFORE it reaches recordDir(id), or it becomes a path-traversal existence oracle.
  if (!isSafeRecordId(id)) throw codedError(`Conflict entry not found: ${id}`, ERR_NOT_FOUND);
  // Don't gate on getConflict(): a corrupt entry would 404 and become undeletable. Check raw directory existence (deleteOne is idempotent).
  if (!existsSync(store().recordDir(id))) throw codedError(`Conflict entry not found: ${id}`, ERR_NOT_FOUND);
  await store().deleteOne(id);
  return { id, deleted: true };
}
