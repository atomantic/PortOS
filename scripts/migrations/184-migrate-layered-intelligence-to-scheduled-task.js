/**
 * Migrate the retired global "Layered Intelligence Loop" autonomous-job into the
 * per-app HANDLER-BACKED `layered-intelligence` Chief-of-Staff scheduled task
 * (issue #2322).
 *
 * The loop shipped as ONE global autonomous-job (`job-layered-intelligence`) that
 * swept every enabled app on a single daily fire, with a global on/off under CoS
 * → System Tasks and per-app config living in `app.layeredIntelligence`. That was
 * confusing (a per-app card could read "Enabled · Due now" yet nothing ran,
 * because the single global sweep already fired) and bespoke (every other per-app
 * automation is a scheduled task). The job, its SCRIPT_HANDLERS registration and
 * its DEFAULT_JOBS catalog entry were removed. Without this migration, an install
 * whose loop was running would silently stop.
 *
 * This migration:
 *   1. In `data/cos/autonomous-jobs.json`: find `job-layered-intelligence`,
 *      capture its `enabled` as `globalEnabled`, and REMOVE the record
 *      (tombstone — nothing dispatches on it anymore).
 *   2. For each app in `data/apps.json` that has a `layeredIntelligence` object,
 *      move the SCHEDULING fields into `taskTypeOverrides['layered-intelligence']`
 *      = { enabled: (globalEnabled && !!li.enabled), interval, intervalMs,
 *      providerId?, model? }. BEHAVIOR (sources/allowedScopes/rules/handoff) and
 *      `lastRunAt` stay in `app.layeredIntelligence`. Faithful effective-state:
 *      a per-app enable did nothing while the global job was off, so the override
 *      is enabled only when BOTH were on.
 *   3. If the global job was enabled, enable the `layered-intelligence` task TYPE
 *      in `data/cos/task-schedule.json` (the master switch the scheduler checks
 *      before any per-app override) — otherwise the moved per-app enables would be
 *      inert and a running loop would stop.
 *
 * Idempotent: the per-app move is skipped when the override already exists, and a
 * re-run after the job is gone finds nothing to tombstone. Safe when any target
 * file is absent (fresh install → no-op).
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const JOBS_REL = 'data/cos/autonomous-jobs.json';
const APPS_REL = 'data/apps.json';
const SCHEDULE_REL = 'data/cos/task-schedule.json';
const LI_JOB_ID = 'job-layered-intelligence';
const LI_TASK_TYPE = 'layered-intelligence';
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

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
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Map a stored per-app intervalMs to the override's { interval, intervalMs }
 * pair the scheduler understands: 'daily'/'weekly' for the standard cadences,
 * else 'custom' (the CUSTOM branch reads the numeric intervalMs). Exported for
 * the migration test.
 */
export function intervalFieldsFromMs(intervalMs) {
  const ms = typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DAY;
  if (Math.abs(ms - DAY) < 1000) return { interval: 'daily', intervalMs: ms };
  if (Math.abs(ms - WEEK) < 1000) return { interval: 'weekly', intervalMs: ms };
  return { interval: 'custom', intervalMs: ms };
}

/**
 * Build the per-app task override from an app's legacy layeredIntelligence config
 * + whether the global job was enabled. Pure — exported for the migration test.
 */
export function buildOverride(li, globalEnabled) {
  const { interval, intervalMs } = intervalFieldsFromMs(li?.intervalMs);
  const override = {
    enabled: !!globalEnabled && li?.enabled === true,
    interval,
    intervalMs
  };
  if (typeof li?.providerId === 'string' && li.providerId) override.providerId = li.providerId;
  if (typeof li?.model === 'string' && li.model) override.model = li.model;
  return override;
}

export default {
  async up({ rootDir }) {
    // 1. Tombstone the global job + capture its enabled state.
    const jobsPath = join(rootDir, JOBS_REL);
    const jobsData = await readJson(jobsPath);
    let globalEnabled = false;
    let jobRemoved = false;
    if (isObject(jobsData) && Array.isArray(jobsData.jobs)) {
      const job = jobsData.jobs.find((j) => isObject(j) && j.id === LI_JOB_ID);
      if (job) {
        globalEnabled = job.enabled === true;
        jobsData.jobs = jobsData.jobs.filter((j) => !(isObject(j) && j.id === LI_JOB_ID));
        await writeJson(jobsPath, jobsData);
        jobRemoved = true;
        console.log(`📝 layered-intelligence: tombstoned the retired global job (was ${globalEnabled ? 'enabled' : 'disabled'})`);
      }
    }

    // 2. Move per-app scheduling into taskTypeOverrides['layered-intelligence'].
    const appsPath = join(rootDir, APPS_REL);
    const appsData = await readJson(appsPath);
    let migratedApps = 0;
    if (isObject(appsData) && isObject(appsData.apps)) {
      for (const app of Object.values(appsData.apps)) {
        if (!isObject(app) || !isObject(app.layeredIntelligence)) continue;
        const overrides = isObject(app.taskTypeOverrides) ? app.taskTypeOverrides : {};
        if (isObject(overrides[LI_TASK_TYPE])) continue; // idempotent — already moved
        overrides[LI_TASK_TYPE] = buildOverride(app.layeredIntelligence, globalEnabled);
        app.taskTypeOverrides = overrides;
        migratedApps += 1;
      }
      if (migratedApps > 0) {
        await writeJson(appsPath, appsData);
        console.log(`📝 layered-intelligence: moved scheduling into per-app task overrides for ${migratedApps} app(s)`);
      }
    }

    // 3. Preserve effective enablement: if the old global job was on, enable the
    //    task TYPE globally (the master switch every per-app override is gated on).
    if (globalEnabled) {
      const schedulePath = join(rootDir, SCHEDULE_REL);
      const schedule = await readJson(schedulePath);
      if (isObject(schedule) && isObject(schedule.tasks)) {
        const task = isObject(schedule.tasks[LI_TASK_TYPE]) ? schedule.tasks[LI_TASK_TYPE] : {};
        if (task.enabled !== true) {
          task.enabled = true;
          schedule.tasks[LI_TASK_TYPE] = task;
          await writeJson(schedulePath, schedule);
          console.log('📝 layered-intelligence: enabled the scheduled task type (the global job was on)');
        }
      } else {
        console.log('⚠️ layered-intelligence: no task-schedule.json to enable — loadSchedule backfills the disabled default; enable it under Chief of Staff → Schedule');
      }
    }

    return { updated: migratedApps + (jobRemoved ? 1 : 0), globalEnabled, jobRemoved, migratedApps };
  }
};
