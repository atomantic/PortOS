/**
 * Task Schedule Service (v2 - Unified)
 *
 * Manages configurable intervals for improvement tasks across all apps (including PortOS).
 * All task types live in a single `tasks` object — no more selfImprovement/appImprovement split.
 *
 * Interval types:
 * - 'rotation': Run as part of normal rotation (default)
 * - 'daily': Run once per day
 * - 'weekly': Run once per week
 * - 'once': Run once per app/globally then stop
 * - 'on-demand': Only run when manually triggered
 * - 'custom': Custom interval in milliseconds
 * - 'cron': Cron expression schedule
 * - 'perpetual': Drain actionable work back-to-back (re-queue on completion)
 *   until a programmatic work-detector reports nothing actionable, then PARK
 *   on a recheck cadence (`recheckCron` / `recheckIntervalMs`, default daily).
 *   See server/services/perpetualWork.js for the detector registry and the
 *   perpetual gate in cosTaskGenerator.generateManagedAppImprovementTaskForType.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { cosEvents, emitLog } from './cosEvents.js';
import { atomicWrite, DAY, ensureDir, HOUR, readJSONFile, PATHS, safeDate } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { getAdaptiveCooldownMultiplier } from './taskLearning.js';
import { isTaskTypeEnabledForApp, getAppTaskTypeInterval, getAppTaskTypeIntervalMs, getActiveApps, getAppTaskTypeOverrides, clearAllPrWatcherState } from './apps.js';
import { loadState, isImprovementEnabled } from './cosState.js';
import { getUserTimezone, getLocalParts } from '../lib/timezone.js';
import { parseCronToNextRun, parseCronToPrevRun } from './eventScheduler.js';
// The prompt catalog + compat constants live in the taskPromptDefaults.js data
// leaf (issue #1083); the prompt getters live in taskPromptService.js (split
// out in issue #744). loadSchedule()/getScheduleStatus() below consume the
// prompt-version machinery (DEFAULT_TASK_PROMPTS / PROMPT_VERSIONS /
// PREVIOUS_DEFAULT_PROMPTS) for the auto-upgrade path, so import those from the
// leaf here. Importing from the leaf (not taskPromptService) is what keeps the
// graph acyclic: taskPromptService imports getTaskInterval from THIS module, so
// this module must not import taskPromptService back. PROMPT_VERSIONS and
// REFERENCE_WATCH_AUDITED_VERSION are part of taskSchedule.js's public API
// (consumers import them from here), so they're re-exported below;
// DEFAULT_TASK_PROMPTS and PREVIOUS_DEFAULT_PROMPTS stay internal.
import {
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  REFERENCE_WATCH_AUDITED_VERSION,
  PREVIOUS_DEFAULT_PROMPTS
} from './taskPromptDefaults.js';

// Re-export the prompt-version constants so existing importers of taskSchedule.js
// are unaffected. The prompt GETTERS (getDefaultPrompt / getTaskPrompt /
// getStagePrompt) moved to taskPromptService.js and are NO LONGER re-exported
// here — import them from './taskPromptService.js' directly (re-exporting them
// would re-form the taskSchedule ⇄ taskPromptService cycle this split removed).
export { PROMPT_VERSIONS, REFERENCE_WATCH_AUDITED_VERSION };

const DATA_DIR = PATHS.cos;
const SCHEDULE_FILE = join(DATA_DIR, 'task-schedule.json');

// Interval type constants
export const INTERVAL_TYPES = {
  ROTATION: 'rotation',      // Default: runs in normal task rotation
  DAILY: 'daily',            // Runs once per day
  WEEKLY: 'weekly',          // Runs once per week
  ONCE: 'once',              // Runs once per app or globally
  ON_DEMAND: 'on-demand',    // Only runs when manually triggered
  CUSTOM: 'custom',          // Custom interval in milliseconds
  CRON: 'cron',              // Cron expression schedule
  PERPETUAL: 'perpetual'     // Drain back-to-back until a work-detector idles, then park on a recheck cadence
};

const WEEK = 7 * DAY;

// Default cadence a parked perpetual task waits before re-probing its
// work-detector, when neither `recheckCron` nor `recheckIntervalMs` is set.
const DEFAULT_PERPETUAL_RECHECK_MS = DAY;

/**
 * Get learning-adjusted interval for a task type
 */
async function getPerformanceAdjustedInterval(taskType, baseIntervalMs) {
  const taskTypeKey = `task:${taskType}`;

  const cooldownInfo = await getAdaptiveCooldownMultiplier(taskTypeKey).catch(() => ({
    multiplier: 1.0,
    reason: 'error-fallback',
    skip: false,
    successRate: null,
    completed: 0
  }));

  if (cooldownInfo.reason === 'insufficient-data' || cooldownInfo.reason === 'error-fallback') {
    // Also check legacy keys for migration period
    const legacyKeys = [`self-improve:${taskType}`, `app-improve:${taskType}`];
    for (const key of legacyKeys) {
      const legacyInfo = await getAdaptiveCooldownMultiplier(key).catch(() => null);
      if (legacyInfo && legacyInfo.reason !== 'insufficient-data' && legacyInfo.reason !== 'error-fallback') {
        const adjustedIntervalMs = Math.round(baseIntervalMs * legacyInfo.multiplier);
        return {
          adjustedIntervalMs,
          multiplier: legacyInfo.multiplier,
          reason: legacyInfo.reason,
          successRate: legacyInfo.successRate,
          dataPoints: legacyInfo.completed,
          skip: legacyInfo.skip,
          adjusted: legacyInfo.multiplier !== 1.0,
          recommendation: legacyInfo.recommendation
        };
      }
    }

    return {
      adjustedIntervalMs: baseIntervalMs,
      multiplier: 1.0,
      reason: cooldownInfo.reason,
      successRate: null,
      dataPoints: cooldownInfo.completed || 0,
      adjusted: false
    };
  }

  const adjustedIntervalMs = Math.round(baseIntervalMs * cooldownInfo.multiplier);

  if (cooldownInfo.multiplier !== 1.0) {
    const direction = cooldownInfo.multiplier < 1 ? 'decreased' : 'increased';
    const percentage = Math.abs(Math.round((1 - cooldownInfo.multiplier) * 100));
    emitLog('debug', `Learning: ${taskType} interval ${direction} by ${percentage}% (${cooldownInfo.successRate}% success rate)`, {
      taskType,
      multiplier: cooldownInfo.multiplier,
      successRate: cooldownInfo.successRate,
      dataPoints: cooldownInfo.completed
    }, '📊 TaskSchedule');
  }

  return {
    adjustedIntervalMs,
    multiplier: cooldownInfo.multiplier,
    reason: cooldownInfo.reason,
    successRate: cooldownInfo.successRate,
    dataPoints: cooldownInfo.completed,
    skip: cooldownInfo.skip,
    adjusted: cooldownInfo.multiplier !== 1.0,
    recommendation: cooldownInfo.recommendation
  };
}

// Unified default interval settings for all task types
export const SELF_IMPROVEMENT_TASK_TYPES = [
  'security', 'code-quality', 'test-coverage', 'performance',
  'accessibility', 'branch-cleanup', 'branch-reconcile', 'issue-reconcile', 'console-errors', 'dependency-updates', 'documentation',
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
  // PortOS-only: researches the current best local LLMs per category and
  // refreshes the bundled suggested-models catalog (server/lib/localLlmCatalog.js)
  // + the editorial family ranking (server/lib/localModelHeuristics.js), opening a
  // PR. No-ops on any repo lacking that catalog file, so enabling it on a
  // non-PortOS app does nothing. See DEFAULT_TASK_PROMPTS['refresh-local-llm-catalog'].
  'refresh-local-llm-catalog',
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
  'layered-intelligence'
];

// Shared config for code-reviewer-a and code-reviewer-b (two instances for independent provider/model configuration)
const CODE_REVIEWER_INTERVAL = { type: INTERVAL_TYPES.WEEKLY, enabled: false, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, simplify: true, pipeline: { stages: [{ name: 'Codebase Review', promptKey: 'code-reviewer-review', readOnly: true, providerId: null, model: null, precondition: { fileNotExists: 'REVIEW.md' } }, { name: 'Triage & Implement', promptKey: 'code-reviewer-implement', readOnly: false, providerId: null, model: null, precondition: { fileExists: 'REVIEW.md' } }] } } };

