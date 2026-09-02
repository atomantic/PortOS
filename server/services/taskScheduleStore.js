/** Persisted task schedule state and prompt-default compatibility upgrades. */

import { existsSync } from 'fs';
import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { emitLog } from './cosEvents.js';
import { INTERVAL_TYPES } from './taskScheduleConstants.js';
import {
  DEFAULT_TASK_INTERVALS,
  createPrReviewerDefaultStages,
  enforceBranchReconcileBatch,
  enforceManagedAgentOptions
} from './taskScheduleRegistry.js';
import {
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  promptMatchesShippedDefault
} from './taskPromptDefaults.js';

const DATA_DIR = PATHS.cos;
const SCHEDULE_FILE = join(DATA_DIR, 'task-schedule.json');
const queueScheduleWrite = createFileWriteQueue();

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

  // v1 schedules predate the v2 merge loop below, so apply the narrow
  // pr-reviewer pipeline migration here as well. Otherwise an install that
  // jumps directly from v1 would keep the old two-stage shape on disk even
  // though the runtime can only safely dispatch the new eligibility boundary.
  migrateLegacyPrReviewerPipeline(migrated.tasks?.['pr-reviewer']);

  return migrated;
}

/**
 * Add the eligibility boundary to the former two-stage pr-reviewer default.
 * This is deliberately narrow: a user-customized pipeline is left alone for
 * the schedule UI to preserve, while the exact shipped security → review shape
 * is upgraded in place. The runtime generator still enforces the gate for a
 * hand-edited/legacy shape that reaches dispatch without this save.
 */
function migrateLegacyPrReviewerPipeline(config) {
  const stages = config?.taskMetadata?.pipeline?.stages;
  if (!Array.isArray(stages) || stages.length !== 2) return false;
  const [security, review] = stages;
  if (security?.promptKey !== 'pr-reviewer-security' || review?.promptKey !== 'pr-reviewer-review') return false;
  if (security.role || review.role || (review.executionProfile && review.executionProfile !== 'public-review')) return false;

  const [defaultSecurity, defaultEligibility, defaultActions] = createPrReviewerDefaultStages();
  config.taskMetadata = {
    ...config.taskMetadata,
    pipeline: {
      ...config.taskMetadata.pipeline,
      stages: [
        { ...defaultSecurity, ...security, role: 'security' },
        { ...defaultEligibility },
        { ...defaultActions, ...review, role: 'actions', executionProfile: defaultActions.executionProfile },
      ],
    },
  };
  return true;
}

/**
 * Read and normalize schedule data without deciding whether the normalized
 * result should be persisted. Callers that mutate the result must do so inside
 * `queueScheduleWrite`, otherwise two stale snapshots can still overwrite each
 * other even when the final atomic writes are individually serialized.
 */
