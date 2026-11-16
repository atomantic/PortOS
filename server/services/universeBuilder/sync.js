/**
 * Universe Builder — peer-sync merge + tombstone GC.
 *
 * Cross-machine federation entry points: merge a remote peer's universe array into local state
 * (LWW by `updatedAt`, inside the store's per-id write queue) and garbage-collect expired
 * tombstones. The barrel at `../universeBuilder.js` re-exports this module.
 */

import {
  isLegacyAbsentValue, preserveLegacyCharacterFields, preserveLegacyObjectFields, preserveLegacyPlaceFields,
} from '../../lib/storyBible.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes,
  deleteSyncBaseHash, withBaseHashFlushBatch,
} from '../../lib/conflictJournal.js';
import { sanitizeTemplate } from './sanitize.js';
import { isValidUniverseId } from './store.js';
import { store } from './storeFacade.js';
import { emitRecordDeleted } from '../sharing/recordEvents.js';
import { unlinkCollectionsForUniverse } from '../mediaCollections.js';
import { clearPendingSheetSlotsForUniverse } from '../universeCharacterSheetSlot.js';
import { isStr } from '../../lib/textUtils.js';
import { compareNewerWins } from '../../lib/lwwTimestamp.js';

/**
 * Cascade orphan cleanup for a universe whose soft-delete arrived via peer sync
 * (mergeUniversesFromSync saw deleted=false → deleted=true). Mirrors the post-queue cleanup in
 * deleteUniverse so a synced delete leaves the same orphan-free state as a local one. Runs
 * outside the universe-builder write queue.
 */
async function cascadeDeleteSideEffects(id) {
  await unlinkCollectionsForUniverse(id).catch((err) => {
    console.error(`❌ unlink media collections for synced-delete universe ${id} failed: ${err?.message || err}`);
  });
  clearPendingSheetSlotsForUniverse(id);
  emitRecordDeleted('universe', id);
}

// Additive universe-level fields an older peer's sanitizer cannot represent, keyed by the
// `universes` wire version that introduced each. The version gate only rejects AHEAD senders,
// so a behind (or no-meta) sender's record arrives with these already sanitized away: its
// omission means "no slot for this", not "the author cleared it". A sender at or above the
// version omitting the field IS a clear.
const ADDITIVE_UNIVERSE_FIELD_VERSIONS = Object.freeze({
  // v8 — shared, user-selected visual references.
  styleReferences: 8,
  // v9 — linked mood board (#4188).
  moodBoardId: 9,
  // v12 — factual/fiction axis (#7616). Persisted only when true.
  factual: 12,
  visualProfile: 16,
});

/**
 * Carry the local copy's additive fields onto a remote universe that won LWW from a sender too
 * old to represent them (universe-level fields plus per-entry character and object fields). A
 * version-aware sender's omission passes through as the intentional clear it is. Pure: returns
 * a new record (or `remote` itself when nothing needed restoring).
 */
export function preserveLegacyUniverseFields(remote, local, senderUniversesVersion) {
  if (!remote || !local) return remote;
  const sender = Number(senderUniversesVersion) || 0;
  const out = { ...remote };
  for (const [field, since] of Object.entries(ADDITIVE_UNIVERSE_FIELD_VERSIONS)) {
    if (sender < since && isLegacyAbsentValue(out[field]) && !isLegacyAbsentValue(local[field])) {
      out[field] = local[field];
    }
  }
  // Only touch the lists the remote carries — a raw share-bucket record may
  // omit one, and an `undefined`-valued key would clobber it in a patch merge.
  if ('characters' in out) out.characters = preserveLegacyCharacterFields(out.characters, local.characters, sender);
  if ('places' in out) out.places = preserveLegacyPlaceFields(out.places, local.places, sender);
  if ('objects' in out) out.objects = preserveLegacyObjectFields(out.objects, local.objects, sender);
  return out;
}

/**
 * Sync-orchestrator entry point. Merges a remote peer's universe array into local state INSIDE
 * the store's per-id write queue, so a record's read-modify-write can't clobber (or be
 * clobbered by) a concurrent local LLM auto-save, promote-variation, or handleSave.
 *
 * Each remote record passes through `sanitizeTemplate` so older-schema payloads land already
 * migrated, like every other entry path (`createUniverse`, `insertUniverseWithId`,
 * `updateUniverse`).
 *
 * LWW by `updatedAt`. Local-only `runs[]` survives (ephemeral, per-peer). Returns
 * `{ applied, count }` where `count` is the number of universes actually changed/added, NOT the
 * post-merge total, so callers summing across categories don't over-report.
 */
