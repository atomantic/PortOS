/**
 * A queued job's optional run window (`params.schedule`): `startAt` holds it in
 * the queue until then, and a job still waiting at `stopBy` never starts. A job
 * already running when `stopBy` passes finishes normally.
 */
export function jobScheduleState(job, now = Date.now()) {
  const schedule = job?.params?.schedule;
  if (!schedule) return null;
  const stopBy = schedule.stopBy ? Date.parse(schedule.stopBy) : NaN;
  if (Number.isFinite(stopBy) && now >= stopBy) return { expired: true };
  const startAt = schedule.startAt ? Date.parse(schedule.startAt) : NaN;
  if (Number.isFinite(startAt) && now < startAt) return { startAt };
  return null;
}

// Built from the absolute start so the message stays constant while the job waits.
export const scheduledWaitMessage = (startAt) =>
  `Scheduled — starts at ${new Date(startAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

export const SCHEDULED_WAIT_PATTERN = /^Scheduled — starts at /;
export const SCHEDULE_EXPIRED_ERROR = 'Its stop-by time passed before it started';
