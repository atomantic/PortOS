/**
 * User-pause hold: the bookkeeping `pauseAgent` stamps onto the paused agent's task and the single definition of when that pause is live.
 *
 * A pause parks a task in `blocked` under `agent-paused` plus pointer keys naming the run; three parties read it: the WRITER (`pauseAgent` → `markPausedTask`, agentManagement.js), the READER (`resumeAgent`, requeueing only the task ITS pause parked), and the CLEARER, `updateTask` (cosTaskStore.js), which drops the whole set when the task leaves `blocked` by ANY path (a dedupe revive, autopilot re-dispatch, orphan-cooldown expiry or human unblock all flip it to `pending`; before the clear moved into `updateTask` they left `pausedAt`/`pausedAgentId` on a running task, so the UI showed a live pause). Pure and dependency-free so all three share ONE definition; mirrors `taskRetryHold.js`.
 */

/** The `blockedCategory` a user pause stamps: proves a blocked task is parked by a pause, not finished (the failure reaper exempts it; `resumeAgent` requires it before requeueing in place). */
export const AGENT_PAUSED_CATEGORY = 'agent-paused';

/** Every metadata key the pause writes, listed once so arm and clear can't drift (a key the clear doesn't know outlives its pause). */
export const PAUSE_METADATA_KEYS = ['pausedAt', 'pausedAgentId', 'resumeWorkspacePath', 'resumeRunId'];

/** The metadata patch that ARMS the hold, merged into the pause's `updateTask`; `resumeWorkspacePath`/`resumeRunId` are omitted when absent, not null (a null serializes into TASKS.md as the string `"null"`). */
export function pauseMetadata({ agentId, pausedAt, workspacePath, runId }) {
  return {
    pausedAt,
    pausedAgentId: agentId,
    ...(workspacePath ? { resumeWorkspacePath: workspacePath } : {}),
    ...(runId ? { resumeRunId: runId } : {}),
  };
}

/** The metadata patch that RELEASES the hold: `undefined` (not `null`) because `updateTask` DELETES undefined keys while a null is stored as a present value. */
export function clearedPauseMetadata() {
  return Object.fromEntries(PAUSE_METADATA_KEYS.map(key => [key, undefined]));
}

/** Is this task parked by a user pause right now? */
export function isAgentPausedTask(task) {
  return task?.status === 'blocked' && task?.metadata?.blockedCategory === AGENT_PAUSED_CATEGORY;
}

/** Is this task the one `agentId`'s pause parked, still awaiting resume? Anything else (re-run, revived and completed, a DIFFERENT agent paused it since) means this pause is spent and requeueing would stomp what followed. */
export function isResumablePausedTask(task, agentId) {
  return isAgentPausedTask(task) && !!agentId && task.metadata?.pausedAgentId === agentId;
}

// === Pause-release adapter (registration-based) ===
// Releasing the hold is more than a metadata clear (#3730): the paused run left a branch and often a worktree, and the resumed run must be POINTED at them or it redoes the work. Resolving the pointer needs the paused agent's RECORD
// in the agent graph, which `cosTaskStore.js` can't import (static cycle, see `server/test/guards/modules/serviceImportCycles.test.js`), so the agent-addressed half is injected: `agentManagement.js` registers it at module load (as `services/sharing/recordEvents.js` does).
// Until registration every call is a silent no-op, which is what the task store's own unit suites want.

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

/** What did the paused run leave behind? The resume-pointer patch (`existingBranch` / `resumeWorktreePath` / `resumedFromAgentId`) for the agent `task.metadata.pausedAgentId` names, or `{}`. Awaited BEFORE the task's own write so the task is never spawnable without its pointer. */
export async function resolvePausedTaskResume(task) {
  return (await pauseReleaseAdapter?.resolvePausedTaskResume?.(task)) || {};
}

/** Retire the paused record now that its task runs again, immediately rather than at the next `retireStrandedPausedAgents` sweep (so the paused card disappears on un-block). Called AFTER the task write: retirement emits `agent:completed`, whose dequeue needs the task already `pending` and pointed. */
export async function retirePausedAgent(agentId, taskId, branchName) {
  return pauseReleaseAdapter?.retirePausedAgent?.(agentId, taskId, branchName);
}
