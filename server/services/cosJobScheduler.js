/**
 * CoS Job Scheduler Module
 *
 * The autonomous-job + improvement-check timer machinery extracted from cos.js.
 * Owns:
 *  - `computeNextJobFireTime` — cron/interval next-fire computation for a job.
 *  - `registerSingleJobSchedule` / `registerJobSchedules` / `unregisterJobSchedules`
 *    — per-job one-shot timers via the event scheduler.
 *  - `executeScheduledJob` — fires a due job (script/shell inline, or emits
 *    `task:ready` for an AI agent) with the spawning-guard machinery
 *    (`spawningJobIds` / `addSpawningJob` / `clearSpawningJob`) that prevents
 *    duplicate spawns when timers overlap.
 *  - `scheduleNextImprovementCheck` — the improvement-check cadence timer that
 *    queues eligible improvement tasks and asks the scheduler to dequeue.
 *
 * Self-contained — imports only sibling services (no import back to cos.js).
 * The paused check reads loadState() directly (cos.js's isPaused lived there),
 * and the improvement-check timer asks for a dequeue via the `cos:dequeue-requested`
 * event instead of calling cos.js's dequeueNextTask, so the spawn-side scheduler
 * stays in cos.js. cos.js's init() wires that event and the job lifecycle
 * (job:spawned/job:spawn-failed → clearSpawningJob + re-register) back to these.
 */

import { schedule as scheduleEvent, cancel as cancelEvent, parseCronToNextRun } from './eventScheduler.js';
import { getUserTimezone, getLocalParts, nextLocalTime } from '../lib/timezone.js';
import { formatDuration } from '../lib/fileUtils.js';
import { loadState, isDaemonRunning } from './cosState.js';
import { getDomainMode } from '../lib/domainAutonomy.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { getCosTasks } from './cosTaskStore.js';
import { queueEligibleImprovementTasks } from './cosTaskGenerator.js';
import { generateTaskFromJob, recordJobGateSkip, isScriptJob, executeScriptJob, isShellJob, executeShellJob } from './autonomousJobs.js';
import { checkJobGate, hasGate } from './jobGates.js';

/**
 * Compute the next fire time for an autonomous job.
 * Supports two scheduling modes:
 * 1. Cron mode: job.cronExpression defines the full schedule
 * 2. Interval mode: job.intervalMs + optional job.scheduledTime (HH:MM in user timezone)
 *
 * @param {Object} job - The job object
 * @param {string} timezone - IANA timezone string for interpreting scheduledTime/cron
 * @returns {number} Timestamp (ms) of next fire time
 */
function computeNextJobFireTime(job, timezone) {
  // Convert scheduledTime (HH:MM) + interval to a cron expression so parseCronToNextRun
  // handles all "next occurrence after lastRun" logic without drift issues.
  // Only synthesize a daily/weekday cron for strictly daily or weekdaysOnly jobs.
  // Weekly/biweekly/sub-daily interval jobs fall through to the interval path below,
  // which correctly computes lastRun + intervalMs without scheduling them every day.
  // e.g. { interval: 'daily', scheduledTime: '04:30' } → '30 4 * * *'
  let cronExpr = job.cronExpression;
  const isDailyCronCandidate = job.interval === 'daily' || job.weekdaysOnly;
  if (!cronExpr && job.scheduledTime && isDailyCronCandidate) {
    const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (match) {
      const dayField = job.weekdaysOnly ? '1-5' : '*';
      cronExpr = `${Number(match[2])} ${Number(match[1])} * * ${dayField}`;
    }
  }

  if (cronExpr) {
    const from = job.lastRun ? new Date(job.lastRun) : new Date();
    const next = parseCronToNextRun(cronExpr, from, timezone);
    if (!next) {
      throw new Error(
        `Invalid cron expression for autonomous job` +
        (job.id ? ` "${job.id}"` : '') +
        `: ${cronExpr}`
      );
    }
    return next.getTime();
  }

  // Interval fallback: lastRun + intervalMs, then align to scheduledTime if set
  const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0;
  let nextDue = lastRun + job.intervalMs;

  // Restore scheduledTime alignment for interval-mode jobs (e.g. weekly at 00:00).
  // nextLocalTime advances nextDue to the next occurrence of HH:MM in the user's timezone,
  // preventing drift when a run occurs slightly late.
  if (job.scheduledTime) {
    const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (match) {
      const candidate = nextLocalTime(nextDue, Number(match[1]), Number(match[2]), timezone);
      if (candidate > nextDue) nextDue = candidate;
    }
  }

  if (job.weekdaysOnly) {
    const { dayOfWeek } = getLocalParts(new Date(nextDue), timezone);
    if (dayOfWeek === 0) nextDue += 24 * 60 * 60 * 1000; // Sunday → Monday
    if (dayOfWeek === 6) nextDue += 2 * 24 * 60 * 60 * 1000; // Saturday → Monday
  }

  return nextDue;
}

