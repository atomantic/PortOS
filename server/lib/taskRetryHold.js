/**
 * Pure metadata helpers for the failed-task retry hold and delivery-cleanup ownership state shared by
 * failure handling, spawn guard and orphan sweep.
 */

import { isTruthyMeta } from './metadataFlags.js';
/**
 * Retry hold: the intermediate task state between a failed run's verdict and the resume pointer its retry needs (#3373). A non-actionable failure under the retry budget once flipped the task straight to `pending` in `finalizeAgent`,
 * while the pointer letting the retry adopt the cleanup-preserved branch is resolvable only AFTER `cleanupAgentWorktree` decides what survived (ms to seconds later): in that window the `agent:completed` dequeue could claim it and start
 * from scratch, redoing work on the preserved branch, and the retry holding the task `in_progress` made the pointer write's own status gate decline, dropping the pointer for good.
 * The fix is a HOLD: the verdict leaves the task `in_progress` (no dequeue tier looks at it and `spawnAgentForTask` rejects it) with the marker below, and the post-cleanup write flips it to `pending` WITH the resume metadata in one `updateTask`,
 * so it is never both spawnable and pointerless. The marker is persisted task metadata, so a process killed mid-transition leaves evidence: `handleOrphanedTask` completes the transition (resolve pointer → `pending` → clear marker).
 * Pure and dependency-free so the writer (agentErrorAnalysis), releaser (agentWorktreeCleanup) and recovery sweep (agentManagement / cos) share ONE definition.
 */

/** How long a hold is treated as LIVE (an in-process cleanup presumed about to release it). The orphan sweep recovers only an older hold, so it can't steal a task from a slow cleanup (merge + push + PR probe); the sweep runs every 15 minutes, so a crash costs at most one interval. */
export const RETRY_HOLD_GRACE_MS = 10 * 60 * 1000;

/** Metadata keys that carry the hold. Exported for tests and greppability. */
export const RETRY_HOLD_KEY = 'retryPendingCleanup';
export const RETRY_HOLD_SINCE_KEY = 'retryPendingSince';

/**
 * The metadata patch that ARMS the hold, merged into the failure verdict's own `updateTask` so the task is never spawnable-but-pointerless. The marker VALUE is the arming run's id (not a bare `true`) so release is owner-scoped:
 * a slow cleanup from attempt A landing after B armed its own hold must not clear B's hold, overwrite B's pointer, or make the task spawnable. A hold with no id (`true`) is a legacy shape any releaser may clear.
 */
export function retryHoldMetadata(agentId, now = Date.now()) {
  return {
    [RETRY_HOLD_KEY]: agentId || true,
    [RETRY_HOLD_SINCE_KEY]: new Date(now).toISOString(),
  };
}

/** The metadata patch that RELEASES the hold. `undefined` (not `null`) because `updateTask` deletes undefined keys while a null is stored as a present value (the `!== 'null'` guards below stay for task files an older install wrote). */
export function clearedRetryHoldMetadata() {
  return {
    [RETRY_HOLD_KEY]: undefined,
    [RETRY_HOLD_SINCE_KEY]: undefined,
  };
}

/** Is this task held pending its resume-pointer write? The marker is an agent id or legacy `true`; the markdown round-trip stringifies booleans, so `'false'`/`'null'` must read as NOT held. */
export function isRetryHeld(metadata) {
  const value = metadata?.[RETRY_HOLD_KEY];
  if (isTruthyMeta(value)) return true;
  return typeof value === 'string' && value !== '' && value !== 'false' && value !== 'null' && value !== 'undefined';
}

/** Return the exact attributed cleanup owner, never a legacy boolean marker. */
export function retryHoldOwnerId(metadata) {
  const value = metadata?.[RETRY_HOLD_KEY];
  return isRetryHeld(metadata) && typeof value === 'string' && !isTruthyMeta(value) ? value : null;
}

/** May `agentId` release this hold? Only the run that armed it, or anyone when the marker carries no id (legacy). The orphan sweep deliberately does NOT consult this: the armer is gone by then. */
export function isRetryHoldOwner(metadata, agentId) {
  if (!isRetryHeld(metadata)) return false;
  const value = metadata[RETRY_HOLD_KEY];
  if (isTruthyMeta(value)) return true;
  return !!agentId && value === agentId;
}

/** A hold nobody will release: the arming process died before cleanup finished. An unparseable/missing timestamp counts as stale (the marker is the evidence, the timestamp only a liveness hint; an undatable hold must not strand the task). */
export function isStaleRetryHold(metadata, now = Date.now(), graceMs = RETRY_HOLD_GRACE_MS) {
  if (!isRetryHeld(metadata)) return false;
  const since = Date.parse(metadata?.[RETRY_HOLD_SINCE_KEY] ?? '');
  if (!Number.isFinite(since)) return true;
  return now - since >= graceMs;
}

/** Repository verification owns these tasks across completion and restarts. */
export const isDeliveryCleanupHeld = metadata => metadata?.deliveryRecovery === 'cleanup'
  && typeof metadata.deliveryRecoveryAgentId === 'string' && metadata.deliveryRecoveryAgentId.length > 0;

/** Extract the protected cleanup/retry owner ids from tasks. Only active (`in_progress`) metadata counts (historical flags on completed results don't establish ownership); `hasUnattributedRetryHold` is true when any carries a legacy boolean hold, which could belong to any completed run until resolved. */
export function collectProtectedCleanupOwners(tasks) {
  const ownerIds = new Set();
  let hasUnattributedRetryHold = false;
  for (const task of tasks || []) {
    if (task?.status !== 'in_progress') continue;
    const meta = task.metadata;
    if (isDeliveryCleanupHeld(meta)) ownerIds.add(meta.deliveryRecoveryAgentId);
    if (isRetryHeld(meta)) {
      const holder = retryHoldOwnerId(meta);
      if (holder) ownerIds.add(holder);
      else if (isTruthyMeta(meta[RETRY_HOLD_KEY])) hasUnattributedRetryHold = true;
    }
  }
  return {
    ownerIds,
    hasUnattributedRetryHold,
    isProtected: agentId => Boolean(agentId) && (hasUnattributedRetryHold || ownerIds.has(agentId)),
  };
}
