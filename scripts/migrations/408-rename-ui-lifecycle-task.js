/**
 * Rename the framework-neutral UI lifecycle audit while preserving schedules,
 * app overrides, pending runs, execution history, and run-order dependencies.
 *
 * The task used to be stored as `react-lifecycle`; all newly written task IDs
 * use `ui-lifecycle`. These values are operator-owned schedule records, so the
 * rename merges into the new key when both are present and only then removes
 * the retired key. The migration is idempotent and does not dispatch work.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileCore.js';

const SCHEDULE_PATH = join('data', 'cos', 'task-schedule.json');
const APPS_PATH = join('data', 'apps.json');
const LEGACY_TASK = 'react-lifecycle';
const CURRENT_TASK = 'ui-lifecycle';
const LEGACY_EXECUTION = `task:${LEGACY_TASK}`;
const CURRENT_EXECUTION = `task:${CURRENT_TASK}`;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const renameTaskType = (taskType) => taskType === LEGACY_TASK ? CURRENT_TASK : taskType;

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

function mergeConfig(legacy, current) {
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
  if (Array.isArray(merged.runAfter)) {
    merged.runAfter = [...new Set(merged.runAfter.map(renameTaskType))];
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

function migrateSchedule(schedule) {
  if (!isObject(schedule)) return { changed: false, pendingRequests: 0 };
  let changed = false;
  let pendingRequests = 0;

  if (isObject(schedule.tasks)) {
    if (hasOwn(schedule.tasks, LEGACY_TASK)) {
      schedule.tasks[CURRENT_TASK] = mergeConfig(schedule.tasks[LEGACY_TASK], schedule.tasks[CURRENT_TASK]);
      delete schedule.tasks[LEGACY_TASK];
      changed = true;
    }
    for (const config of Object.values(schedule.tasks)) {
      if (!isObject(config) || !Array.isArray(config.runAfter)) continue;
      const renamed = [...new Set(config.runAfter.map(renameTaskType))];
      if (renamed.some((taskType, index) => taskType !== config.runAfter[index])
        || renamed.length !== config.runAfter.length) {
        config.runAfter = renamed;
        changed = true;
      }
    }
  }

  if (isObject(schedule.executions) && hasOwn(schedule.executions, LEGACY_EXECUTION)) {
    schedule.executions[CURRENT_EXECUTION] = mergeExecutionRecord(
      schedule.executions[LEGACY_EXECUTION],
      schedule.executions[CURRENT_EXECUTION],
    );
    delete schedule.executions[LEGACY_EXECUTION];
    changed = true;
  }

  if (Array.isArray(schedule.onDemandRequests)) {
    for (const request of schedule.onDemandRequests) {
      if (request?.taskType !== LEGACY_TASK) continue;
      request.taskType = CURRENT_TASK;
      pendingRequests += 1;
      changed = true;
    }
  }

  return { changed, pendingRequests };
}

function migrateApp(app) {
  if (!isObject(app)) return false;
  let changed = false;

  if (isObject(app.taskTypeOverrides) && hasOwn(app.taskTypeOverrides, LEGACY_TASK)) {
    app.taskTypeOverrides[CURRENT_TASK] = mergeConfig(
      app.taskTypeOverrides[LEGACY_TASK],
      app.taskTypeOverrides[CURRENT_TASK],
    );
    delete app.taskTypeOverrides[LEGACY_TASK];
    changed = true;
  }

  if (Array.isArray(app.disabledTaskTypes)) {
    const renamed = [...new Set(app.disabledTaskTypes.map(renameTaskType))];
    if (renamed.some((taskType, index) => taskType !== app.disabledTaskTypes[index])
      || renamed.length !== app.disabledTaskTypes.length) {
      app.disabledTaskTypes = renamed;
      changed = true;
    }
  }

  return changed;
}

export default {
  async up({ rootDir }) {
    let schedules = 0;
    let pendingRequests = 0;
    const storedSchedule = await readJson(rootDir, SCHEDULE_PATH);
    if (storedSchedule) {
      const result = migrateSchedule(storedSchedule.value);
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
        if (migrateApp(app)) migratedApps += 1;
      }
      if (migratedApps) await writeJson(storedApps.fullPath, storedApps.value);
    }

    return { schedules, pendingRequests, migratedApps };
  },
};
