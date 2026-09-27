/**
 * Rename a scheduled task type in an install's persisted CoS state while
 * preserving schedules, app overrides, pending runs, execution history, and
 * run-order dependencies.
 *
 * Task configs are operator-owned records, so when both keys are present the
 * retired key's config is merged UNDER the current one (current wins) and only
 * then removed. Idempotent; it never dispatches work. Shared by the rename
 * migrations (408 react-lifecycle → ui-lifecycle, 417 release-check → do-release).
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileCore.js';

const SCHEDULE_PATH = join('data', 'cos', 'task-schedule.json');
const LEARNING_PATH = join('data', 'cos', 'learning.json');
// Learning maps keyed by the task-type bucket (`self-improve:<type>`,
// `app-improve:<type>`), or by `<bucket>|provider|model|effort`.
const LEARNING_KEYED_MAPS = ['byTaskType', 'routingAccuracy', 'byTaskTypeExecution'];
const APPS_PATH = join('data', 'apps.json');

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

async function readJson(rootDir, relPath) {
  const fullPath = join(rootDir, relPath);
  const raw = await readFile(fullPath, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return { fullPath, value: JSON.parse(raw) };
  } catch (err) {
    throw new Error(`${relPath} is not valid JSON (${err.message}) — repair it and re-run migrations`);
  }
}

const writeJson = (fullPath, value) => atomicWrite(fullPath, `${JSON.stringify(value, null, 2)}\n`);

// Task-type lists on a schedule config: hard (`runAfter`) and advisory
// (`suggestedAfter`) ordering.
const ORDERING_FIELDS = ['runAfter', 'suggestedAfter'];

function mergeConfig(legacy, current, renameTaskType) {
  const oldConfig = isObject(legacy) ? legacy : {};
  const newConfig = isObject(current) ? current : {};
  const merged = { ...oldConfig, ...newConfig };
  if (hasOwn(newConfig, 'taskMetadata') && newConfig.taskMetadata === null) {
    merged.taskMetadata = null;
  } else if (isObject(oldConfig.taskMetadata) || isObject(newConfig.taskMetadata)) {
    merged.taskMetadata = {
      ...(isObject(oldConfig.taskMetadata) ? oldConfig.taskMetadata : {}),
      ...(isObject(newConfig.taskMetadata) ? newConfig.taskMetadata : {}),
    };
  }
  for (const field of ORDERING_FIELDS) {
    if (!Array.isArray(oldConfig[field]) && !Array.isArray(newConfig[field])) continue;
    merged[field] = [...new Set([
      ...(Array.isArray(oldConfig[field]) ? oldConfig[field] : []),
      ...(Array.isArray(newConfig[field]) ? newConfig[field] : []),
    ].map(renameTaskType))];
  }
  return merged;
}

function newerTimestamp(left, right) {
  if (!left) return right || left;
  if (!right) return left;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime > leftTime ? right : left;
  if (Number.isFinite(rightTime)) return right;
  if (Number.isFinite(leftTime)) return left;
  return right;
}

function mergeExecutionRecord(legacy, current) {
  const oldRecord = isObject(legacy) ? legacy : {};
  const newRecord = isObject(current) ? current : {};
  const merged = { ...oldRecord, ...newRecord };
  if (Number.isFinite(oldRecord.count) || Number.isFinite(newRecord.count)) {
    merged.count = (Number.isFinite(oldRecord.count) ? oldRecord.count : 0)
      + (Number.isFinite(newRecord.count) ? newRecord.count : 0);
  }
  if (oldRecord.lastRun || newRecord.lastRun) {
    merged.lastRun = newerTimestamp(oldRecord.lastRun, newRecord.lastRun);
  }

  if (isObject(oldRecord.perApp) || isObject(newRecord.perApp)) {
    merged.perApp = { ...(isObject(oldRecord.perApp) ? oldRecord.perApp : {}) };
    for (const [appId, record] of Object.entries(isObject(newRecord.perApp) ? newRecord.perApp : {})) {
      merged.perApp[appId] = mergeExecutionRecord(merged.perApp[appId], record);
    }
  }
  return merged;
}

// Rename + dedupe a task-type list; null when nothing changed.
function renameList(list, renameTaskType) {
  const renamed = [...new Set(list.map(renameTaskType))];
  const unchanged = renamed.length === list.length && renamed.every((taskType, index) => taskType === list[index]);
  return unchanged ? null : renamed;
}

function migrateSchedule(schedule, { from, to, renameTaskType }) {
  const fromExecution = `task:${from}`;
  const toExecution = `task:${to}`;
  if (!isObject(schedule)) return { changed: false, pendingRequests: 0 };
  let changed = false;
  let pendingRequests = 0;

  if (isObject(schedule.tasks)) {
    if (hasOwn(schedule.tasks, from)) {
      schedule.tasks[to] = mergeConfig(schedule.tasks[from], schedule.tasks[to], renameTaskType);
      delete schedule.tasks[from];
      changed = true;
    }
    for (const config of Object.values(schedule.tasks)) {
      if (!isObject(config)) continue;
      for (const field of ORDERING_FIELDS) {
        if (!Array.isArray(config[field])) continue;
        const renamed = renameList(config[field], renameTaskType);
        if (renamed) {
          config[field] = renamed;
          changed = true;
        }
      }
    }
  }

  if (isObject(schedule.executions) && hasOwn(schedule.executions, fromExecution)) {
    schedule.executions[toExecution] = mergeExecutionRecord(
      schedule.executions[fromExecution],
      schedule.executions[toExecution],
    );
    delete schedule.executions[fromExecution];
    changed = true;
  }

  if (Array.isArray(schedule.onDemandRequests)) {
    for (const request of schedule.onDemandRequests) {
      if (request?.taskType !== from) continue;
      request.taskType = to;
      pendingRequests += 1;
      changed = true;
    }
  }

  return { changed, pendingRequests };
}

function migrateApp(app, { from, to, renameTaskType }) {
  if (!isObject(app)) return false;
  let changed = false;

  if (isObject(app.taskTypeOverrides) && hasOwn(app.taskTypeOverrides, from)) {
    app.taskTypeOverrides[to] = mergeConfig(
      app.taskTypeOverrides[from],
      app.taskTypeOverrides[to],
      renameTaskType,
    );
    delete app.taskTypeOverrides[from];
    changed = true;
  }

  if (Array.isArray(app.disabledTaskTypes)) {
    const renamed = renameList(app.disabledTaskTypes, renameTaskType);
    if (renamed) {
      app.disabledTaskTypes = renamed;
      changed = true;
    }
  }

  return changed;
}

export async function renameScheduledTaskType({ rootDir, from, to }) {
  const names = {
    from,
    to,
    renameTaskType: (taskType) => (taskType === from ? to : taskType),
  };
  let schedules = 0;
  let pendingRequests = 0;
  const storedSchedule = await readJson(rootDir, SCHEDULE_PATH);
  if (storedSchedule) {
    const result = migrateSchedule(storedSchedule.value, names);
    if (result.changed) {
      await writeJson(storedSchedule.fullPath, storedSchedule.value);
      schedules = 1;
      pendingRequests = result.pendingRequests;
    }
  }

  const storedApps = await readJson(rootDir, APPS_PATH);
  let migratedApps = 0;
  if (isObject(storedApps?.value?.apps)) {
    for (const app of Object.values(storedApps.value.apps)) {
      if (migrateApp(app, names)) migratedApps += 1;
    }
    if (migratedApps) await writeJson(storedApps.fullPath, storedApps.value);
  }

  return { schedules, pendingRequests, migratedApps };
}

/**
 * Move a renamed task type's learning history to the new name, so the
 * confidence gate and failure-signal routing keep it — without it the renamed
 * type reads as "new" and auto-approves even when its record required
 * approval. Covers the bucket-keyed aggregates plus the nested references:
 * `taskTypes` maps/lists (errorPatterns, environmentalFailures) and
 * `taskType` fields on history entries (correlationWindow, failure-signature
 * `recent` lists). A key whose target already exists is left in place rather
 * than guessed at.
 */