export const DEFAULT_TASK_INTERVALS = {
  'security':            { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'code-quality':        { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null },
  'test-coverage':       { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'performance':         { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'accessibility':       { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null },
  'branch-cleanup':      { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  // branch-reconcile finishes THIS machine's in-flight LOCAL branches per app
  // (open a PR for pushed-but-unopened work, resolve merge conflicts, drive the
  // review loop, auto-merge when green) AFTER a deterministic pass that removes
  // fully-merged orphaned branches + their worktrees. PERPETUAL (drain-until-done):
  // the generator runs the deterministic reconcile every dispatch, and dispatches
  // the coordinator agent only while actionable in-flight branches remain — then
  // PARKS on the daily recheckCron. The action toggles (cleanupMerged / openPr /
  // resolveConflicts / autoMerge) are per-app taskMetadata booleans (each ON
  // unless explicitly false). useWorktree/openPR are LOCKED off (MANAGED_AGENT_OPTIONS):
  // the coordinator runs in the app's live checkout so it can see + operate on the
  // sibling worktrees; a CoS-managed worktree would hide the branches and could
  // trigger cleanupAgentWorktree's auto-merge. Off by default — enabling it is the
  // user's explicit consent to let it drive PRs on a schedule.
  'branch-reconcile':    { type: INTERVAL_TYPES.PERPETUAL, enabled: false, providerId: null, model: null, prompt: null, recheckCron: '0 3 * * *', taskMetadata: { useWorktree: false, openPR: false, cleanupMerged: true, openPr: true, resolveConflicts: true, autoMerge: true } },
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
  // useWorktree/openPR are LOCKED off (MANAGED_AGENT_OPTIONS): the coordinator
  // works over `gh` (no code changes, no worktree). Off by default — enabling it
  // is the user's explicit consent to let it mutate issue state on a schedule.
  'issue-reconcile':     { type: INTERVAL_TYPES.PERPETUAL, enabled: false, providerId: null, model: null, prompt: null, recheckCron: '0 4 * * *', taskMetadata: { useWorktree: false, openPR: false, autoClose: true } },
  'console-errors':      { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null },
  'dependency-updates':  { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'documentation':       { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null },
  'ui-bugs':             { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null },
  'mobile-responsive':   { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null },
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
  // The agent runs in the source repo's working directory; `git worktree add` doesn't touch that working tree, so it's safe even with uncommitted user changes.
  'plan-task':           { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, simplify: true } },
  // claim-issue drives the /claim --issues flow — the agent creates its OWN
  // claim/issue-<num> worktree, opens the PR (Closes #<num>), merges via
  // `gh pr merge`, and cleans up. Both `useWorktree` and `openPR` are OFF on the
  // CoS side for the SAME reasons as plan-task (a CoS-managed worktree under
  // cos/<task>/<agent> would hide the issue-<num> slug from the in-flight scan
  // and trigger cleanupAgentWorktree's auto-merge into the source repo's HEAD).
  // `issueAuthorFilter` gates which issues are claimable: 'self' (default, the
  // slashdo `/do:next --self` security boundary) only claims issues YOU filed
  // (`@me`); 'owner' only claims issues the repo owner filed; 'any' claims any
  // open issue. Per-app override supported via taskTypeOverrides.
  'claim-issue':         { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, simplify: true, issueAuthorFilter: 'self' } },
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
  // `issueAuthorFilter` applies only when the resolved tracker is a forge
  // (github/gitlab); it's inert for plan/jira.
  'claim-work':          { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, simplify: true, issueAuthorFilter: 'self' } },
  'error-handling':      { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null },
  'typing':              { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null },
  'release-check':       { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null },
  'pr-reviewer':         { type: INTERVAL_TYPES.CUSTOM, intervalMs: 7200000, enabled: false, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { readOnly: true, pipeline: { stages: [{ name: 'Security Scan', promptKey: 'pr-reviewer-security', readOnly: true }, { name: 'Code Review & Merge', promptKey: 'pr-reviewer-review', readOnly: false }] } } },
  'code-reviewer-a':     { ...CODE_REVIEWER_INTERVAL },
  'code-reviewer-b':     { ...CODE_REVIEWER_INTERVAL },
  'jira-sprint-manager': { type: INTERVAL_TYPES.DAILY, enabled: false, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, simplify: true } },
  'jira-status-report':  { type: INTERVAL_TYPES.WEEKLY, enabled: false, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { readOnly: true } },
  // do-replan audits PLAN.md after open PRs and stale branches have been cleaned up,
  // so the plan reflects what actually merged.
  'do-replan':           { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, runAfter: ['pr-reviewer', 'branch-cleanup'], taskMetadata: { useWorktree: true, openPR: true } },
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
  // pr-watcher polls for newly-opened PRs, so it runs on a short custom
  // interval rather than the loose rotation/daily cadence. 30 min keeps the
  // gh polling cheap while still reacting to a PR within one cycle. Default
  // gate is `prAuthorFilter: 'any'` (react to every PR); the operator narrows
  // it to 'self' or 'others' in the schedule UI. `readOnly: false` so a
  // customized prompt can make changes if the operator wants — the shipped
  // default prompt only reviews + comments.
  'pr-watcher':          { type: INTERVAL_TYPES.CUSTOM, intervalMs: 1800000, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { prAuthorFilter: 'any', readOnly: false } },
  // refresh-local-llm-catalog maintains PortOS's own bundled suggested-models
  // catalog. CoS manages the worktree + PR (like feature-ideas/do-replan) — the
  // agent only edits the catalog file. Weekly is generous; the prompt only opens
  // a PR when the catalog is actually stale, so most runs are no-ops. Off by
  // default; the user enables it on the PortOS app.
  'refresh-local-llm-catalog': { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, simplify: true } },
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
  'plan-task': ['useWorktree', 'openPR'],
  // branch-reconcile's coordinator MUST run in the app's live checkout (never a
  // CoS-managed worktree) so it can enumerate + operate on the sibling worktrees
  // of the in-flight branches; a managed worktree would hide those branches from
  // the scan AND could trip cleanupAgentWorktree's auto-merge. Lock both off.
  'branch-reconcile': ['useWorktree', 'openPR'],
  // issue-reconcile's coordinator works purely over `gh` (issue label/state +
  // follow-up filing) — it makes no code changes, so it needs neither a worktree
  // nor a PR. Lock both off so a hand-edited config can't attach one.
  'issue-reconcile': ['useWorktree', 'openPR'],
  // claim-issue's prompt creates its own claim/issue-<num> worktree (same
  // rationale as plan-task), so CoS must not pre-create one or open the PR.
  'claim-issue': ['useWorktree', 'openPR'],
  // claim-work delegates to one of the above prompt bodies, each of which
  // creates its own worktree + PR — so the same lock applies to the router.
  'claim-work': ['useWorktree', 'openPR']
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

function enforceManagedAgentOptions(taskType, config) {
  const managed = MANAGED_AGENT_OPTIONS[taskType];
  if (!managed || !config) return false;
  const defaults = DEFAULT_TASK_INTERVALS[taskType]?.taskMetadata || {};
  let changed = false;
  // If the stored config explicitly cleared taskMetadata (or never had it),
  // we still need the managed fields present — otherwise upstream resolvers
  // (e.g., cos.js applyAppWorktreeDefault) can flip them on via app defaults.
  if (!config.taskMetadata || typeof config.taskMetadata !== 'object') {
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

/**
 * Default schedule data structure (v2 - unified)
 */
const DEFAULT_SCHEDULE = {
  version: 2,
  lastUpdated: null,

  // Unified task intervals (applies to all apps including PortOS)
  tasks: {
    ...DEFAULT_TASK_INTERVALS
  },

  // Track last execution times
  // Format: 'task:security': { lastRun: timestamp, count: number, perApp: {} }
  executions: {},

  // On-demand task templates that can be triggered manually
  templates: []
};

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await ensureDir(DATA_DIR);
  }
}

/**
 * Migrate v1 schedule (selfImprovement + appImprovement) to v2 (unified tasks)
 */
function migrateScheduleV1toV2(schedule) {
  emitLog('info', 'Migrating task schedule from v1 to v2 (unified)', {}, '📅 TaskSchedule');

  const migrated = {
    version: 2,
    lastUpdated: new Date().toISOString(),
    tasks: { ...DEFAULT_TASK_INTERVALS },
    executions: {},
    templates: schedule.templates || [],
    onDemandRequests: schedule.onDemandRequests || []
  };

  // Merge selfImprovement settings into tasks (excluding cos-enhancement)
  if (schedule.selfImprovement) {
    for (const [taskType, config] of Object.entries(schedule.selfImprovement)) {
      if (taskType === 'cos-enhancement') continue; // Removed
      // security stays as 'security' (was already named this in selfImprovement)
      if (migrated.tasks[taskType]) {
        migrated.tasks[taskType] = { ...migrated.tasks[taskType], ...config };
      }
    }
  }

  // Merge appImprovement settings into tasks
  if (schedule.appImprovement) {
    for (const [taskType, config] of Object.entries(schedule.appImprovement)) {
      // Rename security-audit → security
      const unifiedType = taskType === 'security-audit' ? 'security' : taskType;
      if (migrated.tasks[unifiedType]) {
        // If selfImprovement already set a non-default config, prefer it for overlapping types
        // unless appImprovement has a different non-default config
        const existing = migrated.tasks[unifiedType];
        const isExistingDefault = existing.type === DEFAULT_TASK_INTERVALS[unifiedType]?.type;
        const isNewDifferent = config.type !== (taskType === 'security-audit'
          ? INTERVAL_TYPES.WEEKLY : DEFAULT_TASK_INTERVALS[unifiedType]?.type);
        if (isExistingDefault || isNewDifferent) {
          migrated.tasks[unifiedType] = { ...existing, ...config };
        }
      }
    }
  }

  // Migrate execution keys: self-improve:X → task:X, app-improve:X → task:X
  if (schedule.executions) {
    for (const [key, data] of Object.entries(schedule.executions)) {
      let newKey = key;
      if (key.startsWith('self-improve:')) {
        const taskType = key.replace('self-improve:', '');
        if (taskType === 'cos-enhancement') continue; // Removed
        newKey = `task:${taskType}`;
      } else if (key.startsWith('app-improve:')) {
        let taskType = key.replace('app-improve:', '');
        if (taskType === 'security-audit') taskType = 'security';
        newKey = `task:${taskType}`;
      }

      if (migrated.executions[newKey]) {
        // Merge: combine counts, keep latest lastRun, merge perApp
        const existing = migrated.executions[newKey];
        existing.count = (existing.count || 0) + (data.count || 0);
        if (data.lastRun && (!existing.lastRun || new Date(data.lastRun) > new Date(existing.lastRun))) {
          existing.lastRun = data.lastRun;
        }
        if (data.perApp) {
          existing.perApp = { ...existing.perApp, ...data.perApp };
        }
      } else {
        migrated.executions[newKey] = { ...data };
      }
    }
  }

  // Populate prompts from defaults if missing
  for (const [taskType, config] of Object.entries(migrated.tasks)) {
    if (!config.prompt && DEFAULT_TASK_PROMPTS[taskType]) {
      config.prompt = DEFAULT_TASK_PROMPTS[taskType];
    }
  }

  return migrated;
}

// True when a stored prompt byte-matches a shipped default for this task — the
// current default or any prior one in PREVIOUS_DEFAULT_PROMPTS. Used by
// loadSchedule both to recognize legacy (unversioned) prompts and to self-heal a
// prompt mis-flagged as customized. A genuine user edit never byte-matches a
// shipped default, so callers can treat a match as "not really customized".
function promptMatchesShippedDefault(prompt, taskType) {
  if (!prompt || !DEFAULT_TASK_PROMPTS[taskType]) return false;
  return (
    prompt === DEFAULT_TASK_PROMPTS[taskType] ||
    (PREVIOUS_DEFAULT_PROMPTS[taskType] || []).includes(prompt)
  );
}

/**
 * Load schedule data (auto-migrates from v1 if needed)
 */
export async function loadSchedule() {
  await ensureDataDir();

  const loaded = await readJSONFile(SCHEDULE_FILE, null);
  if (!loaded) {
    return { ...DEFAULT_SCHEDULE };
  }

  // Auto-migrate v1 → v2
  if (!loaded.version || loaded.version === 1) {
    const migrated = migrateScheduleV1toV2(loaded);
    await saveSchedule(migrated);
    return migrated;
  }

  // v2: merge each task config with its default to backfill new fields
  // Deep-merge taskMetadata so new default keys are inherited unless explicitly overridden
  const mergedTasks = {};
  for (const taskType of Object.keys(DEFAULT_TASK_INTERVALS)) {
    const defaultTask = DEFAULT_TASK_INTERVALS[taskType];
    const loadedTask = loaded.tasks?.[taskType] || {};
    const merged = { ...defaultTask, ...loadedTask };
    // Deep-merge taskMetadata: preserve explicit null (clears metadata), otherwise merge defaults with stored
    // Only spread if loadedTask.taskMetadata is a plain object to avoid corrupting config
    if (defaultTask.taskMetadata && loadedTask.taskMetadata !== null) {
      const storedMeta = loadedTask.taskMetadata;
      merged.taskMetadata = { ...defaultTask.taskMetadata, ...(isPlainObject(storedMeta) ? storedMeta : {}) };
    }
    mergedTasks[taskType] = merged;
  }
  // Preserve any extra task types from loaded that aren't in defaults
  for (const taskType of Object.keys(loaded.tasks || {})) {
    if (!mergedTasks[taskType]) {
      mergedTasks[taskType] = loaded.tasks[taskType];
    }
  }

  const schedule = {
    ...DEFAULT_SCHEDULE,
    ...loaded,
    tasks: mergedTasks,
    executions: loaded.executions || {},
    templates: loaded.templates || []
  };

  // Populate prompts from defaults if missing, and auto-upgrade stale defaults
  let needsSave = false;
  for (const [taskType, config] of Object.entries(schedule.tasks)) {
    if (enforceManagedAgentOptions(taskType, config)) needsSave = true;
    // Stamp a creation timestamp the first time we see a task so the cron
    // catch-up bound (shouldRunTask) never replays a slot that predates the
    // task. Backfilling to "now" is conservative: it only suppresses catch-up
    // for slots already in the past — future slots fire on their real cadence.
    if (!config.createdAt) {
      config.createdAt = new Date().toISOString();
      needsSave = true;
    }
    if (!config.prompt && DEFAULT_TASK_PROMPTS[taskType]) {
      // No prompt set — initialize with current default and version
      config.prompt = DEFAULT_TASK_PROMPTS[taskType];
      config.promptVersion = PROMPT_VERSIONS[taskType] || 1;
      needsSave = true;
    } else {
      // Legacy migration: infer customization when promptVersion is missing
      if (
        config.prompt &&
        config.promptVersion === undefined &&
        DEFAULT_TASK_PROMPTS[taskType]
      ) {
        if (config.prompt === DEFAULT_TASK_PROMPTS[taskType]) {
          // Matches current default — assign current version (no upgrade needed)
          config.promptVersion = PROMPT_VERSIONS[taskType] || 1;
          needsSave = true;
        } else if ((PREVIOUS_DEFAULT_PROMPTS[taskType] || []).includes(config.prompt)) {
          // Matches a known previous default — assign version 1 so auto-upgrade triggers
          config.promptVersion = 1;
          needsSave = true;
        } else {
          // Prompt differs from all known defaults — treat as user-customized
          config.promptCustomized = true;
          config.promptVersion = PROMPT_VERSIONS[taskType] || 1;
          needsSave = true;
        }
      }

      // Self-heal a mis-flagged customization: a prompt marked promptCustomized
      // that nonetheless byte-matches a shipped default was never user-edited —
      // it was flagged by an earlier legacy migration that ran before this task
      // carried a PREVIOUS_DEFAULT_PROMPTS entry (e.g. the basic self-improvement
      // prompts that hardcoded the app name as "PortOS"). Clear the flag so the
      // auto-upgrade below can replace the stale default.
      if (config.promptCustomized && promptMatchesShippedDefault(config.prompt, taskType)) {
        config.promptCustomized = false;
        needsSave = true;
      }

      if (PROMPT_VERSIONS[taskType] && !config.promptCustomized) {
        // Auto-upgrade non-customized prompts when code version is newer
        const storedVersion = config.promptVersion || 1;
        if (storedVersion < PROMPT_VERSIONS[taskType]) {
          emitLog('info', `Upgrading ${taskType} prompt v${storedVersion} → v${PROMPT_VERSIONS[taskType]}`, { taskType }, '📅 TaskSchedule');
          config.prompt = DEFAULT_TASK_PROMPTS[taskType];
          config.promptVersion = PROMPT_VERSIONS[taskType];
          needsSave = true;
        }
      }
    }
  }

  if (needsSave) {
    await saveSchedule(schedule);
  }

  return schedule;
}

async function saveSchedule(schedule) {
  await ensureDataDir();
  schedule.lastUpdated = new Date().toISOString();
  await atomicWrite(SCHEDULE_FILE, schedule);
}

// ============================================================
// Unified getters/setters (replace split self/app functions)
// ============================================================

export async function getTaskInterval(taskType) {
  const schedule = await loadSchedule();
  return schedule.tasks[taskType] || { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null };
}

export async function updateTaskInterval(taskType, settings) {
  const schedule = await loadSchedule();

  if (!schedule.tasks[taskType]) {
    schedule.tasks[taskType] = { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, createdAt: new Date().toISOString() };
  }

  // Normalize empty/whitespace prompts to null (treated as "use default")
  if ('prompt' in settings && typeof settings.prompt === 'string' && !settings.prompt.trim()) {
    settings.prompt = null;
  }
  // If user is setting a custom prompt, mark it so auto-upgrade won't overwrite it.
  // If user clears the prompt (null), remove the customized flag to resume defaults.
  if ('prompt' in settings) {
    settings.promptCustomized = settings.prompt != null;
  }

  schedule.tasks[taskType] = {
    ...schedule.tasks[taskType],
    ...settings
  };

  // Re-assert agent-managed taskMetadata fields after the merge so a PUT that
  // tries to flip them (UI bypass, hand-edited TASKS.md, direct API call)
  // gets the locked value back in its response.
  enforceManagedAgentOptions(taskType, schedule.tasks[taskType]);

  // Globally disabling pr-watcher also drops its execution cooldown so a later
  // re-enable baselines on the very next tick rather than waiting out the prior
  // 30-min interval — otherwise PRs opened in that delayed window slip past the
  // firstRun baseline and are never dispatched. Paired with clearAllPrWatcherState
  // below (the per-app disable paths in apps.js do the same via resetExecutionHistory).
  if (taskType === 'pr-watcher' && settings.enabled === false) {
    delete schedule.executions['task:pr-watcher'];
  }

  // When the recheck cadence of a perpetual task changes, re-derive the
  // `parkedUntil` of any CURRENTLY-parked execution records (global + per-app)
  // from the new cadence — otherwise an already-parked task keeps waiting out
  // its old timestamp and the cadence control appears to do nothing until then.
  // Only recompute existing parks (never create one), and compute from now so a
  // shortened cadence takes effect on the next slot.
  const merged = schedule.tasks[taskType];
  if (merged.type === INTERVAL_TYPES.PERPETUAL && ('recheckCron' in settings || 'recheckIntervalMs' in settings)) {
    const exec = schedule.executions[`task:${taskType}`];
    if (exec) {
      const records = [exec, ...Object.values(exec.perApp || {})];
      for (const rec of records) {
        if (rec?.parkedUntil) {
          rec.parkedUntil = await computePerpetualRecheckAt(merged);
        }
      }
    }
  }

  await saveSchedule(schedule);

  // Globally disabling pr-watcher clears every app's high-water mark, mirroring
  // the per-app disable clears in apps.js — so a later global re-enable
  // baselines silently instead of dispatching the backlog of PRs opened while
  // it was paused. (`enabled` arrives as a real boolean from the schedule route.)
  if (taskType === 'pr-watcher' && settings.enabled === false) {
    await clearAllPrWatcherState().catch((err) => {
      emitLog('warn', `pr-watcher global-disable state clear failed: ${err.message}`, {}, '📅 TaskSchedule');
    });
  }

  emitLog('info', `Updated task interval for ${taskType}`, { taskType, settings }, '📅 TaskSchedule');
  cosEvents.emit('schedule:changed', { taskType, settings });

  return schedule.tasks[taskType];
}

/**
 * Record a task execution
 */
export async function recordExecution(taskType, appId = null) {
  const schedule = await loadSchedule();
  const key = taskType.startsWith('task:') ? taskType : `task:${taskType}`;

  if (!schedule.executions[key]) {
    schedule.executions[key] = {
      lastRun: null,
      count: 0,
      perApp: {}
    };
  }

  schedule.executions[key].lastRun = new Date().toISOString();
  schedule.executions[key].count = (schedule.executions[key].count || 0) + 1;

  if (appId) {
    if (!schedule.executions[key].perApp[appId]) {
      schedule.executions[key].perApp[appId] = {
        lastRun: null,
        count: 0
      };
    }
    schedule.executions[key].perApp[appId].lastRun = new Date().toISOString();
    schedule.executions[key].perApp[appId].count++;
  }

  await saveSchedule(schedule);
  return schedule.executions[key];
}

export async function getExecutionHistory(taskType) {
  const schedule = await loadSchedule();
  const key = taskType.startsWith('task:') ? taskType : `task:${taskType}`;
  return schedule.executions[key] || { lastRun: null, count: 0, perApp: {} };
}

// ============================================================
// Perpetual (drain-until-done) park state
// ============================================================

/**
 * Compute when a parked perpetual task should next re-probe its work-detector.
 * Prefers `recheckCron` (a 5-field cron string, evaluated in the user's
 * timezone) over `recheckIntervalMs`; falls back to DEFAULT_PERPETUAL_RECHECK_MS.
 * Returns an ISO timestamp string.
 */
export async function computePerpetualRecheckAt(interval, fromMs = Date.now()) {
  const cron = interval?.recheckCron;
  if (typeof cron === 'string' && cron.trim().split(/\s+/).length === 5) {
    const timezone = await getUserTimezone();
    const next = parseCronToNextRun(cron, new Date(fromMs), timezone);
    if (next) return next.toISOString();
  }
  const ms = Number(interval?.recheckIntervalMs) > 0
    ? Number(interval.recheckIntervalMs)
    : DEFAULT_PERPETUAL_RECHECK_MS;
  return new Date(fromMs + ms).toISOString();
}

/**
 * The park record lives ALONGSIDE the execution record (global or per-app), so a
 * perpetual task's "parked until" survives restarts the same way `lastRun` does.
 * Returns the execution sub-record that holds the park fields, creating the
 * skeleton if absent.
 */
function ensureExecutionRecord(schedule, taskType, appId) {
  const key = executionKey(taskType);
  if (!schedule.executions[key]) {
    schedule.executions[key] = { lastRun: null, count: 0, perApp: {} };
  }
  const top = schedule.executions[key];
  if (appId) {
    if (!top.perApp) top.perApp = {};
    if (!top.perApp[appId]) top.perApp[appId] = { lastRun: null, count: 0 };
    return top.perApp[appId];
  }
  return top;
}

/** Normalize a task type to its `task:`-prefixed executions map key. */
function executionKey(taskType) {
  return taskType.startsWith('task:') ? taskType : `task:${taskType}`;
}

/**
 * Resolve the EXISTING execution sub-record (global or per-app) without creating
 * it — the read-only counterpart to ensureExecutionRecord. Returns null when the
 * task (or that app) has no record yet.
 */
function resolveExecutionRecord(schedule, taskType, appId = null) {
  const top = schedule.executions[executionKey(taskType)];
  if (!top) return null;
  return (appId ? top.perApp?.[appId] : top) || null;
}

// Every field parkPerpetual stamps for a park. Kept as one list so the clear /
// reset paths can't drift from what park writes (adding a park field here is the
// single edit that keeps all three in sync).
const PARK_FIELDS = ['parkedUntil', 'parkReason', 'parkActionableCount', 'parkCounts', 'parkedAt'];

/**
 * Park a perpetual task: its work-detector reported nothing actionable, so stop
 * draining and wait until `parkedUntil` before re-probing. Stamps the park
 * fields on the (per-app or global) execution record.
 */
export async function parkPerpetual(taskType, appId = null, { reason = null, actionableCount = 0, counts = null, signature } = {}) {
  const schedule = await loadSchedule();
  const interval = schedule.tasks[taskType] || {};
  const parkedUntil = await computePerpetualRecheckAt(interval);
  const record = ensureExecutionRecord(schedule, taskType, appId);
  record.parkedUntil = parkedUntil;
  record.parkReason = reason;
  record.parkActionableCount = actionableCount;
  // The detector's candidate breakdown ({ open, inFlight, filtered }). Lets the
  // UI explain WHY a non-empty queue yields zero claimable work — "0 of N, M
  // in-flight" — instead of a bare "no work". `null` = the detector reported no
  // breakdown (e.g. the reconcile scans), so the field is left off the record.
  if (counts != null) record.parkCounts = counts;
  else delete record.parkCounts;
  record.parkedAt = new Date().toISOString();
  // A drain that parks because a full cycle made NO progress (branch-reconcile's
  // 'no-progress' park) records the actionable signature it was stuck on, so the
  // next recheck can tell "same stuck set" (park again) from "the set changed"
  // (resume). `null` clears it (an idle park with nothing actionable); `undefined`
  // (the default) leaves any prior signature untouched.
  if (signature !== undefined) {
    if (signature === null) delete record.lastActionableSignature;
    else record.lastActionableSignature = signature;
  }
  await saveSchedule(schedule);
  emitLog('info', `Perpetual ${taskType} parked until ${parkedUntil} (${reason || 'idle'})`, { taskType, appId, parkedUntil }, '📅 TaskSchedule');
  cosEvents.emit('schedule:perpetual-parked', { taskType, appId, parkedUntil, reason, actionableCount, counts });
  return record;
}

/**
 * Read the current park record for a perpetual task (or null when not parked).
 * Used by the on-demand handler to explain to the user WHY an explicit "Run"
 * produced no task — the park fields are freshly stamped by the same dispatch,
 * so this reflects the just-completed detection, not stale cadence state.
 */
export async function getPerpetualParkInfo(taskType, appId = null) {
  const schedule = await loadSchedule();
  const record = resolveExecutionRecord(schedule, taskType, appId);
  if (!record || record.parkedUntil == null) return null;
  return {
    parkedUntil: record.parkedUntil,
    parkReason: record.parkReason ?? null,
    parkActionableCount: record.parkActionableCount ?? null,
    parkCounts: record.parkCounts ?? null,
    parkedAt: record.parkedAt ?? null
  };
}

/** Read the last actionable signature recorded for a perpetual drain (or null). */
export async function getPerpetualSignature(taskType, appId = null) {
  const schedule = await loadSchedule();
  const record = resolveExecutionRecord(schedule, taskType, appId);
  return record?.lastActionableSignature ?? null;
}

/**
 * Record the actionable signature a perpetual drain is dispatching against, so a
 * later cycle that finds the same signature can recognize "no progress" and park
 * instead of re-dispatching an identical run. `null` clears it.
 */
export async function setPerpetualSignature(taskType, appId = null, signature) {
  const schedule = await loadSchedule();
  const record = ensureExecutionRecord(schedule, taskType, appId);
  if (signature == null) delete record.lastActionableSignature;
  else record.lastActionableSignature = signature;
  await saveSchedule(schedule);
  return record;
}

/**
 * Clear a perpetual task's park so the drain resumes (its work-detector found
 * actionable work). No-op (and no write) when there's nothing parked.
 */
export async function clearPerpetualPark(taskType, appId = null) {
  const schedule = await loadSchedule();
  const record = resolveExecutionRecord(schedule, taskType, appId);
  if (!record || record.parkedUntil == null) return false;
  for (const field of PARK_FIELDS) delete record[field];
  await saveSchedule(schedule);
  return true;
}

/**
 * Reset a perpetual task's cached drain state for an explicit user-initiated
 * re-run. Drops any park AND the convergence `lastActionableSignature` in a
 * single write, so the next detection dispatches on LIVE state alone — never a
 * stale "no-progress" verdict or a cadence park. This is what makes a manual
 * "Run" honor the user's intent to re-check now: without clearing the signature,
 * branch-reconcile/issue-reconcile would re-park `no-progress` against an
 * unchanged-since-last-run set even though the user explicitly asked to re-drive.
 * Returns true when it cleared anything.
 */
export async function resetPerpetualForManualRun(taskType, appId = null) {
  const schedule = await loadSchedule();
  const record = resolveExecutionRecord(schedule, taskType, appId);
  if (!record) return false;
  let changed = false;
  for (const field of [...PARK_FIELDS, 'lastActionableSignature']) {
    if (record[field] !== undefined) { delete record[field]; changed = true; }
  }
  if (changed) await saveSchedule(schedule);
  return changed;
}

/**
 * Check if all runAfter dependencies have completed since this task's last run.
 * Returns { satisfied, pending } where pending lists unfinished dependency task types.
 *
 * Dependencies that are disabled — either globally (missing from the schedule or
 * `enabled: false`) or disabled for the requesting app — are skipped, since they
 * will never run and would otherwise block the dependent task indefinitely.
 */
async function checkRunAfterDeps(schedule, taskType, appId = null) {
  const interval = schedule.tasks[taskType];
  const deps = interval?.runAfter;
  if (!deps || deps.length === 0) return { satisfied: true, pending: [] };

  const key = `task:${taskType}`;
  const execution = schedule.executions[key] || { lastRun: null, perApp: {} };
  const ownLastRun = safeDate(appId ? execution.perApp[appId]?.lastRun : execution.lastRun);

  const pending = [];
  for (const dep of deps) {
    const depConfig = schedule.tasks[dep];
    if (!depConfig || !depConfig.enabled) continue;
    if (appId && !(await isTaskTypeEnabledForApp(appId, dep))) continue;

    const depKey = `task:${dep}`;
    const depExec = schedule.executions[depKey] || { lastRun: null, perApp: {} };
    const depLastRun = safeDate(appId ? depExec.perApp[appId]?.lastRun : depExec.lastRun);

    // Dependency must have run after this task's last run (i.e., within the current cycle)
    if (depLastRun <= ownLastRun) {
      pending.push(dep);
    }
  }

  return { satisfied: pending.length === 0, pending };
}

/**
 * Check if a task type should run for a specific app (or globally)
 */
export async function shouldRunTask(taskType, appId = null) {
  const schedule = await loadSchedule();
  const interval = schedule.tasks[taskType];

  if (!interval || !interval.enabled) {
    return { shouldRun: false, reason: 'disabled' };
  }

  // Fetch timezone once for reuse across weekday and cron checks
  const timezone = await getUserTimezone();

  // Weekday-only tasks skip weekends (timezone-aware)
  if (interval.weekdaysOnly) {
    const { dayOfWeek } = getLocalParts(new Date(), timezone);
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return { shouldRun: false, reason: 'weekday-only' };
    }
  }

  if (appId) {
    const enabledForApp = await isTaskTypeEnabledForApp(appId, taskType);
    if (!enabledForApp) {
      return { shouldRun: false, reason: 'disabled-for-app' };
    }
  }

  // Determine effective interval type: per-app override takes precedence
  const perAppInterval = appId ? await getAppTaskTypeInterval(appId, taskType) : null;
  // A per-app numeric intervalMs override (used by handler-backed tasks like
  // layered-intelligence, whose Intelligence-tab UI offers sub-daily cadences the
  // string enum can't express). When set alongside interval:'custom', the CUSTOM
  // branch below uses THIS value as the base interval instead of the global one.
  const perAppIntervalMs = appId ? await getAppTaskTypeIntervalMs(appId, taskType) : null;
  const hasCustomIntervalMs = Number.isFinite(perAppIntervalMs) && perAppIntervalMs > 0;
  // Cron expressions (contain spaces) are stored directly as the interval value
  const isCronOverride = perAppInterval && perAppInterval.includes(' ');
  const effectiveType = isCronOverride ? INTERVAL_TYPES.CRON : (perAppInterval || interval.type);

  const key = `task:${taskType}`;
  const execution = schedule.executions[key] || { lastRun: null, count: 0, perApp: {} };

  // For per-app tracking, use app-specific execution data
  const appExecution = appId
    ? (execution.perApp[appId] || { lastRun: null, count: 0 })
    : execution;

  const now = Date.now();
  const lastRun = appExecution.lastRun ? new Date(appExecution.lastRun).getTime() : 0;
  const timeSinceLastRun = now - lastRun;

  const buildResult = (shouldRun, reason, baseIntervalMs, extra = {}) => {
    const result = { shouldRun, reason, ...extra };
    if (extra.learningAdjustment?.adjusted) {
      result.learningApplied = true;
      result.successRate = extra.learningAdjustment.successRate;
      result.adjustmentMultiplier = extra.learningAdjustment.multiplier;
      result.dataPoints = extra.learningAdjustment.dataPoints;
    }
    return result;
  };

  let result;

  switch (effectiveType) {
    case INTERVAL_TYPES.ROTATION:
      result = { shouldRun: true, reason: 'rotation' };
      break;

    case INTERVAL_TYPES.DAILY: {
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, DAY);
      const adjustedInterval = learningAdjustment.adjustedIntervalMs;
      if (timeSinceLastRun >= adjustedInterval) {
        result = buildResult(true, learningAdjustment.adjusted ? 'daily-due-adjusted' : 'daily-due', DAY, { learningAdjustment });
      } else {
        result = buildResult(false, learningAdjustment.adjusted ? 'daily-cooldown-adjusted' : 'daily-cooldown', DAY, {
          learningAdjustment, nextRunIn: adjustedInterval - timeSinceLastRun,
          nextRunAt: new Date(lastRun + adjustedInterval).toISOString(),
          baseIntervalMs: DAY, adjustedIntervalMs: adjustedInterval
        });
      }
      break;
    }

    case INTERVAL_TYPES.WEEKLY: {
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, WEEK);
      const adjustedInterval = learningAdjustment.adjustedIntervalMs;
      if (timeSinceLastRun >= adjustedInterval) {
        result = buildResult(true, learningAdjustment.adjusted ? 'weekly-due-adjusted' : 'weekly-due', WEEK, { learningAdjustment });
      } else {
        result = buildResult(false, learningAdjustment.adjusted ? 'weekly-cooldown-adjusted' : 'weekly-cooldown', WEEK, {
          learningAdjustment, nextRunIn: adjustedInterval - timeSinceLastRun,
          nextRunAt: new Date(lastRun + adjustedInterval).toISOString(),
          baseIntervalMs: WEEK, adjustedIntervalMs: adjustedInterval
        });
      }
      break;
    }

    case INTERVAL_TYPES.ONCE:
      result = appExecution.count === 0
        ? { shouldRun: true, reason: 'once-first-run' }
        : { shouldRun: false, reason: 'once-completed', completedAt: appExecution.lastRun };
      break;

    case INTERVAL_TYPES.ON_DEMAND:
      result = { shouldRun: false, reason: 'on-demand-only' };
      break;

    case INTERVAL_TYPES.CUSTOM: {
      // A per-app numeric intervalMs override wins over the global custom interval
      // (handler-backed tasks store their per-app cadence there).
      const baseInterval = (hasCustomIntervalMs ? perAppIntervalMs : interval.intervalMs) || DAY;
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, baseInterval);
      const adjustedInterval = learningAdjustment.adjustedIntervalMs;
      if (timeSinceLastRun >= adjustedInterval) {
        result = buildResult(true, learningAdjustment.adjusted ? 'custom-due-adjusted' : 'custom-due', baseInterval, { learningAdjustment });
      } else {
        result = buildResult(false, learningAdjustment.adjusted ? 'custom-cooldown-adjusted' : 'custom-cooldown', baseInterval, {
          learningAdjustment, nextRunIn: adjustedInterval - timeSinceLastRun,
          nextRunAt: new Date(lastRun + adjustedInterval).toISOString(),
          baseIntervalMs: baseInterval, adjustedIntervalMs: adjustedInterval
        });
      }
      break;
    }

    case INTERVAL_TYPES.CRON: {
      // Cron expression: per-app override (stored as the interval string) or global config
      const cronExpr = isCronOverride ? perAppInterval : interval.cronExpression;
      if (!cronExpr || typeof cronExpr !== 'string' || cronExpr.trim().split(/\s+/).length !== 5) {
        result = { shouldRun: false, reason: 'invalid-cron' };
        break;
      }

      // Catch-up: if a cron slot has already elapsed since the last successful run
      // (or, for never-run tasks, within the last cron period), fire it now instead
      // of waiting another full period. This recovers from daemon downtime, restarts,
      // and the hourly-check window missing the 60-second cron match.
      const prevRun = parseCronToPrevRun(cronExpr, new Date(now), timezone);
      if (prevRun) {
        const prevRunMs = prevRun.getTime();
        let lookbackBound;
        if (lastRun) {
          lookbackBound = lastRun;
        } else {
          // Never-run: only catch up to a slot that elapsed AFTER the task was
          // configured. Without this bound a never-run task always fires its most
          // recent past slot, so a weekly "Sunday 09:00" task enabled on a Friday
          // immediately reads as "due now (catch-up)" for last Sunday — a slot that
          // predates the task and was never actually missed. `createdAt` is stamped
          // when the task is first seen (loadSchedule backfills it for existing
          // installs), so catch-up only recovers slots the task was around for. An
          // un-backfilled task (createdAt absent) yields bound 0 → the legacy
          // always-catch-up behavior.
          lookbackBound = safeDate(interval.createdAt);
        }
        if (prevRunMs > lookbackBound && prevRunMs <= now) {
          // Compute nextRun for telemetry/reporting
          const nextRunAfterCatch = parseCronToNextRun(cronExpr, new Date(now), timezone);
          result = {
            shouldRun: true,
            reason: 'cron-catch-up',
            cronExpression: cronExpr,
            missedSlot: prevRun.toISOString(),
            nextRunAt: nextRunAfterCatch ? nextRunAfterCatch.toISOString() : null
          };
          break;
        }
      }

      // For never-run tasks, use 1 minute ago so the first scheduled occurrence can match
      const fromDate = lastRun ? new Date(lastRun) : new Date(now - 60_000);
      const nextRun = parseCronToNextRun(cronExpr, fromDate, timezone);
      if (!nextRun) {
        result = { shouldRun: false, reason: 'invalid-cron', cronExpression: cronExpr };
        break;
      }
      if (now >= nextRun.getTime()) {
        result = { shouldRun: true, reason: 'cron-due', cronExpression: cronExpr, nextRunAt: nextRun.toISOString() };
      } else {
        result = { shouldRun: false, reason: 'cron-cooldown', cronExpression: cronExpr,
          nextRunAt: nextRun.toISOString() };
      }
      break;
    }

    case INTERVAL_TYPES.PERPETUAL: {
      // Drain-until-done: a perpetual task is "due" whenever it isn't parked.
      // The actual programmatic work-detector runs at DISPATCH time (the gate in
      // generateManagedAppImprovementTaskForType) and PARKS the task — writing
      // `parkedUntil` onto the execution record — when nothing is actionable.
      // shouldRunTask only reads that persisted park, so it never does network
      // I/O even though it's called several times per evaluation cycle. While
      // parked, the recheck cadence (parkedUntil) gates re-probing; once it
      // elapses the task becomes due again and the gate re-runs the detector.
      const parkedUntilMs = appExecution.parkedUntil
        ? new Date(appExecution.parkedUntil).getTime()
        : 0;
      if (parkedUntilMs && now < parkedUntilMs) {
        result = {
          shouldRun: false,
          reason: 'perpetual-parked',
          nextRunAt: new Date(parkedUntilMs).toISOString(),
          parkReason: appExecution.parkReason || null,
          parkActionableCount: appExecution.parkActionableCount ?? null
        };
      } else {
        result = { shouldRun: true, reason: parkedUntilMs ? 'perpetual-recheck' : 'perpetual-drain' };
      }
      break;
    }

    default:
      result = { shouldRun: true, reason: 'unknown-default-rotation' };
  }

  // If the task would run, check runAfter dependencies — blocked until all enabled deps have run since our last run.
  // Disabled deps (globally or for this app) are skipped, since they'll never run.
  if (result.shouldRun && interval.runAfter?.length > 0) {
    const depCheck = await checkRunAfterDeps(schedule, taskType, appId);
    if (!depCheck.satisfied) {
      return { shouldRun: false, reason: 'waiting-on-dependencies', pendingDeps: depCheck.pending };
    }
  }

  return result;
}

