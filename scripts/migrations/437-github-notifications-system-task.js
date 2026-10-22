/**
 * Move the GitHub notifications check from the CoS scheduled task
 * `github-notifications` to the System task `job-github-notifications`.
 *
 * The check is one pass for the whole install (the accounts on Dev Tools ›
 * GitHub belong to the machine), so it belongs with the other System tasks
 * rather than beside the per-app scheduled tasks. The scheduled task type, its
 * hook and registry entry were removed; the schedule store keeps unknown task
 * types it loads, so without this migration a stale enabled entry would linger.
 *
 * This migration:
 *   1. In `data/cos/task-schedule.json`: read `tasks['github-notifications']`,
 *      remove it, its `executions` entry and any queued on-demand request.
 *   2. When that task was on a cron cadence (the Automations tab's weekday
 *      check, or a custom cron), seed `job-github-notifications` in
 *      `data/cos/autonomous-jobs.json` as enabled with the same cron. The job
 *      service fills in every other field from its shipped default at boot.
 *
 * An install that never turned the check on keeps the shipped default (off).
 * Idempotent: a re-run finds no scheduled task to move, and an existing job
 * record is never overwritten. An unreadable jobs file is left alone, and the
 * schedule entry is then kept so the move can be retried.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { readJsonOrNull, writeJsonAtomic } from './_lib.js';

const SCHEDULE_REL = 'data/cos/task-schedule.json';
const JOBS_REL = 'data/cos/autonomous-jobs.json';
const TASK_TYPE = 'github-notifications';
const JOB_ID = 'job-github-notifications';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

/** The cron the scheduled task ran on, or null when it was on-demand or off. */
function scheduledCron(task) {
  if (!isObject(task) || task.enabled === false || task.type !== 'cron') return null;
  return typeof task.cronExpression === 'string' && task.cronExpression.trim() ? task.cronExpression.trim() : null;
}

export default {
  async up({ rootDir }) {
    const schedulePath = join(rootDir, SCHEDULE_REL);
    const schedule = await readJsonOrNull(schedulePath);
    if (!isObject(schedule) || !isObject(schedule.tasks) || !(TASK_TYPE in schedule.tasks)) return;
    const cron = scheduledCron(schedule.tasks[TASK_TYPE]);

    if (cron) {
      const jobsPath = join(rootDir, JOBS_REL);
      const jobs = await readJsonOrNull(jobsPath);
      if (jobs === null && existsSync(jobsPath)) {
        console.log(`⏭️ github-notifications: ${JOBS_REL} is not valid JSON; left the scheduled task in place to retry`);
        return;
      }
      const doc = isObject(jobs) && Array.isArray(jobs.jobs) ? jobs : { version: 1, lastUpdated: new Date().toISOString(), jobs: [] };
      if (!doc.jobs.some((job) => isObject(job) && job.id === JOB_ID)) {
        const now = new Date().toISOString();
        doc.jobs.push({ id: JOB_ID, enabled: true, cronExpression: cron, createdAt: now, updatedAt: now });
        await writeJsonAtomic(jobsPath, doc);
        console.log(`📝 github-notifications: carried the ${cron} schedule over to the ${JOB_ID} System task`);
      }
    }

    delete schedule.tasks[TASK_TYPE];
    if (isObject(schedule.executions)) delete schedule.executions[`task:${TASK_TYPE}`];
    if (Array.isArray(schedule.onDemandRequests)) {
      schedule.onDemandRequests = schedule.onDemandRequests.filter((request) => request?.taskType !== TASK_TYPE);
    }
    await writeJsonAtomic(schedulePath, schedule);
    console.log(`📝 github-notifications: removed the retired scheduled task`);
  },
};
