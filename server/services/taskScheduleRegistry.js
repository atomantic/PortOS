import { PRIVATE_SECURITY_TASK_TYPE, PRIVATE_SECURITY_DELIVERY } from '../lib/privateSecurityPolicy.js';
/**
 * Static task-type registry.
 *
 * This module is deliberately independent of apps.js and persisted schedule state
 * so app configuration can consume task definitions without forming a cycle.
 */

import { BRANCHES_PER_AGENT_MAX, BRANCHES_PER_AGENT_MIN, DEFAULT_REPO_SYNC_VERIFY_MODE, ERROR_LOG_TRIAGE_LIMITS, RELEASE_OPTION_KEYS } from '../lib/cos/cosTaskMetadata.js';
import { isAuditTaskType, } from '../lib/auditCatalog.js';
import { DEFAULT_ISSUE_MIN_AGE_MINUTES } from '../lib/issueClaimEvidence.js';
import { MODEL_ABUSE_GUARD_ID } from '../lib/modelAbuseGuard.js';
import {
  PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
} from '../lib/agent/agentExecutionProfiles.js';
import { INTERVAL_TYPES } from './taskScheduleConstants.js';
import { normalizeAutopilotParams } from '../lib/musicVideo/musicVideoAutonomous.js';

// Programmatic handler types + target-scope vocabulary live in
// `lib/taskTargetScope.js` (see that file for why); re-exported here because
// the on-demand request gate, the global generator, and the schedule UI have
// always read them off the registry.
import {
  isProgrammaticScheduledTaskType,
  PROGRAMMATIC_SCHEDULED_TASK_TYPES,
} from '../lib/taskTargetScope.js';

export { isProgrammaticScheduledTaskType, PROGRAMMATIC_SCHEDULED_TASK_TYPES };

// Keep the public registry export while prompt routing imports the narrow catalog.
import { SELF_IMPROVEMENT_TASK_TYPES } from '../lib/scheduledTaskTypes.js';
export { SELF_IMPROVEMENT_TASK_TYPES };

// Shared taskMetadata posture for the NON-COMMITTING COORDINATOR types
// (NON_COMMITTING_COORDINATOR_TASK_TYPES in taskTypeHooks.js). Each delivers its work as a SIDE EFFECT
// in the app's live checkout (deleted branch, merged PR, relabeled issue, posted report) and produces
// no commit, so two code-shipping criteria must be off or every SUCCESSFUL run is recorded as a failure:
//   * `useWorktree`/`openPR` — explicitly false (not merely absent) so applyAppWorktreeDefault's
//     `=== undefined` checks can't fill them from the app defaults. A worktree would hide sibling refs
//     the reconcile scan must inspect, and the implied PR fails the run at finalize with `pr-missing`.
//     Locked in MANAGED_AGENT_OPTIONS so a per-app override can't re-attach them. `readOnly: true`
//     is NOT a substitute: it gates worktree CREATION but the PR-claim check reads `metadata.openPR`.
//   * `worktreeChangesExpected` — a clean tree IS the success shape here.
// A guard test in taskSchedule.test.js asserts every member of that set carries this posture.
const NON_COMMITTING_COORDINATOR_METADATA = { useWorktree: false, openPR: false, worktreeChangesExpected: false };
// do-release delegates its release lifecycle to the bundled slashdo workflow; the command stays in
// managed metadata so a customized prompt or app override can't fall back to a second, drifting
// implementation. The release options (RELEASE_OPTION_KEYS) are seeded ON and operator-editable,
// globally and per app; each is ON unless explicitly false. `stallNudge: false` because the longest
// quiet stretch is waiting on the release PR's CI, and a nudge made runs quit INCOMPLETE.
const DO_RELEASE_METADATA = {
  ...NON_COMMITTING_COORDINATOR_METADATA,
  slashdoCommand: 'release',
  ...Object.fromEntries(RELEASE_OPTION_KEYS.map((key) => [key, true])),
  stallNudge: false,
};
// Migration 274 removes branch-cleanup from new schedules, but a partially
// upgraded install may still load its stored task before the migration runs.
// Keep its safety posture available without making it a newly-shipped task.
const LEGACY_MANAGED_TASK_METADATA = {
  'branch-cleanup': NON_COMMITTING_COORDINATOR_METADATA
};

// Shared config for code-reviewer-a and code-reviewer-b (two instances for independent provider/model configuration)
const CODE_REVIEWER_INTERVAL = { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, simplify: true, pipeline: { stages: [{ name: 'Codebase Review', promptKey: 'code-reviewer-review', readOnly: true, providerId: null, model: null, precondition: { fileNotExists: 'REVIEW.md' } }, { name: 'Triage & Implement', promptKey: 'code-reviewer-implement', readOnly: false, providerId: null, model: null, precondition: { fileExists: 'REVIEW.md' } }] } } };

/**
 * Default `drainDispatchCap` for the reconcile drains: how many times a perpetual drain may
 * dispatch back-to-back before it is parked regardless of reported progress.
 *
 * The `lastActionableSignature` guard stops a drain only when a full cycle changes NOTHING. It cannot
 * stop one whose set keeps changing without emptying (a branch oscillating between states, a
 * coordinator opening then closing a PR); on 2026-08-12 that shape ran ~40 agents in one night. Past
 * the cap the drain parks until its recheck cadence: a delay, never a dropped item.
 *
 * The count is nearly "consecutive dispatches": every terminal park and manual re-run zero it. A FAILED
 * run neither refills nor parks, so its dispatches carry into the next window, which caps early; that
 * is the safe direction for a runaway guard.
 *
 * The cap is PER TYPE because five would throttle a HEALTHY claim-issue drain. Claim drains ship without
 * the key (absent/`null` ⇒ unbounded; their work-detector's idle park is the only brake); only the
 * reconcile scans carry a number.
 */
export const PERPETUAL_DRAIN_DISPATCH_CAP = 5;
export const DEFAULT_BRANCHES_PER_AGENT = 3;