export async function mergeUniversesFromSync(remoteUniverses, { source = { via: 'sync', peerId: null }, senderSchemaVersions = null } = {}) {
  const senderUniversesVersion = Number(senderSchemaVersions?.universes) || 0;
  if (!Array.isArray(remoteUniverses)) return { applied: false, count: 0 };
  // Records that transitioned to deleted get their orphan cascade after the write queue
  // releases, matching locally-initiated `deleteUniverse`.
  //
  // Edit-merges DO NOT call `emitRecordUpdated`: the snapshot sync is meant to be silent, or
  // every 60s cycle would trigger a re-export storm in share-bucket subscriptions. The per-record
  // peer-sync push pipeline owns the "edit arrived from peer" emit.
  const transitionedToDeleted = [];
  const s = store();
  // Each remote runs through its own per-id queue, with the LWW check INSIDE the queued write so
  // a concurrent updateUniverse can't slip between comparison and write. Different ids fan out in
  // parallel.
  let changed = 0;
  const writeTasks = [];
  for (const remote of remoteUniverses) {
    if (!remote || typeof remote !== 'object' || !isStr(remote.id)) continue;
    // Skip a peer record whose id falls outside the store allowlist BEFORE the store throws on it
    // (writeRecord/queueRecordWrite reject such ids synchronously), which would abort the whole
    // batch. A buggy/malicious peer can't poison the batch or plant a non-round-trippable id.
    if (!isValidUniverseId(remote.id)) {
      console.warn(`⚠️ universe sync: skipping peer record with invalid id "${remote.id}"`);
      continue;
    }
    const sanitized = sanitizeTemplate(remote);
    if (!sanitized) continue;
    // `ephemeral` is a LOCAL-only marker: never trust the inbound value. sanitizeTemplate keeps
    // only a literal `{ ephemeral: true }`; strip even that so a non-conformant peer (or the
    // share-bucket importer's mutator path) can't plant a permanently un-syncable "dark" record.
    if ('ephemeral' in sanitized) delete sanitized.ephemeral;
    // `importDraft` (issue #727) is likewise LOCAL-only — never trust an
    // inbound value, or a peer could mark our records GC-eligible.
    if ('importDraft' in sanitized) delete sanitized.importDraft;
    writeTasks.push(s.queueRecordWrite(sanitized.id, async () => {
      const local = await s.loadOne(sanitized.id);
      if (!local) {
        // No local counterpart: accept the record (live OR tombstone) without orphan cascade. A
        // tombstone for a record we never had has nothing to clean up, and `emitRecordDeleted` would
        // spuriously tear down share-bucket subscriptions.
        await s.writeRecord(sanitized.id, sanitized);
        // No local counterpart to lose — nothing to journal, but seed the base
        // hash so a FUTURE divergence on this record is detected.
        await setSyncBaseHash('universe', sanitized.id, contentHashForRecord('universe', sanitized));
        changed += 1;
        return;
      }
      if (local.ephemeral === true) {
        // Local-ephemeral records are IMMUNE to inbound merges: the user marked this record
        // local-only, so peer edits can't overwrite it, peer deletes can't trigger the orphan
        // cascade, and the asset-pull worker never downloads bytes for it.
        return;
      }
      if (compareNewerWins(sanitized.updatedAt, local.updatedAt)) {
        // `styleImageRefs` is WIRE-LOCAL: sanitizeRecordForWire strips it and sanitizeTemplate
        // defaulted it to [] above. The local value is authoritative for THIS peer's probe renders, so
        // restore it before the record is journaled or written, or this remote-wins write would clobber
        // the refs (the conflict hash excludes the field, so the restore can't shift the divergence
        // verdict).
        sanitized.styleImageRefs = local.styleImageRefs ?? [];
        // The per-record render pin is wire-local too: restore the local pair so a remote-wins write
        // can't clear this machine's pinned backend/model (persisted only when set).
        if (local.imageMode) sanitized.imageMode = local.imageMode;
        if (local.imageModelId) sanitized.imageModelId = local.imageModelId;
        // Additive fields (moodBoardId, factual, styleReferences, character and object links, ...)
        // ride the wire, but absent-on-wire is ambiguous: a version-aware sender omits one to mean
        // "cleared", a behind sender because its sanitizer strips it. Restore only the latter.
        Object.assign(sanitized, preserveLegacyUniverseFields(sanitized, local, senderUniversesVersion));
        // Non-blocking conflict journal: archive the about-to-be-lost local version when BOTH sides
        // diverged from the last synced base. Always advances the base hash so the next cycle doesn't
        // re-journal the same divergence. Never throws.
        await maybeJournalBeforeOverwrite({ kind: 'universe', id: sanitized.id, local, remote: sanitized, source });
        await s.writeRecord(sanitized.id, sanitized);
        if (sanitized.deleted && !local.deleted) transitionedToDeleted.push(sanitized.id);
        changed += 1;
      }
    }));
  }
  await Promise.all(writeTasks);
  // Persist the batched base-hash updates accumulated above in one write.
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  // Drop runs for any record that just transitioned to deleted (the local-delete contract). The
  // facade serializes read→filter→write on its run-tail so a concurrent recordRun can't lose its
  // run to a stale snapshot.
  if (transitionedToDeleted.length) {
    await s.removeRunsForUniverses(transitionedToDeleted);
  }
  const result = { applied: true, count: changed };
  // Fire cascades after the queue releases (mirrors deleteUniverse ordering)
  // so a slow media-collections write can't block other universe mutators.
  for (const id of transitionedToDeleted) {
    await cascadeDeleteSideEffects(id);
  }
  return result;
}

