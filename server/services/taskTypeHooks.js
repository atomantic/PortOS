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
 *   - `isTaskOutputPayload(payload)` — pure shape check for that hook's own
 *     deliverable. Optional, but a type that omits it forfeits the transcript
 *     rescue for a payload the model printed instead of writing (#3640).
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

import { isFalsyMeta, isTruthyMeta } from './agentState.js';
import { TRACKER_FILING_TASK_TYPES, CONCRETE_WORK_TRACKERS } from '../lib/workTracker.js';
import { isAuditTaskType } from '../lib/auditCatalog.js';

// taskType → { load }. `load` is the module import thunk; a module may export
// either or both hooks, and a missing export means "no hook of that kind for this
// type". Entries stay objects rather than bare thunks so a capability a caller
// must know WITHOUT paying for the import can be declared here, keeping this the
// single registration point (a parallel per-capability list would be free to drift).
const HOOK_MODULES = {
  'layered-intelligence': {
    load: () => import('./autonomousJobs/layeredIntelligenceHooks.js')
  },
};
const PAYLOAD_OPTIONAL_OUTPUT_HOOKS = new Set();

async function loadHookModule(taskType) {
  if (!isProgrammaticIoTaskType(taskType)) return null;
  return HOOK_MODULES[taskType].load();
}

/**
 * Whether a task type routes through the programmatic-I/O path — i.e. its real
 * output is the `.agent-done` sentinel an output hook consumes, NOT a
 * commit. Synchronous and import-free (a bare registry lookup), so
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
 * posted to Jira — NOT a commit. Their agent runs in the app's LIVE checkout
 * (no worktree, no PR), so they DO have a workspacePath at finalize, and the task-id commit
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
 * would be the wrong default for it. The coordinator types here are complete tasks that finish
 * YOUR in-flight work via a git/gh/API side effect. CAVEAT: the exemption keys on the
 * SCHEDULED TYPE, not the actual per-install prompt, so an operator who rewrites one of
 * these coordinator prompts to make source commits would have that customized run judged by exit
 * code instead of its commit (a telemetry-accuracy tradeoff, not a functional bug). A
 * per-task `noCommitCriterion` contract would remove that caveat but complicates the
 * migration's static type→bucket mapping; deferred as not worth it for the default case.
 *
 * Kept as a leaf so both agentLifecycle (the live criterion) and taskLearning's history
 * backfill (migration-durability) read ONE source of truth. Migration 198 purges the
 * buckets these already poisoned on existing installs.
 */
export const NON_COMMITTING_COORDINATOR_TASK_TYPES = new Set([
  'branch-reconcile', 'issue-reconcile', 'branch-cleanup', 'jira-status-report', 'release-check',
  'stash-cleanup',
]);

/**
 * Whether a task declares NO commit criterion because it is a gh/git
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
 * Whether a task declares NO commit criterion: the static
 * coordinator set above, a NO-CODE-OUTPUT task (its deliverable is an action —
 * an HTTP PATCH, a filed issue — and its prompt never asks for a commit), OR a
 * TRACKER-FILING task whose dispatch derived
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
 * mark a run's deliverable as outside the worktree; someone setting it there is
 * not asking to disable success validation. Ungated, a `security` task
 * carrying it would exit 0 having committed nothing and be recorded as a pass
 * instead of the honest miss it is.
 *
 * Accepts the `'false'` string form for parity with the spawn-side gate
 * (agentTuiSpawning.js's `isFalsyMeta`), since task metadata round-trips through
 * TASKS.md as text. `true`/absent falls through to the commit check unchanged.
 */
export function declaresNoCommitCriterion(task) {
  if (isNonCommittingCoordinatorTask(task)) return true;
  // A discarded worktree cannot leave a commit behind by
  // construction — cleanup removes it without merging, and the prompt forbids
  // committing at all. Scoring the commit check against it marks every
  // SUCCESSFUL run a validation miss and drags that provider/model's learning
  // bucket toward 0% — the #2696/#3273 artifact, arriving by a third route.
  if (isTruthyMeta(task?.metadata?.discardWorktree)) return true;
  // `noCodeOutput` tasks deliver something the agent DOES — an HTTP PATCH, a filed
  // issue, an API call — and their prompt routes through
  // agentPromptBuilder#buildActionOutputCompletionSection, which explicitly does
  // NOT tell them to commit or open a PR. Creative Director tasks are the shipped
  // instance of that shape (their deliverable is `PATCH /api/creative-director/…`),
  // and they run with `useWorktree: false` against the live checkout — so
  // workspacePath IS set and the commit criterion scored every SUCCESSFUL run as a
  // miss, the #2696/#3273 artifact reaching CD by a fourth route (#4146). Resolved
  // exactly as agentPromptBuilder resolves it (flag OR the creativeDirector
  // metadata block) so the criterion and the prompt can't disagree about whether a
  // commit was ever asked for. Their REAL deliverable is verified in the CD
  // completion hook, which is the only place the project record is visible.
  if (isTruthyMeta(task?.metadata?.noCodeOutput) || task?.metadata?.creativeDirector) return true;
  if (!isTrackerFilingDispatch(task)) return false;
  return isFalsyMeta(task?.metadata?.worktreeChangesExpected);
}

/**
 * Whether this task was dispatched by a TRACKER-FILING path — the gate in front
 * of the `worktreeChangesExpected` read above (see that doc comment for why the
 * flag alone is not enough).
 *
 * Two shapes qualify, because tracker-filing runs arrive two ways:
 *
 *   1. A SCHEDULED type in `TRACKER_FILING_PRESETS` (`reference-watch`, `ux`).
 *      Resolved the same way isNonCommittingCoordinatorTask (and the learning
 *      bucket) resolves it, so a LIVE queue task (`analysisType`) and the
 *      archived agent projection (`taskAnalysisType`) agree.
 *   2. A one-off task whose dispatch stamped `metadata.workTracker` — the
 *      concrete tracker the `{trackerInstructions}` block told the agent to file
 *      into. Only a tracker-filing dispatch writes it (repoIntake.js's
 *      `repo-study`, referenceRepos.js#triggerReferenceAnalysis), and it is NOT
 *      in cosValidation's per-app `taskMetadata` ALLOWED keys, so unlike
 *      `worktreeChangesExpected` a user cannot set it on an unrelated task type.
 *
 * Without (2), a hand-queued tracker-filing run could only reach this gate by
 * masquerading as a scheduled type — which would also enroll it in
 * taskSchedule's per-type consecutive-failure ledger (agentFinalization.js) and
 * auto-park a "type" no schedule owns.
 */
function isTrackerFilingDispatch(task) {
  const type = task?.metadata?.analysisType || task?.metadata?.taskAnalysisType || task?.taskType || null;
  // Explicit fileIssues on an audit type wins — including turning ux (which
  // still lives in TRACKER_FILING_TASK_TYPES for back-compat) into do-work.
  if (isTruthyMeta(task?.metadata?.fileIssues)) return true;
  if (isFalsyMeta(task?.metadata?.fileIssues) && isAuditTaskType(type)) return false;
  if (TRACKER_FILING_TASK_TYPES.has(type)) return true;
  return CONCRETE_WORK_TRACKERS.includes(task?.metadata?.workTracker);
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

/**
 * Resolve the hook's own payload SHAPE predicate, or null if it declares none.
 * `isTaskOutputPayload(payload)` → boolean.
 *
 * Only the hook knows what its deliverable looks like, so the transcript rescue
 * in `agentFinalization` (#3640) — which recovers a payload the model printed to
 * the terminal instead of writing to `.agent-done` — asks the hook rather than
 * guessing. A type that exports no predicate simply gets no rescue: without a
 * shape to check against, any JSON-ish blob in the transcript would qualify.
 */
export async function getTaskOutputPayloadPredicate(taskType) {
  const mod = await loadHookModule(taskType);
  return mod && typeof mod.isTaskOutputPayload === 'function' ? mod.isTaskOutputPayload : null;
}
