/** A merged assigned PR completes a review/merge follow-up, independently of
 * preserved work that needs a separate delivery. Never infer this from prose,
 * local ancestry, a branch lookup alone, or an unavailable forge.
 */
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { PR_COMPLETIONS, resolvePrCompletion } from '../lib/prDisposition.js';

export async function verifyMergedReviewFollowUp(task, workspacePath) {
  const meta = task?.metadata;
  if (task?.taskType !== 'internal' || !isTruthyMeta(meta?.reviewLoopFollowUp)
    || isTruthyMeta(meta.reviewLoopLeaveOpen) || resolvePrCompletion(meta) === PR_COMPLETIONS.LEAVE_OPEN || !workspacePath
    || typeof meta.reviewLoopPRBranch !== 'string' || !meta.reviewLoopPRBranch.trim()) return null;
  const target = parsePullRequestUrl(meta.reviewLoopPRUrl);
  if (!target) return null;
  const { getOriginInfo } = await import('../lib/gitRemote.js');
  const origin = await getOriginInfo(workspacePath);
  if (origin?.host !== target.host || origin?.fullName !== `${target.owner}/${target.repo}`) return null;
  const { probeChangeRequestState } = await import('./prProbe.js');
  const state = await probeChangeRequestState(workspacePath, { number: target.number, branch: meta.reviewLoopPRBranch });
  return state.readable === true && state.prState === 'MERGED'
    ? { status: 'verified', prUrl: meta.reviewLoopPRUrl } : null;
}
