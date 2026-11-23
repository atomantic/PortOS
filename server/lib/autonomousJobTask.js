/**
 * The projection that turns a generated autonomous-job task back into the
 * top-level fields `cos.addTask` maps onto `metadata`.
 *
 * `generatedJobTaskFields` (+ `isExpectedUnpersistedMiss`: a scheduled fire never persists its
 * task, so spawn/finalize status writes miss by design) flattens a `generateTaskFromJob`
 * result into the top-level keys the non-raw `cos.addTask` path reads. The scheduled fire
 * emits metadata straight onto `task:ready`; every other caller goes through `addTask`.
 *
 * One allowlist shared by the manual "Run now" endpoint and the quota-burn lane: a key
 * missed by one lane silently vanishes while the task still queues. Callers layer their OWN
 * posture (`approvalRequired`, `context`, provider pins) on top of the spread. Pure, and in
 * lib because it needs none of the generator's I/O that callers' suites mock.
 */

import { isTruthyMeta } from './metadataFlags.js';

/** @param {object} generated - a `generateTaskFromJob` result */
export function generatedJobTaskFields(generated) {
  const meta = generated?.metadata || {};
  return {
    description: generated?.description,
    // Preserve workflow identity through manual/quota projection. Keep any
    // checkpoint id so the creation boundary rejects it instead of erasing it.
    ...(meta.auditDepth != null || meta.auditWorkflow != null || meta.deepAuditId != null ? {
      metadata: { auditDepth: meta.auditDepth, auditWorkflow: meta.auditWorkflow, deepAuditId: meta.deepAuditId }
    } : {}),
    priority: generated?.priority,
    prompt: meta.prompt,
    // Lets `prepareAgentWorkspace` resolve the workspace to the app's repoPath.
    app: meta.app,
    useWorktree: meta.useWorktree,
    openPR: meta.openPR,
    simplify: meta.simplify,
    noChangeSuccess: meta.noChangeSuccess,
    // Report-shaped posture (deliverable is an action DURING the run, or a scratch checkout).
    // Dropping these makes the burn lane queue the job as ordinary code work and push.
    noCodeOutput: meta.noCodeOutput,
    discardWorktree: meta.discardWorktree,
    worktreeChangesExpected: meta.worktreeChangesExpected,
    // Read by the `job:spawned` listener.
    autonomousJob: meta.autonomousJob,
    jobId: meta.jobId,
    provider: meta.provider,
    model: meta.model,
    effort: meta.effort,
    // Per-job provider options (e.g. Codex service tier); cosTaskIntake maps it back onto metadata.
    ...(meta.executionOptions !== undefined ? { executionOptions: meta.executionOptions } : {}),
  };
}

/**
 * A scheduled fire hands its generated task straight to `task:ready` without
 * writing it to the task store (id `<jobId>-<base36 ts>`), so the status writes
 * at spawn and finalization legitimately find no row. Manual/quota runs queue
 * through `addTask` and get a store-minted id, so a missing one IS a deletion.
 */
function isEphemeralJobTask(task) {
  const jobId = task?.metadata?.jobId;
  return isTruthyMeta(task?.metadata?.autonomousJob) && !!jobId && typeof task.id === 'string' && task.id.startsWith(`${jobId}-`);
}

/** True when an `updateTask` error is the expected miss for an unpersisted scheduled job task. */
export function isExpectedUnpersistedMiss(task, error) {
  return error === 'Task not found' && isEphemeralJobTask(task);
}
