/**
 * Programmatic-I/O hooks per scheduled task type.
 *
 * A hook module may export `buildTaskInput({ app, taskType, ignoreTaskId })`
 * (pre-spawn; returns `{ prompt?, providerId?, model?, hookMetadata?, skip? }`),
 * `processTaskOutput({ appId, success, payload, workspacePath, agentId, task }, deps?)`
 * (post-agent, on the parsed `.agent-done` payload) and `isTaskOutputPayload(payload)`
 * (shape check enabling the transcript rescue, #3640).
 *
 * `ignoreTaskId` is the just-finished, still `in_progress` task on a drain refill;
 * hooks counting in-flight work must exclude it. `hookMetadata` merges into task
 * `metadata` only after every skip gate passed, so defer side effects to it; keys
 * colliding with generator-computed metadata are dropped with a warning.
 *
 * `HOOK_MODULES` is the single registration point (lazy imports); `input: false`
 * marks input owned by an earlier coordinator phase. See
 * docs/plans/archive/2026-07-09-programmatic-io-scheduled-tasks.md.
 */

import { isFalsyMeta, isTruthyMeta } from './agent/agentState.js';
import { TRACKER_FILING_TASK_TYPES, CONCRETE_WORK_TRACKERS } from '../lib/workTracker.js';
import { isAuditTaskType } from '../lib/auditCatalog.js';
import { hasClaimFlowContract } from '../lib/claimFlowTaskTypes.js';

// Objects, not bare thunks, so import-free capabilities (`input: false`) live here.
const HOOK_MODULES = {
  'private-security-assessment': { load: () => import('./privateSecurityAssessment.js') },
  'issue-watcher': {
    load: () => import('./issueWatcher.js')
  },
  // No live gather hook: only the preflight's fingerprinted snapshot may enter.
  'pr-reviewer': {
    load: () => import('./prReviewerPipeline.js'),
    input: false,
  },
  'layered-intelligence': {
    load: () => import('./autonomousJobs/layeredIntelligenceHooks.js')
  },
  // buildTaskInput only: skips on an empty ledger; registering exempts the commit criterion.
  'user-action-review': {
    load: () => import('./userActionReviewHooks.js')
  },
  // buildTaskInput only: deterministic triage, always skips (it files separate tasks).
  'error-log-triage': {
    load: () => import('./errorLogTriageHooks.js')
  },
};

async function loadHookModule(taskType) {
  if (!isProgrammaticIoTaskType(taskType)) return null;
  return HOOK_MODULES[taskType].load();
}

/**
 * Whether a type's real output is the `.agent-done` sentinel, not a commit (its
 * prompt forbids committing). Sync and import-free for hot paths; `Object.hasOwn`
 * so 'constructor' can't masquerade as registered.
 */
export function isProgrammaticIoTaskType(taskType) {
  return typeof taskType === 'string' && Object.hasOwn(HOOK_MODULES, taskType);
}

/**
 * Hook key: `metadata.analysisType`, then archived `taskAnalysisType`, then
 * `taskType`. One resolver (#2727) so criterion and output hook can't diverge.
 */
export function resolveTaskHookType(task) {
  return task?.metadata?.analysisType || task?.metadata?.taskAnalysisType || task?.taskType || null;
}

/**
 * Scheduled COORDINATOR types whose deliverable is a git/gh/external side effect,
 * not a commit. A commit criterion would score every successful run a failure and
 * pin the learning bucket at ~0% (#2696); they fall back to the exit code.
 * Types that really commit (security, code-quality, do-replan, ...) must stay out;
 * claim flows use `isClaimFlowDispatch`. The exemption keys on the type, not the
 * per-install prompt. A leaf so agentLifecycle and taskLearning share it.
 */
export const NON_COMMITTING_COORDINATOR_TASK_TYPES = new Set([
  'app-checkout-recovery', 'branch-reconcile', 'issue-reconcile', 'branch-cleanup', 'jira-status-report', 'do-release',
  'stash-cleanup', 'repo-sync', 'pr-reviewer',
  // Pre-rename do-release (migration 417): queued/archived tasks still carry it.
  'release-check',
]);

