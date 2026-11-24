import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { matchesCompletionTaskDispatch } from './agent/agentCompletionTaskHandoff.js';
import { findValidCheckoutCaptures } from './completedCheckoutEvidence.js';
import { spawnBudgetCount } from './cos/cosSpawnBudget.js';

const SWARM_CLAIM_ANALYSIS_TYPES = new Set(['claim-issue', 'claim-issue-gitlab', 'claim-work']);
const REQUIRED_DISPATCH_KEYS = ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'];
const SETTLED_CLEARED_KEYS = new Set(['claimedBy', 'claimedAt']);
const ACTIVE_OWNER_STATUSES = new Set(['running', 'queued', 'finalizing', 'paused']);

function matchesSwarmTaskIdentity(task, agent, instanceId) {
  const meta = agent?.metadata;
  const taskMeta = task?.metadata;
  const swarmCount = Number(taskMeta?.swarmCount);
  return !!instanceId && instanceId !== 'unknown' && meta?.instanceId === instanceId
    && taskMeta?.app === meta.taskApp && isTruthyMeta(taskMeta?.perpetual)
    && taskMeta.analysisType === meta.taskAnalysisType && meta.configClaimFlow === true
    && isTruthyMeta(taskMeta.onDemand) === Boolean(meta.taskOnDemand)
    && (!meta.taskOnDemand || (taskMeta.onDemandOrigin || 'user') === (meta.taskOnDemandOrigin || 'user'))
    && isTruthyMeta(taskMeta.claimFlow) && !taskMeta.claimTarget
    && SWARM_CLAIM_ANALYSIS_TYPES.has(taskMeta.analysisType)
    && Number.isSafeInteger(swarmCount) && swarmCount >= 1 && swarmCount <= 50
    && meta.isWorktree === false;
}

function matchesCleanupRecoveryState(task, agent, { settled }) {
  const meta = agent?.metadata;
  const result = agent?.result;
  if (agent?.status !== 'completed' || result?.executionSuccess !== true
    || result.validationPassed === false || result.deliveryRecoveryOwned !== true
    || result.executionInterruption || meta?.executionInterruption || meta?.blocker
    || meta?.checkoutCapture?.status !== 'captured') return false;
  if (settled) {
    return task?.status === 'completed' && result.success === true
      && result.deferredDeliveryOutcome?.status === 'incomplete'
      && result.deferredDeliveryOutcome?.recovery?.mode === 'cleanup'
      && meta.repoStateVerification?.status === 'completed'
      && meta.cleanupOutcome?.status === 'verified' && meta.cleanupOutcome.unresolved === 0;
  }
  return task?.status === 'in_progress' && task.metadata?.deliveryRecovery === 'cleanup'
    && task.metadata.deliveryRecoveryAgentId === agent.id && result.cleanupPending === true
    && result.taskOutcome?.status === 'incomplete' && result.taskOutcome.recovery?.mode === 'cleanup'
    && task.metadata.taskOutcome?.status === 'incomplete' && task.metadata.taskOutcome.recovery?.mode === 'cleanup';
}

function matchesSwarmDispatchBinding(task, agent, instanceId, { settled }) {
  const binding = agent?.metadata?.completionTaskDispatch;
  if (!Array.isArray(binding?.expected) || binding.expected.length !== REQUIRED_DISPATCH_KEYS.length
    || binding.expected.some(row => !Array.isArray(row) || row.length !== 2)
    || binding.expected.find(row => row[0] === 'claimedBy')?.[1] !== instanceId
    || REQUIRED_DISPATCH_KEYS.some(key => binding.expected.filter(row => row[0] === key && row[1] != null).length !== 1)) {
    return false;
  }
  if (!settled) return matchesCompletionTaskDispatch(agent, task);
  // Settling the task clears its lease fields (claimedBy/claimedAt); the other
  // binding keys (and any still-present lease field) must still match the live task.
  if (binding.taskId !== task?.id || binding.taskId !== agent.taskId
    || binding.taskType !== (task.taskType || 'user')) return false;
  return binding.expected.every(([key, value]) => {
    if (SETTLED_CLEARED_KEYS.has(key) && task.metadata?.[key] == null) return true;
    return key === 'totalSpawnCount'
      ? spawnBudgetCount(value) !== null && spawnBudgetCount(task.metadata?.[key]) === spawnBudgetCount(value)
      : (task.metadata?.[key] ?? null) === value;
  });
}

