/**
 * Stage keys and readiness rules for the persisted agent completion cleanup receipt.
 */

export const COMPLETION_RECEIPT_VERSION = 1;

export const COMPLETION_STAGE = Object.freeze({
  AUDIT_TASK: 'auditTask',
  SENTINEL: 'sentinel',
  JIRA: 'jira',
  NOTIFICATION: 'notification',
  PIPELINE: 'pipeline',
  CREATIVE: 'creative',
  WORKTREE: 'worktree',
  REPORT: 'report',
});

export const REPOSITORY_HOLD = Object.freeze({
  CAPTURE: 'checkout-capture-pending',
  RETIREMENT: 'checkout-retirement-pending',
});

export const REPOSITORY_STATE_VERIFICATION = 'repository-state-verification';
const DEFERRED_TASK_SETTLEMENT = 'after-completion-stages';
// The runner records the regular stages even when their feature is unused.
const REQUIRED_STAGES = Object.values(COMPLETION_STAGE).filter(key => key !== COMPLETION_STAGE.AUDIT_TASK);
const REPOSITORY_HELD_STAGES = new Set([COMPLETION_STAGE.PIPELINE, COMPLETION_STAGE.CREATIVE]);

export function isRepositoryHold(reason) {
  return reason === REPOSITORY_HOLD.CAPTURE || reason === REPOSITORY_HOLD.RETIREMENT;
}

export function completionStagesDoneExceptWorktree(stages) {
  if (!stages?.[COMPLETION_STAGE.WORKTREE]) return false;
  return REQUIRED_STAGES.every(key => key === COMPLETION_STAGE.WORKTREE || stages[key]?.status === 'done')
    && Object.entries(stages).every(([key, stage]) => key === COMPLETION_STAGE.WORKTREE || stage?.status === 'done');
}

export function completionStagesDone(stages) {
  return stages?.[COMPLETION_STAGE.WORKTREE]?.status === 'done' && completionStagesDoneExceptWorktree(stages);
}

export function completionReceiptDone(receipt) {
  return receipt?.version === COMPLETION_RECEIPT_VERSION && receipt.status === 'completed' && completionStagesDone(receipt.stages);
}

export function completionWaitingOnRepository(receipt) {
  const stages = receipt?.stages;
  if (receipt?.version !== COMPLETION_RECEIPT_VERSION || receipt.status !== 'pending'
    || !stages || !REQUIRED_STAGES.every(key => stages[key])) return false;
  // Recheck can release a chain hold after it records repository verification.
  const unfinished = Object.entries(stages).filter(([, stage]) => stage?.status !== 'done');
  return unfinished.length > 0 && unfinished.every(([key, stage]) => REPOSITORY_HELD_STAGES.has(key)
    && stage.status === 'held' && isRepositoryHold(stage.reason));
}

export function verifiedRepositoryWorktreeStage(deferTaskSettlement = false) {
  return { status: 'done', retryable: false, value: [], verifiedBy: REPOSITORY_STATE_VERIFICATION,
    ...(deferTaskSettlement && { taskSettlement: DEFERRED_TASK_SETTLEMENT }) };
}

export function worktreeStageDefersTaskSettlement(stage) {
  return stage?.status === 'done' && stage.verifiedBy === REPOSITORY_STATE_VERIFICATION
    && stage.taskSettlement === DEFERRED_TASK_SETTLEMENT;
}
