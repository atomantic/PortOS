import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { matchesCompletionTaskDispatch } from './agentCompletionTaskHandoff.js';
import { completedCheckoutReceiptValid } from './completedCheckoutEvidence.js';

// A swarm may leave its original task in cleanup recovery while its next batch
// starts. The task and every checkout remain owned by the recovery service.
// This predicate never treats an agent's summary as proof of delivery.
function cleanupOnlySwarmCaptures(task, agent, instanceId) {
  const meta = agent?.metadata;
  const result = agent?.result;
  const binding = meta?.completionTaskDispatch;
  const swarmCount = Number(task?.metadata?.swarmCount);
  if (task?.status !== 'in_progress' || task.metadata?.deliveryRecovery !== 'cleanup'
    || task.metadata.deliveryRecoveryAgentId !== agent?.id || agent?.status !== 'completed'
    || !instanceId || instanceId === 'unknown' || meta?.instanceId !== instanceId
    || task.metadata.app !== meta.taskApp || !isTruthyMeta(task.metadata.perpetual)
    || task.metadata.analysisType !== meta.taskAnalysisType || meta.configClaimFlow !== true
    || isTruthyMeta(task.metadata.onDemand) !== Boolean(meta.taskOnDemand)
    || (meta.taskOnDemand && (task.metadata.onDemandOrigin || 'user') !== (meta.taskOnDemandOrigin || 'user'))
    || !isTruthyMeta(task.metadata.claimFlow) || task.metadata.claimTarget
    || !['claim-issue', 'claim-issue-gitlab', 'claim-work'].includes(task.metadata.analysisType)
    || !Number.isSafeInteger(swarmCount) || swarmCount < 1 || swarmCount > 50 || meta.isWorktree !== false
    || result?.executionSuccess !== true || result.validationPassed === false
    || result.cleanupPending !== true || result.deliveryRecoveryOwned !== true
    || result.taskOutcome?.status !== 'incomplete' || result.taskOutcome.recovery?.mode !== 'cleanup'
    || task.metadata.taskOutcome?.status !== 'incomplete' || task.metadata.taskOutcome.recovery?.mode !== 'cleanup'
    || result.executionInterruption || meta.executionInterruption || meta.blocker
    || meta.checkoutCapture?.status !== 'captured' || !Array.isArray(binding?.expected)
    || binding.expected.length !== 4 || binding.expected.some(row => !Array.isArray(row) || row.length !== 2)
    || !matchesCompletionTaskDispatch(agent, task)
    || binding.expected.find(row => row?.[0] === 'claimedBy')?.[1] !== instanceId
    || ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].some(key =>
      binding.expected.filter(row => Array.isArray(row) && row[0] === key && row[1] != null).length !== 1)) return null;
  const branches = meta.claimBranches;
  const captures = meta.completedCheckouts;
  const repo = meta.sourceWorkspace || meta.workspacePath;
  if (!Array.isArray(branches) || !branches.length || new Set(branches).size !== branches.length
    || !Array.isArray(captures) || captures.length !== branches.length
    || (meta.claimReleasedBranches != null && (!Array.isArray(meta.claimReleasedBranches) || meta.claimReleasedBranches.length))
    || typeof repo !== 'string' || !repo) return null;
  for (const branch of branches) {
    const rows = captures.filter(row => row.branch === branch);
    if (typeof branch !== 'string' || !branch || rows.length !== 1 || !completedCheckoutReceiptValid(agent, rows[0])
      || typeof rows[0].repoPath !== 'string' || resolve(rows[0].repoPath) !== resolve(repo)
      || typeof rows[0].path !== 'string' || !rows[0].path
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(rows[0].head || '')
      || !retirementCheckoutIdentityFromPointer(rows[0].incarnation?.pointer)) return null;
  }
  return captures;
}

export function cleanupDeliveryProofMatches(task, agent, instanceId) {
  const captures = cleanupOnlySwarmCaptures(task, agent, instanceId);
  const proof = agent?.metadata?.swarmCleanupDelivery;
  if (!captures || proof?.version !== 1 || !Array.isArray(proof.branches)
    || proof.branches.length !== captures.length) return false;
  return captures.every(capture => proof.branches.filter(row => row.branch === capture.branch
    && row.head === capture.head && typeof row.prUrl === 'string' && row.prUrl).length === 1);
}

