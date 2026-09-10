/** Registered scheduled task names, kept separate from schedule configuration. */
import { PRIVATE_SECURITY_TASK_TYPE } from './privateSecurityPolicy.js';
import { PROGRAMMATIC_SCHEDULED_TASK_TYPES } from './taskTargetScope.js';

export const SELF_IMPROVEMENT_TASK_TYPES = [
  PRIVATE_SECURITY_TASK_TYPE,
  'model-comparison-refresh',
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
  // Programmatically scans new external issue comments and unreviewed external
  // PRs. Only replies and code-review judgments consume an agent; assignment,
  // review submission, rebase/CI policy enforcement, and merging are hooks.
  'issue-watcher',
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
  // Quota-burn `simplify-audit` counterpart. Dead code, unused exports,
  // copy-paste drift, and YAGNI (speculative abstractions) — distinct from
  // `code-quality` (conventional defects: magic values, brittle conditionals,
  // convention violations). Defaults to file-issues.
  'simplify',
  // Structural-maintainability audit. Treats complexity thresholds as candidate
  // signals, then proves responsibility, reuse, or discoverability impact before
  // filing. Direct remediation is isolated in a managed worktree.
  'module-hygiene',
  // Quota-burn `api-contract-audit` counterpart. Route validation, client/server
  // drift, status envelopes, and missing `asyncHandler`. Defaults to file-issues.
  'api-contract',
  // Quota-burn `react-lifecycle-audit` counterpart. Effect teardowns, stale
  // closures, and post-unmount state — distinct from `ui-bugs` (console errors)
  // and `accessibility`. Defaults to file-issues.
  'react-lifecycle',
  // Quota-burn `observability-audit` counterpart. Silent catches, log noise, and
  // errors logged without the context needed to reproduce them. Files under the
  // `code-quality` category and the `observability` metric label. Defaults to file-issues.
  'observability',
  // Quota-burn `copy-audit` counterpart. User-facing wording only — jargon,
  // ambiguous action verbs, dead-end error text. Files under the `ux` category
  // and the `copy` metric label; narrower than the `ux` audit, which walks the
  // running UI. File-issues.
  'copy',
  // The six lanes below complete the scheduled counterparts of the slashdo
  // `do:better` audit lenses (DO_BETTER_LENS_COVERAGE in lib/auditCatalog.js),
  // so every category of app quality can be scheduled on its own cadence
  // instead of fanning eight sub-agents out of one command run.
  // Measured branching per function — ranks the hottest high-complexity
  // functions by churn and reduces them with a named transformation. The
  // structural cousin of `module-hygiene` (which owns responsibility and
  // ownership, and only uses complexity as a candidate signal). Remediation
  // is a mechanical refactor of hot code, so do-work is worktree-isolated.
  'better-complexity',
  // Reader cost no metric catches: mixed abstraction levels, flag arguments,
  // misleading names, action at a distance. Sibling of `better-complexity`.
  'better-cognitive-load',
  // Carved out of `code-quality` v3: derived artifacts kept as a second
  // source of truth, hand-synchronized registries, incidental-layout
  // coupling. Files under `code-quality` plus the `structural-drift` metric
  // label; do-work is worktree-isolated.
  'better-structural-drift',
  // Latent defects found by reading source: missing awaits, unhandled
  // rejections, unguarded null access, resource leaks, races, unbounded
  // reads. Distinct from `console-errors` (observed at runtime),
  // `error-handling` (failure paths + resilience) and `react-lifecycle`
  // (component effects). Files under `bug` plus the `runtime-safety` metric label.
  'better-runtime-safety',
  // Third-party dependency NECESSITY (the `do:depfree` lens) — replace
  // micro-packages and native-API wrappers with in-repo code. Distinct from
  // `dependency-updates`, which bumps what stays. Worktree-isolated do-work.
  'better-dependency-freedom',
  // Tests that prove nothing: assert on mocks, can never fail, re-implement
  // the code under test, or duplicate a stronger boundary test. Distinct from
  // `test-coverage`, which owns the GAPS. Files under `tests` plus the
  // `test-quality` metric label.
  'better-test-quality',
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
  // user-action-review reads the machine-local operator-action ledger
  // (services/userActions.js) for repeated manual work — Run Now on the same
  // schedule type over and over, near-duplicate task prompts, negative feedback
  // clusters, settings churn — and PROPOSES automations as filed tracker issues
  // (default) or queued CoS tasks. It never edits settings or schedules itself.
  // Install-wide: the ledger records PortOS-operator activity, not one managed
  // app's tree. Its buildTaskInput hook (userActionReviewHooks.js) skips the
  // dispatch entirely when the ledger is empty, so no provider call is burned.
  'user-action-review',
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
  // The two PROGRAMMATIC handlers (services/scheduledHandlers/) — the only
  // scheduled types PortOS executes ITSELF, with no agent, no CoS task, and no
  // spawn slot. They fill blank universe-bible sheets and render the entries
  // that have no image, using the same domain services the Universe Builder's
  // own buttons call. Install-wide (a universe is not a managed app's repo —
  // see `requiresInstallWideTarget`) and ON_DEMAND with no interval, so they are
  // never clock-due and a fresh install spends nothing until the user runs one.
  // Quota Burn reaches the SAME handlers through `quotaBurnInvoke.js`; there
  // is one implementation, not two.
  ...PROGRAMMATIC_SCHEDULED_TASK_TYPES,
  // NOTE: `quota-burn` used to live here as a per-app perpetual task type. It is
  // now ONE install-level loop (services/quotaBurnRunner.js) configured on the
  // Quota Burn page — the burn plan is machine-local, and its jobs name which
  // managed app (if any) the work targets. Migration 221 moves existing per-app
  // overrides across; do not re-add it as a scheduled type.
];
