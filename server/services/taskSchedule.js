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
 */

import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { cosEvents, emitLog } from './cosEvents.js';
import { DAY, ensureDir, HOUR, readJSONFile, PATHS, safeDate } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { getAdaptiveCooldownMultiplier } from './taskLearning.js';
import { isTaskTypeEnabledForApp, getAppTaskTypeInterval, getActiveApps, getAppTaskTypeOverrides, clearAllPrWatcherState } from './apps.js';
import { loadState, isImprovementEnabled } from './cosState.js';
import { getUserTimezone, getLocalParts } from '../lib/timezone.js';
import { parseCronToNextRun, parseCronToPrevRun } from './eventScheduler.js';
// Prompt catalog + getters were extracted to taskPromptService.js (issue #744).
// loadSchedule()/getScheduleStatus() below still consume the prompt-version
// machinery (DEFAULT_TASK_PROMPTS / PROMPT_VERSIONS / PREVIOUS_DEFAULT_PROMPTS)
// for the auto-upgrade path, so import those here. PROMPT_VERSIONS is part of
// taskSchedule.js's public API (consumers import it from here), so it's
// re-exported below alongside the prompt getters; DEFAULT_TASK_PROMPTS and
// PREVIOUS_DEFAULT_PROMPTS stay internal, matching their pre-split visibility.
import {
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  PREVIOUS_DEFAULT_PROMPTS
} from './taskPromptService.js';

// Re-export the public prompt API so existing importers of taskSchedule.js are
// unaffected by the split (PROMPT_VERSIONS is exported via its local binding above).
export { PROMPT_VERSIONS };
export {
  REFERENCE_WATCH_AUDITED_VERSION,
  getDefaultPrompt,
  getTaskPrompt,
  getStagePrompt
} from './taskPromptService.js';

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
  CRON: 'cron'               // Cron expression schedule
};

const WEEK = 7 * DAY;

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
  'accessibility', 'branch-cleanup', 'console-errors', 'dependency-updates', 'documentation',
  'ui-bugs', 'mobile-responsive', 'feature-ideas', 'plan-task', 'claim-issue', 'error-handling',
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
  'reference-watch'
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
  // `issueAuthorFilter` gates which issues are claimable: 'owner' (default,
  // matching /claim --issues) only claims issues the repo owner filed; 'any'
  // claims any open issue. Per-app override supported via taskTypeOverrides.
  'claim-issue':         { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false, openPR: false, simplify: true, issueAuthorFilter: 'owner' } },
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
  'pr-watcher':          { type: INTERVAL_TYPES.CUSTOM, intervalMs: 1800000, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { prAuthorFilter: 'any', readOnly: false } }
};

// Agent-options that a task manages internally — UI locks the toggle, and
// loadSchedule/updateTaskInterval enforce the default value regardless of
// what's persisted or POSTed. The reasoning lives next to each task above
// (e.g., plan-task's prompt creates its own claim/<slug> worktree, so a
// CoS-managed worktree would clobber it).
export const MANAGED_AGENT_OPTIONS = {
  'plan-task': ['useWorktree', 'openPR'],
  // claim-issue's prompt creates its own claim/issue-<num> worktree (same
  // rationale as plan-task), so CoS must not pre-create one or open the PR.
  'claim-issue': ['useWorktree', 'openPR']
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
  await writeFile(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
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
    schedule.tasks[taskType] = { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null };
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
      const baseInterval = interval.intervalMs || DAY;
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
          // Never-run: only catch up if the most-recent occurrence is within ONE cron
          // period of now (e.g. daily cron catches up to ~24h, hourly to ~1h). The bound
          // is "the occurrence before prevRun" — anything older has already been missed
          // by more than one period and shouldn't be replayed.
          const beforePrev = parseCronToPrevRun(cronExpr, new Date(prevRunMs - 60_000), timezone);
          lookbackBound = beforePrev ? beforePrev.getTime() : 0;
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
export async function getNextTaskType(appId = null, lastType = '') {
  const schedule = await loadSchedule();
  const taskTypes = Object.keys(schedule.tasks);

  const dueTasks = await getDueTasks(appId);

  // Explicit time-based schedules (cron, custom interval) outrank loose interval-based
  // ones (daily/weekly/once). A user-pinned 9 AM cron should fire at 9 AM even if a
  // weekly task is perpetually "ready" — the loose tasks will pick up the next slot.
  const cronDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.CRON || t.interval.type === INTERVAL_TYPES.CUSTOM);
  if (cronDue.length > 0) {
    return { taskType: cronDue[0].taskType, reason: `${cronDue[0].interval.type}-due` };
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
    const allOverrides = await Promise.all(activeApps.map(app => getAppTaskTypeOverrides(app.id)));
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

function getTaskTypeDescription(taskType) {
  const descriptions = {
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
    'accessibility': 'Accessibility audit',
    'branch-cleanup': 'Clean up merged branches',
    'dependency-updates': 'Update dependencies',
    'release-check': 'Check for release readiness',
    'error-handling': 'Improve error handling',
    'typing': 'Improve TypeScript types',
    'pr-reviewer': 'Review open PRs from contributors',
    'pr-watcher': 'Run a custom prompt on PRs newly opened against the default branch',
    'jira-sprint-manager': 'Triage and implement JIRA sprint tickets',
    'jira-status-report': 'Generate JIRA weekly status report'
  };
  return descriptions[taskType] || taskType.replace(/-/g, ' ');
}
