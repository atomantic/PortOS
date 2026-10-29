import { isTruthyMeta } from './metadataFlags.js';
/**
 * Retry hold — the intermediate task state between a failed run's verdict and the
 * resume pointer its retry needs (#3373).
 *
 * A non-actionable failure under the retry budget used to flip the task straight
 * back to `pending` inside `finalizeAgent`, while the pointer that lets the retry
 * adopt the branch cleanup preserved is only resolvable AFTER `cleanupAgentWorktree`
 * has decided what survived — hundreds of milliseconds to seconds later. In that
 * window the task is an ordinary `pending` candidate, so the dequeue that
 * `agent:completed` schedules could claim it and start from scratch on a clean
 * worktree, redoing work sitting on the preserved branch. Worse, the retry then
 * holds the task `in_progress`, so the pointer write's own status gate declines and
 * the pointer is dropped for good.
 *
 * The fix is a HOLD: the failure verdict leaves the task `in_progress` (no dequeue
 * tier looks at `in_progress`, and `spawnAgentForTask` rejects it) carrying the
 * marker below, and the post-cleanup write flips it to `pending` WITH the resume
 * metadata in a single `updateTask`. The task is never both spawnable and pointerless.
 *
 * The marker is persisted task metadata, so a process killed mid-transition leaves
 * evidence on disk: `handleOrphanedTask` recognizes a held task and completes the
 * transition (resolve pointer → flip to `pending` → clear the marker) instead of
 * treating it as a fresh orphan.
 *
 * Pure and dependency-free so the writer (agentErrorAnalysis), the releaser
 * (agentWorktreeCleanup) and the recovery sweep (agentManagement / cos) share ONE
 * definition of the state rather than three string literals.
 */

/**
 * How long a hold is treated as LIVE — i.e. some in-process cleanup is presumed to
 * still be running and about to release it. The orphan sweep only recovers a hold
 * older than this, so it can't steal a task out from under a cleanup that is simply
 * slow (a merge + push + PR probe). Comfortably longer than any real cleanup and
 * shorter than nothing that matters: the sweep itself only runs every 15 minutes,
 * so a crash costs at most one sweep interval before recovery.
 */
export const RETRY_HOLD_GRACE_MS = 10 * 60 * 1000;

/** Metadata keys that carry the hold. Exported for tests and greppability. */
export const RETRY_HOLD_KEY = 'retryPendingCleanup';
export const RETRY_HOLD_SINCE_KEY = 'retryPendingSince';

/**
 * The metadata patch that ARMS the hold, merged into the failure verdict's own
 * `updateTask` so the task never exists in a spawnable-but-pointerless state.
 *
 * The marker VALUE is the id of the run that armed it, not a bare `true`, so the
 * release is owner-scoped: a slow cleanup from attempt A that lands after attempt
 * B has already failed and armed its own hold must not clear B's hold, overwrite
 * B's pointer, or make the task spawnable while B's cleanup is still running.
 * A hold with no id (`true`) is a legacy/unattributed shape any releaser may clear.
 */
export function retryHoldMetadata(agentId, now = Date.now()) {
  return {
    [RETRY_HOLD_KEY]: agentId || true,
    [RETRY_HOLD_SINCE_KEY]: new Date(now).toISOString(),
  };
}

/**
 * The metadata patch that RELEASES the hold. `undefined` (not `null`) because
 * `updateTask` deletes undefined keys from the merged metadata, whereas a null
 * survives the merge and stays on the in-memory task for the rest of the tick.
 * (The markdown store no longer persists either one — generateTasksMarkdown
 * drops nullish values rather than writing the literal word `null` — but the
 * `!== 'null'` guards below stay for task files an older install already wrote.)
 */
export function clearedRetryHoldMetadata() {
  return {
    [RETRY_HOLD_KEY]: undefined,
    [RETRY_HOLD_SINCE_KEY]: undefined,
  };
}

/**
 * Is this task held pending its resume-pointer write? The marker is an agent id,
 * or `true` for the legacy/unattributed shape — and the markdown round-trip turns
 * both booleans into strings, so `'false'`/`'null'` must read as NOT held.
 */
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

/**
 * May `agentId` release this hold? Only the run that armed it — or anyone, when
 * the marker carries no id (legacy shape). The orphan sweep deliberately does NOT
 * consult this: whoever armed the hold is gone by the time it looks.
 */
export function isRetryHoldOwner(metadata, agentId) {
  if (!isRetryHeld(metadata)) return false;
  const value = metadata[RETRY_HOLD_KEY];
  if (isTruthyMeta(value)) return true;
  return !!agentId && value === agentId;
}

/**
 * A hold nobody is going to release — the process that armed it died before its
 * cleanup finished. An unparseable or missing timestamp counts as stale: the marker
 * is the evidence, the timestamp is only the liveness hint, and a hold we can't date
 * must not strand the task forever.
 */
export function isStaleRetryHold(metadata, now = Date.now(), graceMs = RETRY_HOLD_GRACE_MS) {
  if (!isRetryHeld(metadata)) return false;
  const since = Date.parse(metadata?.[RETRY_HOLD_SINCE_KEY] ?? '');
  if (!Number.isFinite(since)) return true;
  return now - since >= graceMs;
}

/** Repository verification owns these tasks across completion and restarts. */
export const isDeliveryCleanupHeld = metadata => metadata?.deliveryRecovery === 'cleanup'
  && typeof metadata.deliveryRecoveryAgentId === 'string' && metadata.deliveryRecoveryAgentId.length > 0;

/**
 * Extract the protected cleanup/retry owner ids from a list of tasks.
 * Only active (`in_progress`) task metadata counts; historical flags on
 * completed agent results do not establish current ownership.
 * `hasUnattributedRetryHold` is true when any `in_progress` task carries a
 * legacy boolean retry hold (`retryPendingCleanup: true`), which could belong
 * to any completed run until the hold is resolved.
 */
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
