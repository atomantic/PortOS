/**
 * Static task-type registry.
 *
 * This module is deliberately independent of apps.js and persisted schedule state
 * so app configuration can consume task definitions without forming a cycle.
 */

import { BRANCHES_PER_AGENT_MAX, BRANCHES_PER_AGENT_MIN, DEFAULT_REPO_SYNC_VERIFY_MODE } from '../lib/cosValidation.js';
import { isAuditTaskType, defaultFileIssuesFor } from '../lib/auditCatalog.js';
import { INTERVAL_TYPES } from './taskScheduleConstants.js';

export const SELF_IMPROVEMENT_TASK_TYPES = [
  'security', 'code-quality', 'test-coverage', 'performance',
  'accessibility', 'branch-reconcile', 'issue-reconcile', 'console-errors', 'dependency-updates', 'documentation',
  'ui-bugs', 'mobile-responsive', 'feature-ideas', 'plan-task', 'claim-issue', 'claim-work', 'error-handling',
  'typing', 'release-check', 'pr-reviewer', 'code-reviewer-a', 'code-reviewer-b',
  'jira-sprint-manager', 'jira-status-report', 'do-replan',
  // Polls the app's GitHub repo for pull requests newly opened against the
  // default branch and dispatches an agent (running the configurable
  // pr-watcher prompt) for each one. `taskMetadata.prAuthorFilter` gates on
  // PR authorship (self / others / any). See server/services/prWatcher.js.
  'pr-watcher',
  // Watches `referenceRepos` configured on the app — fetches each upstream
  // repo, finds commits since lastReviewedSha, and appends slug-tagged
  // `[ref-watch-…]` checklist items to the app's PLAN.md for `/claim` /
  // `plan-task` to pick up. No source-code edits, no separate review file.
  'reference-watch',
  // Walks the running app UI with a UX reviewer's eye (Playwright MCP) against a
  // named checklist — buried primary actions, dead-end empty/error states,
  // affordances that drift between sibling screens. Defaults to filing tracker
  // issues (`fileIssues: true`); the user can flip it to implement. Deliberately
  // narrower than its siblings: raw console errors belong to `ui-bugs`, viewport
  // breakage to `mobile-responsive`, ARIA/contrast/keyboard to `accessibility`.
  'ux',
  // Quota-burn `data-safety-audit` counterpart. Migrations, schema parity, and
  // cross-version compatibility. Defaults to file-issues (safer for unattended).
  'data-safety',
  // Quota-burn `simplify-audit` counterpart. Dead code, unused exports, and
  // copy-paste drift — distinct from `code-quality` (which is the broader DRY /
  // long-function / TODO pass). Defaults to file-issues.
  'simplify',
  // Quota-burn `api-contract-audit` counterpart. Route validation, client/server
  // drift, status envelopes, and missing `asyncHandler`. Defaults to file-issues.
  'api-contract',
  // Quota-burn `react-lifecycle-audit` counterpart. Effect teardowns, stale
  // closures, and post-unmount state — distinct from `ui-bugs` (console errors)
  // and `accessibility`. Defaults to file-issues.
  'react-lifecycle',
  // Quota-burn `observability-audit` counterpart. Silent catches, log noise, and
  // errors logged without the context needed to reproduce them. Files under the
  // `code-quality` label. Defaults to file-issues.
  'observability',
  // Quota-burn `copy-audit` counterpart. User-facing wording only — jargon,
  // ambiguous action verbs, dead-end error text. Files under the `ux` label;
  // narrower than the `ux` audit, which walks the running UI. File-issues.
  'copy',
  // Audits `git stash list` for {appName} and drops entries already superseded
  // by (or a subset of) current `main`/HEAD, or that are stale/abandoned scratch
  // work — without discarding real unlanded work. On-demand only (no cadence
  // makes sense for something the user notices ad hoc); non-committing
  // coordinator posture, since a cleared stash is a repo-hygiene side effect,
  // never a commit. See DEFAULT_TASK_PROMPTS['stash-cleanup'].
  'stash-cleanup',
  // Install-wide git hygiene sweep: for EVERY managed app (PortOS included) put
  // the checkout back on its default branch, level with origin both ways, with
  // no leftover local branches/worktrees and an empty stash list. A deterministic
  // Tier-1 pass in services/repoSync.js does everything provable with no LLM call
  // (push what is strictly ahead, fast-forward the default branch, return to it
  // when the current branch is clean + already merged, delegate merged-branch and
  // worktree deletion to branchReconcile, drop stashes whose content is identical
  // to the default branch). It dispatches ONE coordinator agent only when the
  // sweep leaves something needing judgment — a mid-flight merge/rebase,
  // uncommitted work, a diverged branch, unpushed commits with no PR, a stash it
  // could not prove redundant — or, under the default `verifyMode:
  // 'when-changed'`, to double-check a run that actually mutated something.
  // On-demand only, and GLOBAL: 'Run Now' with no app sweeps the whole install,
  // which is the shape the task exists for. Non-committing coordinator posture.
  'repo-sync',
  // The planning-only sibling of `feature-ideas`: runs the same brainstorm
  // research (PRD.md/GOALS.md or repository docs, changelog/git log, and
  // closed-unmerged PRs)
  // but NEVER implements — its deliverable is ONE decision-complete feature
  // plan filed into the app's resolved work tracker via {trackerInstructions}
  // (PLAN.md checklist item / GitHub / GitLab issue / JIRA ticket), which the
  // claim flows pick up later. Always-filing tracker-filing type
  // (TRACKER_FILING_PRESETS['plan-feature']), like reference-watch/repo-study.
  'plan-feature',
  // layered-intelligence is a PROGRAMMATIC-I/O task: it spawns a NORMAL reasoning
  // agent (visible in the CoS queue + Active Agents, TUI-attachable) with two
  // deterministic hooks around it — buildTaskInput gathers the app's goals +
  // telemetry + open issues and builds the reasoning prompt; processTaskOutput
  // validates the agent's `.agent-done` payload, dedups, and files ONE tracker
  // issue. The agent runs in a THROWAWAY worktree (discardWorktree) that is never
  // committed/merged, so the reasoner still can't write code — the structured
  // payload is its only channel out. Scheduling (enabled/interval/provider/model)
  // lives in the per-app taskTypeOverrides; behavior (sources/scopes/rules/handoff)
  // stays in app.layeredIntelligence. Has NO DEFAULT_TASK_PROMPTS entry — the
  // buildTaskInput hook renders the prompt. See taskTypeHooks.js +
  // autonomousJobs/layeredIntelligenceHooks.js.
  'layered-intelligence',
  // NOTE: `quota-burn` used to live here as a per-app perpetual task type. It is
  // now ONE install-level loop (services/quotaBurnRunner.js) configured on the
  // Quota Burn page — the burn plan is machine-local, and its jobs name which
  // managed app (if any) the work targets. Migration 221 moves existing per-app
  // overrides across; do not re-add it as a scheduled type.
];