/**
 * Target scope for a task type — which app (if any) a run must name. The vocabulary lives in
 * `lib/taskTargetScope.js` because `server/lib` may not import upward into `server/services`
 * (`lib/layering.guard.test.js`); re-exported here for registry readers.
 */
export {
  INSTALL_WIDE_TASK_TYPES,
  MANAGED_APP_TARGET_TASK_TYPES,
  requiresInstallWideTarget,
  requiresManagedAppTarget,
} from '../lib/taskTargetScope.js';

// The pr-reviewer pipeline is a trust boundary, not three interchangeable prompt tabs: keep the
// shipped role/profile pairing in one place. Stage 3 is present by default for backwards compatibility
// with the former security → review flow; the schedule UI can remove it for a gate-only run.
export const createPrReviewerDefaultStages = () => ([
  {
    name: 'Security Scan',
    role: 'security',
    promptKey: 'pr-reviewer-security',
    readOnly: true,
    managed: true,
    guardId: MODEL_ABUSE_GUARD_ID,
  },
  {
    name: 'Eligibility Gate',
    role: 'eligibility',
    promptKey: 'pr-reviewer-eligibility',
    readOnly: true,
    useWorktree: true,
    openPR: false,
    simplify: false,
    reviewLoop: false,
    discardWorktree: true,
    noCodeOutput: true,
    managed: true,
    executionProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
  },
  {
    name: 'Code Review & Validated Actions',
    role: 'actions',
    promptKey: 'pr-reviewer-review',
    readOnly: true,
    useWorktree: true,
    openPR: false,
    simplify: false,
    reviewLoop: false,
    discardWorktree: true,
    noCodeOutput: true,
    managed: true,
    executionProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
  },
]);

// Fresh installs expose every task as an enabled manual action: the on-demand type keeps provider work
// silent until the user runs a task, while retaining timing metadata for a later scheduled interval.
// Persisted settings win on load. A `feature` association is code-owned and makes the task invisible
// and non-runnable while that install-wide feature is disabled.
/**
 * The shared shape of an on-demand audit that files issues by default, with open issues + PRs
 * preloaded for dedup. A factory so each type gets its own `taskMetadata`.
 */
const fileIssuesAuditInterval = () => ({
  type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null,
  dataInputs: ['open-issues', 'open-pull-requests'],
  taskMetadata: { fileIssues: true, useWorktree: false, openPR: false },
});

