/**
 * User-pause hold — the bookkeeping a `pauseAgent` stamps onto the paused agent's
 * task, and the single definition of when that pause is still live.
 *
 * A pause parks a task in `blocked` under the `agent-paused` category plus a small
 * set of pointer keys naming the run that parked it. Three parties read that state
 * and they must not drift into three different literals:
 *
 *  - the WRITER (`pauseAgent` → `markPausedTask`, agentManagement.js),
 *  - the READER (`resumeAgent`, which requeues only the task ITS pause parked),
 *  - and the CLEARER — `updateTask` (cosTaskStore.js), which drops the whole set
 *    the moment the task leaves `blocked` by ANY path.
 *
 * That last one is why this is a hold and not a pair of ad-hoc literals. `resumeAgent`
 * is not the only way a paused task runs again: a dedupe revive, an autopilot
 * re-dispatch, an orphan-cooldown expiry, or a human unblocking it from the task list
 * all flip it back to `pending`. Before the clear moved into `updateTask`, every one
 * of those left `pausedAt`/`pausedAgentId` behind on a task that was running again —
 * so the UI kept showing a live pause, and the paused agent record sat next to it with
 * nothing left to resume.
 *
 * Pure and dependency-free so the writer, the reader, and the clearer share ONE
 * definition. Mirrors `taskRetryHold.js`, the same shape for the retry hold.
 */

/**
 * The `blockedCategory` a user pause stamps. Proves a blocked task is parked by a
 * pause rather than finished with — the failure reaper exempts it, and `resumeAgent`
 * requires it before requeueing in place.
 */
export const AGENT_PAUSED_CATEGORY = 'agent-paused';

/**
 * Every metadata key the pause writes. Listed once so the arm and the clear can't
 * drift — a key added to `pauseMetadata` that the clear doesn't know about outlives
 * the pause it belongs to.
 */
export const PAUSE_METADATA_KEYS = ['pausedAt', 'pausedAgentId', 'resumeWorkspacePath', 'resumeRunId'];

/**
 * The metadata patch that ARMS the hold, merged into the pause's own `updateTask`
 * alongside the blocked status. `resumeWorkspacePath`/`resumeRunId` are omitted when
 * the run had neither, rather than written as null — an absent key is absence, and a
 * null would serialize into TASKS.md as the literal string `"null"`.
 */
export function pauseMetadata({ agentId, pausedAt, workspacePath, runId }) {
  return {
    pausedAt,
    pausedAgentId: agentId,
    ...(workspacePath ? { resumeWorkspacePath: workspacePath } : {}),
    ...(runId ? { resumeRunId: runId } : {}),
  };
}

/**
 * The metadata patch that RELEASES the hold. `undefined` (not `null`) because
 * `updateTask` DELETES undefined keys from the merged metadata, whereas a null
 * survives the merge and TASKS.md serializes it as the literal string `"null"` —
 * which reads back as a live pause.
 */
export function clearedPauseMetadata() {
  return Object.fromEntries(PAUSE_METADATA_KEYS.map(key => [key, undefined]));
}

/** Is this task parked by a user pause right now? */
export function isAgentPausedTask(task) {
  return task?.status === 'blocked' && task?.metadata?.blockedCategory === AGENT_PAUSED_CATEGORY;
}

/**
 * Is this task the one `agentId`'s pause parked, still waiting to be resumed?
 *
 * Anything else — the user re-ran it, it was revived and completed, a DIFFERENT
 * agent has since paused it — means this pause is spent, and requeueing the task on
 * its behalf would stomp whatever happened after.
 */
export function isResumablePausedTask(task, agentId) {
  return isAgentPausedTask(task) && !!agentId && task.metadata?.pausedAgentId === agentId;
}

// === Pause-release adapter (registration-based) ============================
//
// Releasing the hold is not only a metadata clear (#3730). The run that paused
// left a branch and often a worktree behind, and the resumed run has to be POINTED
// at them or it starts clean and redoes the work — the exact symptom the resume fix
// removed for the Resume dialog and nowhere else. Resolving that pointer needs the
// paused agent's RECORD, which lives in the agent graph; `cosTaskStore.js` cannot
// import it (static cycle, see `services/agentImportCycles.test.js`). So the
// agent-addressed half is injected: `agentManagement.js` registers it at module
// load, the way `services/sharing/recordEvents.js` registers its subscription
// adapter. Until registration every call is a silent no-op — which is what the task
// store's own unit suites want: no agent graph pulled in, nothing to mock.

let pauseReleaseAdapter = null;

/** `agentManagement.js` registers the real implementation at module load. */
export function registerPauseReleaseAdapter(adapter) {
  pauseReleaseAdapter = adapter;
}

/** Whether the agent-side half is wired. */
export function hasPauseReleaseAdapter() {
  return pauseReleaseAdapter !== null;
}

/** Test-only: detach the adapter so later suites see the unregistered state. */
export function __resetPauseReleaseAdapter() {
  pauseReleaseAdapter = null;
}

/**
 * What did the paused run leave behind? The resume-pointer patch
 * (`existingBranch` / `resumeWorktreePath` / `resumedFromAgentId`) for the agent
 * `task.metadata.pausedAgentId` names, or `{}` when there is nothing to adopt.
 * Awaited BEFORE the task's own write, so the task is never `pending` — and
 * therefore spawnable — without its pointer.
 */
export async function resolvePausedTaskResume(task) {
  return (await pauseReleaseAdapter?.resolvePausedTaskResume?.(task)) || {};
}

/**
 * Retire the paused record now that its task is running again — immediately, rather
 * than leaving it to the next `retireStrandedPausedAgents` sweep, so the paused card
 * disappears when the user un-blocks the task instead of up to a sweep interval
 * later. Called AFTER the task write: retirement emits `agent:completed`, whose
 * handler dequeues, so the task must already be `pending` and pointed first.
 */
export async function retirePausedAgent(agentId, taskId, branchName) {
  return pauseReleaseAdapter?.retirePausedAgent?.(agentId, taskId, branchName);
}
