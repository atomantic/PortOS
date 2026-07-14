/**
 * Universe Builder — peer-sync merge + tombstone GC.
 *
 * Cross-machine federation entry points: merge a remote peer's universe array
 * into local state (LWW by `updatedAt`, inside the store's per-id write queue)
 * and garbage-collect expired tombstones. Split out of the former monolithic
 * `universeBuilder.js` (#2529); the barrel at `../universeBuilder.js`
 * re-exports this module so existing import paths keep working.
 */

import { isStr } from '../../lib/storyBible.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes,
  deleteSyncBaseHash,
} from '../../lib/conflictJournal.js';
import { sanitizeTemplate } from './sanitize.js';
import { isValidUniverseId } from './store.js';
import { store } from './storeFacade.js';
import { emitRecordDeleted } from '../sharing/recordEvents.js';
import { unlinkCollectionsForUniverse } from '../mediaCollections.js';
import { clearPendingSheetSlotsForUniverse } from '../universeCharacterSheetSlot.js';

/**
 * Cascade orphan cleanup for a universe whose soft-delete arrived via peer
 * sync (mergeUniversesFromSync detected a deleted=false → deleted=true
 * transition). Mirrors the post-queue cleanup in deleteUniverse so a synced
 * delete on the receiver leaves the same orphan-free state as a local delete.
 * Runs outside the universe-builder write queue.
 */
async function cascadeDeleteSideEffects(id) {
  await unlinkCollectionsForUniverse(id).catch((err) => {
    console.error(`❌ unlink media collections for synced-delete universe ${id} failed: ${err?.message || err}`);
  });
  clearPendingSheetSlotsForUniverse(id);
  emitRecordDeleted('universe', id);
}

/**
 * Sync-orchestrator entry point. Merges a remote peer's universe array into
 * local state INSIDE the store's per-id write queue, so each remote record's
 * read-modify-write can't clobber (or be clobbered by) a concurrent local LLM
 * auto-save, promote-variation, or handleSave on the same universe id.
 *
 * Each incoming remote record passes through `sanitizeTemplate` so older-
 * schema payloads (pre-v4 universes missing `kind`, prose stylePrompt/
 * negativePrompt, retired `characters` bucket) land on disk already migrated —
 * matching every other entry path into this file (`createUniverse`,
 * `insertUniverseWithId`, `updateUniverse`).
 *
 * LWW semantics by `updatedAt`. Local-only `runs[]` survives the merge
 * (ephemeral, per-peer). Returns `{ applied, count }` where `count` is the
 * number of universes actually changed/added by this merge — NOT the total
 * post-merge count — so callers summing across categories don't over-report.
 */
