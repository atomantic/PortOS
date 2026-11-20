/** Project the agent fields and branch scopes used by the completion-policy evaluator. */
import { resolve } from 'node:path';
import { isTruthyMeta } from '../metadataFlags.js';
import { forkLocalBranch } from '../forkHead.js';
import { PR_COMPLETIONS, explicitPrCompletion } from '../prDisposition.js';

export function normalizedPolicyWorkspace(path) {
  if (typeof path !== 'string' || !path) return null;
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function registeredCompletion(meta) {
  return meta.prCompletionPolicy || (isTruthyMeta(meta.configReviewLoop) ? PR_COMPLETIONS.REVIEW_THEN_MERGE : null) || explicitPrCompletion({ metadata: {
    prCompletion: meta.prCompletion, jiraTicketId: meta.jiraTicketId,
    analysisType: meta.taskAnalysisType, reviewLoopLeaveOpen: meta.reviewLoopLeaveOpen,
  } });
}

// Only the fields read by the policy evaluator belong in the projection.
// Other history consumers (including checkout receipts) still receive full records.
export function projectPolicyAgent(agent) {
  const meta = agent.metadata || {};
  const target = meta.reviewLoopMergeTarget;
  const receipt = meta.branchCompletionPolicy;
  const followUp = meta.mergedReviewFollowUp;
  return {
    status: agent.status, startedAt: agent.startedAt, completedAt: agent.completedAt, result: { success: agent.result?.success },
    metadata: {
      sourceWorkspace: meta.sourceWorkspace || meta.workspacePath,
      worktreeBranch: meta.worktreeBranch, jiraBranch: meta.jiraBranch, claimBranch: meta.claimBranch,
      claimBranches: meta.claimBranches, claimReleasedBranches: meta.claimReleasedBranches,
      prCompletionPolicy: registeredCompletion(meta),
      branchCompletionPolicy: receipt && { branch: receipt.branch, completion: receipt.completion, prUrl: receipt.prUrl, tip: receipt.tip },
      reviewLoopMergeTarget: target && { branch: target.branch, url: target.url, fork: target.fork && { forkHead: target.fork.forkHead } },
      mergedReviewFollowUp: followUp && { prUrl: followUp.prUrl, status: followUp.status },
    },
  };
}

// A fork review target keeps the contributor's remote branch name while the
// checkout is registered under the fork-qualified local name (forkLocalBranch).
export const reviewTargetBranches = target => [target?.branch, target?.fork && forkLocalBranch(target.branch, target.fork.forkHead)].filter(Boolean);

// A malformed present binding on a known policy makes the entire repository
// scope unreadable. Missing legacy bindings still use claimBranch.
export function branchPolicyScope(meta, completion = registeredCompletion(meta)) {
  const receipt = meta.branchCompletionPolicy;
  const bindings = [meta.claimBranches, meta.claimReleasedBranches];
  if ((receipt?.completion || completion) && bindings.some(value => value !== undefined
    && (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !name.trim())))) return null;
  const bound = bindings.flatMap(value => Array.isArray(value) ? value : []);
  return new Set([meta.worktreeBranch, meta.jiraBranch, ...(bound.length ? bound : [meta.claimBranch]), receipt?.branch]
    .filter(branch => typeof branch === 'string' && branch));
}
