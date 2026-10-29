import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { completedCheckoutReceiptValid, checkoutSeedSchema } from './completedCheckoutEvidence.js';
import { matchesCompletionTaskDispatch } from './agentCompletionTaskHandoff.js';
import { matchesSpawnBudgetProof, spawnBudgetCount, validSpawnBudgetEpisode } from './spawnBudgetProof.js';
import { hasClaimFlowContract } from '../lib/claimFlowTaskTypes.js';

const unbound = agent => agent?.metadata?.isWorktree === false && !agent.metadata.worktreeBranch
  && ['claimBranches', 'claimReleasedBranches', 'checkoutSeeds', 'completedCheckouts'].every(key =>
    agent.metadata[key] == null || (Array.isArray(agent.metadata[key]) && agent.metadata[key].length === 0));
const terminal = agent => agent?.status === 'completed' && agent.result?.executionSuccess === true
  && agent.result.cleanupPending === true && agent.result.deliveryRecoveryOwned === true
  && agent.result.validationPassed !== false && !agent.result.executionInterruption && !agent.metadata?.executionInterruption
  && !agent.metadata?.blocker && agent.result.taskOutcome?.recovery?.mode === 'cleanup'
  && Date.parse(agent.startedAt) <= Date.parse(agent.completedAt);
const repository = agent => agent.metadata?.sourceWorkspace || agent.metadata?.workspacePath;
const identity = agent => {
  const { historicalCleanupReconciliation: _reconciliation, ...metadata } = agent.metadata || {};
  const { output: _output, ...record } = agent;
  return { ...record, metadata };
};
const dispatch = agent => {
  const binding = agent.metadata?.completionTaskDispatch;
  if (!Array.isArray(binding?.expected) || binding.expected.some(row => !Array.isArray(row) || row.length !== 2)) return null;
  const metadata = Object.fromEntries(binding.expected);
  return matchesCompletionTaskDispatch(agent, { id: agent.taskId, taskType: binding?.taskType, metadata })
    && spawnBudgetCount(metadata.totalSpawnCount) > 0 && metadata.claimedBy === agent.metadata.instanceId
    && metadata.claimedAt === metadata.lastSpawnedAt && Date.parse(agent.startedAt) <= Date.parse(metadata.claimedAt)
    && Date.parse(metadata.claimedAt) <= Date.parse(agent.completedAt) ? metadata : null;
};
const scope = task => ({ id: task?.id, taskType: task?.taskType || 'user', description: task?.description,
  priority: task?.priority, app: task?.metadata?.app, analysisType: task?.metadata?.analysisType,
  claimFlow: task?.metadata?.claimFlow, claimTarget: task?.metadata?.claimTarget,
  swarmCount: task?.metadata?.swarmCount, prCompletion: task?.metadata?.prCompletion,
  openPR: task?.metadata?.openPR, reviewLoopLeaveOpen: task?.metadata?.reviewLoopLeaveOpen, discardWorktree: task?.metadata?.discardWorktree });

/** Reconnect only an exhausted unbound cleanup retry. Historical outcomes and
 * ownership stay on their original records; this creates no dispatch or grant. */
