/**
 * A boot prerequisite is unfinished delivery, never a failed provider attempt.
 * Persist it on the original task and use the task store's compare-and-set to
 * release it once. Updating remains entirely with the configured idle updater.
 */
import { clearedRetryHoldMetadata } from '../lib/taskRetryHold.js';
import { PATHS } from '../lib/fileUtils.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { getBootCommit } from './installState.js';
import { getAgentRecord } from './cosAgentLifecycle.js';
import { matchesCompletionTaskDispatch } from './agentCompletionTaskHandoff.js';
import { getAllTasks, getTaskById, updateTask } from './cosTaskStore.js';

const SHA = /^[a-f0-9]{40}$/;
const CATEGORY = 'runtime-verification';

async function contains(ancestor, descendant) {
  if (!SHA.test(ancestor || '') || !SHA.test(descendant || '')) return false;
  const result = await execGit(['merge-base', '--is-ancestor', ancestor, descendant], PATHS.root, { ignoreExitCode: true });
  return result.exitCode === 0;
}

/** Structured forge fields only; neither PR prose nor agent assertions are proof. */
async function integrationEvidence(request) {
  if (!SHA.test(request.requiredCommit || '')) throw new Error('A full required commit is missing');
  const origin = await getOriginInfo(PATHS.root);
  const url = new URL(request.prUrl);
  if (!origin.isGithub || url.origin !== `https://${origin.host}` || url.search || url.hash
    || url.pathname.split('/').slice(1, 3).join('/').toLowerCase() !== origin.fullName.toLowerCase()
    || !/^\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(url.pathname)) throw new Error('The fix must belong to this PortOS repository');
  const { execGh } = await import('./github.js');
  const raw = await execGh(['pr', 'view', url.pathname.split('/').at(-1), '--repo', origin.fullName,
    '--json', 'url,state,headRefOid,mergeCommit,baseRefName'], 15000, { cwd: PATHS.root });
  const pr = JSON.parse(raw);
  const repo = JSON.parse(await execGh(['repo', 'view', origin.fullName, '--json', 'defaultBranchRef'], 15000, { cwd: PATHS.root }));
  if (pr.state !== 'MERGED' || pr.url !== request.prUrl || pr.baseRefName !== repo.defaultBranchRef?.name
    || !SHA.test(pr.mergeCommit?.oid || '') || ![pr.headRefOid, pr.mergeCommit.oid].includes(request.requiredCommit)) {
    throw new Error('The required commit is not the verified merged fix on the default branch');
  }
  // A squash/rebase need not contain the old PR head. The forge's integration
  // commit is the runtime prerequisite; never replace it with disk HEAD.
  await execGit(['fetch', '--', 'origin', pr.baseRefName], PATHS.root);
  const target = await execGit(['rev-parse', '--verify', `refs/remotes/origin/${pr.baseRefName}^{commit}`], PATHS.root);
  if (!await contains(pr.mergeCommit.oid, target.stdout.trim())) throw new Error('The merged fix is not integrated in the fetched default branch');
  return { prUrl: request.prUrl, requiredCommit: request.requiredCommit, integratedCommit: pr.mergeCommit.oid };
}

async function prerequisiteReason(prerequisite) {
  const { getSettingsWithStatus } = await import('./settings.js');
  const policy = await getSettingsWithStatus().catch(() => ({ corrupt: true }));
  const update = policy.corrupt ? 'Update policy is unreadable; retain the prerequisite.'
    : policy.settings?.autoUpdate?.enabled === true
      ? 'Waiting for the configured idle update policy, including cooldown and readiness gates.'
      : 'Automatic updates are disabled; a supported operator update is required.';
  return `Runtime verification requires ${prerequisite.integratedCommit || prerequisite.requiredCommit || 'a verified merged fix'}; captured boot is ${getBootCommit() || 'unreadable'}. ${update}`;
}

