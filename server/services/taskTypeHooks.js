/**
 * Programmatic-I/O hooks per scheduled task type.
 *
 * Most scheduled task types are `prompt → agent → wait for the .agent-done
 * sentinel`. A few need PROGRAMMATIC steps around the agent. A hook module may
 * export either or both of:
 *
 *   - `buildTaskInput({ app, taskType, ignoreTaskId })` — runs BEFORE spawn, inside
 *     the task generator. Collects data beyond the base prompt (telemetry, open
 *     issues, …) and returns `{ prompt?, providerId?, model?, hookMetadata?, skip? }`.
 *     `ignoreTaskId` is set on the drain-on-completion refill and names the task
 *     that just finished but is still `in_progress` on disk — a hook that counts
 *     in-flight work must exclude it:
 *       • `prompt`     — a fully-rendered prompt that REPLACES the template.
 *       • `providerId` / `model` — pin the agent's provider/model (per-app choice).
 *       • `hookMetadata` — a free-form bag merged into the task's persisted
 *         `metadata`, so a value resolved pre-agent survives to `processTaskOutput`.
 *         The generator applies it only AFTER every gate that can still skip task
 *         creation has passed, so a hook can safely defer a side effect until the
 *         task really exists (a spend ledger, say — #3179) instead of
 *         performing it speculatively here. Untyped by design — a passthrough, not
 *         a schema; keep the keys namespaced to the task type. A key that collides
 *         with generator-computed metadata is DROPPED with a warning, so the bag
 *         can't overwrite `analysisType`, provider pins, or plan ids.
 *       • `skip: { reason }` — short-circuit: no agent is spawned.
 *
 *   - `processTaskOutput({ appId, success, payload, workspacePath, agentId, task }, deps?)`
 *     — runs AFTER the agent finishes, from the finalize chokepoint. `payload` is
 *     the parsed `.agent-done` sentinel payload (the agent's structured output);
 *     the hook does deterministic work on it (e.g. filing a tracker issue) and
 *     returns an outcome. `deps` is an injectable seam for tests.
 *
 * The agent itself runs through the NORMAL path (visible in the CoS queue +
 * Active Agents, TUI-capable), so a programmatic-I/O task differs from any other
 * scheduled task only in these two slots. See
 * docs/plans/2026-07-09-programmatic-io-scheduled-tasks.md.
 *
 * Hook modules are lazy-imported (their dependency graphs are heavy) and resolved
 * by task type. `HOOK_MODULES` is the single registration point; a new
 * programmatic-I/O task type adds one entry here plus a module that exports the
 * hook(s) above. The resolvers return `null` for any unregistered type without
 * importing anything, so a normal task type pays ~zero cost.
 */

import { isFalsyMeta } from './agentState.js';
import { TRACKER_FILING_TASK_TYPES } from '../lib/workTracker.js';

// taskType → () => import('./path/to/hookModule.js'). A module may export either
// or both hooks; a missing export means "no hook of that kind for this type".
const HOOK_MODULES = {
  'layered-intelligence': () => import('./autonomousJobs/layeredIntelligenceHooks.js'),
};
const PAYLOAD_OPTIONAL_OUTPUT_HOOKS = new Set();

async function loadHookModule(taskType) {
  if (!isProgrammaticIoTaskType(taskType)) return null;
  return HOOK_MODULES[taskType]();
}

/**
 * Whether a task type routes through the programmatic-I/O path — i.e. its real
 * output is the `.agent-done` sentinel an output hook consumes, NOT a
 * `[task-<id>]` commit. Synchronous and import-free (a bare registry lookup), so
 * it is safe to consult from hot paths like the agent finalize chain.
 *
 * This is what tells success-criteria validation that the commit criterion does
 * not apply to these tasks (see evaluateSuccessCriteria): their prompts
 * explicitly FORBID committing, so checking for a commit would mark every
 * correct run a failure. `Object.hasOwn` — not a truthiness check — so an
 * inherited key like 'constructor' can't masquerade as a registered type.
 */
export function isProgrammaticIoTaskType(taskType) {
  return typeof taskType === 'string' && Object.hasOwn(HOOK_MODULES, taskType);
}