export async function recoverHistoricalClaimCleanup(agent, verifyBranches) {
  if (!terminal(agent) || !unbound(agent)) return null;
  const [{ getTaskById, updateTask }, { readBranchCompletionPolicies }, lifecycle, { getInstanceId, UNKNOWN_INSTANCE_ID }] = await Promise.all([
    import('./cosTaskStore.js'), import('./branchCompletionPolicy.js'), import('./cosAgentLifecycle.js'), import('./instanceIdentity.js'),
  ]);
  const task = structuredClone(await getTaskById(agent.taskId));
  if (task?.status !== 'blocked' || task.metadata?.blockedCategory !== 'task-recovery-exhausted'
    || task.metadata.blocker || task.metadata.deliveryRecovery !== 'cleanup'
    || task.metadata.deliveryRecoveryAgentId !== agent.id || task.metadata.deliveryDecisionAgentId !== agent.id) return null;
  const save = async patch => {
    if (!await lifecycle.recordHistoricalCleanupReconciliation(agent.id, agent, { version: 1,
      checkedAt: new Date().toISOString(), ...patch })) throw new Error('historical-cleanup-receipt-unavailable');
  };
  const held = async reason => {
    await save({ status: 'held', reason });
    return { verified: false, skipReason: reason, issues: [], recoveryTaskId: null };
  };
  const instance = await getInstanceId();
  if (!instance || instance === UNKNOWN_INSTANCE_ID || agent.metadata.instanceId !== instance) return held('historical-cleanup-instance-unverified');
  const records = await readBranchCompletionPolicies({ repairIndex: false }).catch(() => null);
  if (!records) return held('historical-cleanup-history-unavailable');
  const history = structuredClone(records).filter(row => row.taskId === task.id).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const latest = dispatch(agent);
  if (!hasClaimFlowContract(task) || !latest) return held('historical-cleanup-dispatch-unverified');
  if (task.metadata.lastSpawnedAt !== latest.lastSpawnedAt
    || spawnBudgetCount(task.metadata.totalSpawnCount) !== spawnBudgetCount(latest.totalSpawnCount)) return held('historical-cleanup-latest-dispatch-changed');
  if (history.at(-1)?.id !== agent.id || new Set(history.map(row => row.id)).size !== history.length
    || !isDeepStrictEqual(identity(history.at(-1) || {}), identity(agent))) return held('historical-cleanup-history-ambiguous');
  const candidates = history.filter(row => row.metadata?.isWorktree === false && row.metadata.configClaimFlow === true
    && row.metadata.repoStateVerification?.status === 'completed'
    && row.metadata.repoStateVerification.reasons?.includes('cleanup-transferred-to-recovery')
    && row.metadata.completedCheckouts?.length > 0);
  if (candidates.length !== 1) return held('historical-cleanup-source-ambiguous');
  const source = candidates[0], chain = history.slice(history.indexOf(source));
  const repo = repository(source);
  if (typeof repo !== 'string' || !repo || chain.length < 2 || chain.length > 25
    || chain.some((row, index) => !terminal(row) || row.metadata.instanceId !== instance
      || typeof repository(row) !== 'string' || resolve(repository(row)) !== resolve(repo)
      || !dispatch(row) || row.metadata.completionTaskDispatch.taskType !== (task.taskType || 'user')
      || (index && (!unbound(row) || Date.parse(chain[index - 1].completedAt) > Date.parse(row.startedAt)
        || spawnBudgetCount(dispatch(row).totalSpawnCount) !== spawnBudgetCount(dispatch(chain[index - 1]).totalSpawnCount) + 1)))) {
    return held('historical-cleanup-episode-unverified');
  }
  if (chain.slice(0, -1).some(row => !row.metadata.repoStateVerification?.reasons?.includes('cleanup-transferred-to-recovery'))) {
    return held('historical-cleanup-transfer-unverified');
  }
  if ([source.metadata.claimBranches, source.metadata.claimReleasedBranches].some(value => value != null && !Array.isArray(value))) {
    return held('historical-cleanup-capture-unverified');
  }
  const branches = [...new Set([source.metadata.claimBranches, source.metadata.claimReleasedBranches].flatMap(value => value || []))];
  if (!branches.length || branches.some(branch => typeof branch !== 'string' || !/^claim\/issue-[1-9]\d*$/.test(branch))
    || source.metadata.completedCheckouts.length !== branches.length || branches.some(branch => {
      const rows = source.metadata.completedCheckouts.filter(row => row.branch === branch);
      return rows.length !== 1 || !completedCheckoutReceiptValid(source, rows[0])
        || rows[0].repoPath !== repo || !rows[0].path || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(rows[0].head || '')
        || !checkoutSeedSchema.shape.incarnation.safeParse(rows[0].incarnation).success;
    })) return held('historical-cleanup-capture-unverified');
  const { readCompletionData } = await import('./agentCompletionData.js');
  const replays = await Promise.all(chain.map(row => readCompletionData(row, row.metadata.completionCleanup?.replay).catch(() => null)));
  if (replays.some(replay => !replay?.task || !isDeepStrictEqual(scope(replay.task), scope(task)))) return held('historical-cleanup-task-scope-unverified');
  const proof = task.metadata.spawnBudgetProof;
  if (proof != null) {
    if (!validSpawnBudgetEpisode(proof) || chain.some(row => {
      const entry = [...(proof.history || []), proof.dispatch].find(item => item?.agentId === row.id);
      return !entry || !matchesSpawnBudgetProof({ ...task, metadata: { ...task.metadata,
        spawnBudgetProof: { ...proof, history: (proof.history || []).slice(0, spawnBudgetCount(entry.totalSpawnCount) - spawnBudgetCount(proof.baseline || 0) - 1), dispatch: entry } } }, row);
    })) return held('historical-cleanup-episode-reset-or-ambiguous');
  } else {
    // Legacy dispatches predate episode UUIDs. Their immutable pre-dispatch
    // replay must name the immediately preceding charge, without a reset or gap.
    if (chain.some(row => row.metadata.completionTaskDispatch.spawnBudgetEpoch)
      || replays.slice(1).some((replay, index) => replay.task.metadata?.lastSpawnedAt !== dispatch(chain[index]).lastSpawnedAt
        || spawnBudgetCount(replay.task.metadata?.totalSpawnCount) !== spawnBudgetCount(dispatch(chain[index]).totalSpawnCount))) {
      return held('historical-cleanup-episode-reset-or-ambiguous');
    }
  }
  const { readClaimOwnershipAgents } = await import('./cosClaimOwnership.js');
  const { activeAgents, runnerAgents } = await import('./agentState.js');
  const recheck = async () => {
    const current = await getTaskById(task.id);
    const owners = await readClaimOwnershipAgents();
    if (!isDeepStrictEqual(current, task)) throw new Error('historical-cleanup-task-changed');
    if (!owners || owners.some(row => row.taskId === task.id && ['running', 'paused'].includes(row.status))
      || [activeAgents, runnerAgents].some(map => [...map.values()].some(row => (row.taskId || row.task?.id) === task.id))) {
      throw new Error('historical-cleanup-owner-active');
    }
    const currentHistory = (await readBranchCompletionPolicies({ repairIndex: false })).filter(row => row.taskId === task.id)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    if (!isDeepStrictEqual(currentHistory.map(identity), history.map(identity))) throw new Error('historical-cleanup-history-changed');
  };
  try { await recheck(); } catch (error) { return held(error.message); }
  const { verifyCleanupClaimDisposition } = await import('./claimDisposition.js');
  const disposition = await verifyCleanupClaimDisposition({ task, agent: source }).catch(() => null);
  if (disposition?.status !== 'verified' || !Array.isArray(disposition.issues)
    || branches.some(branch => disposition.issues.filter(row => row.issue === Number(branch.slice('claim/issue-'.length))).length !== 1)) {
    return held('historical-cleanup-tracker-unverified');
  }
  await save({ status: 'pending', reason: null, sourceAgentId: source.id, sourceStartedAt: source.startedAt,
    agentIds: chain.map(row => row.id), captures: source.metadata.completedCheckouts });
  const recordCleanup = async outcome => {
    await save({ branchOutcome: outcome });
    return true;
  };
  const result = await verifyBranches({ agentId: source.id, agentState: source, task, success: true,
    prExpected: true, cleanupWarnings: [], recheckCleanup: recheck, recordCleanup });
  try { await recheck(); } catch (error) { return held(error.message); }
  if (result.verified) {
    const updated = await updateTask(task.id, { status: 'completed', metadata: {
      deliveryRecovery: undefined, deliveryRecoveryAgentId: undefined,
      taskOutcome: { status: 'completed', reason: 'Historical delivery and cleanup verified by repository retirement receipts.' },
    } }, task.taskType || 'user', { expectedStatus: 'blocked',
      expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
      recoveryOwner: { id: agent.id, startedAt: agent.startedAt, requireInactive: true }, preserveRetryBudget: true });
    if (updated?.status !== 'completed' || updated.error || updated.statusChanged) return held('historical-cleanup-task-settlement-unverified');
  }
  await save({ status: result.verified ? 'verified' : 'held', reason: result.verified ? null : 'historical-cleanup-obligations-held',
    reasons: (result.branches || [result]).map(row => row.skipReason).filter(Boolean) });
  return result;
}