/**
 * Register a single autonomous job as a one-shot scheduled event.
 * After execution, re-registers for the next fire time.
 */
export async function registerSingleJobSchedule(jobId) {
  const { getJob } = await import('./autonomousJobs.js');
  const job = await getJob(jobId);
  if (!job || !job.enabled) {
    cancelEvent(`job:${jobId}`);
    return;
  }

  const timezone = await getUserTimezone();
  const nextFire = computeNextJobFireTime(job, timezone);
  const delayMs = Math.max(nextFire - Date.now(), 1000);

  scheduleEvent({
    id: `job:${jobId}`,
    type: 'once',
    delayMs,
    handler: () => executeScheduledJob(jobId),
    metadata: { description: `Autonomous job: ${job.name}`, jobId }
  });
}

// Track jobs currently being spawned (between task:ready emit and agent registration)
// to prevent duplicate spawns when timers overlap or fire during spawn
const spawningJobIds = new Set();
const spawningJobTimeouts = new Map();

function addSpawningJob(jobId) {
  spawningJobIds.add(jobId);
  // Auto-clear after 5 minutes if spawn never completes, and re-register the timer
  if (spawningJobTimeouts.has(jobId)) clearTimeout(spawningJobTimeouts.get(jobId));
  spawningJobTimeouts.set(jobId, setTimeout(() => {
    spawningJobIds.delete(jobId);
    spawningJobTimeouts.delete(jobId);
    emitLog('warn', `Job ${jobId} spawning timed out after 5m, re-registering schedule`, { jobId });
    registerSingleJobSchedule(jobId).catch(err =>
      console.error(`❌ Failed to re-register job schedule after spawn timeout for ${jobId}: ${err.message}`)
    );
  }, 5 * 60 * 1000));
}

export function clearSpawningJob(jobId) {
  spawningJobIds.delete(jobId);
  const timeout = spawningJobTimeouts.get(jobId);
  if (timeout) {
    clearTimeout(timeout);
    spawningJobTimeouts.delete(jobId);
  }
}

/**
 * Execute a scheduled autonomous job and re-register its timer.
 */