/** A queued refill may outlive physical retirement of its source checkout. */
export function cleanupRefillSourceMatches(task, agent, instanceId) {
  if (cleanupDeliveryProofMatches(task, agent, instanceId)) return true;
  if (task?.status !== 'completed' || agent?.result?.success !== true
    || agent.result.deferredDeliveryOutcome?.recovery?.mode !== 'cleanup'
    || agent.metadata?.repoStateVerification?.status !== 'completed'
    || agent.metadata?.cleanupOutcome?.status !== 'verified' || agent.metadata.cleanupOutcome.unresolved !== 0) return false;
  // Settling the task clears its claim fields; restore them from the agent's own dispatch binding
  // (the other binding keys must still match the live task) or a settled source never refills.
  const claim = Object.fromEntries((agent.metadata?.completionTaskDispatch?.expected || [])
    .filter(row => Array.isArray(row) && (row[0] === 'claimedBy' || row[0] === 'claimedAt') && task.metadata?.[row[0]] == null));
  return cleanupDeliveryProofMatches({ ...task, status: 'in_progress', metadata: { ...task.metadata, ...claim,
    deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: agent.id, taskOutcome: agent.result.deferredDeliveryOutcome } }, { ...agent, result: { ...agent.result,
    cleanupPending: true, taskOutcome: agent.result.deferredDeliveryOutcome } }, instanceId);
}

/** Read fresh forge evidence for each server-captured checkout. No Git or file
 * mutation, and no retirement authorization, follows from this proof. */
export async function proveSwarmCleanupDelivery(task, agent, instanceId) {
  const captures = cleanupOnlySwarmCaptures(task, agent, instanceId);
  if (!captures) return null;
  const [{ probePrForBranch }, { readRetirementForgeEvidence }, { getAppById }] = await Promise.all([
    import('./prProbe.js'), import('./heldCheckoutReview.js'), import('./apps.js'),
  ]);
  const app = await getAppById(task.metadata.app).catch(() => null);
  const repo = agent.metadata.sourceWorkspace || agent.metadata.workspacePath;
  if (!app?.repoPath || resolve(app.repoPath) !== resolve(repo)) return null;
  const branches = [];
  for (const capture of captures) {
    const probe = await probePrForBranch(repo, capture.branch).catch(() => null);
    if (!probe?.readable || probe.prState !== 'MERGED' || !probe.prUrl) return null;
    if (probe.cli === 'gh') {
      const forge = await readRetirementForgeEvidence(repo, capture.branch, probe.prUrl, {
        forgeAccount: app.forgeAccount ?? null, exactDeliveredHead: capture.head,
      }).catch(() => null);
      if (forge?.scopeProof !== 'exact-delivered-head' || forge.prHead !== capture.head || forge.prUrl !== probe.prUrl) return null;
    } else if (probe.cli === 'glab') {
      if (!await hasExactGitlabMerge(app, repo, capture, probe)) return null;
    } else return null;
    branches.push({ branch: capture.branch, head: capture.head, prUrl: probe.prUrl });
  }
  return { version: 1, branches };
}

async function hasExactGitlabMerge(app, repo, capture, probe) {
  const [{ resolveAppForgeTarget }, { resolveForgeExecOptions }, { execGlab }] = await Promise.all([
    import('../lib/workTracker.js'), import('./forgeExecOptions.js'), import('./gitlab.js'),
  ]);
  const { target } = await resolveAppForgeTarget(app, { repoPath: repo });
  const url = parsePullRequestUrl(probe.prUrl);
  if (target?.forge !== 'gitlab' || !target.fullName || !target.webHost || !url
    || url.host.toLowerCase() !== target.webHost.toLowerCase() || `${url.owner}/${url.repo}` !== target.fullName
    || !Number.isSafeInteger(Number(probe.prNumber)) || Number(probe.prNumber) <= 0 || url.number !== Number(probe.prNumber)) return false;
  const options = await resolveForgeExecOptions(repo, { forgeAccount: app.forgeAccount ?? null });
  const raw = await execGlab(['api', '--hostname', target.webHost, `projects/${encodeURIComponent(target.fullName)}/merge_requests/${url.number}`], repo, 30_000,
    { env: options.env }).catch(() => null);
  const mr = safeJSONParse(raw, null);
  return mr?.state === 'merged' && Number.isSafeInteger(mr.project_id) && mr.project_id > 0
    && mr.project_id === mr.source_project_id && mr.project_id === mr.target_project_id
    && mr.source_branch === capture.branch && mr.sha === capture.head && mr.web_url === probe.prUrl
    && typeof mr.target_branch === 'string' && mr.target_branch.length > 0 && Number.isFinite(Date.parse(mr.merged_at));
}