const TASK_INTERVAL_DEFAULTS = {
  [PRIVATE_SECURITY_TASK_TYPE]: { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { ...PRIVATE_SECURITY_DELIVERY } },
  'model-comparison-refresh': { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, worktreeChangesExpected: true } },
  'security':            { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'code-quality':        { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'test-coverage':       { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true } },
  'performance':         { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'accessibility':       { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  // branch-reconcile first removes fully-merged, clean orphaned worktrees and branches, then finishes
  // THIS machine's remaining in-flight LOCAL branches per app (open a PR, resolve conflicts, drive the
  // review loop, auto-merge when green). Detector-driven drain: the generator runs the deterministic
  // reconcile every manual/on-demand dispatch and dispatches the coordinator only while actionable
  // branches remain, then PARKS on the daily recheckCron. The action toggles (cleanupMerged / openPr /
  // resolveConflicts / autoMerge / finishAbandoned) are per-app booleans, each ON unless explicitly
  // false; `finishAbandoned` covers work a dead agent left UNCOMMITTED in its worktree;
  // `reapSuperseded` retires a branch with a fresh SUPERSEDED verdict after writing its recoverable
  // backup. `branchesPerAgent` bounds each coordinator prompt so a backlog drains across agents.
  // useWorktree/openPR are LOCKED off (MANAGED_AGENT_OPTIONS): the coordinator runs in the live
  // checkout to operate on sibling worktrees, and a managed worktree would hide the branches and could
  // trigger cleanupAgentWorktree's auto-merge. On-demand by default: a manual Run is the consent to
  // drive PRs.
  'branch-reconcile':    { type: INTERVAL_TYPES.ON_DEMAND, perpetual: true, enabled: true, providerId: null, model: null, prompt: null, recheckCron: '0 3 * * *', drainDispatchCap: PERPETUAL_DRAIN_DISPATCH_CAP, taskMetadata: { ...NON_COMMITTING_COORDINATOR_METADATA, cleanupMerged: true, reapSuperseded: true, openPr: true, resolveConflicts: true, autoMerge: true, finishAbandoned: true, branchesPerAgent: DEFAULT_BRANCHES_PER_AGENT } },
  // issue-reconcile heals ZOMBIE issues: open + `in-progress` yet with their PR already MERGED and no
  // live claim, so the queue (which skips `in-progress`) never re-picks the remaining scope.
  // Detector-driven drain: the deterministic gh/git scan runs every manual/on-demand dispatch and the
  // coordinator is dispatched only while zombies remain, then PARKS on the daily recheckCron (an hour
  // after branch-reconcile so merged-branch cleanup lands first). The coordinator applies the
  // partial-ship hybrid per zombie (close + file a scoped follow-up when the remainder is separable,
  // else comment "done/remaining" + release the claim). `autoClose` (ON unless explicitly false) is
  // the only per-app toggle: OFF means comment + unlabel only. It works purely over `gh`, so it takes
  // the non-committing-coordinator posture. On-demand: a manual Run is the consent to mutate issues.
  //
  // The same deterministic pre-step unblocks `blocked` issues whose `Blocked by #N` blockers are all
  // closed (blockedIssueReconcile.js); like releaseAbandonedClaims it needs no model and runs every pass.
  'issue-reconcile':     { type: INTERVAL_TYPES.ON_DEMAND, perpetual: true, enabled: true, providerId: null, model: null, prompt: null, recheckCron: '0 4 * * *', drainDispatchCap: PERPETUAL_DRAIN_DISPATCH_CAP, taskMetadata: { ...NON_COMMITTING_COORDINATOR_METADATA, autoClose: true } },
  'console-errors':      { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  // dependency-updates runs package-manager installs, so it ALWAYS gets an isolated CoS worktree with
  // private node_modules (agentWorkspacePrep passes `linkDependencies: false`): in the live checkout
  // `npm install` follows the shared-dependency symlinks and rewrites the running server's
  // node_modules. `useWorktree` is LOCKED (MANAGED_AGENT_OPTIONS). `openPR` is the shipped delivery so
  // CI validates a bump, but the operator may flip it. `noChangeSuccess`: already-current dependencies
  // are the common outcome, an empty branch that is still a success (lib/noChangeCompletion.js).
  'dependency-updates':  { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, noChangeSuccess: true } },
  'documentation':       { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'ui-bugs':             { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'mobile-responsive':   { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  // feature-ideas waits for do-replan so new work is grounded in a fresh PLAN.md.
  'feature-ideas':       { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, runAfter: ['do-replan'], taskMetadata: { useWorktree: true, openPR: true, simplify: true } },
  // plan-task is a strict executor of PLAN.md items — no brainstorm fallback, no runAfter deps. It
  // drives the /claim flow itself (prompt v5+): the agent creates its OWN `claim/<slug>` worktree,
  // opens the PR, merges and cleans up. Both `useWorktree` and `openPR` are OFF on the CoS side:
  //   * `useWorktree: false` — a CoS worktree under `cos/<task>/<agent>` would hide the slug from the
  //     in-flight branch scan AND trigger `cleanupAgentWorktree`'s auto-merge into the source repo's HEAD.
  //   * `openPR: false` — keeps the cos.js "openPR implies useWorktree" invariant from forcing
  //     useWorktree back on; the agent opens and merges its own PR.
  // `claimFlow: true` is the lifecycle marker, separate from `openPR`: it tells prompt/completion
  // handling the claim prompt owns push → PR → review → merge/cleanup, while `openPR` tells CoS whether
  // to provision and publish a managed worktree. Conflating them sent claim agents into the generic
  // commit-only handoff (#4153).
  'plan-task':           { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, claimFlow: true, simplify: true } },
  // claim-issue drives the /claim --issues flow: the agent creates its OWN claim/issue-<num> worktree,
  // opens the PR (Closes #<num>), merges and cleans up. `useWorktree`/`openPR` are OFF for the same
  // reasons as plan-task. `issueAuthorFilter` gates which issues are claimable: 'self' (default, the
  // slashdo `/do:next --self` security boundary) only issues YOU filed; 'collaborators' widens to every
  // account with repo access; 'owner' only the repo owner's; 'any' any open issue.
  // `issueExcludeLabels` (default `[]`) adds labels to skip on top of NON_ACTIONABLE_ISSUE_LABELS
  // (perpetualWork.js), e.g. `good first issue`. `issueMinAgeMinutes` (default 5, 0 = off) skips issues
  // younger than that so a run never snipes one its filer is about to claim; a pinned target ignores
  // it. Per-app overrides via taskTypeOverrides.
  'claim-issue':         { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, claimFlow: true, simplify: true, issueAuthorFilter: 'self', issueExcludeLabels: [], issueMinAgeMinutes: DEFAULT_ISSUE_MIN_AGE_MINUTES } },
  // claim-work is the SINGLE-SOURCE router: one toggle per app that ships the next work item from the
  // app's tracker (app.workTracker, default 'auto' → resolved from the git origin host). At dispatch
  // the generator delegates to the matching prompt body (plan→plan-task, github→claim-issue,
  // gitlab→claim-issue-gitlab, jira→claim-issue-jira, the per-ticket flow, NOT the standalone
  // jira-sprint-manager triage). `useWorktree`/`openPR` are OFF for the same reasons as plan-task.
  // `issueAuthorFilter` / `issueExcludeLabels` apply only for a forge tracker (github/gitlab).
  'claim-work':          { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, claimFlow: true, simplify: true, issueAuthorFilter: 'self', issueExcludeLabels: [], issueMinAgeMinutes: DEFAULT_ISSUE_MIN_AGE_MINUTES } },
  'error-handling':      { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'typing':              { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  // do-release finishes in-flight PRs, merges dependency updates and drives the main → release PR. It
  // must run from the app's live main checkout so its branch/ref checks describe the real release
  // flow; a CoS worktree would hide that checkout.
  'do-release':          { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { ...DO_RELEASE_METADATA } },
  // stash-cleanup triages `git stash list` and drops superseded/stale entries, leaving real unlanded
  // work for the user. It runs in the live checkout (a stash belongs to the checkout it was taken in)
  // and ships no code. On-demand only: there is no useful cadence for a stash the user may not have
  // touched.
  'stash-cleanup':       { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { ...NON_COMMITTING_COORDINATOR_METADATA } },
  // repo-sync sweeps EVERY managed app's checkout in one run. Like stash-cleanup it runs in the live
  // checkouts (branches, stashes and worktrees belong to them) and ships no code. On-demand: a cadence
  // would switch branches under a checkout the user may be in. Every action toggle is ON except
  // `reapRemotes`, which DELETES branches on origin and stays opt-in.
  'repo-sync':           { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { ...NON_COMMITTING_COORDINATOR_METADATA, syncPush: true, syncPull: true, switchDefault: true, cleanupMerged: true, dropStashes: true, reapRemotes: false, verifyMode: DEFAULT_REPO_SYNC_VERIFY_MODE } },
  'pr-reviewer':         { type: INTERVAL_TYPES.ON_DEMAND, intervalMs: 7200000, enabled: true, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { readOnly: true, useWorktree: false, openPR: false, worktreeChangesExpected: false, pipeline: { stages: createPrReviewerDefaultStages() } } },
  'code-reviewer-a':     { ...CODE_REVIEWER_INTERVAL },
  'code-reviewer-b':     { ...CODE_REVIEWER_INTERVAL },
  'jira-sprint-manager': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, weekdaysOnly: true, feature: 'jira', providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, simplify: true } },
  // jira-status-report posts to JIRA and edits nothing in the repo, so it takes the non-committing
  // coordinator posture: `readOnly: true` alone skips worktree creation but leaves `openPR` fillable
  // from `defaultOpenPR`, scoring a posted report as `pr-missing`.
  'jira-status-report':  { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, weekdaysOnly: true, feature: 'jira', providerId: null, model: null, prompt: null, taskMetadata: { ...NON_COMMITTING_COORDINATOR_METADATA, readOnly: true } },
  // do-replan audits PLAN.md after open PRs and stale branches are cleaned up.
  'do-replan':           { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, runAfter: ['pr-reviewer', 'branch-reconcile'], taskMetadata: { useWorktree: true, openPR: true } },
  // Writable: the v4 reference-watch prompt records proposals via the resolved tracker (PLAN.md commits
  // or forge issues), and `readOnly: true` would inject the "do not modify files" guard. Worktree off
  // because the PLAN.md write is small enough to commit in place (mirrors
  // referenceRepos.js#triggerReferenceAnalysis). `readOnly` is coupled to
  // PROMPT_VERSIONS['reference-watch'] (REFERENCE_WATCH_AUDITED_VERSION above); a bump requires
  // re-auditing it, enforced by a guard test in taskSchedule.test.js.
  'reference-watch':     { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { readOnly: false } },
  // ux audits the RUNNING app UI and files tracker issues by default (`fileIssues: true`).
  // `readOnly: false` so the PLAN.md path can commit checklist items / forge paths can create issues.
  // On-demand by default (AI Provider Usage Policy): a manual Run is the consent to a browser-driving
  // LLM run.
  'ux':                  { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false, readOnly: false } },
  'design':                  { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false, readOnly: false } },
  // data-safety / simplify are the scheduled counterparts of the quota-burn
  // `data-safety-audit` and `simplify-audit` presets. New types default to
  // file-issues so an unattended scheduled run doesn't land code. On-demand
  // defaults keep manual filing available without opting into scheduling.
  'data-safety':         { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'simplify':            { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'over-engineering':    { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'module-hygiene':      { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, dataInputs: ['open-issues', 'open-pull-requests'], taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'api-contract':      { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'ui-lifecycle':      { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'observability':     { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'copy':                { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  // The do:better-lens lanes. All file-issues by default (an unattended run
  // must not land a refactor) and on-demand until the user picks a cadence.
  // Open issues + PRs are preloaded so the agent dedups against in-flight
  // work without spending its own forge calls, the way module-hygiene does.
  'better-complexity':          fileIssuesAuditInterval(),
  'better-cognitive-load':      fileIssuesAuditInterval(),
  'better-structural-drift':    fileIssuesAuditInterval(),
  'app-bugs':                   fileIssuesAuditInterval(),
  'better-runtime-safety':      fileIssuesAuditInterval(),
  'better-dependency-freedom':  fileIssuesAuditInterval(),
  'better-test-quality':        fileIssuesAuditInterval(),
  'better-dev-environment':     fileIssuesAuditInterval(),
  // Service and data-platform lenses (see AUDIT_DEFINITIONS). File-issues by
  // default — their findings usually touch production configuration — with
  // open issues + PRs preloaded for dedup like the do:better lanes above.
  'infrastructure':             fileIssuesAuditInterval(),
  'data-integrity':             fileIssuesAuditInterval(),
  'reliability':                fileIssuesAuditInterval(),
  'privacy':                    fileIssuesAuditInterval(),
  'cost-efficiency':            fileIssuesAuditInterval(),
  // Gap lenses the page-walking audits miss: unfinished features and workflows
  // that strand their record between steps. File-issues by default.
  'feature-completeness':       fileIssuesAuditInterval(),
  'workflow-recovery':          fileIssuesAuditInterval(),
  // Executed counterpart of data-safety: scratch-only migrations, restore and
  // boot. File-issues by default; a scratch run never lands code.
  'upgrade-rehearsal':          fileIssuesAuditInterval(),
  // Trusted remediation is separate from external intake. Legacy author
  // filter settings cannot widen this lane into untrusted contributor PRs.
  'pr-watcher':          { type: INTERVAL_TYPES.ON_DEMAND, intervalMs: 1800000, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { prAuthorFilter: 'trusted', readOnly: false } },
  // External issue intake uses screening, a direct tool-free text API, and
  // validated actions. No general CoS agent or checkout is provisioned.
  'issue-watcher':       { type: INTERVAL_TYPES.ON_DEMAND, intervalMs: 1800000, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, readOnly: true, worktreeChangesExpected: false } },
  // plan-feature files a plan, not code — tracker-filing posture mirrors
  // reference-watch: writable (a file-based tracker commits checklist items), no
  // managed worktree, no PR. On-demand by default; when scheduled, weekly (not
  // daily like feature-ideas) so it doesn't flood the tracker with plans.
  // runAfter do-replan so proposals are checked against the freshest available
  // work tracker before a new feature plan is filed.
  'plan-feature':         { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, dataInputs: ['product-requirements', 'project-goals', 'open-issues', 'open-pull-requests', 'closed-unmerged-pull-requests'], runAfter: ['do-replan'], taskMetadata: { useWorktree: false, openPR: false, readOnly: false } },
  // Same tracker-filing posture as plan-feature; the tracker Inventory step already lists issues.
  'media-render-research': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, dataInputs: ['open-pull-requests'], taskMetadata: { useWorktree: false, openPR: false, readOnly: false } },
  // user-action-review proposes automations from the operator-action ledger.
  // fileIssues defaults ON (safer unattended: a filed issue over queued work);
  // flipping it OFF makes the agent queue CoS tasks instead — either way it
  // ships no code of its own (useWorktree/openPR off, like the other
  // file-issues types; dispatch stamps noCodeOutput). On-demand + enabled per
  // the AI-provider policy: a manual Run is the consent for the review's LLM
  // run, and the empty-ledger skip in its buildTaskInput hook keeps an idle
  // install silent. Effectively on-demand-only today: the hook also skips
  // every per-app dispatch (a per-app cadence would queue one identical
  // global-ledger review PER app) and scheduled dispatch has no global lane
  // for install-wide types yet — see #5629.
  'user-action-review':  { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  // error-log-triage (#12851) triages new stderr lines from PortOS's own PM2
  // processes. Off by default the way every shipped task is: ON_DEMAND is never
  // clock-due, so a manual Run or a cadence the user picks is the consent for
  // the investigation agents it files on providerId/model below. The
  // collect/fingerprint/dedupe pass itself makes no provider call, and its
  // buildTaskInput hook never spawns a coordinator agent — hence no prompt.
  // taskMetadata holds the run caps (lib/cos/cosValidation.js clamps them).
  'error-log-triage': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: Object.fromEntries(Object.entries(ERROR_LOG_TRIAGE_LIMITS).map(([key, limit]) => [key, limit.default])) },
  // layered-intelligence is a programmatic-I/O task (agent-backed, hooked). On-demand
  // by default; per-app scheduling (enabled/interval/provider/model) is set in the
  // Intelligence tab and stored on the app's taskTypeOverrides['layered-intelligence'].
  // No `prompt` field — the buildTaskInput hook renders the prompt (no
  // DEFAULT_TASK_PROMPTS entry, so the prompt-version machinery in loadSchedule
  // skips it). taskMetadata pins the throwaway-worktree posture: the reasoning
  // agent runs in a worktree that is discarded without a commit/merge/PR
  // (discardWorktree), so it can't land code — its `.agent-done` payload is the
  // only sanctioned output (consumed by the processTaskOutput hook).
  'layered-intelligence': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: false, discardWorktree: true } },
  // The two PROGRAMMATIC handlers. No `prompt` (PortOS performs the work itself
  // — there is no template to render and no DEFAULT_TASK_PROMPTS entry), and no
  // agent posture keys, because no agent, worktree, or PR is ever involved.
  //
  // `taskMetadata` here is the handler's PARAMS bag, mirroring the catalog row
  // Quota Burn renders its job form from (`QUOTA_BURN_JOB_CATALOG` in
  // lib/quotaBurnConfig.js) so the two doors advertise the same defaults —
  // taskScheduleRegistry.programmatic.test.js fails when they drift. A param
  // whose catalog default is null is OMITTED rather than stored as null:
  // "unset" means the handler resolves it (the image job falls through to the
  // universe-bible render-target ladder), which is not the same as a value.
  //
  // ON_DEMAND with NO interval and NO cron: enabled so the user can press Run
  // Now, never clock-due, so a fresh install spends nothing until they do.
  'development-watchdog': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: null },
  // music-video-autopilot turns one unused Brain idea into a fully autonomous
  // music video per run (lyrics → Suno song → mood board → production). Like
  // the bible handlers it is on-demand until the operator sets a cadence on the
  // card. Its params bag is `musicVideoAutopilot` (tools, per-tool models,
  // budget, checkpoints, idea tags); the shipped default is the free/local tool
  // set so nothing metered is spent until the operator opts in. It has no Quota
  // Burn form: image/video spend is bounded by its own budget and limits.
  'music-video-autopilot': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, displayName: 'Autonomous run', providerId: null, model: null, prompt: null, taskMetadata: { musicVideoAutopilot: normalizeAutopilotParams({}) } },
  'universe-bible-describe': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { universeId: 'all', scope: 'all', depth: 'full', maxEntries: 10 } },
  'universe-bible-images':   { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { universeId: 'all', scope: 'all', maxEntries: 10, requireDescribed: false } }
};

// Every catalog audit is displayed as a `better-*` quality task. Give all of
// them the current issue inventory by default so they can avoid filing work
// that is already tracked, the lane's recent slices so runs rotate coverage
// (#12090), and the lane's health record so a rejected or reverted finding is
// not re-filed (#12088). Preserve other configured inputs such as PRs.
export const DEFAULT_TASK_INTERVALS = Object.fromEntries(
  Object.entries(TASK_INTERVAL_DEFAULTS).map(([taskType, interval]) => [
    taskType,
    isAuditTaskType(taskType)
      ? { ...interval, dataInputs: [...new Set([...(interval.dataInputs || []), 'open-issues', 'audit-slice-history', 'lane-health'])] }
      : interval
  ])
);

// Repo paths whose change makes a repeat of an expensive executed audit worth
// buying. An automatic launch is skipped (`inputs-unchanged`) while none differ
// from the HEAD of the last clean run (#12907); a user-origin launch always runs.
// Git pathspecs relative to the app's repo root. The prompt version stands in
// for the prompt body: a body change requires a bump.
export const TASK_INPUT_PATHS = Object.freeze({
  'upgrade-rehearsal': Object.freeze([
    'scripts/run-migrations.js',
    'scripts/lib/',
    'scripts/migrations/',
    'data.reference/',
    'server/services/backup.js',
    'server/services/backupRestore*',
    'server/services/taskPromptDefaults/versions.js',
  ]),
});

// Agent-options that a task manages internally — UI locks the toggle, and
// loadSchedule/updateTaskInterval enforce the default value regardless of
// what's persisted or POSTed. The reasoning lives next to each task above
// (e.g., plan-task's prompt creates its own claim/<slug> worktree, so a
// CoS-managed worktree would clobber it).
export const MANAGED_AGENT_OPTIONS = {
  'plan-task': ['useWorktree', 'openPR', 'claimFlow'],
  // The parent task is a non-committing coordinator. Its isolated Stage 2
  // reviewer explicitly overrides `useWorktree` inside the pipeline; the
  // parent-level false prevents the generic task defaults from treating the
  // coordinator itself as code-producing work.
  'pr-reviewer': ['useWorktree', 'openPR', 'worktreeChangesExpected'],
  // Programmatic-I/O review task: the model only returns structured judgment;
  // deterministic hooks own every GitHub mutation. Keep its worktree throwaway
  // even when a global/per-app metadata override tries to make it writable.
  'issue-watcher': ['useWorktree', 'openPR', 'readOnly', 'worktreeChangesExpected'],
  'pr-watcher': ['prAuthorFilter'],
  // Package-manager installs are never safe in the live checkout (see the task's
  // entry above), so isolation is not an operator choice; `openPR` stays free.
  'dependency-updates': ['useWorktree'],
  // The non-committing coordinators (NON_COMMITTING_COORDINATOR_METADATA above) all
  // run in the app's LIVE checkout and ship no code, so a CoS-managed worktree is at
  // best unused and at worst harmful — branch-reconcile needs to see the sibling
  // worktrees of the in-flight branches (a managed worktree hides them from the scan
  // AND could trip cleanupAgentWorktree's auto-merge). Locking both off also keeps the
  // finalize-time PR-claim check from scoring a completed run `pr-missing`.
  //
  // `worktreeChangesExpected` is managed for these coordinators as well — the one type-keyed
  // exception to it being a free per-app override. A clean tree is definitionally the
  // success shape for a branch deletion or a posted report, so setting it back to
  // `true` can only make successful runs fail; it is exactly as non-negotiable here as
  // the other two. Managing it is also what carries it through an explicit
  // `taskMetadata: null` clear — loadSchedule preserves that null (skipping the
  // defaults deep-merge), and enforceManagedAgentOptions rebuilds only the MANAGED
  // fields, so an unmanaged `worktreeChangesExpected` would silently go absent and the
  // task bookkeeping would otherwise treat the clean worktree as missing code work.
  ...Object.fromEntries(
    ['branch-reconcile', 'branch-cleanup', 'issue-reconcile', 'jira-status-report', 'stash-cleanup', 'repo-sync']
      .map((t) => [t, ['useWorktree', 'openPR', 'worktreeChangesExpected']])
  ),
  // claim-issue's prompt creates its own claim/issue-<num> worktree (same
  // rationale as plan-task), so CoS must not pre-create one or open the PR.
  'claim-issue': ['useWorktree', 'openPR', 'claimFlow'],
  // claim-work delegates to one of the above prompt bodies, each of which
  // creates its own worktree + PR — so the same lock applies to the router.
  'claim-work': ['useWorktree', 'openPR', 'claimFlow'],
  'do-release': ['useWorktree', 'openPR', 'worktreeChangesExpected', 'slashdoCommand']
};

// Strip managed-agent fields from a per-app override map before merging on top
// of the (already-enforced) global config. Without this, an app-level override
// for a managed field (e.g. `plan-task.useWorktree=false`) carries through into
// the task spawn even though the UI toggle is locked, defeating the lock's
// intent. Returns the cleaned metadata (or null if every key was managed).
export function stripManagedAgentOptionsFromOverride(taskType, taskMetadata) {
  const managed = MANAGED_AGENT_OPTIONS[taskType];
  if (!managed || !taskMetadata || typeof taskMetadata !== 'object') return taskMetadata;
  const cleaned = { ...taskMetadata };
  for (const field of managed) delete cleaned[field];
  return Object.keys(cleaned).length ? cleaned : null;
}

export function enforceManagedAgentOptions(taskType, config) {
  const managed = MANAGED_AGENT_OPTIONS[taskType];
  if (!managed || !config) return false;
  const defaults = DEFAULT_TASK_INTERVALS[taskType]?.taskMetadata
    || LEGACY_MANAGED_TASK_METADATA[taskType]
    || {};
  let changed = false;
  // If the stored config explicitly cleared taskMetadata (or never had it),
  // we still need the managed fields present — otherwise upstream resolvers
  // (e.g., cos.js applyAppWorktreeDefault) can flip them on via app defaults.
  if (!config.taskMetadata || typeof config.taskMetadata !== 'object' || Array.isArray(config.taskMetadata)) {
    config.taskMetadata = {};
    changed = true;
  }
  for (const field of managed) {
    if (config.taskMetadata[field] !== defaults[field]) {
      config.taskMetadata[field] = defaults[field];
      changed = true;
    }
  }
  return changed;
}

// The batch size is user-configurable, but an old schedule or an explicit
// metadata clear must not silently restore the pre-batch all-at-once behavior.
// Keep the persisted global task on the same safe default as a fresh install;
// per-app overrides still layer on top of it at dispatch time.
export function enforceBranchReconcileBatch(taskType, config) {
  if (taskType !== 'branch-reconcile' || !config) return false;
  if (!config.taskMetadata || typeof config.taskMetadata !== 'object' || Array.isArray(config.taskMetadata)) {
    config.taskMetadata = {};
  }
  const value = config.taskMetadata.branchesPerAgent;
  if (!Number.isInteger(value) || value < BRANCHES_PER_AGENT_MIN || value > BRANCHES_PER_AGENT_MAX) {
    config.taskMetadata.branchesPerAgent = DEFAULT_BRANCHES_PER_AGENT;
    return true;
  }
  return false;
}

// Short human-readable blurb per task type, shown on schedule cards and in the
// upcoming-tasks list. Every entry in SELF_IMPROVEMENT_TASK_TYPES must have a
// key here — a missing one falls back to a dasherized label ("claim work"),
// which reads as an orphaned/legacy task. A parity guard in taskSchedule.test.js
// fails the suite if the two ever drift apart.
export const TASK_TYPE_DESCRIPTIONS = {
  'ui-bugs': 'Find UI bugs — file issues or implement fixes',
  'mobile-responsive': 'Mobile/responsive audit — file issues or implement fixes',
  [PRIVATE_SECURITY_TASK_TYPE]: 'Private security assessment — sandboxed local model, report and remediation only; no issues or PRs',
  'security': 'Security audit — file issues or implement fixes',
  'code-quality': 'Code quality — file issues or implement fixes',
  'console-errors': 'Console errors — file issues or implement fixes',
  'performance': 'Performance audit — file issues or implement fixes',
  'test-coverage': 'Test coverage — file issues or add tests',
  'documentation': 'Docs drift — file issues or implement fixes',
  'feature-ideas': 'Implement next planned feature or brainstorm new one',
  'plan-task': 'Execute next PLAN.md item, remove it from PLAN.md, log to changelog (worktree+PR)',
  'claim-issue': 'Claim and ship the next open GitHub issue (owner-filed or any author), PR closes it',
  'claim-work': "Ship the next work item from the app's configured tracker (PLAN.md, GitHub/GitLab issues, or JIRA), routed automatically",
  'accessibility': 'Accessibility audit — file issues or implement fixes',
  'branch-reconcile': "Finish this machine's in-flight local branches: clean up merged ones, open PRs, resolve conflicts, drive review, auto-merge when green",
  'issue-reconcile': "Remediate trusted operator and collaborator issues: heal zombies (open + in-progress but their PR already merged with no live claim — close + file a scoped follow-up or release the claim) and auto-unblock: remove the `blocked` label once every issue named in its `Blocked by #N` line has closed",
  'dependency-updates': 'Land or resolve open Dependabot/Renovate PRs, then update the dependencies they missed',
  'do-release': 'Ship a release: finish in-flight work, merge dependency updates, fix blockers, then run the release workflow',
  'error-handling': 'Failure-path audit — file issues or implement fixes',
  'typing': 'TypeScript types — file issues or implement fixes',
  'pr-reviewer': 'Watch external contributor PRs: screen content, gate eligibility, and validate review actions',
  'pr-watcher': 'Remediate operator and collaborator PRs using screened activity; verify tests and reviews before merging',
  'issue-watcher': 'Triage external issues and comments through screening, tool-free analysis, and deterministic replies or volunteer assignment',
  'code-reviewer-a': 'Review the codebase and triage/implement findings (independent provider/model instance A)',
  'code-reviewer-b': 'Review the codebase and triage/implement findings (independent provider/model instance B)',
  'do-replan': 'Audit and prune PLAN.md after merges and branch cleanup so it reflects what actually shipped',
  'jira-sprint-manager': 'Triage and implement JIRA sprint tickets',
  'jira-status-report': 'Generate JIRA weekly status report',
  'reference-watch': 'Watch reference repos and append PLAN.md items for new upstream work',
  'design': 'Rendered design audit — file issues (default) or implement fixes',
  'ux': 'UX audit — file issues (default) or implement fixes',
  'data-safety': 'Data/upgrade-safety audit — file issues (default) or implement fixes',
  'simplify': 'Dead-code/duplication audit — file issues (default) or implement removals',
  'over-engineering': 'Over-engineering — process and validation machinery costing more (CI minutes, agent turnaround, maintenance) than the harm it prevents; file issues (default) or implement removals',
  'module-hygiene': 'Module hygiene — complexity, reuse, ownership, and discoverability; file issues (default) or implement one refactor',
  'api-contract': 'API/route-contract audit — file issues (default) or implement fixes',
  'ui-lifecycle': 'UI lifecycle/state audit — file issues (default) or implement fixes',
  'observability': 'Logging/observability audit — file issues (default) or implement fixes',
  'copy': 'Copy/text-clarity audit — file issues (default) or implement rewrites',
  'better-complexity': 'Cyclomatic complexity — measure branching per function, reduce the hottest offenders; file issues (default) or implement one refactor',
  'better-cognitive-load': 'Cognitive load — excessive code comments, mixed abstraction levels, flag arguments, misleading names, action at a distance; file issues (default) or implement one refactor',
  'better-structural-drift': 'Structural drift — generated artifacts as a second source of truth, hand-synced registries, layout coupling; file issues (default) or implement one consolidation',
  'app-bugs': 'App bugs — server and core-logic bugs: wrong results, edge inputs, success that did nothing, races a user or job can trigger; file issues (default) or implement fixes',
  'better-runtime-safety': 'Runtime safety — missing awaits, unhandled rejections, unguarded nulls, leaks, races; file issues (default) or implement fixes',
  'better-dependency-freedom': 'Dependency freedom — replace micro-packages and native-API wrappers with in-repo code; file issues (default) or implement one removal',
  'better-test-quality': 'Test quality — vacuous, weak, or redundant tests; file issues (default) or implement one cleanup',
  'better-dev-environment': 'Development environment — temp files/processes leaked by test runs, writes outside the sandbox, watcher cost, suite runtime; file issues (default) or implement one fix',
  'infrastructure': 'Infrastructure & deployment — IaC, containers, orchestration and CI: exposure, identity grants, secrets, pinning, limits; file issues (default) or implement fixes',
  'data-integrity': 'Data integrity — idempotent ingestion, atomic writes, consistency, schema evolution of stored data; file issues (default) or implement fixes',
  'reliability': 'Reliability — graceful shutdown, health/readiness, backpressure, job leasing, mixed-version deploys; file issues (default) or implement fixes',
  'privacy': 'Privacy & data governance — personal data in logs/exports/third parties, minimization, retention and erasure; file issues (default) or implement fixes',
  'cost-efficiency': 'Cost efficiency — metered API/model calls, unbounded scans, storage tiers, over-provisioning; file issues (default) or implement fixes',
  'feature-completeness': 'Feature completeness — stubs reachable from the UI, disabled or "coming soon" controls, settings nothing reads, endpoints with no entry point; file issues (default) or finish one',
  'workflow-recovery': 'Workflow recovery — in-progress states with no visible resume/cancel, busy refusals without a handle, follow-up steps that strand a record; file issues (default) or implement fixes',
  'upgrade-rehearsal': 'Upgrade & restore rehearsal — runs migrations over synthetic older installs and a backup restore in scratch directories, never the live data; file issues (default) or implement fixes',
  'model-comparison-refresh': 'Research sourced model quality, effort, price, latency and quota evidence for Models Comparison',
  'stash-cleanup': 'Triage git stash list — drop entries superseded by or stale relative to main, leave real unlanded work in place',
  'repo-sync': 'Sync every managed app with origin — back on the default branch, pushed and pulled, merged branches/worktrees and redundant stashes cleared',
  'plan-feature': "Brainstorm one feature and file its decision-complete plan to the app's work tracker (no code)",
  'media-render-research': 'Research local Apple Silicon image/video models, runtimes and settings; file ready-to-work issues for improvements (no code)',
  'user-action-review': 'Review the operator-action log for repeated manual work and propose automations — file issues (default) or queue CoS tasks',
  'error-log-triage': 'Triage new stderr lines from PortOS processes — fingerprint and dedupe against issues, then queue one investigation agent per new fault',
  'layered-intelligence': "Use app goals + performance metrics to file at most one deduplicated improvement issue; inspect read-only context and file a visibility gap when evidence is insufficient — no code",
  'development-watchdog': 'Inspect maintainer repository ownership and queue eligible work without an inference call',
  'music-video-autopilot': 'Turn the next unused Brain idea into a fully autonomous music video — lyrics, Suno song, mood board and video. No agent',
  'universe-bible-describe': 'Fill in blank universe bible sheets — one expand prompt per entry, emptiest first. No agent',
  'universe-bible-images': 'Render images for universe bible entries that have none yet. No agent — PortOS enqueues the renders itself'
};

export function getTaskTypeDescription(taskType) {
  return TASK_TYPE_DESCRIPTIONS[taskType] || taskType.replace(/-/g, ' ');
}

/**
 * Prompt presentation metadata for task types whose prompt is assembled by a
 * programmatic input hook rather than read from the persisted schedule.
 *
 * Keeping this separate from DEFAULT_TASK_PROMPTS is intentional: adding a
 * placeholder prompt there would make the schedule look configured while the
 * hook still replaces it at dispatch time. The UI can therefore explain the
 * real execution shape without changing prompt-version migration state.
 */
export const TASK_TYPE_PROMPT_INFO = Object.freeze({
  'development-watchdog': Object.freeze({ mode: 'programmatic', description: 'Agent-free maintenance. Configure recurring cadence and repository scope in the Persistent Mind maintainer role; Run Now scans immediately.' }),
  [PRIVATE_SECURITY_TASK_TYPE]: Object.freeze({ mode: 'runtime-generated', description: 'Private assessment of committed source and remediation guidance. Requires a pinned local Ollama or LM Studio CLI provider/model and macOS Seatbelt; tools, remote networking and publishing are disabled. Reports appear in the local Review Hub. No issues or PRs.' }),
  'pr-reviewer': Object.freeze({
    mode: 'runtime-generated',
    description: 'Runs a model-abuse screen, a tool-free eligibility gate, and an optional tool-free code review; the server validates every requested GitHub action.'
  }),
  'issue-watcher': Object.freeze({
    mode: 'runtime-generated',
    description: 'Three enforced server phases: screen external issue activity, analyze it through a text-only API with no tools or private context, then validate current content before replies or assignments. Configure the source policy in Models → LLMs → Abuse Guard.'
  }),
  'error-log-triage': Object.freeze({
    mode: 'runtime-generated',
    description: 'PortOS reads its own stderr logs, fingerprints and redacts each new fault, and dedupes it against the issue tracker with no model call. Each new fault seen at least the configured number of times queues one investigation agent on the provider and model below, up to the per-run cap; that prompt is generated from the redacted excerpt.'
  }),
  'layered-intelligence': Object.freeze({
    mode: 'runtime-generated',
    description: 'Generated for each run from the app\'s configured goals, metrics, and repository context.'
  }),
  // `programmatic` is NOT `runtime-generated`: there is no prompt at all for the
  // user to read or a hook to render. PortOS performs the work itself, so the
  // UI shows the settings that bound it instead of a prompt editor.
  'music-video-autopilot': Object.freeze({
    mode: 'programmatic',
    description: 'PortOS picks the oldest unused active Brain idea and runs the autonomous music-video pipeline itself — no agent and no prompt template. Tools, per-tool models, budget, checkpoints and idea tags are the settings that bound it.'
  }),
  'universe-bible-describe': Object.freeze({
    mode: 'programmatic',
    description: 'PortOS sends one bible-expand prompt per entry itself — no agent and no prompt template. Scope, depth, and the per-run entry cap are the settings that bound it.'
  }),
  'universe-bible-images': Object.freeze({
    mode: 'programmatic',
    description: 'PortOS compiles the missing entries\' render prompts and enqueues them on the media job queue itself — no agent and no prompt template.'
  })
});

/**
 * Sparse, explicit contract for task types owned by another automation.
 *
 * The current scheduled task catalog has no top-level subsidiary-only entries:
 * every task card is a user-invokable task, while pipeline stages are nested
 * inside their parent task. Future automation-only types belong here instead
 * of being inferred from names or from a task's implementation details.
 *
 * A visible subsidiary entry should use:
 *   { kind: 'subsidiary', visibility: 'visible', userInvokable: false,
 *     label: 'Automation-only', description: '...' }
 * A hidden entry should use `visibility: 'hidden'` and still set
 * `userInvokable: false`.
 */
export const TASK_TYPE_INVOCATION = Object.freeze({});

const DEFAULT_TASK_TYPE_PROMPT_INFO = Object.freeze({ mode: 'template', description: null });
const DEFAULT_TASK_TYPE_INVOCATION = Object.freeze({
  kind: 'direct',
  visibility: 'visible',
  userInvokable: true
});

export function getTaskTypePromptInfo(taskType) {
  return TASK_TYPE_PROMPT_INFO[taskType] || DEFAULT_TASK_TYPE_PROMPT_INFO;
}

export function getTaskTypeInvocation(taskType) {
  return TASK_TYPE_INVOCATION[taskType] || DEFAULT_TASK_TYPE_INVOCATION;
}