export async function executeScheduledJob(jobId) {
  if (!isDaemonRunning()) return;

  const paused = (await loadState()).paused || false;
  if (paused) {
    // Re-register for later
    await registerSingleJobSchedule(jobId);
    return;
  }

  const { getJob } = await import('./autonomousJobs.js');
  const job = await getJob(jobId);
  if (!job || !job.enabled) return;

  const state = await loadState();
  if (!state.config.autonomousJobsEnabled) {
    // Re-register so it fires when re-enabled
    await registerSingleJobSchedule(jobId);
    return;
  }

  // Per-domain CoS auto-run gate: a SCHEDULED job firing automatically is an
  // autonomous action, so off/dry-run withhold it (dry-run logs what it would
  // have run). Manual triggers run through POST /jobs/:id/trigger (which calls
  // the spawn/execute helpers directly), not this scheduled path, so explicit
  // user intent is unaffected. Record a skip first (advances
  // lastRun without incrementing runCount, exactly like the gate-skip path) so
  // re-registration computes a FUTURE fire time — re-registering a past-due job
  // with stale lastRun would refire every second (the same 1s-loop the spawn
  // branch's comment warns about).
  const cosAutonomyMode = getDomainMode(state.config, 'cos');
  if (cosAutonomyMode !== 'execute') {
    if (cosAutonomyMode === 'dry-run') {
      emitLog('info', `[dry-run] CoS auto-run would fire scheduled job: ${job.name}`, { jobId, domainAutonomy: 'cos' });
    }
    await recordJobGateSkip(jobId).catch(err =>
      console.error(`❌ Failed to record autonomy-skip for ${jobId}: ${err.message}`)
    );
    await registerSingleJobSchedule(jobId);
    return;
  }

  // Script jobs and shell jobs execute directly without spawning an AI agent
  if (isScriptJob(job)) {
    const scriptOk = await executeScriptJob(job).then(() => true, err => {
      emitLog('error', `Script job failed: ${job.name} - ${err.message}`, { jobId: job.id });
      return false;
    });
    if (scriptOk) emitLog('info', `Script job executed: ${job.name}`, { jobId: job.id });
  } else if (isShellJob(job)) {
    const shellOk = await executeShellJob(job).then(() => true, err => {
      emitLog('error', `Shell job failed: ${job.name} - ${err.message}`, { jobId: job.id });
      return false;
    });
    if (shellOk) emitLog('info', `Shell job executed: ${job.name}`, { jobId: job.id });
  } else {
    // Check if this job is already being spawned or has a running agent.
    // Don't re-register the timer here — the job:spawned handler will do it
    // after recordJobExecution updates lastRun. Re-registering with stale
    // lastRun causes a 1-second re-fire loop.
    if (spawningJobIds.has(jobId)) {
      emitLog('debug', `Job ${job.name} skipped - already spawning`, { jobId });
      return;
    }
    const agentAlreadyRunning = Object.values(state.agents).some(
      a => a.status === 'running' && a.metadata?.jobId === jobId
    );
    if (agentAlreadyRunning) {
      emitLog('debug', `Job ${job.name} skipped - agent already running`, { jobId });
      return;
    }

    // Check capacity before spawning an agent
    const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
    if (runningAgents >= state.config.maxConcurrentAgents) {
      emitLog('debug', `Job ${job.name} deferred - no agent slots`, { jobId });
      // Retry in 60s
      scheduleEvent({
        id: `job:${jobId}`,
        type: 'once',
        delayMs: 60000,
        handler: () => executeScheduledJob(jobId),
        metadata: { description: `Autonomous job: ${job.name} (retry)`, jobId }
      });
      return;
    }

    // Run gate check — skip LLM if precondition not met
    // Gate errors fail-open (run the job) to avoid silently dropping scheduled work
    let gateResult;
    try {
      gateResult = await checkJobGate(jobId);
    } catch (gateErr) {
      emitLog('warn', `Job ${job.name} gate error, failing open: ${gateErr?.message || gateErr}`, { jobId });
      gateResult = { shouldRun: true, reason: 'Gate error — failing open' };
    }
    if (!gateResult.shouldRun) {
      emitLog('debug', `Job ${job.name} gate skipped: ${gateResult.reason}`, { jobId, gate: gateResult });
      // Update lastRun so the job reschedules at its normal interval, but don't increment runCount
      await recordJobGateSkip(jobId).catch(err =>
        console.error(`❌ Failed to record gate-skip for ${jobId}: ${err.message}`)
      );
      await registerSingleJobSchedule(jobId);
      return;
    }
    if (hasGate(jobId)) {
      emitLog('info', `Job ${job.name} gate passed: ${gateResult.reason}`, { jobId, gate: gateResult });
    }

    // Mark as spawning before emitting task:ready to prevent races
    addSpawningJob(jobId);
    try {
      const task = await generateTaskFromJob(job);
      emitLog('info', `Autonomous job firing: ${job.name}`, { jobId, category: job.category });
      cosEvents.emit('task:ready', task);
      // Don't re-register timer here — lastRun hasn't been updated yet, so
      // computeNextJobFireTime would return a past-due time and the timer would
      // fire in 1s, creating a rapid re-fire loop. The job:spawned handler
      // re-registers after recordJobExecution updates lastRun.
      return;
    } catch (err) {
      clearSpawningJob(jobId);
      emitLog('error', `Failed to fire autonomous job: ${job.name} - ${err?.message || err}`, { jobId, category: job.category });
    }
  }

  // Re-register for next fire time (script/shell jobs, early returns, and error paths)
  await registerSingleJobSchedule(jobId);
}

