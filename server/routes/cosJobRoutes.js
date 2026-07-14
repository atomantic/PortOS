/**
 * CoS Autonomous Jobs Routes
 */

import { Router } from 'express';
import * as cos from '../services/cos.js';
import * as autonomousJobs from '../services/autonomousJobs.js';
import { checkJobGate, hasGate, getRegisteredGates } from '../services/jobGates.js';
import { parseCronToNextRun } from '../services/eventScheduler.js';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { createCosJobSchema, updateCosJobSchema } from '../lib/validation.js';

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

// GET /api/cos/jobs - Get all autonomous jobs
router.get('/jobs', asyncHandler(async (req, res) => {
  const jobs = await autonomousJobs.getAllJobs();
  const stats = await autonomousJobs.getJobStats();
  const jobsWithGates = jobs.map(j => ({ ...j, hasGate: hasGate(j.id) }));
  res.json({ jobs: jobsWithGates, stats, registeredGates: getRegisteredGates() });
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
  const { name, description, category, type, interval, intervalMs, scheduledTime, cronExpression, enabled, priority, autonomyLevel, promptTemplate, command, triggerAction, appId, taskMetadata, providerId, model, effort } = parsedJob.data;

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

  const job = await autonomousJobs.createJob({
    name, description, category, type, interval, intervalMs, scheduledTime, cronExpression,
    enabled, priority, autonomyLevel, promptTemplate, command, triggerAction, appId, taskMetadata, providerId, model, effort
  });
  res.json({ success: true, job });
}));

// PUT /api/cos/jobs/:id - Update a job
router.put('/jobs/:id', asyncHandler(async (req, res) => {
  const parsedJobUpdate = updateCosJobSchema.safeParse(req.body);
  if (!parsedJobUpdate.success) failValidation(parsedJobUpdate);
  const { name, description, category, type, interval, intervalMs, scheduledTime, cronExpression,
    enabled, priority, autonomyLevel, promptTemplate, command, triggerAction, weekdaysOnly, appId, taskMetadata, providerId, model, effort } = parsedJobUpdate.data;
  if (cronExpression) {
    validateCronExpression(cronExpression);
  }
  const job = await autonomousJobs.updateJob(req.params.id, {
    name, description, category, type, interval, intervalMs, scheduledTime, cronExpression,
    enabled, priority, autonomyLevel, promptTemplate, command, triggerAction, weekdaysOnly, appId, taskMetadata, providerId, model, effort
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
    const result = await autonomousJobs.executeShellJob(job).catch(err => ({
      success: false,
      exitCode: err.exitCode ?? 1,
      output: err.message
    }));
    return res.json({ success: result.success !== false, type: 'shell', ...result });
  }

  // Script jobs run their built-in handler directly
  if (autonomousJobs.isScriptJob(job)) {
    const result = await autonomousJobs.executeScriptJob(job).catch(err => ({
      success: false,
      error: err.message
    }));
    return res.json({ success: (result?.success ?? true) !== false, type: 'script', ...(result || {}) });
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
    // keys onto metadata.provider/metadata.model).
    provider: task.metadata?.provider,
    model: task.metadata?.model
  }, 'internal');

  if (!taskResult?.id) {
    res.json({ success: false, type: 'agent', error: 'Task was not queued (may be duplicate or blocked)' });
    return;
  }
  res.json({ success: true, type: 'agent', taskId: taskResult.id });
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
