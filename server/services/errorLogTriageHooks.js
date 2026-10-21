/**
 * Pre-agent hook for the `error-log-triage` scheduled task (#12851).
 *
 * The triage itself is deterministic (services/errorLogTriage.js); the only
 * agents it starts are the per-fingerprint investigation tasks it files
 * through the shared investigation producer. So the hook always answers
 * `skip`: `resolveTaskInputHook` records the execution, advancing the cadence,
 * and no coordinator agent is spawned for the triage pass.
 */

import { ERROR_LOG_TRIAGE_TASK_TYPE, describeTriageSummary, runErrorLogTriage } from './errorLogTriage.js';

export async function buildTaskInput({ app } = {}) {
  // PortOS's own PM2 logs are one install-wide source; a per-app dispatch would
  // triage the same lines once per app.
  if (app?.id) return { skip: { reason: 'install-wide-only' } };
  const { getTaskInterval } = await import('./taskSchedule.js');
  const interval = await getTaskInterval(ERROR_LOG_TRIAGE_TASK_TYPE);
  const summary = await runErrorLogTriage({
    params: interval.taskMetadata || {},
    job: { providerId: interval.providerId || null, model: interval.model || null, effort: interval.effort || null },
  });
  const line = describeTriageSummary(summary);
  console.log(`🩺 error-log-triage: ${line}`);
  return { skip: { reason: line } };
}
