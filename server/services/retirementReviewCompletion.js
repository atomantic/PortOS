/** Receipt-backed completion for one server-assigned cleanup-only recovery.
 * Task prose and writable metadata never substitute for its protected parent
 * assignment, durable service receipt, or a fresh absence/ownership check. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { matchingRetirementReceipts } from '../lib/reconcileRetirementEvidence.js';
import { PR_COMPLETIONS, resolvePrCompletion } from '../lib/prDisposition.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';

export const isRetirementReviewRecovery = task => task?.metadata?.recoveryOrigin?.subsystem === 'repository-cleanup'
  && !!task.metadata.retirementReview && !task.metadata.recoveryMergeTarget;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && resolve(a) === resolve(b);
const pointerHash = pointer => pointer && createHash('sha256').update(JSON.stringify([
  String(pointer.dev), String(pointer.ino), String(pointer.birthtimeNs),
])).digest('hex');

export async function verifyRetirementReviewCompletion(candidate, options = {}) {
  if (!isRetirementReviewRecovery(candidate)) return null;
  return verifyAssignedRetirement(candidate, options).catch(() => ({ status: 'unverified', reason: 'retirement-verification-unavailable' }));
}

async function verifyAssignedRetirement(candidate, { agentId = null } = {}) {
  if (!isRetirementReviewRecovery(candidate)) return null;
  const held = reason => ({ status: 'unverified', reason });
  const { getTaskById } = await import('./cosTaskStore.js');
  const task = await getTaskById(candidate.id);
  if (!task || !isRetirementReviewRecovery(task) || task.taskType !== 'internal'
    || !isDeepStrictEqual(task.metadata.retirementReview, candidate.metadata.retirementReview)
    || !isDeepStrictEqual(task.metadata.recoveryOrigin, candidate.metadata.recoveryOrigin)) return held('cleanup-assignment-changed');
  if (resolvePrCompletion(task.metadata) === PR_COMPLETIONS.LEAVE_OPEN) return held('pr-completion-human-handoff');
  const target = task.metadata.retirementReview;
  const release = target.release;
  if (!target.appId || !isAbsolute(release?.path || '') || !release.branch
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(release.head || '')
    || !/^[a-f0-9]{64}$/.test(release.checkoutIdentity || '') || !Number.isFinite(Date.parse(target.createdAt))) return held('cleanup-target-unverified');
  const [{ getAgentRecord }, { getAppById }, { getActiveAgentIds }, { readClaimOwnershipAgents }] = await Promise.all([
    import('./cosAgentLifecycle.js'), import('./apps.js'), import('./agentState.js'), import('./cosClaimOwnership.js'),
  ]);
  const origin = task.metadata.recoveryOrigin;
  const parent = await getAgentRecord(origin.parentAgentId);
  const assignment = parent?.metadata?.repoCleanupRecoveries?.[release.branch];
  if (parent?.status !== 'completed' || assignment?.taskId !== task.id
    || ![assignment.observation, ...(assignment?.observations || [])].includes(origin.observation)) return held('cleanup-parent-binding-unverified');
  const app = await getAppById(target.appId);
  if (!app?.repoPath || !samePath(app.repoPath, parent.metadata.sourceWorkspace || parent.metadata.workspacePath)) return held('cleanup-repository-unverified');
  // New producers bind the complete tuple on the protected parent. Older tasks
  // can use the independently server-captured checkout generation, never its name alone.
  const { completedCheckoutReceiptValid } = await import('./completedCheckoutEvidence.js');
  const captured = parent.metadata.completedCheckouts?.some(row => completedCheckoutReceiptValid(parent, row)
    && row.branch === release.branch && row.head === release.head
    && samePath(row.path, release.path) && samePath(row.repoPath, app.repoPath)
    && pointerHash(row.incarnation?.pointer) === release.checkoutIdentity);
  if (!isDeepStrictEqual(assignment.retirementReview, target) && !captured) return held('cleanup-target-binding-unverified');
  if ([...getActiveAgentIds()].includes(parent.id)) return held('cleanup-parent-active');
  const agents = await readClaimOwnershipAgents();
  const owner = claimCheckoutOwnerReason({ branchName: release.branch, holderPath: release.path,
    sourceWorkspace: app.repoPath, agents, ignoreIds: [agentId].filter(Boolean) });
  if (owner) return held(owner);
  const { readBranchCompletionHold } = await import('./branchCompletionPolicy.js');
  const policy = await readBranchCompletionHold({ repoPath: app.repoPath, branch: release.branch, tip: release.head, agents });
  if (policy && policy !== 'pr-completion-review-required') return held(policy);
  const { getBranchReconcileOutcome } = await import('./taskSchedule.js');
  const outcome = await getBranchReconcileOutcome(target.appId);
  const receipt = matchingRetirementReceipts(outcome, release).find(row => row.branchDeleted === true
    && row.checkoutIdentity === release.checkoutIdentity && Date.parse(row.retiredAt) >= Date.parse(target.createdAt));
  if (!receipt) return held('retirement-receipt-unverified');
  const { readCheckoutPathPresence, readLocalBranchPresence } = await import('./repoCleanupObservation.js');
  const absent = await Promise.all([readCheckoutPathPresence(release.path), readLocalBranchPresence(app.repoPath, release.branch)]);
  if (absent.some(value => value !== false)) return held('retired-target-not-absent');
  const { listWorktrees } = await import('./worktreeManager.js');
  const inventory = await listWorktrees(app.repoPath);
  if (!inventory?.length) return held('retired-target-inventory-unavailable');
  if (inventory.some(tree => samePath(tree.path, release.path)
    || tree.branch?.replace(/^refs\/heads\//, '') === release.branch)) return held('retired-target-registration-present');
  return { status: 'verified', reason: 'retirement-receipt-verified', appId: target.appId,
    release, retiredAt: receipt.retiredAt };
}

/** No provider, new agent or retry-budget write for already satisfied work. */
export async function settleRetirementReviewBeforeSpawn(task) {
  if (!isRetirementReviewRecovery(task)) return false;
  const { withClaimOwnershipLock } = await import('./cosClaimOwnership.js');
  return withClaimOwnershipLock(async () => {
    const { getTaskById, updateTask } = await import('./cosTaskStore.js');
    const current = await getTaskById(task.id);
    if (!current || !['pending', 'completed'].includes(current.status)
      || !isDeepStrictEqual(current.metadata?.retirementReview, task.metadata.retirementReview)
      || !isDeepStrictEqual(current.metadata?.recoveryOrigin, task.metadata.recoveryOrigin)) return false;
    const proof = await verifyRetirementReviewCompletion(current);
    if (proof?.status !== 'verified') return false;
    if (current.status === 'completed') return true;
    const saved = await updateTask(task.id, { status: 'completed', metadata: { retirementCompletion: proof,
      taskOutcome: { status: 'no-action-needed', reason: 'The assigned checkout and branch are absent with an exact service retirement receipt.' } } },
    task.taskType, { expectedTask: { status: 'pending', metadata: current.metadata }, preserveRetryBudget: true });
    return saved?.status === 'completed' && !saved.error && !saved.statusChanged;
  });
}