/**
 * Whether a task declares NO commit criterion as a gh/git coordinator. Resolves
 * the type exactly as extractTaskType (taskLearning/store.js) does, since archived
 * agents carry `metadata.taskAnalysisType` (#2696). PR follow-ups often commit
 * nothing, or commit only to the contributor's branch in a throwaway worktree.
 */
export function isNonCommittingCoordinatorTask(task) {
  if (isTruthyMeta(task?.metadata?.reviewLoopFollowUp)) return true;
  if (isTruthyMeta(task?.metadata?.prRemediationFollowUp)) return true;
  const type = task?.metadata?.analysisType || task?.metadata?.taskAnalysisType || task?.taskType || null;
  return NON_COMMITTING_COORDINATOR_TASK_TYPES.has(type);
}

/**
 * Whether a task runs a CLAIM flow whose prompt owns its own claim/<item> worktree.
 * Its commit lands outside the workspace the commit probe checks, so a declared
 * `validationPassed: false` would override the exit code (#2696); goal-fidelity
 * still reviews it. The explicit `claimFlow` marker covers older queued schedules.
 */
export function isClaimFlowDispatch(task) {
  return hasClaimFlowContract(task);
}

/**
 * Whether a task declares NO commit criterion: coordinator, no-code-output, or a
 * tracker-filing dispatch with `worktreeChangesExpected: false` (#3273). The same
 * type commits on a `plan`-tracker app but files issues elsewhere, so a type set
 * can't express it. The type gate is needed because that flag is a user-settable
 * per-app override accepted for every type. Accepts the `'false'` string form.
 */
export function declaresNoCommitCriterion(task) {
  if (isNonCommittingCoordinatorTask(task)) return true;
  // A discarded worktree never keeps a commit and its prompt forbids committing.
  if (isTruthyMeta(task?.metadata?.discardWorktree)) return true;
  // `noCodeOutput` tasks (e.g. Creative Director, #4146) deliver an action, not a
  // commit; resolved as agentPromptBuilder does so criterion and prompt agree.
  if (isTruthyMeta(task?.metadata?.noCodeOutput) || task?.metadata?.creativeDirector) return true;
  if (!isTrackerFilingDispatch(task)) return false;
  return isFalsyMeta(task?.metadata?.worktreeChangesExpected);
}

/**
 * Whether this task was dispatched by a TRACKER-FILING path: a SCHEDULED type in
 * `TRACKER_FILING_PRESETS`, or a one-off task whose dispatch stamped
 * `metadata.workTracker` (not user-settable per app, so a hand-queued run needn't
 * masquerade as a scheduled type and enroll in taskSchedule's failure ledger).
 */
function isTrackerFilingDispatch(task) {
  const type = task?.metadata?.analysisType || task?.metadata?.taskAnalysisType || task?.taskType || null;
  // Explicit fileIssues on an audit type wins (even turning ux into do-work).
  if (isTruthyMeta(task?.metadata?.fileIssues)) return true;
  if (isFalsyMeta(task?.metadata?.fileIssues) && isAuditTaskType(type)) return false;
  if (TRACKER_FILING_TASK_TYPES.has(type)) return true;
  return CONCRETE_WORK_TRACKERS.includes(task?.metadata?.workTracker);
}

/** Resolve the pre-agent `buildTaskInput` hook for a task type, or null. */
export async function getTaskInputHook(taskType) {
  if (HOOK_MODULES[taskType]?.input === false) return null;
  const mod = await loadHookModule(taskType);
  return mod && typeof mod.buildTaskInput === 'function' ? mod.buildTaskInput : null;
}

/** Resolve the post-agent `processTaskOutput` hook for a task type, or null. */
export async function getTaskOutputHook(taskType) {
  const mod = await loadHookModule(taskType);
  return mod && typeof mod.processTaskOutput === 'function' ? mod.processTaskOutput : null;
}

/**
 * Resolve the hook's own payload SHAPE predicate, or null. Only the hook knows
 * its deliverable's shape; the transcript rescue in `agentFinalization` (#3640)
 * asks it, and a type without one gets no rescue.
 */
export async function getTaskOutputPayloadPredicate(taskType) {
  const mod = await loadHookModule(taskType);
  return mod && typeof mod.isTaskOutputPayload === 'function' ? mod.isTaskOutputPayload : null;
}
