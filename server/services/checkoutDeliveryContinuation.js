/** Fresh delivery evidence for one captured checkout, including partial batches.
 * This never changes the producing agent, its result, or its original policy.
 */
import { reviewedDeliveryHandoffValid } from './branchCompletionPolicy.js';
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
    && agent.metadata.completedCheckouts.some(row => samePath(row?.repoPath, repoPath) && row.branch === branch
      && isDeepStrictEqual(row.incarnation, checkoutIncarnation)));
  if (candidates.length > 25) return [];
  const proofEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: devNull };
  const ancestor = (older, newer) => oid(older) && oid(newer)
    ? execGit(['--no-replace-objects', '-c', 'core.commitGraph=false', 'merge-base', '--is-ancestor', older, newer],
      repoPath, { env: proofEnv }).then(() => true, () => false) : false;
  if (!await ancestor(retirementForge.mergeCommit, targetHead)) return [];
  const captured = agent => {
    const rows = agent.metadata.completedCheckouts.filter(row => samePath(row?.repoPath, repoPath)
      && row.branch === branch
      && completedCheckoutReceiptValid(agent, row) && isDeepStrictEqual(row.incarnation, checkoutIncarnation));
    const current = rows.filter(row => samePath(row.path, checkoutPath));
    return current.length === 1 ? current[0] : rows.length === 1 ? rows[0] : null;
  };
  const byId = new Map(candidates.map(agent => [agent.id, agent]));
  if (byId.size !== candidates.length) return [];
  const current = candidates.filter(agent => samePath(captured(agent)?.path, checkoutPath));
  const resumeChain = original => {
    if (current.length !== 1 || !original.taskId || !original.metadata.instanceId
      || original.metadata.instanceId === 'unknown') return null;
    const chain = [], seen = new Set();
    let child = current[0];
    while (child && chain.length < 25 && !seen.has(child.id)) {
      if (child.taskId !== original.taskId || child.metadata.instanceId !== original.metadata.instanceId
        || child.result?.taskOutcome?.recovery?.mode === 'approval' || child.metadata?.blocker
        || !samePath(captured(child)?.path, child.metadata.workspacePath)) return null;
      seen.add(child.id); chain.push(child.id);
      if (child.id === original.id) return chain;
      const parent = byId.get(child.metadata.resumedFromAgentId);
      if (!parent || !(Date.parse(parent.completedAt) <= Date.parse(child.startedAt))) return null;
      child = parent;
    }
    return null;
  };
  const reviewTasks = new Map();
  const reviewHandoff = async agent => {
    const target = agent.metadata.reviewLoopMergeTarget;
    if (target?.url !== prUrl || target.branch !== branch) return null;
    if (!reviewTasks.has(agent.taskId)) reviewTasks.set(agent.taskId,
      Promise.resolve().then(async () => (opts.getTaskById || (await import('./cosTaskStore.js')).getTaskById)(agent.taskId)).catch(() => null));
    const task = await reviewTasks.get(agent.taskId);
    const source = task?.metadata?.sourceAgentId && byId.get(task.metadata.sourceAgentId);
    const sourceChain = source && resumeChain(source);
    if (!sourceChain) return null;
    const reviewChain = [], seen = new Set();
    let node = agent;
    while (node && reviewChain.length < 25 && !seen.has(node.id)) {
      seen.add(node.id); reviewChain.push(node.id);
      if (!node.metadata.resumedFromAgentId) break;
      node = byId.get(node.metadata.resumedFromAgentId);
    }
    const handoff = { task: task && { id: task.id, status: task.status, metadata: {
      sourceAgentId: task.metadata?.sourceAgentId, sourceTaskId: task.metadata?.sourceTaskId,
      reviewLoopFollowUp: task.metadata?.reviewLoopFollowUp, reviewLoopPRUrl: task.metadata?.reviewLoopPRUrl,
      reviewLoopPRBranch: task.metadata?.reviewLoopPRBranch, reviewLoopLeaveOpen: task.metadata?.reviewLoopLeaveOpen,
      // The fields prHeldForOperator reads, so a held review task is never a delivery handoff.
      readOnly: task.metadata?.readOnly, prCompletion: task.metadata?.prCompletion,
      jiraTicketId: task.metadata?.jiraTicketId, analysisType: task.metadata?.analysisType } },
      reviewChain, sourceChain };
    if (!reviewedDeliveryHandoffValid(input, agents, handoff, agent.id)) return null;
    for (const id of [...reviewChain, ...sourceChain]) if (!await ancestor(captured(byId.get(id))?.head, tip)) return null;
    return handoff;
  };
  const evidence = [];
  const historical = new Map();
  // Bounded sequential forge reads, only for a matching completed execution
  // whose known PR differs. The aggregate task outcome is never promoted.
  for (const agent of candidates) {
    const capturedRow = captured(agent);
    const moved = capturedRow && !samePath(capturedRow.path, checkoutPath) ? resumeChain(agent) : null;
    const handoff = capturedRow && !samePath(capturedRow.path, checkoutPath) && !moved ? await reviewHandoff(agent) : null;
    if (!capturedRow || (!samePath(capturedRow.path, checkoutPath) && !moved && !handoff)) continue;
    const policyUrl = agent.metadata.branchCompletionPolicy?.prUrl;
    const target = agent.metadata.reviewLoopMergeTarget;
    if ((policyUrl != null && !parsePullRequestUrl(policyUrl))
      || (target != null && (!parsePullRequestUrl(target.url) || target.branch !== branch))) continue;
    const originalPrUrl = policyUrl ?? target?.url ?? null;
    const rows = [capturedRow];
    if (rows.length !== 1 || !await ancestor(rows[0].head, tip)) continue;
    if (!originalPrUrl || originalPrUrl === prUrl) {
      evidence.push({ kind: 'captured-merged-delivery', agentId: agent.id, originalPrUrl,
        originalPrHead: originalPrUrl ? retirementForge.prHead : null, originalMergeCommit: originalPrUrl ? retirementForge.mergeCommit : null,
        capturedHead: rows[0].head, capturedAt: rows[0].capturedAt, prUrl, tip, checkoutIncarnation,
        ...(moved && { resumeChain: moved }), ...(handoff && { reviewHandoff: handoff }) });
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