function readValidSwarmCheckoutCaptures(agent) {
  const meta = agent?.metadata;
  const branches = meta?.claimBranches;
  const captures = meta?.completedCheckouts;
  const repo = meta?.sourceWorkspace || meta?.workspacePath;
  if (!Array.isArray(branches) || !branches.length || new Set(branches).size !== branches.length
    || !Array.isArray(captures) || captures.length !== branches.length
    || (meta.claimReleasedBranches != null && (!Array.isArray(meta.claimReleasedBranches) || meta.claimReleasedBranches.length))
    || typeof repo !== 'string' || !repo) return null;
  for (const branch of branches) {
    if (typeof branch !== 'string' || !branch
      || findValidCheckoutCaptures(agent, { branch, repoPath: repo }).length !== 1) return null;
  }
  return captures;
}

// A swarm may leave its original task in cleanup recovery while its next batch
// starts. The task and every checkout remain owned by the recovery service.
// This predicate never treats an agent's summary as proof of delivery.
function cleanupOnlySwarmCaptures(task, agent, instanceId, { settled = false } = {}) {
  if (!matchesSwarmTaskIdentity(task, agent, instanceId)
    || !matchesCleanupRecoveryState(task, agent, { settled })
    || !matchesSwarmDispatchBinding(task, agent, instanceId, { settled })) return null;
  return readValidSwarmCheckoutCaptures(agent);
}

export function cleanupDeliveryProofMatches(task, agent, instanceId, options = {}) {
  const captures = cleanupOnlySwarmCaptures(task, agent, instanceId, options);
  const proof = agent?.metadata?.swarmCleanupDelivery;
  if (!captures || proof?.version !== 1 || !Array.isArray(proof.branches)
    || proof.branches.length !== captures.length) return false;
  return captures.every(capture => proof.branches.filter(row => row.branch === capture.branch
    && row.head === capture.head && typeof row.prUrl === 'string' && row.prUrl).length === 1);
}

/** A queued refill may outlive physical retirement of its source checkout. */
export function cleanupRefillSourceMatches(task, agent, instanceId) {
  return cleanupDeliveryProofMatches(task, agent, instanceId)
    || cleanupDeliveryProofMatches(task, agent, instanceId, { settled: true });
}

/** Read fresh forge evidence for each server-captured checkout. No Git or file
 * mutation, and no retirement authorization, follows from this proof. */