/**
 * Get all enabled task types that are due to run (optionally for a specific app)
 */
export async function getDueTasks(appId = null) {
  const schedule = await loadSchedule();
  const due = [];

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!interval.enabled) continue;

    const check = await shouldRunTask(taskType, appId);
    if (check.shouldRun) {
      due.push({ taskType, reason: check.reason, interval });
    }
  }

  return due;
}

/**
 * Get the next task type to run (optionally for a specific app)
 */
export async function getNextTaskType(appId = null, lastType = '', { perpetualOnly = false } = {}) {
  const schedule = await loadSchedule();
  const taskTypes = Object.keys(schedule.tasks);

  const dueTasks = await getDueTasks(appId);

  // `perpetualOnly` constrains the pick to a due perpetual (drain-until-done)
  // task, skipping every other schedule type. Callers set this when the app is
  // on its review cooldown: only perpetual drains bypass that cooldown (their
  // work-detector park is the throttle), so a higher-priority cron/custom/daily
  // type that's also due must NOT be returned — it would mask the perpetual
  // drain and the caller, seeing a non-exempt pick, would skip the whole app for
  // the cooldown window (the mixed-schedule stall). Returns null when nothing
  // perpetual is due, so the caller leaves the cooled-down app alone.
  if (perpetualOnly) {
    const perpetualDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.PERPETUAL);
    return perpetualDue.length > 0
      ? { taskType: perpetualDue[0].taskType, reason: 'perpetual-drain' }
      : null;
  }

  // Explicit time-based schedules (cron, custom interval) outrank loose interval-based
  // ones (daily/weekly/once). A user-pinned 9 AM cron should fire at 9 AM even if a
  // weekly task is perpetually "ready" — the loose tasks will pick up the next slot.
  const cronDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.CRON || t.interval.type === INTERVAL_TYPES.CUSTOM);
  if (cronDue.length > 0) {
    return { taskType: cronDue[0].taskType, reason: `${cronDue[0].interval.type}-due` };
  }

  // Perpetual tasks actively draining a backlog outrank the loose interval
  // tasks (daily/weekly/once/rotation) so the drain keeps the app's single
  // improvement slot until its work-detector idles and it parks — at which
  // point the loose tasks below get their turn. (Explicit time-pinned cron/
  // custom schedules above still win, so a perpetual drain can't starve a
  // user-pinned 9 AM job.)
  const perpetualDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.PERPETUAL);
  if (perpetualDue.length > 0) {
    return { taskType: perpetualDue[0].taskType, reason: 'perpetual-drain' };
  }

  const dailyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.DAILY);
  if (dailyDue.length > 0) {
    return { taskType: dailyDue[0].taskType, reason: 'daily-priority' };
  }

  const weeklyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.WEEKLY);
  if (weeklyDue.length > 0) {
    return { taskType: weeklyDue[0].taskType, reason: 'weekly-priority' };
  }

  const onceDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.ONCE);
  if (onceDue.length > 0) {
    return { taskType: onceDue[0].taskType, reason: 'once-first-run' };
  }

  // Fall back to rotation among enabled rotation tasks
  const rotationTasks = taskTypes.filter(t =>
    schedule.tasks[t].enabled &&
    schedule.tasks[t].type === INTERVAL_TYPES.ROTATION
  );

  if (rotationTasks.length === 0) {
    return null;
  }

  const currentIndex = rotationTasks.indexOf(lastType);
  const nextIndex = (currentIndex + 1) % rotationTasks.length;

  return { taskType: rotationTasks[nextIndex], reason: 'rotation' };
}