// Shared taskMetadata posture for the NON-COMMITTING COORDINATOR types
// (NON_COMMITTING_COORDINATOR_TASK_TYPES in taskTypeHooks.js — branch-reconcile /
// issue-reconcile / branch-cleanup / jira-status-report / release-check). Each delivers its work
// as a SIDE EFFECT in the app's live checkout — a deleted branch, a merged PR, a
// relabeled issue, a posted report — and by design produces no commit of its own.
// Two code-shipping criteria therefore have to be switched off or every SUCCESSFUL
// run is recorded as a failure:
//   * `useWorktree`/`openPR` — explicitly false (not merely absent) so
//     applyAppWorktreeDefault's `=== undefined` checks can't fill them from the
//     app's `defaultOpenPR`/`defaultUseWorktree`. A worktree these tasks never cd
//     into is at best unused and at worst harmful (it hides sibling refs the
//     reconcile scan must inspect), and the implied PR expectation fails the run at finalize
//     with `pr-missing` — there is no code to open a PR for. Locked in
//     MANAGED_AGENT_OPTIONS below so a per-app override can't re-attach them.
//     `readOnly: true` is NOT a substitute: it gates worktree CREATION
//     (agentWorkspacePrep.js) but the PR-claim check reads `metadata.openPR`
//     directly (agentTuiSpawning.js).
  //   * `worktreeChangesExpected` — a clean tree IS the success shape here, so the
  //     task's deliverable posture must record that this is not code work.