export async function renameLearningBuckets({ rootDir, from, to }) {
  const stored = await readJson(rootDir, LEARNING_PATH);
  if (!isObject(stored?.value)) return { learningBuckets: 0 };
  const renameBucket = (key) => {
    const match = typeof key === 'string' && /^(self-improve|app-improve):([^|]+)(\|.*)?$/.exec(key);
    return match && match[2] === from ? `${match[1]}:${to}${match[3] || ''}` : null;
  };
  let learningBuckets = 0;
  const renameKeys = (map) => {
    for (const key of Object.keys(map)) {
      const target = renameBucket(key);
      if (!target || hasOwn(map, target)) continue;
      map[target] = map[key];
      delete map[key];
      learningBuckets += 1;
    }
  };
  // Nested references: walk every value below the top-level maps.
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        const target = renameBucket(item);
        if (target) { node[index] = target; learningBuckets += 1; } else walk(item);
      });
      return;
    }
    if (!isObject(node)) return;
    const taskTypeTarget = renameBucket(node.taskType);
    if (taskTypeTarget) { node.taskType = taskTypeTarget; learningBuckets += 1; }
    if (isObject(node.taskTypes)) renameKeys(node.taskTypes);
    for (const value of Object.values(node)) walk(value);
  };
  for (const mapName of LEARNING_KEYED_MAPS) {
    if (isObject(stored.value[mapName])) renameKeys(stored.value[mapName]);
  }
  walk(stored.value);
  if (learningBuckets) await writeJson(stored.fullPath, stored.value);
  return { learningBuckets };
}