// ============================================================
// Templates
// ============================================================

export async function addTemplateTask(template) {
  const schedule = await loadSchedule();

  const newTemplate = {
    id: `template-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    name: template.name,
    description: template.description,
    category: template.category || 'custom',
    taskType: template.taskType,
    priority: template.priority || 'MEDIUM',
    metadata: template.metadata || {}
  };

  schedule.templates.push(newTemplate);
  await saveSchedule(schedule);

  emitLog('info', `Added template task: ${newTemplate.name}`, { templateId: newTemplate.id }, '📅 TaskSchedule');
  return newTemplate;
}

export async function getTemplateTasks() {
  const schedule = await loadSchedule();
  return schedule.templates;
}

export async function deleteTemplateTask(templateId) {
  const schedule = await loadSchedule();
  const index = schedule.templates.findIndex(t => t.id === templateId);

  if (index === -1) {
    return { error: 'Template not found' };
  }

  const deleted = schedule.templates.splice(index, 1)[0];
  await saveSchedule(schedule);

  emitLog('info', `Deleted template task: ${deleted.name}`, { templateId }, '📅 TaskSchedule');
  return { success: true, deleted };
}

// ============================================================
// On-Demand Requests
// ============================================================

export async function triggerOnDemandTask(taskType, appId = null) {
  const schedule = await loadSchedule();

  // Cheap per-task-type check first; the master-flag check pays a state.json read.
  const tasks = schedule.tasks || {};
  if (!Object.prototype.hasOwnProperty.call(tasks, taskType)) {
    return { error: `Unknown task type '${taskType}'` };
  }
  if (!tasks[taskType].enabled) {
    return { error: `Task type '${taskType}' is disabled` };
  }

  // Reject if the master Improve toggle is off — request would be silently dropped downstream
  const state = await loadState();
  if (!isImprovementEnabled(state)) {
    return { error: 'Improvement is disabled — enable it in CoS → Config to run on-demand tasks' };
  }

  if (!schedule.onDemandRequests) {
    schedule.onDemandRequests = [];
  }

  const request = {
    id: `demand-${Date.now().toString(36)}`,
    taskType,
    appId,
    requestedAt: new Date().toISOString()
  };

  schedule.onDemandRequests.push(request);
  await saveSchedule(schedule);

  emitLog('info', `On-demand task requested: ${taskType}`, { appId }, '📅 TaskSchedule');
  cosEvents.emit('task:on-demand-requested', request);

  return request;
}

export async function getOnDemandRequests() {
  const schedule = await loadSchedule();
  return schedule.onDemandRequests || [];
}

export async function clearOnDemandRequest(requestId) {
  const schedule = await loadSchedule();

  if (!schedule.onDemandRequests) return null;

  const index = schedule.onDemandRequests.findIndex(r => r.id === requestId);
  if (index === -1) return null;

  const cleared = schedule.onDemandRequests.splice(index, 1)[0];
  await saveSchedule(schedule);

  return cleared;
}

// ============================================================
// Schedule Status
// ============================================================

export async function getScheduleStatus() {
  // Surface the master Improve toggle so the UI can disable Run Now affordances
  const [schedule, state] = await Promise.all([loadSchedule(), loadState()]);

  const status = {
    lastUpdated: schedule.lastUpdated,
    improvementEnabled: isImprovementEnabled(state),
    tasks: {},
    templates: schedule.templates,
    onDemandRequests: schedule.onDemandRequests || [],
    learningAdjustmentsActive: 0
  };

  // Fetch active apps once for per-app override aggregation
  const activeApps = await getActiveApps().catch(() => []);
  const totalAppCount = activeApps.length;

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    const execution = schedule.executions[`task:${taskType}`] || { lastRun: null, count: 0, perApp: {} };

    // Get learning adjustment info
    const baseInterval = interval.type === 'daily' ? DAY : interval.type === 'weekly' ? WEEK : (interval.intervalMs || DAY);
    const learningInfo = await getPerformanceAdjustedInterval(taskType, baseInterval);

    // Check global shouldRun status
    const check = await shouldRunTask(taskType);

    const isEnabledForApp = (override) => override?.enabled === true;
    const appOverrides = {};
    let enabledAppCount = 0;
    const allOverrides = await mapWithConcurrency(activeApps, 8, (app) => getAppTaskTypeOverrides(app.id));
    for (let i = 0; i < activeApps.length; i++) {
      const override = allOverrides[i][taskType];
      if (override) {
        appOverrides[activeApps[i].id] = {
          enabled: isEnabledForApp(override),
          interval: override.interval || null,
          ...(override.taskMetadata && { taskMetadata: override.taskMetadata })
        };
      }
      if (isEnabledForApp(override)) {
        enabledAppCount++;
      }
    }

    const taskStatus = {
      ...interval,
      lastRun: execution.lastRun,
      runCount: execution.count,
      globalLastRun: execution.lastRun,
      globalRunCount: execution.count,
      perAppCount: Object.keys(execution.perApp).length,
      appOverrides,
      enabledAppCount,
      totalAppCount,
      status: check,
      learningAdjusted: learningInfo.adjusted,
      learningMultiplier: learningInfo.multiplier,
      successRate: learningInfo.successRate,
      dataPoints: learningInfo.dataPoints,
      adjustedIntervalMs: learningInfo.adjustedIntervalMs,
      recommendation: learningInfo.recommendation
    };

    // Include default stage prompts for pipeline tasks so UI can display them
    if (interval.taskMetadata?.pipeline?.stages?.length > 0) {
      taskStatus.stagePrompts = interval.taskMetadata.pipeline.stages.map(stage =>
        DEFAULT_TASK_PROMPTS[stage.promptKey] || null
      );
    }

    // Surface agent-managed flags so the UI can lock the corresponding toggles
    if (MANAGED_AGENT_OPTIONS[taskType]) {
      taskStatus.managedAgentOptions = MANAGED_AGENT_OPTIONS[taskType];
    }

    // Perpetual tasks park PER-APP (parkPerpetual is called with the appId), so
    // the global `status` above (shouldRunTask with no appId) always reads
    // 'perpetual-drain' for app-scoped tasks like claim-issue/claim-work even
    // when every app is parked. Aggregate the per-app (and global) park records
    // so the UI can show the true parked/draining state and the soonest recheck.
    if (interval.type === INTERVAL_TYPES.PERPETUAL) {
      const nowMs = Date.now();
      const isParked = (r) => !!(r?.parkedUntil && new Date(r.parkedUntil).getTime() > nowMs);
      const perAppEntries = Object.values(execution.perApp || {});
      const parkedApps = perAppEntries.filter(isParked);
      const globalParked = isParked(execution);
      const nextRecheckAt = [
        ...parkedApps.map((r) => r.parkedUntil),
        ...(globalParked ? [execution.parkedUntil] : [])
      ].filter(Boolean).sort()[0] || null;
      taskStatus.perpetual = {
        globalParked,
        parkedAppCount: parkedApps.length,
        trackedAppCount: perAppEntries.length,
        nextRecheckAt,
        parkReason: parkedApps[0]?.parkReason || (globalParked ? execution.parkReason : null) || null
      };
    }

    status.tasks[taskType] = taskStatus;

    if (learningInfo.adjusted) {
      status.learningAdjustmentsActive++;
    }
  }

  return status;
}

/**
 * Reset execution history for a task type
 */
export async function resetExecutionHistory(taskType, appId = null) {
  const schedule = await loadSchedule();
  const key = `task:${taskType}`;

  if (!schedule.executions[key]) {
    return { error: 'No execution history found' };
  }

  if (appId) {
    if (schedule.executions[key].perApp?.[appId]) {
      delete schedule.executions[key].perApp[appId];
    }
  } else {
    delete schedule.executions[key];
  }

  await saveSchedule(schedule);
  emitLog('info', `Reset execution history for ${taskType}`, { appId }, '📅 TaskSchedule');

  return { success: true, taskType, appId };
}

// ============================================================
// Upcoming Tasks Preview
// ============================================================

export async function getUpcomingTasks(limit = 10) {
  const schedule = await loadSchedule();
  const now = Date.now();
  const upcoming = [];

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!interval.enabled) continue;
    if (interval.type === INTERVAL_TYPES.ON_DEMAND) continue;

    const check = await shouldRunTask(taskType);
    const execution = schedule.executions[`task:${taskType}`] || { lastRun: null, count: 0 };

    let eligibleAt = now;
    let taskStatus = 'ready';

    if (check.shouldRun) {
      eligibleAt = now;
      taskStatus = 'ready';
    } else if (check.nextRunAt) {
      eligibleAt = new Date(check.nextRunAt).getTime();
      taskStatus = 'scheduled';
    } else if (interval.type === INTERVAL_TYPES.ONCE && execution.count > 0) {
      taskStatus = 'completed';
      eligibleAt = Infinity;
    }

    if (taskStatus === 'completed') continue;

    upcoming.push({
      taskType,
      intervalType: interval.type,
      status: taskStatus,
      eligibleAt,
      eligibleIn: eligibleAt - now,
      eligibleInFormatted: formatTimeRemaining(eligibleAt - now),
      lastRun: execution.lastRun,
      lastRunFormatted: execution.lastRun ? formatRelativeTime(new Date(execution.lastRun).getTime()) : 'never',
      runCount: execution.count,
      successRate: check.successRate ?? null,
      learningAdjusted: check.learningApplied || false,
      adjustmentMultiplier: check.adjustmentMultiplier || 1.0,
      description: getTaskTypeDescription(taskType)
    });
  }

  upcoming.sort((a, b) => {
    if (a.status === 'ready' && b.status !== 'ready') return -1;
    if (b.status === 'ready' && a.status !== 'ready') return 1;
    return a.eligibleAt - b.eligibleAt;
  });

  return upcoming.slice(0, limit);
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return '< 1m';
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// Short human-readable blurb per task type, shown in the schedule UI's
// upcoming-tasks list. Every entry in SELF_IMPROVEMENT_TASK_TYPES must have a
// key here — a missing one falls back to a dasherized label ("claim work"),
// which reads as an orphaned/legacy task. A parity guard in taskSchedule.test.js
// fails the suite if the two ever drift apart.
export const TASK_TYPE_DESCRIPTIONS = {
  'ui-bugs': 'Find and fix UI bugs',
  'mobile-responsive': 'Check mobile responsiveness',
  'security': 'Security vulnerability audit',
  'code-quality': 'Code quality improvements',
  'console-errors': 'Fix console errors',
  'performance': 'Performance optimization',
  'test-coverage': 'Improve test coverage',
  'documentation': 'Update documentation',
  'feature-ideas': 'Implement next planned feature or brainstorm new one',
  'plan-task': 'Execute next PLAN.md item, remove it from PLAN.md, log to changelog (worktree+PR)',
  'claim-issue': 'Claim and ship the next open GitHub issue (owner-filed or any author), PR closes it',
  'claim-work': "Ship the next work item from the app's configured tracker (PLAN.md, GitHub/GitLab issues, or JIRA), routed automatically",
  'accessibility': 'Accessibility audit',
  'branch-cleanup': 'Clean up merged branches',
  'branch-reconcile': "Finish this machine's in-flight local branches: clean up merged ones, open PRs, resolve conflicts, drive review, auto-merge when green",
  'issue-reconcile': "Heal zombie issues: open + in-progress but their PR already merged with no live claim — close + file a scoped follow-up when work remains, or release the claim so the queue re-picks it",
  'dependency-updates': 'Update dependencies',
  'release-check': 'Check for release readiness',
  'error-handling': 'Improve error handling',
  'typing': 'Improve TypeScript types',
  'pr-reviewer': 'Review open PRs from contributors',
  'pr-watcher': 'Run a custom prompt on PRs newly opened against the default branch',
  'code-reviewer-a': 'Review the codebase and triage/implement findings (independent provider/model instance A)',
  'code-reviewer-b': 'Review the codebase and triage/implement findings (independent provider/model instance B)',
  'do-replan': 'Audit and prune PLAN.md after merges and branch cleanup so it reflects what actually shipped',
  'jira-sprint-manager': 'Triage and implement JIRA sprint tickets',
  'jira-status-report': 'Generate JIRA weekly status report',
  'reference-watch': 'Watch reference repos and append PLAN.md items for new upstream work',
  'refresh-local-llm-catalog': "Refresh PortOS's bundled suggested local-model catalog + editorial ranking (PortOS repo only)",
  'layered-intelligence': "Read this app's goals + telemetry, ask a reasoning model for one improvement, and file one deduplicated tracker issue — no code, no agent"
};

function getTaskTypeDescription(taskType) {
  return TASK_TYPE_DESCRIPTIONS[taskType] || taskType.replace(/-/g, ' ');
}