async function readSchedule() {
  await ensureDataDir();

  const loaded = await readJSONFile(SCHEDULE_FILE, null);
  if (!loaded) {
    return { schedule: { ...DEFAULT_SCHEDULE }, needsSave: false };
  }

  // Auto-migrate v1 → v2
  if (!loaded.version || loaded.version === 1) {
    const migrated = migrateScheduleV1toV2(loaded);
    return { schedule: migrated, needsSave: true };
  }

  // v2: merge each task config with its default to backfill new fields
  // Deep-merge taskMetadata so new default keys are inherited unless explicitly overridden
  const mergedTasks = {};
  for (const taskType of Object.keys(DEFAULT_TASK_INTERVALS)) {
    const defaultTask = DEFAULT_TASK_INTERVALS[taskType];
    const loadedTask = loaded.tasks?.[taskType] || {};
    const merged = { ...defaultTask, ...loadedTask };
    // A shipped task's feature association is code-owned, like its identity.
    // Do not let a stale persisted snapshot retain, replace, or remove the gate
    // when a later PortOS version changes the registry.
    if (defaultTask.feature) merged.feature = defaultTask.feature;
    else delete merged.feature;
    // Deep-merge taskMetadata: preserve explicit null (clears metadata), otherwise merge defaults with stored
    // Only spread if loadedTask.taskMetadata is a plain object to avoid corrupting config
    if (defaultTask.taskMetadata && loadedTask.taskMetadata !== null) {
      const storedMeta = loadedTask.taskMetadata;
      merged.taskMetadata = { ...defaultTask.taskMetadata, ...(isPlainObject(storedMeta) ? storedMeta : {}) };
    }
    if (taskType === 'pr-reviewer' && migrateLegacyPrReviewerPipeline(merged)) {
      // The migration is applied below while the normal schedule read is still
      // deciding whether this normalized snapshot needs persistence.
      // `needsSave` is declared after this merge loop, so mark it on the task
      // and detect it in the pass that enforces managed settings.
      merged.__prReviewerPipelineMigrated = true;
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
    if (config.__prReviewerPipelineMigrated) {
      delete config.__prReviewerPipelineMigrated;
      needsSave = true;
    }
    if (enforceManagedAgentOptions(taskType, config)) needsSave = true;
    if (enforceBranchReconcileBatch(taskType, config)) needsSave = true;
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
      // A prompt-less config pins nothing, so drop any stale provenance rather
      // than let it freeze the freshly-installed default off the upgrade path.
      if (config.promptSource) config.promptSource = null;
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
        } else if (promptMatchesShippedDefault(config.prompt, taskType)) {
          // Matches a known previous default — assign version 1 so auto-upgrade triggers
          config.promptVersion = 1;
          needsSave = true;
        } else {
          // Prompt differs from all known defaults — treat as user-customized.
          // Stamp the provenance as INFERRED, not 'user': this branch is a guess
          // made from a body we don't recognize, so the self-heal below must stay
          // free to undo it once the body turns out to be a retired default.
          config.promptCustomized = true;
          config.promptSource = 'legacy-inferred';
          config.promptVersion = PROMPT_VERSIONS[taskType] || 1;
          needsSave = true;
        }
      }

      // Self-heal a mis-flagged customization: a prompt marked promptCustomized
      // that nonetheless matches a shipped default was never user-edited — it
      // was flagged by an earlier legacy migration that ran before this task
      // carried a PREVIOUS_DEFAULT_PROMPTS entry (the basic self-improvement
      // prompts that hardcoded the app name as "PortOS", and both
      // pre-unification generations — `[Self-Improvement] …` and
      // `[App Improvement: …]` — that the schedule unification replaced without
      // preserving). Clear the flag so the auto-upgrade below can replace the
      // stale default.
      //
      // Clearing the flag is NOT enough on its own. That legacy migration
      // stamped `promptVersion = PROMPT_VERSIONS[taskType]` alongside the flag,
      // so an install flagged after a type was versioned carries the CURRENT
      // version while holding a RETIRED body — the upgrade below then sees
      // `storedVersion < current` as false and leaves the stale prompt in place
      // forever, now un-flagged so nothing else notices. Reset the version to 1
      // whenever the body is a prior default rather than the current one, which
      // is the same stamp the version-inference branch above applies.
      //
      // Gated on provenance (#5432): a user who deliberately pastes an older
      // SHIPPED body into Settings → Scheduled Tasks also byte-matches a shipped
      // default, and clearing THAT flag would let the next PROMPT_VERSIONS bump
      // overwrite their chosen text. `promptSource === 'user'` marks an explicit
      // write through updateTaskInterval and is left alone; 'legacy-inferred' and
      // absent (every install upgrading into this field) self-heal exactly as
      // they do today.
      if (config.promptSource !== 'user'
        && config.promptCustomized
        && promptMatchesShippedDefault(config.prompt, taskType)) {
        config.promptCustomized = false;
        if (config.prompt !== DEFAULT_TASK_PROMPTS[taskType]) config.promptVersion = 1;
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

  return { schedule, needsSave };
}

/**
 * Load schedule data (auto-migrates from v1 if needed).
 *
 * Normal reads stay off the queue unless compatibility repair is needed. When
 * repair is needed, discard the pre-queue snapshot and read it again inside a
 * queued turn so a concurrent mutation cannot be overwritten by stale repair
 * data.
 */
export async function loadSchedule() {
  const initial = await readSchedule();
  if (!initial.needsSave) return initial.schedule;

  return queueScheduleWrite(async () => {
    const current = await readSchedule();
    if (current.needsSave) await saveScheduleNow(current.schedule);
    return current.schedule;
  });
}

/**
 * Serialize a complete schedule read-modify-write cycle.
 *
 * `mutate` receives the freshest normalized schedule and must return
 * `{ result, changed }`. `changed: false` preserves no-op callers' no-write
 * behavior, while compatibility repairs discovered during the read still save.
 */
export async function updateSchedule(mutate) {
  return queueScheduleWrite(async () => {
    const { schedule, needsSave } = await readSchedule();
    const { result, changed } = await mutate(schedule);
    if (needsSave || changed) await saveScheduleNow(schedule);
    return result;
  });
}

async function saveScheduleNow(schedule) {
  await ensureDataDir();
  schedule.lastUpdated = new Date().toISOString();
  await atomicWrite(SCHEDULE_FILE, schedule);
}

export function saveSchedule(schedule) {
  return queueScheduleWrite(() => saveScheduleNow(schedule));
}
