/** Apply peer changes and maintain Brain tombstones and record origins. */
import { mergeIncomingLinkRecord } from '../../lib/brainLinkLocalFields.js';
import { parseTsMs, compareNewerWins } from '../../lib/lwwTimestamp.js';
import { getInstanceId } from '../instanceIdentity.js';
import {
  BRAIN_ENTITY_TYPES, brainEvents, emitRecordChanged, isTombstone, makeTombstone, storeFor,
} from './recordStore.js';

// GC grace period: how long a tombstone is retained before it can be hard-
// pruned. Must comfortably exceed the longest realistic peer-offline window so
// a peer that reconnects still sees the delete (not a since-vanished id that it
// would re-create). 30 days matches the sharing-side tombstone grace buffer.
export const BRAIN_TOMBSTONE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
// =============================================================================
// REMOTE SYNC OPERATIONS (no per-record events, no sync log — echo prevention)
// =============================================================================
// The only event these emit is the local-only `record:changed` invalidation
// signal (see emitRecordChanged) — it never leaves this instance.

/**
 * The LWW rejection for an incoming op whose clock is not newer than ours.
 *
 * `local_current` means we already hold exactly the state the op carries — same
 * LWW clock, same delete-ness — so the op is ALREADY APPLIED here (an echo, or a
 * delta re-pulled after a crash between our save and our relay append). The
 * wire-shape of our copy rides along so the caller can relay it if our sync log
 * lacks it (#8316). Anything else is `local_newer`: a genuinely stale op.
 */
function rejectedAgainst(existing, record, incomingIsDelete) {
  if (existing.updatedAt !== record.updatedAt || isTombstone(existing) !== incomingIsDelete) {
    return { applied: false, reason: 'local_newer' };
  }
  const current = isTombstone(existing)
    ? { updatedAt: existing.updatedAt, originInstanceId: existing.originInstanceId }
    : { ...existing };
  return { applied: false, reason: 'local_current', current };
}

/**
 * Apply a remote record to a store (last-writer-wins by updatedAt).
 * Rejections carry `reason` `local_newer` (stale op) or `local_current` (op
 * already applied — `current` is our copy in wire shape); see rejectedAgainst.
 */
export async function applyRemoteRecord(type, id, record, op) {
  const store = storeFor(type);
  // Reject a malformed id (can't name a valid per-record dir) or a
  // prototype-polluting name — the store's `isValidId` owns both the format
  // allowlist AND the reserved-key denylist (`__proto__`/`constructor`/
  // `prototype`), so a bad id returns `invalid_id` here instead of throwing on
  // the write-queue assertion or appending a phantom relay entry that can never
  // converge (this covers BOTH the delta-sync and reconcile-snapshot callers).
  if (!store.isValidId(id)) {
    return { applied: false, reason: 'invalid_id' };
  }
  // Both delta pulls and snapshots bypass the HTTP push schema. Reject invalid
  // clocks here too, before any write or relay, while preserving missing-clock
  // skips for legacy peers. Parseable offsets/legacy formats remain supported.
  if (!record?.updatedAt) {
    return { applied: false, reason: 'missing_timestamp' };
  }
  if (parseTsMs(record.updatedAt) === null) {
    return { applied: false, reason: 'invalid_timestamp' };
  }
  return store.queueRecordWrite(id, async () => {
    const existing = await store.loadOne(id);

    if (op === 'delete') {
      // LWW: skip if our copy (live record OR existing tombstone) is at least as
      // new as the incoming delete. The tombstone-vs-tombstone case makes a
      // repeated delete idempotent → not relayed → the echo loop converges.
      if (existing && !compareNewerWins(record.updatedAt, existing.updatedAt)) {
        return rejectedAgainst(existing, record, true);
      }
      // Tombstone in place even when no local record exists. A delete that
      // arrives before we ever saw a create still leaves a marker, so a later
      // stale create for that id is rejected instead of resurrecting.
      await store.saveOneNow(id, makeTombstone(
        record.updatedAt,
        record.originInstanceId ?? existing?.originInstanceId
      ));
    } else {
      // Guard also fires when `existing` is a tombstone — a stale create (older
      // updatedAt than the recorded delete) is rejected, breaking the
      // resurrection loop. A genuinely newer create (later updatedAt than the
      // tombstone) still wins and legitimately revives the record.
      if (existing && !compareNewerWins(record.updatedAt, existing.updatedAt)) {
        return rejectedAgainst(existing, record, record._deleted === true);
      }
      // Defense-in-depth: a create carrying `_deleted` (a future peer, or a
      // direct caller bypassing brainSync's reroute) must persist as a proper
      // tombstone, never as a malformed live record missing `deletedAt`.
      await store.saveOneNow(id, record._deleted
        ? makeTombstone(record.updatedAt, record.originInstanceId ?? existing?.originInstanceId)
        : (type === 'links' ? mergeIncomingLinkRecord(record, existing) : { ...record }));
    }

    // Still no per-record event (that would echo back to the peer, #1077) —
    // just the local invalidation signal so derived projections re-read.
    emitRecordChanged(type, id);
    return { applied: true };
  });
}

