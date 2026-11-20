/**
 * Registered scheduled task names (`SELF_IMPROVEMENT_TASK_TYPES`) shared by schedule config and skill routing.
 *
 * Also re-exports the retired-name map (`TASK_TYPE_RENAMES`, `currentTaskTypeName`, `taskExecutionKey`)
 * for tasks and records written before a task rename.
 */
import { CONSOLIDATED_AUDIT_DOMAINS } from './auditDomains.js';
import { PRIVATE_SECURITY_TASK_TYPE } from './privateSecurityPolicy.js';
import { currentTaskTypeName } from './taskTypeRenames.js';
import { PROGRAMMATIC_SCHEDULED_TASK_TYPES } from './taskTargetScope.js';

export { AUDIT_DOMAIN_ALIASES, auditDomainFor } from './auditDomains.js';
export { TASK_TYPE_RENAMES, currentTaskTypeName } from './taskTypeRenames.js';

export const taskExecutionKey = (taskType) => `task:${currentTaskTypeName(taskType.startsWith('task:') ? taskType.slice(5) : taskType)}`;

export const SELF_IMPROVEMENT_TASK_TYPES = [
  ...Object.keys(CONSOLIDATED_AUDIT_DOMAINS),
  PRIVATE_SECURITY_TASK_TYPE,
  'model-comparison-refresh',
  'security', 'code-quality', 'test-coverage', 'performance',
  'accessibility', 'branch-reconcile', 'issue-reconcile', 'console-errors', 'dependency-updates', 'documentation',
  'ui-bugs', 'mobile-responsive', 'feature-ideas', 'plan-task', 'claim-issue', 'claim-work', 'error-handling',
  'typing', 'do-release', 'pr-reviewer', 'code-reviewer-a', 'code-reviewer-b',
  'jira-sprint-manager', 'jira-status-report', 'do-replan',
  // `taskMetadata.prAuthorFilter` gates on PR authorship (self / others / any). See services/prWatcher.js.
  'pr-watcher',
  // Only replies and code-review judgments consume an agent; assignment, review
  // submission, rebase/CI policy enforcement and merging are programmatic hooks.
  'issue-watcher',
  // Files proposals in the app's tracker from `referenceRepos` commits; edits no source.
  'reference-watch',
  // Narrower than its siblings: raw console errors belong to `ui-bugs`, viewport
  // breakage to `mobile-responsive`, ARIA/contrast/keyboard to `accessibility`.
  'ux', 'design',
  'data-safety',
  // Dead code, unused exports, copy-paste drift, YAGNI; `code-quality` owns conventional defects.
  'simplify',
  // Process/validation machinery whose cost exceeds its demonstrated harm; `simplify` owns code with no behavior.
  'over-engineering',
  'module-hygiene',
  'api-contract',
  // Distinct from `ui-bugs` (console errors) and `accessibility`.
  'ui-lifecycle',
  'observability',
  'copy',
  // The `better-*` missions map onto slashdo `do:better` scopes through
  // DO_BETTER_SCOPE_COVERAGE in lib/auditCatalog.js and schedule independently.
  // Structural cousin of `module-hygiene`; do-work is worktree-isolated.
  'better-complexity',
  'better-cognitive-load',
  'better-structural-drift',
  'better-runtime-safety',
  // Server-side counterpart of `ui-bugs`; `better-runtime-safety` owns code-shape defects.
  'app-bugs',
  // Dependency necessity (the `do:depfree` lens); `dependency-updates` bumps what stays.
  'better-dependency-freedom',
  // Tests that prove nothing; `test-coverage` owns the gaps.
  'better-test-quality',
  'better-dev-environment',
  // Service/data-platform lenses. `infrastructure` is gated on IaC/container/CI files;
  // the rest apply to any service and report `not-applicable` otherwise.
  'infrastructure',
  // Runtime data correctness; `data-safety` owns upgrade/migration/destructive-default risk.
  'data-integrity',
  // Distinct from `error-handling`, which owns per-call timeouts and retries.
  'reliability',
  'privacy',
  'cost-efficiency',
  'feature-completeness',
  // Distinct from `ui-bugs` (one click on a fresh page) and `error-handling`.
  'workflow-recovery',
  // Executes migrations and a backup restore against scratch installs; `data-safety` reads the same code statically.
  'upgrade-rehearsal',
  // On-demand only; non-committing coordinator posture. See DEFAULT_TASK_PROMPTS['stash-cleanup'].
  'stash-cleanup',
  // Install-wide git hygiene. services/repoSync.js does the provable work with no LLM call and
  // dispatches ONE coordinator agent only when something needs judgment (or, under the default
  // `verifyMode: 'when-changed'`, to double-check a run that mutated something). On-demand and
  // GLOBAL: 'Run Now' with no app sweeps the whole install. Non-committing coordinator posture.
  'repo-sync',
  // Planning-only sibling of `feature-ideas`: never implements, files ONE plan through
  // {trackerInstructions} (TRACKER_FILING_PRESETS['plan-feature']).
  'plan-feature',
  // Always-filing research type (TRACKER_FILING_PRESETS), like plan-feature.
  'media-render-research',
  // Proposes automations from the machine-local operator-action ledger (services/userActions.js);
  // never edits settings or schedules itself. Install-wide. Its buildTaskInput hook
  // (userActionReviewHooks.js) skips dispatch when the ledger is empty so no provider call is burned.
  'user-action-review',
  // buildTaskInput (errorLogTriageHooks.js) does the whole pass deterministically and never spawns an agent.
  'error-log-triage',
  // PROGRAMMATIC-I/O task: a normal reasoning agent runs in a THROWAWAY worktree (discardWorktree,
  // never committed/merged) between buildTaskInput (prompt) and processTaskOutput (validates the
  // `.agent-done` payload, dedups, files ONE issue), so its only channel out is the structured payload.
  // Scheduling lives in the per-app taskTypeOverrides, behavior in app.layeredIntelligence. No
  // DEFAULT_TASK_PROMPTS entry. See taskTypeHooks.js + autonomousJobs/layeredIntelligenceHooks.js.
  'layered-intelligence',
  // Programmatic handlers (services/scheduledHandlers/) PortOS executes itself: no agent, CoS task or
  // spawn slot. Install-wide (see `requiresInstallWideTarget`) and ON_DEMAND with no interval, so a
  // fresh install spends nothing until the user runs one. Quota Burn reaches the same handlers via
  // `quotaBurnInvoke.js`.
  ...PROGRAMMATIC_SCHEDULED_TASK_TYPES,
  // Do not re-add `quota-burn` as a scheduled type: it is one install-level loop
  // (services/quotaBurnRunner.js) configured on the Quota Burn page.
];