/**
 * Whether recovery may safely run this output hook when its worktree/sentinel
 * no longer exists. Payload-dependent hooks must wait for a real sentinel
 * rather than treating recovery's missing output as an agent-produced empty
 * response.
 */
export function canRunTaskOutputHookWithoutPayload(taskType) {
  return PAYLOAD_OPTIONAL_OUTPUT_HOOKS.has(taskType);
}

/**
 * The task type a hook is keyed on, for a task record. The SCHEDULED type lives in
 * `metadata.analysisType` (the top-level `task.taskType` is the CoS queue category,
 * e.g. 'internal'), falling back to `taskType` for a task shaped the other way.
 *
 * Single resolver on purpose (#2727): "does this task get the programmatic-I/O
 * success criterion?" and "does this task run an output hook?" must be the same
 * question. When they diverged, a task carrying only `taskType:
 * 'layered-intelligence'` ran the hook but was still commit-checked — the exact
 * #2700 bug, one shape over.
 */
export function resolveTaskHookType(task) {
  return task?.metadata?.analysisType || task?.taskType || null;
}

/**
 * Scheduled COORDINATOR task types whose deliverable is a git/gh/external side effect —
 * a merged PR, a resolved conflict, a deleted branch, healed issue state, a status report
 * posted to Jira — NOT a `[task-<id>]` commit. Their agent runs in the app's LIVE checkout
 * (no worktree, no PR), so they DO have a workspacePath at finalize, and the `[task-<id>]`
 * commit criterion would score every SUCCESSFUL run as a failure and pin their learning
 * bucket at ~0% (#2696). They declare no commit criterion (fall back to the exit code),
 * exactly like pipeline/media jobs.
 *
 * Deliberately NOT every self-improvement type: accessibility / security / code-quality
 * / plan-task / claim-issue / claim-work / jira-sprint-manager / do-replan all COMMIT
 * (fixing tasks, /claim flows, or a triage that commits PLAN.md), so their commit
 * criterion is real and must stay — exempting them would MASK genuine failures. Only
 * complete tasks whose DEFAULT contract is structurally no-commit belong here.
 *
 * pr-watcher is intentionally excluded on a different axis: it is a review-of-others'-PRs
 * TEMPLATE — its shipped prompt explicitly says "the operator customizes this prompt to
 * change what happens on each opened PR" (and it ships `readOnly:false`), i.e. it is
 * designed to be rewritten, commonly into a commit-pushing flow, so a type-level exemption
 * would be the wrong default for it. The four types here are complete tasks that finish
 * YOUR in-flight work via a git/gh/API side effect. CAVEAT: the exemption keys on the
 * SCHEDULED TYPE, not the actual per-install prompt, so an operator who rewrites one of
 * these four prompts to make source commits would have that customized run judged by exit
 * code instead of its commit (a telemetry-accuracy tradeoff, not a functional bug). A
 * per-task `noCommitCriterion` contract would remove that caveat but complicates the
 * migration's static type→bucket mapping; deferred as not worth it for the default case.
 *
 * Kept as a leaf so both agentLifecycle (the live criterion) and taskLearning's history
 * backfill (migration-durability) read ONE source of truth. Migration 198 purges the
 * buckets these already poisoned on existing installs.
 */
export const NON_COMMITTING_COORDINATOR_TASK_TYPES = new Set([
  'branch-reconcile', 'issue-reconcile', 'branch-cleanup', 'jira-status-report',
]);

/**
 * Whether a task declares NO `[task-<id>]` commit criterion because it is a gh/git
 * coordinator (see NON_COMMITTING_COORDINATOR_TASK_TYPES).
 *
 * Resolves the type the SAME way extractTaskType (taskLearning/store.js) computes the
 * learning bucket — `metadata.analysisType || metadata.taskAnalysisType || taskType` — NOT
 * via resolveTaskHookType (which reads only `analysisType`). This matters for the archived
 * agent shape: a LIVE queue task carries `metadata.analysisType`, but agentLifecycle stamps
 * the run's type onto the AGENT record as `metadata.taskAnalysisType` (agentLifecycle.js),
 * and that archived form is exactly what the history backfill re-processes. Keying on
 * `analysisType` alone made this predicate DISAGREE with the bucket for archived agents, so
 * the backfill sanitizer skipped them and the migration's purge could be undone (#2696,
 * codex review). Matching extractTaskType keeps the criterion, the bucket, and the sanitizer
 * consistent across both task shapes.
 *
 * PR follow-ups (`metadata.reviewLoopFollowUp`, spawned by agentWorktreeCleanup)
 * are the same shape without being a scheduled type: they deliver a reviewed
 * and/or merged PR as a side effect, and the happy path makes NO commit at all —
 * a merge-only follow-up on an already-green PR just merges it, and even a review
 * follow-up commits nothing when every reviewer comes back clean. Commit-checking
 * them would record each successful run as a failure, the #2696 artifact again.
 */