// A guard test in taskSchedule.test.js asserts every member of that set carries
// this posture, so a new coordinator type can't be added to one list only.
const NON_COMMITTING_COORDINATOR_METADATA = { useWorktree: false, openPR: false, worktreeChangesExpected: false };
// Release-check delegates its release lifecycle to the bundled slashdo workflow.
// Keep the command in managed metadata so a customized prompt or app override
// cannot silently fall back to a second, drifting release implementation.
const RELEASE_CHECK_METADATA = { ...NON_COMMITTING_COORDINATOR_METADATA, slashdoCommand: 'release' };
// Migration 274 removes branch-cleanup from new schedules, but a partially
// upgraded install may still load its stored task before the migration runs.
// Keep its safety posture available without making it a newly-shipped task.
const LEGACY_MANAGED_TASK_METADATA = {
  'branch-cleanup': NON_COMMITTING_COORDINATOR_METADATA
};

// Shared config for code-reviewer-a and code-reviewer-b (two instances for independent provider/model configuration)
const CODE_REVIEWER_INTERVAL = { type: INTERVAL_TYPES.WEEKLY, enabled: false, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, simplify: true, pipeline: { stages: [{ name: 'Codebase Review', promptKey: 'code-reviewer-review', readOnly: true, providerId: null, model: null, precondition: { fileNotExists: 'REVIEW.md' } }, { name: 'Triage & Implement', promptKey: 'code-reviewer-implement', readOnly: false, providerId: null, model: null, precondition: { fileExists: 'REVIEW.md' } }] } } };

/**
 * Default `drainDispatchCap` for the reconcile drains: how many times a perpetual
 * drain may dispatch back-to-back before it is parked regardless of how much
 * progress it reports.
 *
 * The `lastActionableSignature` guard stops the drain only when a full cycle
 * changes NOTHING. It cannot stop a drain whose set keeps changing without ever
 * emptying — a branch that oscillates between two states, a coordinator that opens
 * a PR one run and closes it the next, a repo where new work arrives as fast as it
 * is finished. Those are indistinguishable from healthy progress one cycle at a
 * time, and on 2026-08-12 that shape ran ~40 coordinator agents between 05:19 and
 * 08:47 against the same two branches. So progress buys more cycles, not unlimited
 * ones: past the cap the drain parks until its recheck cadence, which is a delay,
 * never a dropped item — the branches are still there and the next recheck sees
 * them. Five is enough for a legitimately long drain (open PR → CI → merge →
 * cleanup) to finish a couple of branches per window.
 *
 * The count is very nearly "consecutive dispatches": every terminal park and every
 * manual re-run zero it. The one gap is a FAILED run — it neither refills nor
 * parks, so its spent dispatches carry into the next scheduled window and that
 * window caps early. It self-heals within one window (the next park zeroes it), and
 * erring toward capping early is the safe direction for a runaway guard.
 *
 * Why the cap is PER TYPE (`drainDispatchCap`) and not one global number: five is
 * ample for finishing branches (a handful per day) but would throttle a HEALTHY
 * claim-issue drain to five issues per recheck window — a real regression for a
 * drain the user relies on running productively overnight. So the claim drains
 * ship without the key at all (absent/`null` ⇒ unbounded, their work-detector's
 * idle park remains the only brake) and only the reconcile scans carry a number.
 */