export async function resolveRuntimeVerificationUpdate(task, outcome, agentId) {
  const now = new Date().toISOString();
  const owner = await getAgentRecord(agentId);
  const live = await getTaskById(task.id);
  const replay = live?.status === 'blocked' && live.metadata?.runtimeVerificationId === `${task.id}:${agentId}`
    && live.metadata?.runtimeVerification?.agentId === agentId;
  if (!live || owner?.taskId !== task.id || (!replay && (live.status !== 'in_progress'
    || !matchesCompletionTaskDispatch(owner, live)))) throw new Error('Runtime verification dispatch ownership is unverified');
  task = live;
  // Internal publication context, separate from metadata: the caller forwards it
  // to updateTask's options; the task-store projection never persists this field.
  // Snapshot before forge awaits so later edits cannot redefine observed authority.
  const runtimeRecoveryContext = {
    expectedStatus: task.status,
    expectedTask: structuredClone({ description: task.description, priority: task.priority, metadata: task.metadata }),
    recoveryOwner: { id: agentId, startedAt: owner.startedAt },
  };
  const prior = task.metadata?.runtimeVerification;
  // Replaying finalization retains the original dispatch identity and evidence.
  const same = prior?.agentId === agentId && task.metadata?.runtimeVerificationId === `${task.id}:${agentId}`;
  let prerequisite = same ? prior : { version: 1, status: 'waiting', taskId: task.id, agentId,
    lastSpawnedAt: task.metadata?.lastSpawnedAt || null,
    totalSpawnCount: String(task.metadata?.totalSpawnCount ?? ''), requestedAt: now,
    prUrl: outcome.recovery.prUrl, requiredCommit: outcome.recovery.requiredCommit };
  let reason;
  if (task.metadata?.app && task.metadata.app !== PORTOS_APP_ID) {
    reason = 'Runtime verification owner or PortOS task scope could not be verified';
  } else {
    const evidence = await integrationEvidence(prerequisite).catch(() => null);
    if (evidence) {
      prerequisite = { ...prerequisite, ...evidence };
      reason = await prerequisiteReason(prerequisite);
    } else reason = 'Runtime prerequisite retained: merged-fix integration evidence is unreadable or invalid';
  }
  return { status: 'blocked', runtimeRecoveryContext, metadata: { ...task.metadata,
    runtimeVerificationId: `${task.id}:${agentId}`, runtimeVerification: { ...prerequisite, dispatchStatus: task.status,
      dispatch: Object.fromEntries(['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount']
        .filter(key => task.metadata?.[key] !== undefined).map(key => [key, task.metadata[key]])) },
    deliveryDecisionAgentId: agentId, blockedCategory: CATEGORY, blockedAt: same ? task.metadata.blockedAt : now,
    blockedReason: reason, taskOutcome: outcome,
    ...clearedRetryHoldMetadata(),
    deliveryRecovery: undefined, deliveryRecoveryAgentId: undefined } };
}

/** Every sweep rechecks boot/forge/dispatch evidence; an unreadable fact holds. */
export async function sweepRuntimeVerifications() {
  const queues = await getAllTasks();
  const { readAgentsStateForSafetyCheck } = await import('./cosState.js');
  const owners = await readAgentsStateForSafetyCheck();
  if (!owners.trusted) return { resumed: [] };
  const resumed = [];
  for (const [taskType, queue] of [['user', queues.user], ['internal', queues.cos]]) {
    for (const task of queue?.tasks || []) {
      const m = task.metadata || {};
      const p = m.runtimeVerification;
      if (task.status !== 'blocked' || m.blockedCategory !== CATEGORY || p?.version !== 1 || p.status !== 'waiting'
        || p.taskId !== task.id || m.runtimeVerificationId !== `${task.id}:${p.agentId}`
        || m.deliveryDecisionAgentId !== p.agentId || (m.app && m.app !== PORTOS_APP_ID)
        || (m.lastSpawnedAt || null) !== p.lastSpawnedAt
        || String(m.totalSpawnCount ?? '') !== p.totalSpawnCount
        || Object.values(owners.agents).some(a => a.taskId === task.id && a.status === 'running')) continue;
      const owner = await getAgentRecord(p.agentId);
      if (owner?.taskId !== task.id || !['completed', 'failed'].includes(owner.status)) continue;
      // A restart may interrupt the failed-delivery cleanup before its resume
      // pointer is saved. Reuse its guarded preservation path, without re-running
      // finalization, resetting budgets or declaring checkout retirement complete.
      if (m.runtimeVerificationReadyAgentId !== p.agentId) {
        const { releaseRetryHold } = await import('./agentWorktreeCleanup.js');
        await releaseRetryHold({ agentId: p.agentId, task: { ...task, taskType }, success: false, agentMetadata: owner.metadata })
          .catch(async () => {
            await updateTask(task.id, { metadata: { blockedReason: 'Runtime prerequisite retained: original checkout resume evidence is unavailable.' } }, taskType,
              { expectedStatus: 'blocked', expectedMetadata: { runtimeVerificationId: m.runtimeVerificationId, deliveryDecisionAgentId: p.agentId } });
          });
        continue;
      }
      const boot = getBootCommit();
      if (!SHA.test(boot || '')) continue;
      // A stale boot cannot change until restart. Do not poll the forge or fetch
      // every minute during the operator's potentially hours-long cooldown.
      if (p.integratedCommit && !await contains(p.integratedCommit, boot).catch(() => false)) continue;
      const evidence = await integrationEvidence(p).catch(() => null);
      if (!evidence || (p.integratedCommit && p.integratedCommit !== evidence.integratedCommit)) continue;
      if (!await contains(evidence.integratedCommit, boot).catch(() => false)) continue;
      const result = await updateTask(task.id, { status: 'pending', metadata: {
        runtimeVerification: { ...p, ...evidence, status: 'resumed', bootCommit: boot, resumedAt: new Date().toISOString() },
        runtimeVerificationReadyAgentId: undefined,
      } }, taskType, { expectedStatus: 'blocked', expectedMetadata: {
        runtimeVerificationId: m.runtimeVerificationId, deliveryDecisionAgentId: p.agentId,
        blockedCategory: CATEGORY, blockedAt: m.blockedAt, lastSpawnedAt: m.lastSpawnedAt, totalSpawnCount: m.totalSpawnCount,
      } });
      if (!result?.error && !result?.statusChanged) resumed.push(task.id);
    }
  }
  return { resumed };
}
