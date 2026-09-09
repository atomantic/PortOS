/** Strict sequence barriers; ordinary burn rotations keep their existing semantics. */
import { requiresInstallWideTarget } from '../lib/taskTargetScope.js';
import { burnPlanOwnsAgent, burnPlanOwnsTask, quotaBurnProvenance } from '../lib/quotaBurnOrigin.js';
import { MAINTENANCE_DRAIN_TASK } from '../lib/maintenanceSequence.js';
import { jobIsSpent, quotaBurnJobKey } from '../lib/quotaBurnConfig.js';
import { recordQuotaBurnJobCompletion } from './quotaBurnCompletions.js';

/** A task the sequence still has to wait on. */
export const ACTIVE_TASK_STATUSES = new Set(['pending', 'in_progress', 'blocked']);

/**
 * Whether a sequence step may be walked at all: a run-once reference to an
 * app-scoped built-in task. Shared with the manual maintenance run, which
 * builds exactly these steps and must be refused the same way if it ever
 * stops doing so.
 */
export const sequenceStepShapeReason = (job) => (
  !job.runOnce || job.taskRef?.kind !== 'builtin' || !job.taskRef.appId || requiresInstallWideTarget(job.taskRef.taskType)
    ? 'sequence steps must be run-once app scheduled tasks'
    : null);

/**
 * Probe a `drain: true` claim step. Returns `{ job }` when the referenced app
 * still has claimable issues, `{ reason }` when the step must hold (the
 * detector is transient, claims are still in flight, or the reference does not
 * resolve to a perpetual `claim-issue`), or `{ drained: true }` when the backlog
 * is empty and the step counts as done.
 *
 * Shared by the quota-burn sequence and the manual maintenance run: the drain is
 * the one step whose completion is decided by a probe rather than by an agent
 * finishing, and two probes would drift on which filters they honor.
 */
export async function probeSequenceDrain(job, { catalog, ignoreTaskId = null }) {
  const { resolveQuotaBurnStep } = await import('./quotaBurnInvoke.js');
  const resolved = await resolveQuotaBurnStep(job, catalog);
  if (resolved.unavailable) return { reason: resolved.unavailable.reason };
  if (resolved.ref?.taskType !== MAINTENANCE_DRAIN_TASK || resolved.interval?.perpetual !== true) {
    return { reason: 'sequence drain requires perpetual claim-issue in Scheduled Tasks' };
  }
  const [{ getAppById }, { detectActionableWork }, { sanitizeTaskMetadata }] = await Promise.all([
    import('./apps.js'), import('./perpetualWork.js'), import('../lib/cosValidation.js'),
  ]);
  const app = await getAppById(resolved.ref.appId);
  if (!app) return { reason: 'sequence target app is unavailable' };
  const metadata = {
    ...sanitizeTaskMetadata(resolved.interval.taskMetadata),
    ...sanitizeTaskMetadata(app.taskTypeOverrides?.[MAINTENANCE_DRAIN_TASK]?.taskMetadata),
    ...sanitizeTaskMetadata(job.overrides?.params),
  };
  const detection = await detectActionableWork(MAINTENANCE_DRAIN_TASK, app, {
    issueAuthorFilter: metadata.issueAuthorFilter || 'self',
    issueExcludeLabels: metadata.issueExcludeLabels || [],
    ignoreTaskId,
  });
  if (detection.transient || !detection.hasDetector) return { reason: detection.reason || 'claim probe unavailable' };
  if (detection.actionable) return { job };
  if (detection.inFlightCount > 0) return { reason: 'sequence waiting for in-flight issue claims' };
  return { drained: true };
}

export async function nextQuotaBurnSequenceJob(family, { completions, reservations, catalog, ignoreTaskId = null }) {
  const { getAllTasks } = await import('./cosTaskStore.js');
  const { user, cos } = await getAllTasks();
  const active = [...(user?.tasks || []), ...(cos?.tasks || [])].find(task => task.id !== ignoreTaskId
    && burnPlanOwnsTask(task.metadata) && quotaBurnProvenance(task.metadata).family === family.id
    && ACTIVE_TASK_STATUSES.has(task.status));
  if (active) return { reason: 'sequence waiting for its queued, running, or blocked task' };
  if (Object.values(reservations).some(record => record.familyId === family.id)) {
    return { reason: 'sequence waiting for acceptance' };
  }
  for (const job of family.jobs) {
    if (jobIsSpent(job, family.id, completions)) continue;
    // Disabled or unavailable predecessors are barriers, never permission to skip ahead.
    if (job.enabled === false) return { reason: 'sequence step is disabled' };
    const shape = sequenceStepShapeReason(job);
    if (shape) return { reason: shape };
    if (!job.drain) return { job };
    const probe = await probeSequenceDrain(job, { catalog, ignoreTaskId });
    if (!probe.drained) return probe;
    const written = await recordQuotaBurnJobCompletion(family.id, job.id);
    if (!written) return { reason: 'could not record drained sequence step' };
    completions[quotaBurnJobKey(family.id, job.id)] = written[quotaBurnJobKey(family.id, job.id)];
  }
  return { reason: 'maintenance sequence complete' };
}

export async function completeQuotaBurnSequenceStep(agent) {
  if (!burnPlanOwnsAgent(agent)) return;
  const familyId = agent.metadata.taskQuotaBurnFamily;
  const jobId = agent.metadata.taskQuotaBurnStepId;
  if (!jobId) return;
  const { getQuotaBurnConfig } = await import('./quotaBurnStore.js');
  const family = (await getQuotaBurnConfig()).families[familyId];
  if (!family?.sequence || !agent?.result?.success) return;
  const job = family.jobs.find(entry => entry.id === jobId);
  if (job && !job.drain && job.runOnce) {
    if (!await recordQuotaBurnJobCompletion(familyId, jobId)) throw new Error('could not record completed sequence step');
  }
}
