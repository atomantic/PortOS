/**
 * CoS Autonomous Jobs Routes
 */

import { Router } from 'express';
import * as cos from '../services/cos.js';
import * as autonomousJobs from '../services/autonomousJobs.js';
import { checkJobGate, hasGate, getRegisteredGates } from '../services/jobGates.js';
import { computeNextJobRun } from '../services/autonomousJobs/scheduler.js';
import { parseCronToNextRun, isValidRecurrence } from '../services/eventScheduler.js';
import { getUserTimezone } from '../services/userTimezone.js';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { createCosJobSchema, updateCosJobSchema } from '../lib/validation.js';
import { getTaskDataInputCatalog } from '../lib/taskDataInputCatalog.js';

const router = Router();

// Validate a 5-field cron expression for job create/update. Throws a 400
// ServerError on a malformed field count or an unparseable expression.
function validateCronExpression(cronExpression) {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new ServerError('cronExpression must be a 5-field cron expression (minute hour dayOfMonth month dayOfWeek)', { status: 400, code: 'VALIDATION_ERROR' });
  }
  let nextRun;
  try {
    nextRun = parseCronToNextRun(cronExpression, new Date(), 'UTC');
  } catch (err) {
    throw new ServerError(`Invalid cronExpression: ${err?.message || 'unable to parse'}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (nextRun === null) {
    throw new ServerError('Invalid cronExpression: no valid run time could be determined', { status: 400, code: 'VALIDATION_ERROR' });
  }
}

function validateRecurrenceRule(rule) {
  if (!isValidRecurrence(rule)) {
    throw new ServerError('Invalid cron recurrence rule', { status: 400, code: 'VALIDATION_ERROR' });
  }
}

// GET /api/cos/jobs - Get all autonomous jobs
router.get('/jobs', asyncHandler(async (req, res) => {
  const jobs = await autonomousJobs.getAllJobs();
  const stats = await autonomousJobs.getJobStats();
  const recurrenceJobs = jobs.filter(job => job.cronSchedule);
  const timezone = recurrenceJobs.length ? await getUserTimezone() : null;
  const jobsWithGates = jobs.map(j => {
    const nextRun = j.cronSchedule && isValidRecurrence(j.cronSchedule)
      ? computeNextJobRun(j, timezone)
      : null;
    return {
      ...j,
      hasGate: hasGate(j.id),
      ...(j.cronSchedule ? { nextRunAt: Number.isFinite(nextRun) ? new Date(nextRun).toISOString() : null } : {})
    };
  });
  res.json({ jobs: jobsWithGates, stats, registeredGates: getRegisteredGates(), dataInputCatalog: getTaskDataInputCatalog() });
}));

// GET /api/cos/jobs/due - Get jobs that are due to run
router.get('/jobs/due', asyncHandler(async (req, res) => {
  const due = await autonomousJobs.getDueJobs();
  res.json({ due });
}));

// GET /api/cos/jobs/intervals - Get available interval options
router.get('/jobs/intervals', (req, res) => {
  res.json({ intervals: autonomousJobs.INTERVAL_OPTIONS });
});

// GET /api/cos/jobs/allowed-commands - Get allowed commands for shell jobs
router.get('/jobs/allowed-commands', (req, res) => {
  res.json({ commands: autonomousJobs.getAllowedCommands() });
});

// GET /api/cos/jobs/gates - Get all registered LLM gates
router.get('/jobs/gates', asyncHandler(async (req, res) => {
  const gateIds = getRegisteredGates();
  const settled = await Promise.allSettled(
    gateIds.map(async (id) => {
      const result = await checkJobGate(id);
      return { jobId: id, ...result };
    })
  );
  const results = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { jobId: gateIds[i], shouldRun: true, reason: `Gate error (fail-open): ${s.reason?.message || s.reason}`, error: true }
  );
  res.json({ gates: results });
}));

// POST /api/cos/jobs/:id/gate-check - Check a job's LLM gate without running
router.post('/jobs/:id/gate-check', asyncHandler(async (req, res) => {
  const result = await checkJobGate(req.params.id);
  res.json({ jobId: req.params.id, hasGate: hasGate(req.params.id), ...result });
}));

// GET /api/cos/jobs/:id - Get a single job
router.get('/jobs/:id', asyncHandler(async (req, res) => {
  const job = await autonomousJobs.getJob(req.params.id);
  if (!job) {
    throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(job);
}));

// POST /api/cos/jobs - Create a new autonomous job
router.post('/jobs', asyncHandler(async (req, res) => {
  const parsedJob = createCosJobSchema.safeParse(req.body);
  if (!parsedJob.success) failValidation(parsedJob);
  const { name, description, category, type, interval, intervalMs, scheduledTime, cronExpression, cronSchedule, enabled, priority, autonomyLevel, promptTemplate, dataInputs, command, triggerAction, appId, taskMetadata, providerId, model, effort } = parsedJob.data;

  if (type === 'shell' && !command?.trim()) {
    throw new ServerError('command is required for shell jobs', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!type || type === 'agent') {
    if (!promptTemplate) {
      throw new ServerError('promptTemplate is required for agent jobs', { status: 400, code: 'VALIDATION_ERROR' });
    }
  }
  if (cronExpression) {
    validateCronExpression(cronExpression);
  }
  if (cronSchedule) validateRecurrenceRule(cronSchedule);

  const job = await autonomousJobs.createJob({
    name, description, category, type, interval, intervalMs, scheduledTime, cronExpression, cronSchedule,
    enabled, priority, autonomyLevel, promptTemplate, dataInputs, command, triggerAction, appId, taskMetadata, providerId, model, effort
  });
  res.json({ success: true, job });
}));

// PUT /api/cos/jobs/:id - Update a job
router.put('/jobs/:id', asyncHandler(async (req, res) => {
  const parsedJobUpdate = updateCosJobSchema.safeParse(req.body);
  if (!parsedJobUpdate.success) failValidation(parsedJobUpdate);
  const { name, description, category, type, interval, intervalMs, scheduledTime, cronExpression, cronSchedule,
    enabled, priority, autonomyLevel, promptTemplate, dataInputs, command, triggerAction, weekdaysOnly, appId, taskMetadata, providerId, model, effort } = parsedJobUpdate.data;
  if (cronExpression) {
    validateCronExpression(cronExpression);
  }
  if (cronSchedule) validateRecurrenceRule(cronSchedule);
  const job = await autonomousJobs.updateJob(req.params.id, {
    name, description, category, type, interval, intervalMs, scheduledTime, cronExpression, cronSchedule,
    enabled, priority, autonomyLevel, promptTemplate, dataInputs, command, triggerAction, weekdaysOnly, appId, taskMetadata, providerId, model, effort
  });
  if (!job) {
    throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true, job });
}));

// POST /api/cos/jobs/:id/toggle - Toggle job enabled/disabled
router.post('/jobs/:id/toggle', asyncHandler(async (req, res) => {
  const job = await autonomousJobs.toggleJob(req.params.id);
  if (!job) {
    throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true, job });
}));

// POST /api/cos/jobs/:id/trigger - Manually trigger a job now
router.post('/jobs/:id/trigger', asyncHandler(async (req, res) => {
  const job = await autonomousJobs.getJob(req.params.id);
  if (!job) {
    throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
  }

  // Shell jobs execute the command directly
  if (autonomousJobs.isShellJob(job)) {
    const result = await autonomousJobs.executeShellJob(job);
    return res.json({ success: result.success !== false, type: 'shell', status: 'completed', ...result });
  }

  // Script jobs run their built-in handler directly. This is the manual
  // "Run now" path — the user explicitly requested it, so mark it foreground
  // (`manual: true`) and any fan-out handler reports failures individually
  // rather than coalescing them as unattended background work.
  if (autonomousJobs.isScriptJob(job)) {
    const result = await autonomousJobs.executeScriptJob(job, { manual: true });
    return res.json({ success: (result?.success ?? true) !== false, type: 'script', status: 'completed', ...(result || {}) });
  }

  // Generate task and add to CoS internal task queue
  // Job execution is recorded via the job:spawned event when the agent actually starts
  // Manual triggers always bypass approval — the user explicitly requested execution
  const task = await autonomousJobs.generateTaskFromJob(job);
  // Forward the app scope + git-workflow options from the generated task's
  // metadata. addTask maps these top-level keys back onto metadata; without
  // them an app-scoped job triggered manually would run in the PortOS root
  // (the scheduled path emits the full task object via task:ready and is unaffected).
  const taskResult = await cos.addTask({
    description: task.description,
    priority: task.priority,
    context: `Manually triggered autonomous job: ${job.name}`,
    approvalRequired: false,
    app: task.metadata?.app,
    useWorktree: task.metadata?.useWorktree,
    openPR: task.metadata?.openPR,
    simplify: task.metadata?.simplify,
    // Forward the job's AI provider/model override so a manual trigger uses the
    // same provider/model the scheduled path would (addTask maps these top-level
    // keys onto metadata.provider/metadata.model). Effort follows the same path
    // so a manual run cannot silently lose its saved reasoning override.
    provider: task.metadata?.provider,
    model: task.metadata?.model,
    effort: task.metadata?.effort,
    prompt: task.metadata?.prompt,
    // Preserve the markers consumed by the job:spawned listener so Run now
    // records the execution and re-registers the saved schedule.
    autonomousJob: task.metadata?.autonomousJob,
    jobId: task.metadata?.jobId,
    // A marked audit may complete successfully with a verified empty branch;
    // preserve that contract on the manually queued task as well as the
    // scheduled task path.
    noChangeSuccess: task.metadata?.noChangeSuccess
  }, 'internal', { suppressDequeue: true });

  if (!taskResult?.id) {
    res.json({
      success: false,
      type: 'agent',
      status: 'skipped',
      reason: 'Task was not queued (may be duplicate or blocked)'
    });
    return;
  }
  if (taskResult.duplicate) {
    // A manual trigger is an explicit retry: a failure-blocked twin is revived
    // with a fresh retry budget (#2614) instead of silently pointing the user
    // at a task that will never run; an active twin is surfaced as-is.
    if (taskResult.status === 'blocked') {
      await cos.reviveBlockedTask(taskResult.id, { priority: task.priority, metadata: task.metadata }, 'internal');
      res.json({ success: true, type: 'agent', status: 'queued', taskId: taskResult.id, revived: true });
      return;
    }
    res.json({
      success: true,
      type: 'agent',
      status: 'skipped',
      reason: 'An equivalent task is already queued',
      taskId: taskResult.id,
      duplicate: true
    });
    return;
  }

  // A manual trigger is an explicit Run now action, so use the same force-spawn
  // path as the task-list play button. The ordinary `tasks:changed` listener
  // intentionally applies autonomous scheduling gates to internal tasks and can
  // leave this freshly-created task pending until a later evaluation or manual
  // start. Keep the task queued when the spawn cannot proceed (for example, no
  // capacity), but report the actionable reason instead of claiming it started.
  const spawnResult = await cos.forceSpawnTask(taskResult.id);
  if (spawnResult?.error) {
    res.json({
      success: false,
      type: 'agent',
      status: 'skipped',
      reason: spawnResult.error,
      taskId: taskResult.id
    });
    return;
  }
  res.json({ success: true, type: 'agent', status: 'queued', started: true, taskId: taskResult.id });
}));

// DELETE /api/cos/jobs/:id - Delete a job
router.delete('/jobs/:id', asyncHandler(async (req, res) => {
  const deleted = await autonomousJobs.deleteJob(req.params.id);
  if (!deleted) {
    throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true });
}));

export default router;
