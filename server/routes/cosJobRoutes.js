/**
 * CoS Autonomous Jobs Routes
 */

import { Router } from 'express';
import { addTask, reviveBlockedTask } from '../services/cos/cosTaskStore.js';
import { forceSpawnTask } from '../services/cos/cos.js';
import * as autonomousJobs from '../services/autonomousJobs.js';
import { hasGate, getRegisteredGates } from '../services/jobGates.js';
import { computeNextJobRun } from '../services/autonomousJobs/scheduler.js';
import { getJobNotepad, getJobNote, setJobNote, deleteJobNote, clearJobNotes } from '../services/autonomousJobs/notepad.js';
import { noteKeySchema, putNoteBodySchema } from '../lib/autonomousJobNotepadValidation.js';
import { parseCronToNextRun, isValidRecurrence } from '../services/eventScheduler.js';
import { getUserTimezone } from '../services/userTimezone.js';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { createCosJobSchema, updateCosJobSchema, triggerCosJobSchema } from '../lib/cos/cosValidation.js';
import { getTaskDataInputCatalog } from '../lib/taskDataInputCatalog.js';
import { generatedJobTaskFields } from '../lib/autonomousJobTask.js';
import { describeReaimedValues } from '../lib/jobFormFields.js';

const router = Router();

// The incident ledger is only read here, so keep it out of the boot import closure.
const loadIncidents = () => import('../services/autonomousJobs/incidents.js');

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
  const timezone = await getUserTimezone();
  const { listJobIncidents } = await loadIncidents();
  const openIncidentByJob = new Map();
  for (const incident of await listJobIncidents({ openOnly: true })) {
    // Newest first: keep the most recent open incident per job.
    if (!openIncidentByJob.has(incident.jobId)) openIncidentByJob.set(incident.jobId, incident);
  }
  // nextRunAt is the server's own next-fire projection (user timezone, DST,
  // weekdaysOnly), so the UI renders it instead of re-deriving it in the browser.
  const jobsWithGates = jobs.map(j => {
    const nextRun = j.cronSchedule && !isValidRecurrence(j.cronSchedule)
      ? null
      : computeNextJobRun(j, timezone);
    return {
      ...j,
      hasGate: hasGate(j.id),
      openIncident: openIncidentByJob.get(j.id) || null,
      nextRunAt: Number.isFinite(nextRun) ? new Date(nextRun).toISOString() : null
    };
  });
  res.json({ jobs: jobsWithGates, stats, registeredGates: getRegisteredGates(), dataInputCatalog: getTaskDataInputCatalog() });
}));

// GET /api/cos/jobs/incidents - Deduplicated failure incidents (open first, then resolved), newest first
router.get('/jobs/incidents', asyncHandler(async (req, res) => {
  const { listJobIncidents } = await loadIncidents();
  const incidents = await listJobIncidents();
  res.json({ incidents });
}));

// POST /api/cos/jobs/incidents/:id/ack - Acknowledge an open incident (silences reminders until a new signature appears)
router.post('/jobs/incidents/:id/ack', asyncHandler(async (req, res) => {
  const { acknowledgeJobIncident } = await loadIncidents();
  const incident = await acknowledgeJobIncident(req.params.id);
  if (!incident) throw new ServerError('Incident not found or already resolved', { status: 404, code: 'NOT_FOUND' });
  res.json({ incident });
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
  const { name, description, category, type, interval, intervalMs, scheduledTime, scheduleAnchor, cronExpression, cronSchedule, enabled, weekdaysOnly, priority, autonomyLevel, promptTemplate, dataInputs, formFields, formValues, command, triggerAction, appId, taskMetadata, providerId, model, effort, executionOptions, config } = parsedJob.data;

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

  // This hand-off is an ALLOWLIST, not a spread: a field added to the schema and
  // missed here is silently dropped — the request still succeeds and the job is
  // still created, just without it. Keep both lists in step.
  const job = await autonomousJobs.createJob({
    name, description, category, type, interval, intervalMs, scheduledTime, scheduleAnchor, cronExpression, cronSchedule,
    enabled, weekdaysOnly, priority, autonomyLevel, promptTemplate, dataInputs, formFields, formValues, command, triggerAction, appId, taskMetadata, providerId, model, effort, executionOptions, config
  });
  res.json({ success: true, job });
}));