export const PERPETUAL_DRAIN_DISPATCH_CAP = 5;
export const DEFAULT_BRANCHES_PER_AGENT = 3;

/**
 * Task types whose "Run Now" with NO app is the REAL run — they sweep every
 * managed app in one dispatch rather than acting on one. Surfaced per task on
 * `getScheduleStatus()` so the schedule UI can offer an "All apps" entry
 * instead of forcing every run through the app picker (which would make the
 * install-wide lane unreachable on any install that has apps).
 */
export const INSTALL_WIDE_TASK_TYPES = new Set(['repo-sync']);

export const DEFAULT_TASK_INTERVALS = {
  'security':            { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'code-quality':        { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'test-coverage':       { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'performance':         { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'accessibility':       { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  // branch-reconcile first removes fully-merged, clean orphaned worktrees and
  // branches, then finishes THIS machine's remaining in-flight LOCAL branches
  // per app (open a PR for pushed-but-unopened work, resolve merge conflicts,
  // drive the review loop, auto-merge when green). PERPETUAL (drain-until-done):
  // the generator runs the deterministic reconcile every dispatch, and dispatches
  // the coordinator agent only while actionable in-flight branches remain — then
  // PARKS on the daily recheckCron. The action toggles (cleanupMerged / openPr /
  // resolveConflicts / autoMerge / finishAbandoned) are per-app taskMetadata
  // booleans (each ON unless explicitly false); `finishAbandoned` covers the work
  // a dead agent left UNCOMMITTED in its worktree — commit + ship it, or report it
  // as unfinished. `branchesPerAgent` bounds each coordinator prompt to a
  // prioritized batch so a large backlog drains across several agents. It is
  // independently overridable per app. useWorktree/openPR are LOCKED off
  // (MANAGED_AGENT_OPTIONS):
  // the coordinator runs in the app's live checkout so it can see + operate on the
  // sibling worktrees; a CoS-managed worktree would hide the branches and could
  // trigger cleanupAgentWorktree's auto-merge. Its edits likewise land in those
  // SIBLING worktrees, never in its own cwd — hence the shared non-committing
  // -coordinator posture above. Off by default — enabling it is the user's
  // explicit consent to let it drive PRs on a schedule.
  'branch-reconcile':    { type: INTERVAL_TYPES.PERPETUAL, enabled: false, providerId: null, model: null, prompt: null, recheckCron: '0 3 * * *', drainDispatchCap: PERPETUAL_DRAIN_DISPATCH_CAP, taskMetadata: { ...NON_COMMITTING_COORDINATOR_METADATA, cleanupMerged: true, openPr: true, resolveConflicts: true, autoMerge: true, finishAbandoned: true, branchesPerAgent: DEFAULT_BRANCHES_PER_AGENT } },
  // issue-reconcile heals ZOMBIE issues: open + `in-progress` (claimed) yet with
  // their PR already MERGED and no live claim anywhere — a partial ship left the
  // claim marker on, so the queue (which skips `in-progress`) never re-picks the
  // remaining scope. PERPETUAL (drain-until-done): the generator runs the
  // deterministic gh/git scan every dispatch and dispatches the coordinator agent
  // only while zombies remain — then PARKS on the daily recheckCron (offset an
  // hour after branch-reconcile so merged-branch cleanup lands first). The
  // coordinator applies the partial-ship hybrid per zombie (close + file a scoped
  // follow-up when the remainder is separable, else comment "done/remaining" +
  // release the claim). `autoClose` (ON unless explicitly false) is the only
  // per-app toggle: OFF forbids closing/filing — comment + unlabel only.
  // The coordinator works purely over `gh` — no code changes, no worktree, and
  // issue-state mutation is its whole deliverable — hence the shared
  // non-committing-coordinator posture above. Off by default — enabling it is the
  // user's explicit consent to let it mutate issue state on a schedule.
  'issue-reconcile':     { type: INTERVAL_TYPES.PERPETUAL, enabled: false, providerId: null, model: null, prompt: null, recheckCron: '0 4 * * *', drainDispatchCap: PERPETUAL_DRAIN_DISPATCH_CAP, taskMetadata: { ...NON_COMMITTING_COORDINATOR_METADATA, autoClose: true } },
  'console-errors':      { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'dependency-updates':  { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'documentation':       { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'ui-bugs':             { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'mobile-responsive':   { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  // feature-ideas waits for do-replan so new work is grounded in a fresh PLAN.md
  // that already accounts for any in-flight or unmerged work.
  'feature-ideas':       { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null, runAfter: ['do-replan'], taskMetadata: { useWorktree: true, openPR: true, simplify: true } },
  // plan-task is a strict executor of PLAN.md items — no brainstorm fallback, no
  // runAfter deps. Picks the next unchecked item, implements it, and removes it
  // from PLAN.md in the same commit (changelog + git log are the audit trail).
  // plan-task (prompt v5+) drives the /claim flow itself — the agent creates its OWN `claim/<slug>` worktree, opens the PR, merges via `gh pr merge`, and cleans up.
  // Both `useWorktree` and `openPR` are OFF on the CoS side:
  //   * `useWorktree: false` — CoS pre-creating a worktree under `cos/<task>/<agent>` would hide the slug from the in-flight branch scan AND trigger
  //     `cleanupAgentWorktree`'s auto-merge into whatever the source repo's HEAD is on (clobbering a TUI user's in-flight claim branch).
  //   * `openPR: false` — keeps the cos.js "openPR implies useWorktree" invariant from forcing useWorktree back on. The agent opens its own PR via `gh pr create`
  //     and merges via `gh pr merge`, so CoS doesn't need to.
  // `claimFlow: true` is the lifecycle marker. It is deliberately separate from
  // `openPR`: the former tells prompt/completion handling that the claim prompt
  // owns push → PR/MR → review → merge/cleanup, while the latter tells CoS whether
  // it should provision and publish a managed worktree. Conflating them sent
  // claim agents into the generic commit-only handoff (#4153).
  // The agent runs in the source repo's working directory; `git worktree add` doesn't touch that working tree, so it's safe even with uncommitted user changes.
  'plan-task':           { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, claimFlow: true, simplify: true } },
  // claim-issue drives the /claim --issues flow — the agent creates its OWN
  // claim/issue-<num> worktree, opens the PR (Closes #<num>), merges via
  // `gh pr merge`, and cleans up. Both `useWorktree` and `openPR` are OFF on the
  // CoS side for the SAME reasons as plan-task (a CoS-managed worktree under
  // cos/<task>/<agent> would hide the issue-<num> slug from the in-flight scan
  // and trigger cleanupAgentWorktree's auto-merge into the source repo's HEAD).
  // `issueAuthorFilter` gates which issues are claimable: 'self' (default, the
  // slashdo `/do:next --self` security boundary) only claims issues YOU filed
  // (`@me`); 'collaborators' widens that to you plus every account with repo
  // access (GitHub collaborators / GitLab project members); 'owner' only claims
  // issues the repo owner filed; 'any' claims any open issue. Per-app override
  // supported via taskTypeOverrides.
  // `issueExcludeLabels` (default `[]`) lists ADDITIONAL labels to skip when
  // auto-claiming, on top of the fixed NON_ACTIONABLE_ISSUE_LABELS set
  // (perpetualWork.js) — e.g. `good first issue`, to leave those open for human
  // contributors. Per-app override supported via taskTypeOverrides, like
  // `issueAuthorFilter`.
  'claim-issue':         { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, claimFlow: true, simplify: true, issueAuthorFilter: 'self', issueExcludeLabels: [] } },
  // claim-work is the SINGLE-SOURCE router: one toggle per app that ships the
  // next work item from whatever tracker the app is configured for
  // (app.workTracker, default 'auto' → resolved from the git origin host). At
  // dispatch the generator resolves the tracker and delegates to the matching
  // prompt body — plan→plan-task, github→claim-issue, gitlab→claim-issue-gitlab,
  // jira→claim-issue-jira — so the agent still creates its OWN worktree and
  // opens its OWN MR/PR. (jira routes to the per-ticket claim-issue-jira flow,
  // NOT the broader jira-sprint-manager triage job, which stays standalone.)
  // Both `useWorktree` and `openPR` are OFF on the CoS side
  // for the SAME reasons as plan-task/claim-issue (a CoS-managed worktree would
  // hide the claim slug and trigger cleanupAgentWorktree's auto-merge).
  // `issueAuthorFilter` / `issueExcludeLabels` apply only when the resolved
  // tracker is a forge (github/gitlab); both are inert for plan/jira.
  'claim-work':          { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, claimFlow: true, simplify: true, issueAuthorFilter: 'self', issueExcludeLabels: [] } },
  'error-handling':      { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  'typing':              { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: false } },
  // Release-check inspects and mutates release state (for example, the main →
  // release PR) rather than producing source commits. It must run from the app's
  // live main checkout so its branch/ref checks describe the real release flow;
  // a CoS worktree hides that checkout and creates an irrelevant task branch.
  'release-check':       { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { ...RELEASE_CHECK_METADATA } },
  // stash-cleanup triages `git stash list` and drops what's superseded/stale,
  // leaving real unlanded work in place for the user to recover by hand. It
  // runs in the app's live checkout (never a CoS worktree — a stash is a
  // property of the checkout it was taken in) and, like the other coordinators,
  // ships no code of its own. On-demand only: unlike branch/issue reconcile,
  // there's no useful cadence for a stash a user hasn't necessarily touched
  // since the last run — they trigger it when they notice stash clutter.
  'stash-cleanup':       { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { ...NON_COMMITTING_COORDINATOR_METADATA } },
  // repo-sync sweeps EVERY managed app's checkout in one run (see the type list
  // above). Like stash-cleanup it runs in the live checkouts — a branch, a stash,
  // and a worktree are all properties of the checkout they live in, so a CoS
  // worktree would hide every one of them — and ships no code of its own.
  // On-demand: the user runs it when they want a clean slate, and a cadence would
  // switch branches under a checkout they may be sitting in. Every action toggle
  // is ON except `reapRemotes`, which DELETES branches on origin and so stays
  // opt-in even though the reconciler only ever reaps already-merged ones.
  'repo-sync':           { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { ...NON_COMMITTING_COORDINATOR_METADATA, syncPush: true, syncPull: true, switchDefault: true, cleanupMerged: true, dropStashes: true, reapRemotes: false, verifyMode: DEFAULT_REPO_SYNC_VERIFY_MODE } },
  'pr-reviewer':         { type: INTERVAL_TYPES.CUSTOM, intervalMs: 7200000, enabled: false, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { readOnly: true, pipeline: { stages: [{ name: 'Security Scan', promptKey: 'pr-reviewer-security', readOnly: true }, { name: 'Code Review & Merge', promptKey: 'pr-reviewer-review', readOnly: false }] } } },
  'code-reviewer-a':     { ...CODE_REVIEWER_INTERVAL },
  'code-reviewer-b':     { ...CODE_REVIEWER_INTERVAL },
  'jira-sprint-manager': { type: INTERVAL_TYPES.DAILY, enabled: false, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, simplify: true } },
  // jira-status-report posts its report to JIRA and edits nothing in the repo, so it
  // takes the shared non-committing-coordinator posture above. `readOnly: true` alone
  // was NOT enough: it skips worktree creation but leaves `openPR` free to be filled
  // from the app's `defaultOpenPR`, and the finalize-time PR-claim check reads
  // `metadata.openPR` directly — scoring a posted report as `pr-missing`.
  'jira-status-report':  { type: INTERVAL_TYPES.WEEKLY, enabled: false, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { ...NON_COMMITTING_COORDINATOR_METADATA, readOnly: true } },
  // do-replan audits PLAN.md after open PRs and stale branches have been cleaned up,
  // so the plan reflects what actually merged.
  'do-replan':           { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, runAfter: ['pr-reviewer', 'branch-reconcile'], taskMetadata: { useWorktree: true, openPR: true } },
  // Writable — the v2 reference-watch prompt (PROMPT_VERSIONS['reference-watch'] = 2)
  // instructs the agent to APPEND slug-tagged `[ref-watch-…]` checklist items to
  // PLAN.md and commit them. `readOnly: true` would inject the "do not modify or
  // commit files" guard into the system prompt and the agent would refuse to write
  // the PLAN entries — defeating the whole flow. Worktree off because the task body
  // itself reads from data/cos/reference-repos (managed clones the user can't
  // accidentally clobber) and the PLAN.md write is small enough that the in-place
  // commit on the source repo is simpler than a worktree round-trip. Mirrors the
  // on-commit trigger path in referenceRepos.js#triggerReferenceAnalysis.
  // `readOnly` is coupled to PROMPT_VERSIONS['reference-watch'] — see
  // REFERENCE_WATCH_AUDITED_VERSION above; bumping the prompt version requires
  // re-auditing this default (a guard test in taskSchedule.test.js enforces it).
  'reference-watch':     { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { readOnly: false } },
  // ux audits the RUNNING app UI. Defaults to filing tracker issues
  // (`fileIssues: true`); flip that off to implement. `readOnly: false` so the
  // PLAN.md path can commit checklist items / forge paths can `gh issue create`.
  // Off by default (AI Provider Usage Policy — enabling it is the user's consent
  // to a weekly browser-driving LLM run).
  'ux':                  { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false, readOnly: false } },
  // data-safety / simplify are the scheduled counterparts of the quota-burn
  // `data-safety-audit` and `simplify-audit` presets. New types default to
  // file-issues so an unattended enable doesn't land code. Off by default.
  'data-safety':         { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'simplify':            { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'api-contract':      { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'react-lifecycle':   { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'observability':     { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  'copy':                { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { fileIssues: true, useWorktree: false, openPR: false } },
  // pr-watcher polls for newly-opened PRs, so it runs on a short custom
  // interval rather than the loose rotation/daily cadence. 30 min keeps the
  // gh polling cheap while still reacting to a PR within one cycle. Default
  // gate is `prAuthorFilter: 'any'` (react to every PR); the operator narrows
  // it to 'self' or 'others' in the schedule UI. `readOnly: false` so a
  // customized prompt can make changes if the operator wants — the shipped
  // default prompt only reviews + comments.
  'pr-watcher':          { type: INTERVAL_TYPES.CUSTOM, intervalMs: 1800000, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { prAuthorFilter: 'any', readOnly: false } },
  // plan-feature files a plan, not code — tracker-filing posture mirrors
  // reference-watch: writable (a file-based tracker commits checklist items), no
  // managed worktree, no PR. Weekly (not daily like feature-ideas) so an
  // enabled run doesn't flood the tracker with plans — one filed plan per run.
  // runAfter do-replan so proposals are checked against the freshest available
  // work tracker before a new feature plan is filed.
  'plan-feature':         { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, dataInputs: ['product-requirements', 'project-goals', 'open-issues', 'open-pull-requests', 'closed-unmerged-pull-requests'], runAfter: ['do-replan'], taskMetadata: { useWorktree: false, openPR: false, readOnly: false } },
  // layered-intelligence is a programmatic-I/O task (agent-backed, hooked). Daily
  // by default; per-app scheduling (enabled/interval/provider/model) is set in the
  // Intelligence tab and stored on the app's taskTypeOverrides['layered-intelligence'].
  // No `prompt` field — the buildTaskInput hook renders the prompt (no
  // DEFAULT_TASK_PROMPTS entry, so the prompt-version machinery in loadSchedule
  // skips it). taskMetadata pins the throwaway-worktree posture: the reasoning
  // agent runs in a worktree that is discarded without a commit/merge/PR
  // (discardWorktree), so it can't land code — its `.agent-done` payload is the
  // only sanctioned output (consumed by the processTaskOutput hook).
  'layered-intelligence': { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: false, discardWorktree: true } }
};

// Agent-options that a task manages internally — UI locks the toggle, and
// loadSchedule/updateTaskInterval enforce the default value regardless of
// what's persisted or POSTed. The reasoning lives next to each task above
// (e.g., plan-task's prompt creates its own claim/<slug> worktree, so a
// CoS-managed worktree would clobber it).
export const MANAGED_AGENT_OPTIONS = {
  'plan-task': ['useWorktree', 'openPR', 'claimFlow'],
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
  'release-check': ['useWorktree', 'openPR', 'worktreeChangesExpected', 'slashdoCommand']
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

// Short human-readable blurb per task type, shown in the schedule UI's
// upcoming-tasks list. Every entry in SELF_IMPROVEMENT_TASK_TYPES must have a
// key here — a missing one falls back to a dasherized label ("claim work"),
// which reads as an orphaned/legacy task. A parity guard in taskSchedule.test.js
// fails the suite if the two ever drift apart.
export const TASK_TYPE_DESCRIPTIONS = {
  'ui-bugs': 'Find UI bugs — file issues or implement fixes',
  'mobile-responsive': 'Mobile/responsive audit — file issues or implement fixes',
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
  'issue-reconcile': "Heal zombie issues: open + in-progress but their PR already merged with no live claim — close + file a scoped follow-up when work remains, or release the claim so the queue re-picks it",
  'dependency-updates': 'Land or resolve open Dependabot/Renovate PRs, then update the dependencies they missed',
  'release-check': 'Check for release readiness',
  'error-handling': 'Failure-path audit — file issues or implement fixes',
  'typing': 'TypeScript types — file issues or implement fixes',
  'pr-reviewer': 'Review open PRs from contributors',
  'pr-watcher': 'Run a custom prompt on PRs newly opened against the default branch',
  'code-reviewer-a': 'Review the codebase and triage/implement findings (independent provider/model instance A)',
  'code-reviewer-b': 'Review the codebase and triage/implement findings (independent provider/model instance B)',
  'do-replan': 'Audit and prune PLAN.md after merges and branch cleanup so it reflects what actually shipped',
  'jira-sprint-manager': 'Triage and implement JIRA sprint tickets',
  'jira-status-report': 'Generate JIRA weekly status report',
  'reference-watch': 'Watch reference repos and append PLAN.md items for new upstream work',
  'ux': 'UX/design audit — file issues (default) or implement fixes',
  'data-safety': 'Data/upgrade-safety audit — file issues (default) or implement fixes',
  'simplify': 'Dead-code/duplication audit — file issues (default) or implement removals',
  'api-contract': 'API/route-contract audit — file issues (default) or implement fixes',
  'react-lifecycle': 'React lifecycle/state audit — file issues (default) or implement fixes',
  'observability': 'Logging/observability audit — file issues (default) or implement fixes',
  'copy': 'Copy/text-clarity audit — file issues (default) or implement rewrites',
  'stash-cleanup': 'Triage git stash list — drop entries superseded by or stale relative to main, leave real unlanded work in place',
  'repo-sync': 'Sync every managed app with origin — back on the default branch, pushed and pulled, merged branches/worktrees and redundant stashes cleared',
  'plan-feature': "Brainstorm one feature and file its decision-complete plan to the app's work tracker (no code)",
  'layered-intelligence': "Read this app's goals + telemetry, ask a reasoning model for one improvement, and file one deduplicated tracker issue — no code, no agent"
};

export function getTaskTypeDescription(taskType) {
  return TASK_TYPE_DESCRIPTIONS[taskType] || taskType.replace(/-/g, ' ');
}