/**
 * Universe id listers for the tombstone-sweep's orphan resolvers
 * (server/services/sharing/tombstoneGc.js). Id-only projections (no hydration or sanitize) so a
 * membership check never pays for a universe's JSONB body.
 *
 * `listLiveIds` excludes tombstones (LIVE_ID_LISTERS: a tombstoned record stops protecting its
 * base hash); `listIds` includes them (ALL_ID_LISTERS: a tombstone still owns its peer
 * subscription until hard-deleted).
 */
export async function listLiveIds() {
  return store().listLiveIds();
}
export async function listIds() {
  return store().listIds();
}

/**
 * Garbage-collect universe tombstones older than `beforeMs`. The caller
 * (server/services/sharing/tombstoneGc.js) owns the ack-cursor + grace-period math and supplies
 * the cutoff.
 *
 * Tombstones whose `deletedAt` is non-parseable are KEPT: better to leak a few garbled records
 * than silently delete data. Returns `{ pruned }` with the count actually removed.
 */
export async function pruneTombstonedUniverses(beforeMs) {
  if (!Number.isFinite(beforeMs)) return { pruned: 0 };
  const s = store();
  // Id-only candidate scan for the out-of-queue pass (a SQL projection on Postgres, hydrate+filter
  // on the file escape hatch): the sweep almost never finds a tombstone, so it must not pay for
  // every universe's JSONB body. The authoritative re-check inside each per-id queue uses loadOne.
  const candidates = await s.listTombstoneIdsBefore(beforeMs);
  // Per-id deletes fan out, but the tombstone status is re-checked INSIDE each queue: a concurrent
  // mergeUniversesFromSync could have un-deleted the record (newer remote `updatedAt`) since the
  // snapshot read, and without the re-check we'd rm -rf it. Counts only records actually pruned.
  const results = await withBaseHashFlushBatch(() =>
    Promise.allSettled(candidates.map((id) =>
      s.queueRecordWrite(id, async () => {
        const fresh = await s.loadOne(id);
        if (!fresh?.deleted) return false; // un-deleted between snapshot and queue
        const t = Date.parse(fresh.deletedAt || '');
        if (!Number.isFinite(t) || t >= beforeMs) return false;
        await s.deleteRecord(id);
        await deleteSyncBaseHash('universe', id);
        return true;
      })
    )));
  let pruned = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value === true) pruned += 1;
    else if (r.status === 'rejected') console.log(`⚠️ pruneTombstonedUniverses: delete failed: ${r.reason?.message || r.reason}`);
  }
  return { pruned };
}
