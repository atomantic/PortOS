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
 */
export function retryHoldMetadata(now = Date.now()) {
  return {
    [RETRY_HOLD_KEY]: true,
    [RETRY_HOLD_SINCE_KEY]: new Date(now).toISOString(),
  };
}

/**
 * The metadata patch that RELEASES the hold. `undefined` (not `null`) because
 * `updateTask` deletes undefined keys from the merged metadata, whereas a null
 * survives the merge and is serialized into TASKS.md as the literal string
 * `"null"` — which would read back as a live marker.
 */
export function clearedRetryHoldMetadata() {
  return {
    [RETRY_HOLD_KEY]: undefined,
    [RETRY_HOLD_SINCE_KEY]: undefined,
  };
}

/**
 * Is this task held pending its resume-pointer write? Accepts the markdown
 * round-trip (`true` comes back as the string `'true'`), same as `isTruthyMeta`.
 */
export function isRetryHeld(metadata) {
  const value = metadata?.[RETRY_HOLD_KEY];
  return value === true || value === 'true';
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
