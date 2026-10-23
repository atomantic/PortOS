/**
 * Repair migration 437's successful return on an unreadable jobs file. The
 * runner recorded that return as applied, so the retained schedule never
 * retried. Keep the frozen transform, but refuse damaged inputs before using
 * it: this repair must stay pending until the operator restores those bytes.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import moveTask from './437-github-notifications-system-task.js';
import { readJsonOrNull } from './_lib.js';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export default {
  async up({ rootDir }) {
    const schedulePath = join(rootDir, 'data/cos/task-schedule.json');
    const schedule = await readJsonOrNull(schedulePath);
    if (schedule === null && existsSync(schedulePath)) {
      throw new Error('Cannot retry the GitHub notifications task move: repair data/cos/task-schedule.json before retrying migrations');
    }
    const task = schedule?.tasks?.['github-notifications'];
    if (!task) return;

    if (task.enabled !== false && task.type === 'cron'
      && typeof task.cronExpression === 'string' && task.cronExpression.trim()) {
      const jobsPath = join(rootDir, 'data/cos/autonomous-jobs.json');
      const jobs = await readJsonOrNull(jobsPath);
      if ((jobs === null && existsSync(jobsPath))
        || (jobs !== null && (!isObject(jobs) || !Array.isArray(jobs.jobs)))) {
        throw new Error('Cannot retry the GitHub notifications task move: repair data/cos/autonomous-jobs.json before retrying migrations');
      }
    }

    // An existing System task remains authoritative, including an explicit
    // disabled state. The frozen move also retains unrelated jobs and queues.
    await moveTask.up({ rootDir });
  },
};