/** Only server-persisted proof for the current dispatch releases a queue slot. */
export async function verifiedCleanupSwarmTaskIds(tasks, { allowSourceAgentId = null } = {}) {
  const candidates = tasks.filter(task => task.status === 'in_progress'
    && task.metadata?.deliveryRecovery === 'cleanup' && task.metadata.deliveryRecoveryAgentId);
  if (!candidates.length) return new Set();
  const [{ getAgentRecord }, { getInstanceId }, { readAgentsStateForSafetyCheck }, { hasActiveTaskOwner, getActiveAgentIds }] = await Promise.all([
    import('./cosAgentLifecycle.js'), import('./instanceIdentity.js'), import('./cosState.js'), import('./agentState.js'),
  ]);
  const [instance, owners] = await Promise.all([getInstanceId(), readAgentsStateForSafetyCheck()]);
  if (!owners.trusted) return new Set();
  const activeIds = new Set(getActiveAgentIds());
  const verified = await Promise.all(candidates.map(async task => {
    const agent = await getAgentRecord(task.metadata.deliveryRecoveryAgentId).catch(() => null);
    const scopedTask = { ...task, taskType: task.taskType || 'internal' };
    const activeOwner = Object.values(owners.agents).some(owner => owner.taskId === task.id
      && ['running', 'queued', 'finalizing', 'paused'].includes(owner.status));
    return (agent?.metadata?.swarmCleanupDelivery?.continuationIssued === true || agent?.id === allowSourceAgentId)
      && !activeIds.has(agent?.id) && !activeOwner && !hasActiveTaskOwner(task.id, owners.agents)
      && cleanupDeliveryProofMatches(scopedTask, agent, instance) ? task.id : null;
  }));
  return new Set(verified.filter(Boolean));
}

export async function validCleanupRefillSource(agentId, taskType, appId) {
  const [{ getAgentRecord }, { getTaskById }, { getInstanceId }] = await Promise.all([
    import('./cosAgentLifecycle.js'), import('./cosTaskStore.js'), import('./instanceIdentity.js'),
  ]);
  const agent = await getAgentRecord(agentId);
  const task = agent && await getTaskById(agent.taskId);
  if (task?.metadata?.analysisType !== taskType || task.metadata.app !== appId
    || !cleanupRefillSourceMatches(task, agent, await getInstanceId())) return false;
  if (task.status !== 'completed') return (await verifiedCleanupSwarmTaskIds([task], { allowSourceAgentId: agentId })).has(task.id);
  const [{ readAgentsStateForSafetyCheck }, { hasActiveTaskOwner, getActiveAgentIds }] = await Promise.all([
    import('./cosState.js'), import('./agentState.js'),
  ]);
  const owners = await readAgentsStateForSafetyCheck();
  return owners.trusted && !getActiveAgentIds().includes(agentId) && !hasActiveTaskOwner(task.id, owners.agents)
    && !Object.values(owners.agents).some(owner => owner.taskId === task.id && ['running', 'queued', 'finalizing', 'paused'].includes(owner.status));
}

export function sameSwarmCleanupSnapshot(left, right) {
  return left?.startedAt === right?.startedAt && left?.taskId === right?.taskId
    && isDeepStrictEqual(left?.metadata?.completionTaskDispatch, right?.metadata?.completionTaskDispatch)
    && isDeepStrictEqual(left?.metadata?.claimBranches, right?.metadata?.claimBranches)
    && isDeepStrictEqual(left?.metadata?.claimReleasedBranches, right?.metadata?.claimReleasedBranches)
    && isDeepStrictEqual(left?.metadata?.completedCheckouts, right?.metadata?.completedCheckouts);
}