export async function proveSwarmCleanupDelivery(task, agent, instanceId) {
  const captures = cleanupOnlySwarmCaptures(task, agent, instanceId);
  if (!captures) return null;
  const [{ probePrForBranch }, { readMergedPrDelivery }, { getAppById }] = await Promise.all([
    import('./prProbe.js'), import('./mergedPrEvidence.js'), import('./apps.js'),
  ]);
  const app = await getAppById(task.metadata.app).catch(() => null);
  const repo = agent.metadata.sourceWorkspace || agent.metadata.workspacePath;
  if (!app?.repoPath || resolve(app.repoPath) !== resolve(repo)) return null;
  const branches = [];
  for (const capture of captures) {
    const probe = await probePrForBranch(repo, capture.branch).catch(() => null);
    if (!probe?.readable || probe.prState !== 'MERGED' || !probe.prUrl) return null;
    if (probe.cli === 'gh') {
      const forge = await readMergedPrDelivery(repo, capture.branch, probe.prUrl, {
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

function hasLiveTaskOrAgentOwner({ taskId, agentId, owners, activeIds, hasActiveTaskOwner }) {
  return activeIds.has(agentId)
    || hasActiveTaskOwner(taskId, owners.agents)
    || Object.values(owners.agents).some(owner => owner.taskId === taskId && ACTIVE_OWNER_STATUSES.has(owner.status));
}

/** Only server-persisted proof for the current dispatch releases a queue slot. */
export async function verifiedCleanupSwarmTaskIds(tasks, { allowSourceAgentId = null } = {}) {
  const candidates = tasks.filter(task => task.status === 'in_progress'
    && task.metadata?.deliveryRecovery === 'cleanup' && task.metadata.deliveryRecoveryAgentId);
  if (!candidates.length) return new Set();
  const [{ getAgentRecord }, { getInstanceId }, { readAgentsStateForSafetyCheck }, { hasActiveTaskOwner, getActiveAgentIds }] = await Promise.all([
    import('./cos/cosAgentLifecycle.js'), import('./instanceIdentity.js'), import('./cos/cosState.js'), import('./agent/agentState.js'),
  ]);
  const [instance, owners] = await Promise.all([getInstanceId(), readAgentsStateForSafetyCheck()]);
  if (!owners.trusted) return new Set();
  const activeIds = new Set(getActiveAgentIds());
  const verified = await Promise.all(candidates.map(async task => {
    const agent = await getAgentRecord(task.metadata.deliveryRecoveryAgentId).catch(() => null);
    const scopedTask = { ...task, taskType: task.taskType || 'internal' };
    return (agent?.metadata?.swarmCleanupDelivery?.continuationIssued === true || agent?.id === allowSourceAgentId)
      && !hasLiveTaskOrAgentOwner({ taskId: task.id, agentId: agent?.id, owners, activeIds, hasActiveTaskOwner })
      && cleanupDeliveryProofMatches(scopedTask, agent, instance) ? task.id : null;
  }));
  return new Set(verified.filter(Boolean));
}

export async function validCleanupRefillSource(agentId, taskType, appId) {
  const [{ getAgentRecord }, { getTaskById }, { getInstanceId }] = await Promise.all([
    import('./cos/cosAgentLifecycle.js'), import('./cos/cosTaskStore.js'), import('./instanceIdentity.js'),
  ]);
  const agent = await getAgentRecord(agentId);
  const task = agent && await getTaskById(agent.taskId);
  if (task?.metadata?.analysisType !== taskType || task.metadata.app !== appId
    || !cleanupRefillSourceMatches(task, agent, await getInstanceId())) return false;
  if (task.status !== 'completed') return (await verifiedCleanupSwarmTaskIds([task], { allowSourceAgentId: agentId })).has(task.id);
  const [{ readAgentsStateForSafetyCheck }, { hasActiveTaskOwner, getActiveAgentIds }] = await Promise.all([
    import('./cos/cosState.js'), import('./agent/agentState.js'),
  ]);
  const owners = await readAgentsStateForSafetyCheck();
  if (!owners.trusted) return false;
  const activeIds = new Set(getActiveAgentIds());
  return !hasLiveTaskOrAgentOwner({ taskId: task.id, agentId, owners, activeIds, hasActiveTaskOwner });
}

export function sameSwarmCleanupSnapshot(left, right) {
  return left?.startedAt === right?.startedAt && left?.taskId === right?.taskId
    && isDeepStrictEqual(left?.metadata?.completionTaskDispatch, right?.metadata?.completionTaskDispatch)
    && isDeepStrictEqual(left?.metadata?.claimBranches, right?.metadata?.claimBranches)
    && isDeepStrictEqual(left?.metadata?.claimReleasedBranches, right?.metadata?.claimReleasedBranches)
    && isDeepStrictEqual(left?.metadata?.completedCheckouts, right?.metadata?.completedCheckouts);
}
