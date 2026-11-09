/**
 * Give existing weekly/biweekly/monthly autonomous jobs a `scheduleAnchor`
 * (#15395): the local weekday (or day of month) of the `scheduledTime` slot
 * nearest the job's lastRun, or nearest now when it never ran. The scheduler
 * snapped `lastRun + interval` to that same slot before, so an on-time job's
 * next fire time is unchanged; only later runs stop being able to move the day.
 *
 * Edits the install's own jobs file in place, so it gates on that file existing
 * (no data.reference seed, nothing derived). A job that already carries a valid
 * anchor is left alone, which also makes a re-run a no-op.
 */
import { join } from 'path';
import { readFile } from 'fs/promises';
import { readJsonOrNull, writeJsonAtomic } from './_lib.js';
import { deriveScheduleAnchor, needsScheduleAnchor } from '../../server/lib/scheduleAnchor.js';

const JOBS_REL = 'data/cos/autonomous-jobs.json';
const SETTINGS_REL = 'data/settings.json';

// The runtime server runs under TZ=UTC, so an unconfigured install schedules in UTC.
async function resolveTimezone(rootDir) {
  const raw = await readFile(join(rootDir, SETTINGS_REL), 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  let timezone = null;
  try { timezone = raw == null ? null : JSON.parse(raw)?.timezone ?? null; } catch { timezone = null; }
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

export default {
  async up({ rootDir }) {
    const jobsPath = join(rootDir, JOBS_REL);
    const data = await readJsonOrNull(jobsPath);
    if (!Array.isArray(data?.jobs)) return { anchored: 0, reason: 'no-jobs-file' };

    const pending = data.jobs.filter(needsScheduleAnchor);
    if (pending.length === 0) return { anchored: 0 };

    const timezone = await resolveTimezone(rootDir);
    for (const job of pending) job.scheduleAnchor = deriveScheduleAnchor(job, timezone);
    await writeJsonAtomic(jobsPath, data);
    console.log(`📅 Anchored ${pending.length} weekly-or-longer autonomous job(s) to their scheduled day`);
    return { anchored: pending.length };
  },
};