// PUT /api/cos/jobs/:id - Update a job
router.put('/jobs/:id', asyncHandler(async (req, res) => {
  const parsedJobUpdate = updateCosJobSchema.safeParse(req.body);
  if (!parsedJobUpdate.success) failValidation(parsedJobUpdate);
  const { name, description, category, type, interval, intervalMs, scheduledTime, scheduleAnchor, cronExpression, cronSchedule,
    enabled, priority, autonomyLevel, promptTemplate, dataInputs, formFields, formValues, command, triggerAction, weekdaysOnly, appId, taskMetadata, providerId, model, effort, executionOptions, config } = parsedJobUpdate.data;
  if (cronExpression) {
    validateCronExpression(cronExpression);
  }
  if (cronSchedule) validateRecurrenceRule(cronSchedule);
  // Same allowlist hazard as the create path above — `updateJob` skips only
  // `undefined`, so a key missing HERE reads as "preserve", and an edit that
  // clears a field looks like it saved while the old value stays on disk.
  const job = await autonomousJobs.updateJob(req.params.id, {
    name, description, category, type, interval, intervalMs, scheduledTime, scheduleAnchor, cronExpression, cronSchedule,
    enabled, priority, autonomyLevel, promptTemplate, dataInputs, formFields, formValues, command, triggerAction, weekdaysOnly, appId, taskMetadata, providerId, model, effort, executionOptions, config
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

  const parsedTrigger = triggerCosJobSchema.safeParse(req.body || {});
  if (!parsedTrigger.success) failValidation(parsedTrigger);
  const { formValues: runFormValues } = parsedTrigger.data;

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
  // A one-off run configuration re-aims THIS run only: the values are merged
  // over the stored ones for prompt assembly and the job on disk is left alone,
  // so the card's inputs are an ad-hoc dial rather than a silent edit. Merged
  // (not replaced) so a field the caller didn't render keeps its saved value.
  const jobForRun = runFormValues
    ? { ...job, formValues: { ...job.formValues, ...runFormValues } }
    : job;
  const task = await autonomousJobs.generateTaskFromJob(jobForRun);
  const generated = generatedJobTaskFields(task);
  // A re-aimed run is different work, and `addTask` dedupes on the description's
  // first line + app — which the run configuration, appended to the END of the
  // prompt, never reaches. Name the changed values there so aiming the same
  // on-demand job somewhere else isn't swallowed as a duplicate of the run
  // already queued (and reported to the caller as a success).
  // Diff the MERGED values the run will actually use, not the request body: a
  // caller that sends only the field it changed leaves the rest to the stored
  // values, and diffing the partial body would report those as cleared.
  const reaimed = runFormValues ? describeReaimedValues(job.formFields, job.formValues, jobForRun.formValues) : '';
  // Forward the app scope + git-workflow options from the generated task's
  // metadata. addTask maps these top-level keys back onto metadata; without
  // them an app-scoped job triggered manually would run in the PortOS root
  // (the scheduled path emits the full task object via task:ready and is unaffected).
  const taskResult = await addTask({
    // The generator's own field projection — the app scope, the git-workflow
    // options, the provider/model/effort pins, the job:spawned markers and the
    // no-change-success contract — so a manual trigger queues exactly what the
    // scheduled path emits. Shared with the quota-burn lane
    // (`quotaBurnInvoke.js`), which layers a different approval posture on top.
    ...generated,
    ...(reaimed ? { description: `${generated.description} — ${reaimed}` } : {}),
    context: `Manually triggered autonomous job: ${job.name}`,
    approvalRequired: false
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
      await reviveBlockedTask(taskResult.id, { priority: task.priority, metadata: task.metadata }, 'internal');
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
  const spawnResult = await forceSpawnTask(taskResult.id);
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

// Per-job durable KV notepad (#17392). Machine-local; the job must exist so a
// typo'd id cannot accumulate orphan rows that deleteJob would never clear.
async function requireJob(id) {
  const job = await autonomousJobs.getJob(id);
  if (!job) throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
}

function parseNoteKey(key) {
  const parsed = noteKeySchema.safeParse(key);
  if (!parsed.success) failValidation(parsed);
  return parsed.data;
}

// GET /api/cos/jobs/:id/notepad - Entries plus byte usage and remaining budget
router.get('/jobs/:id/notepad', asyncHandler(async (req, res) => {
  await requireJob(req.params.id);
  res.json(await getJobNotepad(req.params.id));
}));

// GET /api/cos/jobs/:id/notepad/:key - One entry
router.get('/jobs/:id/notepad/:key', asyncHandler(async (req, res) => {
  await requireJob(req.params.id);
  const note = await getJobNote(req.params.id, parseNoteKey(req.params.key));
  if (!note) throw new ServerError('Notepad key not found', { status: 404, code: 'NOT_FOUND' });
  res.json(note);
}));

// PUT /api/cos/jobs/:id/notepad/:key - Upsert { value }; 400 on a cap overflow, state untouched
router.put('/jobs/:id/notepad/:key', asyncHandler(async (req, res) => {
  const key = parseNoteKey(req.params.key);
  const parsed = putNoteBodySchema.safeParse(req.body);
  if (!parsed.success) failValidation(parsed);
  await requireJob(req.params.id);
  res.json(await setJobNote(req.params.id, key, parsed.data.value));
}));

// DELETE /api/cos/jobs/:id/notepad/:key - Delete one entry
router.delete('/jobs/:id/notepad/:key', asyncHandler(async (req, res) => {
  await requireJob(req.params.id);
  if (!await deleteJobNote(req.params.id, parseNoteKey(req.params.key))) {
    throw new ServerError('Notepad key not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(await getJobNotepad(req.params.id));
}));

// DELETE /api/cos/jobs/:id/notepad - Clear every entry
router.delete('/jobs/:id/notepad', asyncHandler(async (req, res) => {
  await requireJob(req.params.id);
  await clearJobNotes(req.params.id);
  res.json(await getJobNotepad(req.params.id));
}));

export default router;
