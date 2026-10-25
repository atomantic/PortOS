/** Fresh delivery evidence for one captured checkout, including partial batches.
 * This never changes the producing agent, its result, or its original policy.
 */
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { completedCheckoutReceiptValid } from './completedCheckoutEvidence.js';
import { isDeepStrictEqual } from 'node:util';
import { devNull } from 'node:os';
import { resolve } from 'node:path';

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

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
  const targetHead = retirementForge?.targetHead ?? retirementForge?.defaultHead;
  const targetBranch = retirementForge?.targetBranch ?? retirementForge?.defaultBranch;
  if (!Array.isArray(agents) || !checkoutIncarnation?.pointer || !checkoutIncarnation.gitdir
    || verifiedPrHead !== tip || !oid(tip) || retirementForge?.prUrl !== prUrl
    || retirementForge.prHead !== tip || !oid(targetHead)) return [];
  const candidates = agents.filter(agent => agent?.status === 'completed'
    && (agent.result?.success === true || agent.result?.executionSuccess === true)
    && agent.result.executionSuccess !== false && agent.result.validationPassed !== false
    && Array.isArray(agent.metadata?.completedCheckouts)
    && agent.metadata.completedCheckouts.some(row => samePath(row?.repoPath, repoPath) && samePath(row.path, checkoutPath) && row.branch === branch));
  if (candidates.length > 25) return [];
  const proofEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: devNull };
  const ancestor = (older, newer) => oid(older) && oid(newer)
    ? execGit(['--no-replace-objects', '-c', 'core.commitGraph=false', 'merge-base', '--is-ancestor', older, newer],
      repoPath, { env: proofEnv }).then(() => true, () => false) : false;
  if (!await ancestor(retirementForge.mergeCommit, targetHead)) return [];
  const evidence = [];
  const historical = new Map();
  // Bounded sequential forge reads, only for a matching completed execution
  // whose known PR differs. The aggregate task outcome is never promoted.
  for (const agent of candidates) {
    const policyUrl = agent.metadata.branchCompletionPolicy?.prUrl;
    const target = agent.metadata.reviewLoopMergeTarget;
    if ((policyUrl != null && !parsePullRequestUrl(policyUrl))
      || (target != null && (!parsePullRequestUrl(target.url) || target.branch !== branch))) continue;
    const originalPrUrl = policyUrl ?? target?.url ?? null;
    const rows = agent.metadata.completedCheckouts.filter(row => samePath(row?.repoPath, repoPath) && samePath(row.path, checkoutPath)
      && row.branch === branch && completedCheckoutReceiptValid(agent, row) && isDeepStrictEqual(row.incarnation, checkoutIncarnation));
    if (rows.length !== 1 || !await ancestor(rows[0].head, tip)) continue;
    if (!originalPrUrl || originalPrUrl === prUrl) {
      evidence.push({ kind: 'captured-merged-delivery', agentId: agent.id, originalPrUrl,
        originalPrHead: originalPrUrl ? retirementForge.prHead : null, originalMergeCommit: originalPrUrl ? retirementForge.mergeCommit : null,
        capturedHead: rows[0].head, capturedAt: rows[0].capturedAt, prUrl, tip, checkoutIncarnation });
      continue;
    }
    if (!historical.has(originalPrUrl)) historical.set(originalPrUrl,
      (opts.readHistoricalMerge || historicalMerge)(repoPath, originalPrUrl, opts.forgeAccount));
    const old = await historical.get(originalPrUrl);
    if (old?.url !== originalPrUrl || old.state !== 'MERGED' || old.isCrossRepository !== false
      || old.headRefName !== branch || old.baseRefName !== targetBranch
      || !await ancestor(old.headRefOid, rows[0].head)
      || !await ancestor(old.mergeCommit?.oid, targetHead)) continue;
    evidence.push({ kind: 'continued-merged-delivery', agentId: agent.id, originalPrUrl, originalPrHead: old.headRefOid,
      originalMergeCommit: old.mergeCommit.oid, capturedHead: rows[0].head,
      capturedAt: rows[0].capturedAt, prUrl, tip, checkoutIncarnation });
  }
  return evidence;
}