/**
 * True when a stored file exists for the id: a live record, an archived one, or
 * a tombstone. False only when nothing is stored at all (never created here, or
 * its tombstone was pruned).
 */
export async function hasStoredRecord(type, id) {
  return !!(await storeFor(type).loadOne(id));
}

/**
 * Hard-prune tombstones older than `cutoffMs` (a Date.now()-style epoch ms).
 * Called by the brain tombstone GC sweep on the orchestrator's interval.
 * Per-id re-check inside the write queue so a tombstone a concurrent apply just
 * refreshed isn't pruned on a stale read. Returns the number of tombstones
 * removed.
 */
export async function pruneTombstones(type, cutoffMs) {
  const store = storeFor(type);
  const ids = await store.listIds();
  // Different ids are independent files — prune them in parallel (each still
  // serialized on its own per-id queue so the stale-read recheck holds). The
  // count is order-independent.
  const results = await Promise.all(ids.map((id) => store.queueRecordWrite(id, async () => {
    const record = await store.loadOne(id);
    if (!isTombstone(record)) return false;
    const deletedAt = Date.parse(record.deletedAt ?? record.updatedAt ?? '');
    if (Number.isFinite(deletedAt) && deletedAt < cutoffMs) {
      await store.deleteOneNow(id);
      emitRecordChanged(type, id);
      // Past the grace window a peer can no longer un-delete this record, so the
      // bridge uses this signal to purge its own archived memory copy.
      brainEvents.emit('tombstone:pruned', { type, id });
      return true;
    }
    return false;
  })));
  return results.filter(Boolean).length;
}

/**
 * Backfill originInstanceId on records missing it (run once at startup)
 */
export async function backfillOriginInstanceId() {
  const instanceId = await getInstanceId();

  // Every record across all types is an independent file — backfill them in
  // parallel (per-id writes still serialize on their own queue). This runs at
  // startup and gates sync start, so the parallelism directly shortens boot.
  const perType = await Promise.all(BRAIN_ENTITY_TYPES.map(async (type) => {
    const store = storeFor(type);
    const ids = await store.listIds();
    const changes = await Promise.all(ids.map((id) => store.queueRecordWrite(id, async () => {
      const record = await store.loadOne(id);
      // Tombstones always carry originInstanceId; skip them and absent records.
      if (!record || isTombstone(record) || record.originInstanceId) return false;
      await store.saveOneNow(id, { ...record, originInstanceId: instanceId });
      emitRecordChanged(type, id);
      return true;
    })));
    return changes.filter(Boolean).length;
  }));

  const totalBackfilled = perType.reduce((sum, n) => sum + n, 0);
  if (totalBackfilled > 0) {
    console.log(`🧠 Backfilled originInstanceId on ${totalBackfilled} records`);
  }
}