/**
 * Register all enabled autonomous jobs as individual one-shot scheduled events.
 */
export async function registerJobSchedules() {
  const { getEnabledJobs } = await import('./autonomousJobs.js');
  const jobs = await getEnabledJobs();

  for (const job of jobs) {
    await registerSingleJobSchedule(job.id);
  }

  if (jobs.length > 0) {
    emitLog('info', `📅 Registered ${jobs.length} autonomous job schedule(s)`);
  }
}

/**
 * Cancel all autonomous job scheduled events.
 */
export async function unregisterJobSchedules() {
  const { getAllJobs } = await import('./autonomousJobs.js');
  const jobs = await getAllJobs();

  for (const job of jobs) {
    cancelEvent(`job:${job.id}`);
  }
}

/**
 * Schedule a one-shot timer for the next due improvement task.
 * When it fires, queues eligible improvement tasks and re-schedules.
 */
export async function scheduleNextImprovementCheck() {
  if (!isDaemonRunning()) return;

  const taskSchedule = await import('./taskSchedule.js');
  // Pull a wider list so a perpetually-"ready" weekly task can't mask an upcoming
  // cron boundary. We sort by status (ready first), so 1-element peeks always miss
  // the cron slot when anything else is ready.
  const upcoming = await taskSchedule.getUpcomingTasks(50);

  // Default: check again in 1 hour if nothing scheduled
  // Cap at 1 hour so per-app cron tasks (e.g. feature-ideas at 1am) are always checked
  // on time — getUpcomingTasks only sees global tasks, not per-app schedules
  const MAX_CHECK_INTERVAL = 60 * 60 * 1000;
  let delayMs = MAX_CHECK_INTERVAL;
  let description = 'Periodic improvement check (1h)';

  // Pick the soonest *scheduled* task (status='scheduled' with positive eligibleIn).
  // Ready tasks don't gate the delay — they'll be queued on whatever the next check
  // ends up being. Cron tasks DO gate the delay, because their firing window is a
  // single minute; missing it pushes the next attempt out by a full period.
  const nextScheduled = upcoming
    .filter(t => t.status === 'scheduled' && t.eligibleIn > 0)
    .sort((a, b) => a.eligibleIn - b.eligibleIn)[0];

  if (nextScheduled && nextScheduled.eligibleIn < MAX_CHECK_INTERVAL) {
    delayMs = nextScheduled.eligibleIn;
    description = `Next improvement: ${nextScheduled.taskType} in ${formatDuration(delayMs)}`;
  } else if (nextScheduled) {
    description = `Next improvement: ${nextScheduled.taskType} in ${nextScheduled.eligibleInFormatted} (capped at 1h)`;
  }

  scheduleEvent({
    id: 'cos-improvement-check',
    type: 'once',
    delayMs: Math.max(delayMs, 1000),
    handler: async () => {
      if (!isDaemonRunning()) return;
      // This is a 'once' event — the eventScheduler does NOT auto-reschedule it,
      // so the handler must re-arm itself. Re-arm in `finally` so a throw in the
      // body (loadState / getCosTasks / queueEligibleImprovementTasks) can't
      // permanently halt the improvement cadence until a process restart.
      try {
        const paused = (await loadState()).paused || false;
        if (paused) return;

        const state = await loadState();
        // Gate on the CoS auto-run domain: queueing improvement tasks mutates
        // COS-TASKS.md with autonomous internal work, so off/dry-run must not
        // queue (dry-run is purely a planning posture; the spawn-side gate
        // already withholds execution, but we also avoid the queue mutation).
        if (state.config.idleReviewEnabled && getDomainMode(state.config, 'cos') === 'execute') {
          const cosTaskData = await getCosTasks();
          await queueEligibleImprovementTasks(state, cosTaskData);
          cosEvents.emit('cos:dequeue-requested');
        }
      } finally {
        await scheduleNextImprovementCheck();
      }
    },
    metadata: { description }
  });
}
