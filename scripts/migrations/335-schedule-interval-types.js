/**
 * Collapse the seven scheduled-task interval types onto the two-variant cadence
 * model, with `perpetual` as an orthogonal boolean flag.
 *
 *   once      → on-demand (manual trigger only; no auto-run, no reset loop)
 *   rotation  → cron '0 7 * * *'   (un-shipped in defaults; a conservative
 *                                   daily slot, never an unbounded drain)
 *   daily     → cron '0 7 * * *'
 *   weekly    → cron '0 7 * * 1'   (Monday, so work never lands on a weekend)
 *   custom    → cron derived from intervalMs
 *   perpetual → on-demand + perpetual: true (recheck cadence retained)
 *   on-demand → on-demand (branch-reconcile / issue-reconcile gain perpetual)
 *
 * Applies to both schedule-file locations and to the per-app cadence overrides
 * in apps.json. Idempotent: a record already on the new model is left alone,
 * and a raw 5-field cron override passes through untouched. `enabled`,
 * `weekdaysOnly`, and every other field are preserved.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  INTERVAL_TYPES,
  decodeIntervalType,
  isCronExpression,
  isReconcileDrainTaskType,
  normalizeIntervalConfig,
} from '../../server/services/taskScheduleConstants.js';

const SCHEDULE_PATHS = [
  join('data', 'cos', 'task-schedule.json'),
  join('data', 'task-schedule.json'),
];
const APPS_PATH = join('data', 'apps.json');

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

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

/** Migrate one task config in place. Returns true when it changed. */
export function migrateTaskConfig(taskType, config) {
  if (!config || typeof config !== 'object') return false;
  let changed = normalizeIntervalConfig(config);
  // The reconcile drains shipped as on-demand while their drain behavior was
  // hardcoded by task name. That special case is gone, so the flag has to be
  // written onto the record for them to keep draining.
  if (isReconcileDrainTaskType(taskType) && config.perpetual !== true) {
    config.perpetual = true;
    changed = true;
  }
  return changed;
}

/**
 * Migrate one per-app override in place. Per-app rows carry the cadence as a
 * bare string (`interval`), so a retired name becomes either 'on-demand' or a
 * cron expression. Returns true when it changed.
 */
export function migrateAppOverride(override) {
  if (!override || typeof override !== 'object') return false;
  const { interval } = override;
  if (typeof interval !== 'string' || isCronExpression(interval)) return false;
  const decoded = decodeIntervalType(interval, { intervalMs: override.intervalMs });
  const next = decoded.type === INTERVAL_TYPES.CRON ? decoded.cronExpression : INTERVAL_TYPES.ON_DEMAND;
  if (next === interval) return false;
  override.interval = next;
  return true;
}

export default {
  async up({ rootDir }) {
    let updated = 0;

    for (const relPath of SCHEDULE_PATHS) {
      const fullPath = join(rootDir, relPath);
      const schedule = await readJson(fullPath);
      const tasks = schedule?.tasks;
      if (!tasks || typeof tasks !== 'object') continue;

      let migrated = 0;
      for (const [taskType, config] of Object.entries(tasks)) {
        if (migrateTaskConfig(taskType, config)) migrated += 1;
      }
      if (!migrated) continue;
      await writeJson(fullPath, schedule);
      updated += migrated;
      console.log(`📅 ${relPath}: migrated ${migrated} task cadence(s) to on-demand/cron + perpetual flag`);
    }

    // apps.json stores `apps` as an object keyed by app id.
    const appsPath = join(rootDir, APPS_PATH);
    const apps = await readJson(appsPath);
    if (apps?.apps && typeof apps.apps === 'object') {
      let migrated = 0;
      for (const app of Object.values(apps.apps)) {
        for (const override of Object.values(app?.taskTypeOverrides || {})) {
          if (migrateAppOverride(override)) migrated += 1;
        }
      }
      if (migrated) {
        await writeJson(appsPath, apps);
        updated += migrated;
        console.log(`📅 ${APPS_PATH}: migrated ${migrated} per-app cadence override(s)`);
      }
    }

    return { updated };
  },
};
