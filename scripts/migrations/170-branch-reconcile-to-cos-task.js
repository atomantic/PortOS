/**
 * Migrate the retired PortOS-only Branch & PR Reconciler into the new per-app
 * `branch-reconcile` Chief-of-Staff scheduled task.
 *
 * The old feature was a bespoke daily cron gated by `settings.branchReconcile`
 * (enabled/cron/actions), hardwired to the PortOS checkout. Its scheduler,
 * `/api/branch-reconcile` route, and settings schema were removed when the
 * feature became the per-app `branch-reconcile` task type — which is disabled by
 * default. Without this migration, an install that had `branchReconcile.enabled:
 * true` would silently STOP reconciling after the upgrade.
 *
 * This migration:
 *   1. If the old reconciler was ENABLED, enables the new `branch-reconcile`
 *      task in the schedule, carrying `cron` → `recheckCron` and `actions` →
 *      per-app action `taskMetadata` (cleanupMerged/openPr/resolveConflicts/
 *      autoMerge). It preserves the old PortOS-only scope by disabling the task
 *      (via `taskTypeOverrides`) on every OTHER managed app — the global enable
 *      would otherwise run it everywhere. The PortOS baseline app (which owns the
 *      install repo the old reconciler ran on) inherits the enable.
 *   2. Removes the now-dead `settings.branchReconcile` key (its scheduler/route/
 *      schema are gone; leaving it would just be re-imported and renamed aside on
 *      each boot).
 *
 * Idempotent: once the key is removed a re-run finds nothing and no-ops. When the
 * old reconciler was disabled, only the dead key is removed (no task is enabled).
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const SETTINGS_REL = 'data/settings.json';
const SCHEDULE_REL = 'data/cos/task-schedule.json';
const APPS_REL = 'data/apps.json';
const PORTOS_APP_ID = 'portos-default';

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

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** ON unless explicitly false — mirrors the runtime `actionOn` opt-out semantics. */
const on = (actions, key) => actions?.[key] !== false;

export default {
  async up({ rootDir }) {
    const settingsPath = join(rootDir, SETTINGS_REL);
    const settings = await readJson(settingsPath);
    if (!isObject(settings) || !('branchReconcile' in settings)) {
      return { updated: 0, reason: 'no-branchReconcile-settings' };
    }

    const old = isObject(settings.branchReconcile) ? settings.branchReconcile : {};
    const wasEnabled = old.enabled === true;

    if (wasEnabled) {
      // 1a. Enable + configure the new task from the old settings.
      const schedulePath = join(rootDir, SCHEDULE_REL);
      const schedule = await readJson(schedulePath);
      if (isObject(schedule) && isObject(schedule.tasks)) {
        const task = isObject(schedule.tasks['branch-reconcile']) ? schedule.tasks['branch-reconcile'] : {};
        task.enabled = true;
        if (typeof old.cron === 'string' && old.cron.trim().split(/\s+/).length === 5) {
          task.recheckCron = old.cron;
        }
        const actions = isObject(old.actions) ? old.actions : {};
        task.taskMetadata = {
          ...(isObject(task.taskMetadata) ? task.taskMetadata : {}),
          useWorktree: false,
          openPR: false,
          cleanupMerged: on(actions, 'cleanupMerged'),
          openPr: on(actions, 'openPr'),
          resolveConflicts: on(actions, 'resolveConflicts'),
          autoMerge: on(actions, 'autoMerge')
        };
        schedule.tasks['branch-reconcile'] = task;
        await writeFile(schedulePath, `${JSON.stringify(schedule, null, 2)}\n`);
        console.log('📝 branch-reconcile: carried the enabled PortOS reconciler into the new per-app CoS task');
      } else {
        console.log('⚠️ branch-reconcile: no task-schedule.json to enable — loadSchedule will backfill the disabled default; enable it under Chief of Staff');
      }

      // 1b. Preserve PortOS-only scope: disable the task on every non-PortOS app.
      const appsPath = join(rootDir, APPS_REL);
      const appsData = await readJson(appsPath);
      if (isObject(appsData) && isObject(appsData.apps)) {
        let scoped = 0;
        for (const [appId, app] of Object.entries(appsData.apps)) {
          if (appId === PORTOS_APP_ID || !isObject(app)) continue;
          const overrides = isObject(app.taskTypeOverrides) ? app.taskTypeOverrides : {};
          if (overrides['branch-reconcile']?.enabled === false) continue;
          overrides['branch-reconcile'] = { ...(isObject(overrides['branch-reconcile']) ? overrides['branch-reconcile'] : {}), enabled: false };
          app.taskTypeOverrides = overrides;
          scoped += 1;
        }
        if (scoped > 0) {
          await writeFile(appsPath, `${JSON.stringify(appsData, null, 2)}\n`);
          console.log(`📝 branch-reconcile: preserved PortOS-only scope — disabled on ${scoped} other managed app(s) (re-enable per app under Chief of Staff)`);
        }
      }
    }

    // 2. Drop the dead settings key.
    delete settings.branchReconcile;
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    console.log(`✅ branch-reconcile: removed dead settings.branchReconcile key (was ${wasEnabled ? 'enabled → migrated to CoS task' : 'disabled'})`);
    return { updated: 1, wasEnabled };
  }
};
