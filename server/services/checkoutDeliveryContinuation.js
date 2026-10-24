/** Fresh delivery evidence for a later merged PR on one captured checkout.
 * This never changes the producing agent, its result, or its original policy.
 */
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { completedCheckoutReceiptValid } from './completedCheckoutEvidence.js';
import { isDeepStrictEqual } from 'node:util';

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);

async function historicalMerge(repoPath, prUrl, forgeAccount) {
  const origin = await getOriginInfo(repoPath);
  const parsed = parsePullRequestUrl(prUrl);
  if (!origin || !parsed || parsed.host !== origin.host || `${parsed.owner}/${parsed.repo}` !== origin.fullName) return null;
  const [{ execGh }, { resolveForgeExecOptions }] = await Promise.all([import('./github.js'), import('./forgeExecOptions.js')]);
  const options = await resolveForgeExecOptions(repoPath, { forgeAccount });
  return execGh(['pr', 'view', prUrl, '--json', 'url,state,headRefName,headRefOid,isCrossRepository,mergeCommit,baseRefName'],
    10000, options).then(JSON.parse).catch(() => null);
}

/** Only callers that freshly verified the current PR and captured the exact
 * pointer AND private-administration generation supply this input. A native
 * transaction reuses that bound generation after independently verifying its
 * original/quarantine placements; no missing-path inference is performed here.
 */
export async function readCheckoutDeliveryContinuations(input, agents, opts = {}) {
  const { repoPath, branch, checkoutPath, tip, prUrl, verifiedPrHead, checkoutIncarnation, retirementForge } = input;
  if (!Array.isArray(agents) || !checkoutIncarnation?.pointer || !checkoutIncarnation.gitdir
    || verifiedPrHead !== tip || !oid(tip) || retirementForge?.prUrl !== prUrl
    || retirementForge.prHead !== tip || !oid(retirementForge.defaultHead)) return [];
  const candidates = agents.filter(agent => agent?.status === 'completed' && agent.result?.success === true
    && Array.isArray(agent.metadata?.completedCheckouts)
    && agent.metadata.completedCheckouts.some(row => row?.repoPath === repoPath && row.path === checkoutPath && row.branch === branch));
  if (candidates.length > 25) return [];
  const ancestor = (older, newer) => oid(older) && oid(newer)
    ? execGit(['merge-base', '--is-ancestor', older, newer], repoPath).then(() => true, () => false) : false;
  const evidence = [];
  const historical = new Map();
  // Bounded sequential forge reads, only for a physically matching successful
  // owner whose known PR differs. Unknown or unreadable history remains held.
  for (const agent of candidates) {
    const originalPrUrl = agent.metadata.branchCompletionPolicy?.prUrl || agent.metadata.reviewLoopMergeTarget?.url;
    if (!originalPrUrl || originalPrUrl === prUrl) continue;
    const rows = agent.metadata.completedCheckouts.filter(row => row?.repoPath === repoPath && row.path === checkoutPath
      && row.branch === branch && completedCheckoutReceiptValid(agent, row) && isDeepStrictEqual(row.incarnation, checkoutIncarnation));
    if (rows.length !== 1 || !await ancestor(rows[0].head, tip)) continue;
    if (!historical.has(originalPrUrl)) historical.set(originalPrUrl,
      (opts.readHistoricalMerge || historicalMerge)(repoPath, originalPrUrl, opts.forgeAccount));
    const old = await historical.get(originalPrUrl);
    if (old?.url !== originalPrUrl || old.state !== 'MERGED' || old.isCrossRepository !== false
      || old.headRefName !== branch || old.baseRefName !== retirementForge.defaultBranch
      || !await ancestor(old.headRefOid, rows[0].head)
      || !await ancestor(old.mergeCommit?.oid, retirementForge.defaultHead)) continue;
    evidence.push({ agentId: agent.id, originalPrUrl, originalPrHead: old.headRefOid,
      originalMergeCommit: old.mergeCommit.oid, capturedHead: rows[0].head,
      capturedAt: rows[0].capturedAt, prUrl, tip, checkoutIncarnation });
  }
  return evidence;
}
