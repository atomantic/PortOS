/** Operator reconciliation of a held release candidate whose historical evidence
 * is insufficient (docs/VERSIONING.md "Reconciling a legacy held candidate").
 *
 * Retiring records who stopped waiting and on what evidence. It never edits the
 * candidate, its review files, tags or the predecessor's history, and it never
 * marks a release published: the task is closed with a `candidate-reconciled`
 * resolution so a new release run can reserve a fresh cutoff.
 */
import { realpath } from 'node:fs/promises';
import { execGit } from '../lib/execGit.js';
import { currentTaskTypeName } from '../lib/taskTypeRenames.js';
import { INSUFFICIENT_EVIDENCE_HOLD_REASONS, releaseCandidateReconciliationSchema } from '../lib/releasePublication.js';
import { ownershipTransaction } from './cosClaimOwnership.js';
import { releaseCandidateBranch } from './completedCheckoutEvidence.js';
import { readReleaseCandidate } from './releaseCandidateEvidence.js';
import { candidateBranchPulls, openCandidateForge, readReleaseBaseTip } from './releaseCandidateRecovery.js';

const refuse = reason => { throw Object.assign(new Error(reason), { reconciliationReason: reason }); };
const run = agent => ({ agentId: agent.id, taskId: agent.taskId, startedAt: agent.startedAt });
const repository = agent => agent.sourceWorkspace || agent.metadata?.sourceWorkspace || agent.workspacePath || agent.metadata?.workspacePath;
const typeOf = agent => currentTaskTypeName(agent.metadata?.taskAnalysisType || agent.metadata?.analysisType);
const RELEASE_WORK = new Set(['do-release', 'release-sync']);
const CANDIDATE_BRANCH = /^codex\/release-agent-[a-z0-9-]+$/;

/** No release or synchronization agent of this repository may be live, including
 * the held successor itself. Another repository's release does not matter. */
async function assertRepositoryIdle(state, repoPath) {
  const { getActiveAgentIds } = await import('./agentState.js');
  const active = new Set(getActiveAgentIds());
  const agents = Object.values(state.agents);
  if ([...active].some(id => !state.agents[id])) refuse('release-ownership-unavailable');
  for (const agent of agents) {
    if (!RELEASE_WORK.has(typeOf(agent)) || (agent.status === 'completed' && !active.has(agent.id))) continue;
    // An unresolvable workspace cannot be proven to belong to another repository.
    const workspace = repository(agent) && await realpath(repository(agent)).catch(() => null);
    if (!workspace || workspace === repoPath) refuse('release-active');
  }
}

/** The immutable identity of the abandoned candidate, from Git alone. */
async function candidateIdentity(source, repoPath) {
  const branch = releaseCandidateBranch(source?.metadata);
  if (!CANDIDATE_BRANCH.test(branch || '')) refuse('candidate-identity-unavailable');
  const ref = await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], repoPath, { ignoreExitCode: true });
  const head = ref.exitCode === 0 ? ref.stdout.trim() : '';
  const evidence = head && await readReleaseCandidate(head, repoPath).catch(() => null);
  if (!evidence) refuse('candidate-identity-unavailable');
  const checkouts = [...(source.metadata.completedCheckouts || []), ...(source.metadata.checkoutSeeds || [])];
  return { cutoff: evidence.cutoff, pin: evidence.pin, head, tree: evidence.tree, releaseBase: evidence.releaseBase,
    branch, path: checkouts.find(row => row.branch === branch)?.path || null };
}

/** A promotion PR, merged or still open, means this candidate is (becoming) a
 * release; a moved `release` base means a newer release already superseded it. */
async function assertUnpromoted(repoPath, identity) {
  let forge, pulls, tip;
  try {
    forge = await openCandidateForge(repoPath);
    pulls = await candidateBranchPulls(forge, identity.branch);
    tip = await readReleaseBaseTip(forge);
  } catch { refuse('candidate-forge-unavailable'); }
  // A full page may hide an older promotion PR: fail closed rather than paginate.
  if (!Array.isArray(pulls) || pulls.length >= 100) refuse('candidate-publication-ambiguous');
  if (pulls.some(pr => pr.state === 'open' || pr.merged_at)) refuse('candidate-promotion-exists');
  if (tip !== identity.releaseBase) refuse('candidate-release-base-changed');
}