export async function mergeUniversesFromSync(remoteUniverses, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteUniverses)) return { applied: false, count: 0 };
  // Records that transitioned to deleted via this merge get their orphan
  // cascade fired after the write queue releases — matches the side-effect
  // contract of locally-initiated `deleteUniverse`.
  //
  // Edit-merges (no delete-transition) DO NOT call `emitRecordUpdated` here.
  // Unlike `updateUniverse`, the snapshot sync is meant to be silent — every
  // 60s cycle would otherwise trigger a re-export storm in share-bucket
  // subscriptions even when nothing user-visible changed. The Stage 2
  // per-record peer-sync push pipeline will own the "edit arrived from
  // peer" emit so subscribers fire exactly once per actual edit.
  const transitionedToDeleted = [];
  const s = store();
  // Each remote runs through its own per-id queue. The LWW check sits INSIDE
  // each queued write so a concurrent updateUniverse on the same id can't
  // sneak in between the LWW comparison and the write. Different ids fan out
  // in parallel — the scalability win vs. the old single-tail queue.
  let changed = 0;
  const writeTasks = [];
  for (const remote of remoteUniverses) {
    if (!remote || typeof remote !== 'object' || !isStr(remote.id)) continue;
    // Skip a peer record whose id falls outside the store allowlist BEFORE the
    // store throws on it — the store's writeRecord/queueRecordWrite reject such
    // ids synchronously (collectionStore parity), which would otherwise abort
    // this whole sync batch. A buggy/malicious peer can't poison the batch or
    // plant a non-round-trippable id in `universes`.
    if (!isValidUniverseId(remote.id)) {
      console.warn(`⚠️ universe sync: skipping peer record with invalid id "${remote.id}"`);
      continue;
    }
    const sanitized = sanitizeTemplate(remote);
    if (!sanitized) continue;
    // `ephemeral` is a LOCAL-only marker — never trust the inbound value.
    // sanitizeTemplate only persists a literal `{ ephemeral: true }` (any
    // other value gets dropped at the sanitizer); strip even that here so
    // a buggy/older/non-conformant peer (or the share-bucket importer's
    // mutator-form path) can't plant a "dark" record on us that's
    // permanently un-syncable. The on-disk-only contract is enforced on
    // the receive boundary.
    if ('ephemeral' in sanitized) delete sanitized.ephemeral;
    // `importDraft` (issue #727) is likewise LOCAL-only — never trust an
    // inbound value, or a peer could mark our records GC-eligible.
    if ('importDraft' in sanitized) delete sanitized.importDraft;
    writeTasks.push(s.queueRecordWrite(sanitized.id, async () => {
      const local = await s.loadOne(sanitized.id);
      if (!local) {
        // No local counterpart — accept the record (live OR tombstone) but
        // do NOT cascade orphan-cleanup. A tombstone for a record we never
        // had has nothing to clean up; firing `emitRecordDeleted` would
        // spuriously tear down share-bucket subscriptions.
        await s.writeRecord(sanitized.id, sanitized);
        // No local counterpart to lose — nothing to journal, but seed the base
        // hash so a FUTURE divergence on this record is detected.
        await setSyncBaseHash('universe', sanitized.id, contentHashForRecord('universe', sanitized));
        changed += 1;
        return;
      }
      if (local.ephemeral === true) {
        // Local-ephemeral records are IMMUNE to inbound merges. The user
        // explicitly marked this record local-only — peer edits can't
        // overwrite its content, peer deletes can't trigger our orphan
        // cascade, and the post-merge asset-pull worker never gets the
        // chance to download bytes for it.
        return;
      }
      const localTs = local.updatedAt || '';
      const remoteTs = sanitized.updatedAt || '';
      if (remoteTs > localTs) {
        // `styleImageRefs` is WIRE-LOCAL — sanitizeRecordForWire strips it, so an
        // inbound payload never carries it and sanitizeTemplate defaulted it to []
        // above. The local value is authoritative for THIS peer's probe renders;
        // without restoring it, this remote-wins LWW write would clobber the local
        // refs to []. Preserve it onto the sanitized record before it's journaled
        // or written (the conflict hash excludes the field, so this restore can't
        // shift the journal's divergence verdict). Mirror of the ephemeral
        // local-only contract above.
        sanitized.styleImageRefs = local.styleImageRefs ?? [];
        // Non-blocking conflict journal: archive the about-to-be-lost local
        // version when BOTH sides diverged from the last synced base. Always
        // advances the base hash (clean or conflict) so the next snapshot
        // cycle doesn't re-journal the same divergence. Never throws.
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
  // Drop runs for any record that just transitioned to deleted — matches the
  // local-delete contract that ditches now-orphan runs. The facade serializes
  // the runs read→filter→write on its run-tail so a concurrent recordRun can't
  // lose its newly-appended run to a stale filtered snapshot.
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
 * Garbage-collect universe tombstones older than `beforeMs`. Pure of GC
 * policy — the caller (server/services/sharing/tombstoneGc.js) owns the
 * ack-cursor + grace-period math and just tells us the cutoff timestamp.
 *
 * Tombstones whose `deletedAt` is a non-parseable string are conservatively
 * KEPT — we'd rather leak a few garbled records than silently delete data.
 * Returns `{ pruned }` with the count actually removed.
 */
export async function pruneTombstonedUniverses(beforeMs) {
  if (!Number.isFinite(beforeMs)) return { pruned: 0 };
  const s = store();
  // Bulk raw read for the out-of-queue candidate scan — we only need
  // id/deleted/deletedAt, so skip the per-record sanitize. The authoritative
  // re-check inside each per-id queue below still uses loadOne (sanitized).
  const records = await s.listRaw();
  const candidates = [];
  for (const u of records) {
    if (!u?.deleted || !isStr(u.id)) continue;
    const t = Date.parse(u.deletedAt || '');
    if (!Number.isFinite(t)) continue;
    if (t < beforeMs) candidates.push(u.id);
  }
  // Per-id deletes fan out, but we re-check the tombstone status INSIDE each
  // per-id queue. A concurrent mergeUniversesFromSync could have un-deleted
  // the record (newer remote `updatedAt`, `deleted: false`) between our
  // out-of-queue snapshot read and the queued delete; without the re-check,
  // we'd rm -rf a freshly un-deleted record. Counts only the records we
  // actually pruned (the candidates set minus any rescued by a concurrent
  // un-delete).
  const results = await Promise.allSettled(candidates.map((id) =>
    s.queueRecordWrite(id, async () => {
      const fresh = await s.loadOne(id);
      if (!fresh?.deleted) return false; // un-deleted between snapshot and queue
      const t = Date.parse(fresh.deletedAt || '');
      if (!Number.isFinite(t) || t >= beforeMs) return false;
      await s.deleteRecord(id);
      await deleteSyncBaseHash('universe', id);
      return true;
    })
  ));
  let pruned = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value === true) pruned += 1;
    else if (r.status === 'rejected') console.log(`⚠️ pruneTombstonedUniverses: delete failed: ${r.reason?.message || r.reason}`);
  }
  return { pruned };
}
