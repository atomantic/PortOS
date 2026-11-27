/**
 * Registered scheduled task names (`SELF_IMPROVEMENT_TASK_TYPES`) shared by schedule config and skill routing.
 *
 * Also re-exports the retired-name map (`TASK_TYPE_RENAMES`, `currentTaskTypeName`, `taskExecutionKey`)
 * for tasks and records written before a task rename.
 */
import { ACTIVE_AUDIT_DOMAIN_IDS, auditDomainFor } from './auditDomains.js';
import { PRIVATE_SECURITY_TASK_TYPE } from './privateSecurityPolicy.js';
import { currentTaskTypeName } from './taskTypeRenames.js';
import { PROGRAMMATIC_SCHEDULED_TASK_TYPES } from './taskTargetScope.js';

export { AUDIT_DOMAIN_ALIASES, auditDomainFor } from './auditDomains.js';
export { TASK_TYPE_RENAMES, currentTaskTypeName } from './taskTypeRenames.js';

export const taskExecutionKey = (taskType) => `task:${auditDomainFor(currentTaskTypeName(taskType.startsWith('task:') ? taskType.slice(5) : taskType))}`;

export const SELF_IMPROVEMENT_TASK_TYPES = [
  ...ACTIVE_AUDIT_DOMAIN_IDS,
  PRIVATE_SECURITY_TASK_TYPE,
  'model-comparison-refresh',
  'branch-reconcile', 'issue-reconcile', 'dependency-updates', 'feature-ideas',
  'plan-task', 'claim-issue', 'claim-work', 'do-release', 'pr-reviewer',
  'code-reviewer-a', 'code-reviewer-b', 'jira-sprint-manager', 'jira-status-report',
  'do-replan', 'pr-watcher', 'issue-watcher', 'reference-watch',
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