async function loadHeldTask(successor) {
  const { getTaskById } = await import('./cosTaskStore.js');
  const task = await getTaskById(successor.taskId);
  if (currentTaskTypeName(task?.metadata?.analysisType || task?.metadata?.selfImprovementType) !== 'do-release') refuse('candidate-task-unverified');
  return task;
}

async function reconcile(agentId, reason, operator, state, save) {
  const successor = state.agents[agentId];
  const hold = successor?.metadata?.releaseCandidateRecovery;
  if (!successor?.taskId || !successor.startedAt || !repository(successor)
    || successor.metadata?.taskAnalysisType !== 'do-release' || successor.metadata.isWorktree !== false
    || hold?.status !== 'held') refuse('candidate-not-held');
  const prior = hold.reconciliation;
  if (prior && prior.reason !== reason) refuse('candidate-already-reconciled');
  if (!prior && !INSUFFICIENT_EVIDENCE_HOLD_REASONS.includes(hold.reason)) refuse('candidate-hold-not-reconcilable');
  const task = await loadHeldTask(successor);
  if (prior && task.status === 'completed' && task.metadata?.releaseCandidateReconciliation?.reconciledAt === prior.reconciledAt) {
    return { receipt: prior, task };
  }
  // A repeated request finishes a failed task update, but only while nothing
  // has resumed the task, started release work or promoted the candidate since.
  if (!['blocked', 'pending'].includes(task.status)) refuse('candidate-task-unverified');
  const repoPath = await realpath(repository(successor)).catch(() => null);
  if (!repoPath) refuse('release-active');
  await assertRepositoryIdle(state, repoPath);
  if (prior) {
    await assertUnpromoted(repoPath, prior.candidate);
    return { receipt: prior, task };
  }
  const { getAgentRecord } = await import('./cosAgentLifecycle.js');
  const identity = await candidateIdentity(state.agents[hold.predecessorAgentId] || await getAgentRecord(hold.predecessorAgentId), repoPath);
  await assertUnpromoted(repoPath, identity);
  const receipt = { version: 1, action: 'retire', reconciledAt: new Date().toISOString(), operator, reason,
    priorHold: { reason: hold.reason, predecessorAgentId: hold.predecessorAgentId }, successor: run(successor), candidate: identity };
  if (!releaseCandidateReconciliationSchema.safeParse(receipt).success) refuse('candidate-receipt-unavailable');
  state.agents[agentId] = { ...successor, metadata: { ...successor.metadata, releaseCandidateRecovery: { ...hold, reconciliation: receipt } } };
  await save();
  const { cosEvents } = await import('./cosEvents.js');
  cosEvents.emit('agent:updated', state.agents[agentId]);
  return { receipt, task };
}

/** Retire the held successor's task. The receipt is already on the successor,
 * so a failure here is repaired by repeating the same request. */
async function closeTask(task, receipt) {
  if (task.status === 'completed') return true;
  const { updateTask } = await import('./cosTaskStore.js');
  const saved = await updateTask(task.id, { status: 'completed', metadata: {
    resolution: 'candidate-reconciled', releaseCandidateReconciliation: receipt } }, task.taskType || 'internal',
  { expectedStatus: task.status, suppressDequeue: true, suppressCompletionWake: true });
  return !saved?.error && !saved?.statusChanged;
}

export async function retireHeldReleaseCandidate(agentId, reason, operator) {
  // A refusal is an answer, not a failure: settle the transaction with it.
  const outcome = await ownershipTransaction('release-retire', 'retired', (state, save) => reconcile(agentId, reason, operator, state, save)
    .catch(error => {
      if (!error.reconciliationReason) throw error;
      return { retired: false, reason: error.reconciliationReason };
    }));
  if (outcome.retired === false) {
    console.log(`🚫 Held release candidate ${agentId} was not retired: ${outcome.reason}`);
    return outcome;
  }
  if (!await closeTask(outcome.task, outcome.receipt)) return { retired: false, reason: 'candidate-task-changed' };
  console.log(`🧾 Held release candidate ${agentId} retired by ${operator}; a new release run may reserve a fresh cutoff`);
  return { retired: true, taskId: outcome.task.id, reconciliation: outcome.receipt };
}