export function isNonCommittingCoordinatorTask(task) {
  if (task?.metadata?.reviewLoopFollowUp === true || task?.metadata?.reviewLoopFollowUp === 'true') return true;
  const type = task?.metadata?.analysisType || task?.metadata?.taskAnalysisType || task?.taskType || null;
  return NON_COMMITTING_COORDINATOR_TASK_TYPES.has(type);
}

/**
 * Whether a task declares NO `[task-<id>]` commit criterion: the static
 * coordinator set above, OR a TRACKER-FILING task whose dispatch derived
 * `worktreeChangesExpected: false` (cosTaskGenerator.js#resolveTrackerFilingBlock,
 * referenceRepos.js#triggerReferenceAnalysis).
 *
 * A type-keyed set alone cannot express the tracker-filing shape: the SAME task
 * type legitimately commits on a `plan`-tracker app (it appends + commits
 * PLAN.md checklist items) and legitimately commits NOTHING on a
 * github/gitlab/jira app (it files issues/tickets out of band). Reading the
 * already-derived per-task flag gets both right, and retro-fixes the same latent
 * #2696-class artifact `reference-watch` has on non-`plan` trackers today —
 * every successful run scoring as a failure and pinning the type's learning
 * bucket at ~0% (#3273).
 *
 * The flag alone is NOT sufficient, hence the type gate in front of it:
 * `worktreeChangesExpected` is a user-settable per-app taskMetadata override
 * accepted for EVERY task type (`cosValidation.js` ALLOWED keys → `POST
 * /api/apps/:id/task-types` → merged into `metadata` in
 * cosTaskGenerator.js#generateManagedAppImprovementTaskForType). It exists to
 * opt a run out of the TUI idle-complete clean-tree gate; someone setting it
 * there is not asking to disable success validation. Ungated, a `security` task
 * carrying it would exit 0 having committed nothing and be recorded as a pass
 * instead of the honest miss it is.
 *
 * Accepts the `'false'` string form for parity with the spawn-side gate
 * (agentTuiSpawning.js's `isFalsyMeta`), since task metadata round-trips through
 * TASKS.md as text. `true`/absent falls through to the commit check unchanged.
 */
export function declaresNoCommitCriterion(task) {
  if (isNonCommittingCoordinatorTask(task)) return true;
  // Resolved the same way isNonCommittingCoordinatorTask (and the learning
  // bucket) resolves it, so a LIVE queue task (`analysisType`) and the archived
  // agent projection (`taskAnalysisType`) agree.
  const type = task?.metadata?.analysisType || task?.metadata?.taskAnalysisType || task?.taskType || null;
  if (!TRACKER_FILING_TASK_TYPES.has(type)) return false;
  return isFalsyMeta(task?.metadata?.worktreeChangesExpected);
}

/**
 * Resolve the pre-agent input hook for a task type, or null if it has none.
 * `buildTaskInput({ app, taskType })` → `{ prompt?, providerId?, model?, hookMetadata?, skip? }`
 * (see the module header for each field's contract).
 */
export async function getTaskInputHook(taskType) {
  const mod = await loadHookModule(taskType);
  return mod && typeof mod.buildTaskInput === 'function' ? mod.buildTaskInput : null;
}

/**
 * Resolve the post-agent output hook for a task type, or null if it has none.
 * `processTaskOutput({ appId, success, payload, workspacePath, agentId, task })` → outcome.
 */
export async function getTaskOutputHook(taskType) {
  const mod = await loadHookModule(taskType);
  return mod && typeof mod.processTaskOutput === 'function' ? mod.processTaskOutput : null;
}
