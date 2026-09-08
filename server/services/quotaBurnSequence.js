/** Strict sequence barriers; ordinary burn rotations keep their existing semantics. */
import { requiresInstallWideTarget } from '../lib/taskTargetScope.js';
import { quotaBurnProvenance } from '../lib/quotaBurnOrigin.js';
import { jobIsSpent, quotaBurnJobKey } from '../lib/quotaBurnConfig.js';
import { recordQuotaBurnJobCompletion } from './quotaBurnCompletions.js';

export async function nextQuotaBurnSequenceJob(family, { completions, reservations, catalog, ignoreTaskId = null }) {
  const { getAllTasks } = await import('./cosTaskStore.js');
  const { user, cos } = await getAllTasks();
  const active = [...(user?.tasks || []), ...(cos?.tasks || [])].find(task =>
    task.id !== ignoreTaskId && quotaBurnProvenance(task.metadata).family === family.id
    && ['pending', 'in_progress', 'blocked'].includes(task.status));
  if (active) return { reason: 'sequence waiting for its queued, running, or blocked task' };
  if (Object.values(reservations).some(record => record.familyId === family.id)) {
    return { reason: 'sequence waiting for acceptance' };
  }
  for (const job of family.jobs) {
    if (jobIsSpent(job, family.id, completions)) continue;
    // Disabled or unavailable predecessors are barriers, never permission to skip ahead.
    if (job.enabled === false) return { reason: 'sequence step is disabled' };
    if (!job.runOnce || job.taskRef?.kind !== 'builtin' || !job.taskRef.appId || requiresInstallWideTarget(job.taskRef.taskType)) {
      return { reason: 'sequence steps must be run-once app scheduled tasks' };
    }
    if (!job.drain) return { job };
    const { resolveQuotaBurnStep } = await import('./quotaBurnInvoke.js');
    const resolved = await resolveQuotaBurnStep(job, catalog);
    if (resolved.unavailable) return { reason: resolved.unavailable.reason };
    if (resolved.ref?.taskType !== 'claim-issue' || resolved.interval?.perpetual !== true) {
      return { reason: 'sequence drain requires perpetual claim-issue in Scheduled Tasks' };
    }
    const [{ getAppById }, { detectActionableWork }, { sanitizeTaskMetadata }] = await Promise.all([
      import('./apps.js'), import('./perpetualWork.js'), import('../lib/cosValidation.js'),
    ]);
    const app = await getAppById(resolved.ref.appId);
    if (!app) return { reason: 'sequence target app is unavailable' };
    const metadata = {
      ...sanitizeTaskMetadata(resolved.interval.taskMetadata),
      ...sanitizeTaskMetadata(app.taskTypeOverrides?.['claim-issue']?.taskMetadata),
      ...sanitizeTaskMetadata(job.overrides?.params),
    };
    const detection = await detectActionableWork('claim-issue', app, {
      issueAuthorFilter: metadata.issueAuthorFilter || 'self',
      issueExcludeLabels: metadata.issueExcludeLabels || [],
      ignoreTaskId,
    });
    if (detection.transient || !detection.hasDetector) return { reason: detection.reason || 'claim probe unavailable' };
    if (detection.actionable) return { job };
    if (detection.inFlightCount > 0) return { reason: 'sequence waiting for in-flight issue claims' };
    const written = await recordQuotaBurnJobCompletion(family.id, job.id);
    if (!written) return { reason: 'could not record drained sequence step' };
    completions[quotaBurnJobKey(family.id, job.id)] = written[quotaBurnJobKey(family.id, job.id)];
  }
  return { reason: 'maintenance sequence complete' };
}

export async function completeQuotaBurnSequenceStep(agent) {
  const familyId = agent?.metadata?.taskQuotaBurnFamily;
  const jobId = agent?.metadata?.taskQuotaBurnStepId;
  if (!familyId || !jobId) return;
  const { getQuotaBurnConfig } = await import('./quotaBurnStore.js');
  const family = (await getQuotaBurnConfig()).families[familyId];
  if (!family?.sequence || !agent?.result?.success) return;
  const job = family.jobs.find(entry => entry.id === jobId);
  if (job && !job.drain && job.runOnce) {
    if (!await recordQuotaBurnJobCompletion(familyId, jobId)) throw new Error('could not record completed sequence step');
  }
}
