/**
 * Retire the standalone branch-cleanup task in favor of branch-reconcile.
 *
 * branch-reconcile now begins with the deterministic merged-and-clean worktree
 * reaper, so keeping a second scheduled coordinator creates two competing
 * owners for the same local branches. Move any existing global task and
 * per-app enablement into branch-reconcile, then remove the old task key. The
 * migration intentionally does not copy the old weekly interval or prompt:
 * reconcile's perpetual drain and its safe cleanup-first pass are the new
 * contract. An enabled legacy task keeps the combined task enabled; otherwise
 * an upgrade could silently turn off cleanup that was already scheduled. A
 * non-null provider/model pin also carries forward when the new task still has
 * its default null pin, while an explicit target pin wins.
 */

import { readFile } from 'fs/promises';
import { writeJsonAtomic } from './_lib.js';
import { join } from 'path';

const SCHEDULE_REL = 'data/cos/task-schedule.json';
const APPS_REL = 'data/apps.json';
const LEGACY_TASK = 'branch-cleanup';
const TARGET_TASK = 'branch-reconcile';
const CARRY_FIELDS = ['enabled', 'providerId', 'model'];

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

async function readJson(path) {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(path, value) {
  await writeJsonAtomic(path, value);
}

/**
 * Merge the legacy global task into an existing target. Preserve an active
 * legacy schedule and carry non-null legacy pins into default-null target
 * fields; explicit target pins remain authoritative. Pure and exported for
 * migration tests.
 */
export function mergeTaskConfig(legacy, target) {
  const next = isObject(target) ? { ...target } : {};
  if (legacy?.enabled === true) next.enabled = true;
  for (const field of CARRY_FIELDS) {
    if (field === 'enabled') {
      if (!hasOwn(next, field) && hasOwn(legacy, field)) next[field] = legacy[field];
      continue;
    }
    if ((!hasOwn(next, field) || next[field] == null) && legacy[field] != null) next[field] = legacy[field];
  }
  return next;
}

/**
 * Move app-level enablement and provider pins while leaving the new task's
 * perpetual cadence and action metadata to the branch-reconcile defaults.
 * Pure and exported for migration tests.
 */
export function mergeAppOverride(legacy, target) {
  const next = isObject(target) ? { ...target } : {};
  if (legacy?.enabled === true) next.enabled = true;
  for (const field of CARRY_FIELDS) {
    if (field === 'enabled') {
      if (!hasOwn(next, field) && hasOwn(legacy, field)) next[field] = legacy[field];
      continue;
    }
    if ((!hasOwn(next, field) || next[field] == null) && legacy[field] != null) next[field] = legacy[field];
  }
  return next;
}

export default {
  async up({ rootDir }) {
    const schedulePath = join(rootDir, SCHEDULE_REL);
    const schedule = await readJson(schedulePath);
    let taskMigrated = false;

    if (isObject(schedule?.tasks) && hasOwn(schedule.tasks, LEGACY_TASK)) {
      const legacy = isObject(schedule.tasks[LEGACY_TASK]) ? schedule.tasks[LEGACY_TASK] : {};
      if (hasOwn(schedule.tasks, TARGET_TASK)) {
        schedule.tasks[TARGET_TASK] = mergeTaskConfig(legacy, schedule.tasks[TARGET_TASK]);
      } else {
        const migrated = mergeTaskConfig(legacy, null);
        if (Object.keys(migrated).length > 0) schedule.tasks[TARGET_TASK] = migrated;
      }
      delete schedule.tasks[LEGACY_TASK];
      await writeJson(schedulePath, schedule);
      taskMigrated = true;
      console.log('📝 branch-cleanup: merged global schedule into branch-reconcile');
    }

    const appsPath = join(rootDir, APPS_REL);
    const apps = await readJson(appsPath);
    let migratedApps = 0;
    if (isObject(apps?.apps)) {
      for (const app of Object.values(apps.apps)) {
        if (!isObject(app?.taskTypeOverrides) || !hasOwn(app.taskTypeOverrides, LEGACY_TASK)) continue;
        const legacy = isObject(app.taskTypeOverrides[LEGACY_TASK])
          ? app.taskTypeOverrides[LEGACY_TASK]
          : {};
        const target = hasOwn(app.taskTypeOverrides, TARGET_TASK)
          ? app.taskTypeOverrides[TARGET_TASK]
          : null;
        app.taskTypeOverrides[TARGET_TASK] = mergeAppOverride(legacy, target);
        delete app.taskTypeOverrides[LEGACY_TASK];
        migratedApps += 1;
      }
      if (migratedApps > 0) {
        await writeJson(appsPath, apps);
        console.log(`📝 branch-cleanup: moved app overrides for ${migratedApps} app(s)`);
      }
    }

    return { taskMigrated, migratedApps, updated: (taskMigrated ? 1 : 0) + migratedApps };
  }
};
