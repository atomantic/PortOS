/** Trusted completion handoffs survive the run that produced a branch.
 * Read the existing agent records, including archives; PR bodies, summaries and
 * shared forge logins never authorize reconciliation. Scoped reads use the
 * derived archive index and overlay the authoritative live records.
 */
import { join } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import {
  branchPolicyScope, normalizedPolicyWorkspace, projectPolicyAgent, registeredCompletion, reviewTargetBranches,
} from '../lib/cos/branchCompletionProjection.js';
import { PR_COMPLETIONS, explicitPrCompletion } from '../lib/prDisposition.js';
import { BRANCH_POLICY_PUBLICATION_PENDING } from '../lib/cos/branchPolicyArchiveRows.js';
import {
  readBranchPolicyArchiveIndex, readBranchPolicyArchiveRecord, validateBranchPolicyArchiveRow,
} from '../lib/cos/branchPolicyArchiveSource.js';

const samePath = (path, normalizedRepo) => normalizedPolicyWorkspace(path) === normalizedRepo;
const held = 'pr-completion-human-handoff';
const unavailable = 'pr-completion-policy-unavailable';

const unavailableBecause = cause => new Error(unavailable, { cause });
/** Read once per gather, freshly again at mutation. Missing old policy fields
 * are unknown history, not invented leave-open instructions. Corrupt records
 * cannot establish that a known handoff has been released. An unavailable read
 * logs its cause here, once per read, because every caller collapses the
 * rejection into the same per-branch reason. Any other failure is wrapped as
 * the unavailable reason with that failure as its cause.
 */
export async function readBranchCompletionPolicies({ repairIndex = true, repoPath, branch, branches } = {}) {
  const scoped = normalizedPolicyWorkspace(repoPath);
  return (scoped ? readScopedPolicies(scoped, branch === undefined ? branches : [branch], repairIndex)
    : readPolicies(repairIndex)).catch(error => {
    const cause = error.cause ?? error;
    console.warn(`⚠️ Branch completion policy unavailable: ${cause.code ? `${cause.code} ` : ''}${cause.message}`);
    throw error.message === unavailable ? error : unavailableBecause(error);
  });
}

async function readLivePolicyAgents() {
  const { readAgentsStateForSafetyCheck } = await import('./cos/cosState.js');
  const snapshot = await readAgentsStateForSafetyCheck();
  if (!snapshot.trusted || !isPlainObject(snapshot.agents)) throw unavailableBecause(new Error('live agent state is untrusted'));
  const agents = new Map(Object.entries(snapshot.agents));
  if ([...agents].some(([id, agent]) => !isPlainObject(agent) || agent.id !== id)) throw unavailableBecause(new Error('live agent state has a mismatched record'));
  return agents;
}

const policyArchiveDir = () => join(PATHS.cos, 'agents');

async function readScopedPolicies(repoPath, branches, repairIndex) {
  const { readIndexedArchivePolicies, withArchivePolicyRead } = await import('./cos/cosBranchPolicyArchive.js');
  return withArchivePolicyRead(async () => {
    const live = await readLivePolicyAgents();
    const rows = await readIndexedArchivePolicies(policyArchiveDir(), repoPath, branches).catch(error => {
      if (error.code === BRANCH_POLICY_PUBLICATION_PENDING) throw error;
      return null;
    });
    if (rows === null) return readPolicies(repairIndex, repoPath, live);
    const agents = new Map([...live].filter(([, agent]) => samePath(agent.metadata?.sourceWorkspace || agent.metadata?.workspacePath, repoPath)));
    const dangling = [];
    for (const { agentId, policy } of rows) {
      if (live.has(agentId) || agents.has(agentId)) continue;
      if (policy?.dangling === true) { dangling.push(agentId); continue; }
      if (policy?.error) throw unavailableBecause(Object.assign(new Error(policy.error), { code: policy.code }));
      if (!isPlainObject(policy) || !isPlainObject(policy.metadata)) throw unavailableBecause(new Error('archived policy row is malformed'));
      agents.set(agentId, policy);
    }
    if (repairIndex && dangling.length) dropDanglingIndexRows(dangling);
    return [...agents.values()];
  });
}

async function readPolicies(repairIndex, repoPath, agents) {
  agents ??= await readLivePolicyAgents();
  const records = [];
  const collect = agent => {
    if (!repoPath || samePath(agent.metadata?.sourceWorkspace || agent.metadata?.workspacePath, repoPath)) records.push(agent);
  };
  for (const agent of agents.values()) collect(agent);
  const dir = policyArchiveDir();
  const index = await readBranchPolicyArchiveIndex(dir, new Set(agents.keys()));
  const { archivedRecordCacheEpoch, cacheArchivedRecord, getCachedArchivedRecord, pruneArchivedRecordCache } = await import('./cos/cosAgentIndex.js');
  pruneArchivedRecordCache(new Set(Object.keys(index)));
  const entries = [];
  const dangling = [];
  // Consume hits before misses start inserting: an archive larger than the LRU
  // would otherwise evict every hit just before a sequential reader reached it.
  for (const [id, date] of Object.entries(index)) {
    if (agents.has(id)) continue;
    validateBranchPolicyArchiveRow(id, date);
    const cached = getCachedArchivedRecord(id, date);
    if (!cached) entries.push([id, date]);
    else if (cached.agent) collect(repoPath ? projectPolicyAgent(cached.agent) : cached.agent);
    else dangling.push(id);
  }
  // Bounded parallelism; never read transcripts or archive records here.
  // Parsed records are memoized across reads (cosAgentIndex.js); archive writers invalidate them.
  for (let offset = 0; offset < entries.length; offset += 50) {
    await Promise.all(entries.slice(offset, offset + 50).map(async ([id, date]) => {
      const epoch = archivedRecordCacheEpoch();
      const agent = await readBranchPolicyArchiveRecord(dir, id, date).catch(error => {
        console.error(`❌ ${error.message}`);
        throw unavailableBecause(error);
      });
      if (agent === null) { dangling.push(id); cacheArchivedRecord(id, date, null, epoch); return; }
      cacheArchivedRecord(id, date, agent, epoch);
      collect(repoPath ? projectPolicyAgent(agent) : agent);
    }));
  }
  if (repairIndex && dangling.length) dropDanglingIndexRows(dangling);
  return records;
}

// Fire-and-forget repair of the source; the read above already ignores these rows.
function dropDanglingIndexRows(ids) {
  import('./cos/cosAgentIndex.js')
    .then(({ removeDanglingAgentIndexEntries }) => removeDanglingAgentIndexEntries(ids))
    .then(count => { if (count) console.log(`🧹 Dropped ${count} agent-index row(s) with no archive directory`); })
    .catch(error => console.error(`❌ Failed to drop dangling agent-index rows: ${error.message}`));
}

/** Exact repo/branch identity. A known PR receipt never applies to another PR
 * on the same branch. Without a PR read (offline retirement), preserve it.
 * Only a later, completed, explicit policy for this exact PR and current tip
 * can release a handoff; an absent/default policy or PR prose cannot do so.
 */
export function indexBranchCompletionPolicies(repoPath, agents) {
  if (!Array.isArray(agents)) return null;
  const byBranch = new Map();
  const normalizedRepo = normalizedPolicyWorkspace(repoPath);
  if (!normalizedRepo) return byBranch;
  for (const agent of agents) {
    const meta = agent?.metadata || {};
    if (!samePath(meta.sourceWorkspace || meta.workspacePath, normalizedRepo)) continue;
    const receipt = meta.branchCompletionPolicy;
    const completion = registeredCompletion(meta);
    const scopes = branchPolicyScope(meta, completion);
    if (!scopes) return null;
    // A review run is bound to the one PR it was assigned. Without that scope a
    // reused branch (the quality-snapshot publisher) inherits every past run's
    // obligation on every later PR, and none of them can ever be released.
    const reviewBranches = reviewTargetBranches(meta.reviewLoopMergeTarget);
    for (const branch of scopes) {
      const target = reviewBranches.includes(branch) ? meta.reviewLoopMergeTarget.url : undefined;
      const policy = receipt?.branch === branch ? receipt : { branch, completion, ...(target && { prUrl: target }) };
      // A verified merge discharges the review of that exact assigned PR only.
      if (policy.completion === PR_COMPLETIONS.REVIEW_THEN_MERGE && agent.status === 'completed'
        && meta.mergedReviewFollowUp?.status === 'verified' && target
        && meta.mergedReviewFollowUp.prUrl === target && (policy.prUrl ?? target) === target) continue;
      if (!byBranch.has(branch)) byBranch.set(branch, []);
      byBranch.get(branch).push({ ...policy, agent, time: Date.parse(agent.startedAt) || 0 });
    }
  }
  return byBranch;
}

function completionDecision({ branch, prUrl, tip, policyIndex }) {
  if (!policyIndex) return { reason: unavailable };
  const policies = (policyIndex.get(branch) || []).filter(policy => !prUrl || !policy.prUrl || prUrl === policy.prUrl);
  policies.sort((a, b) => b.time - a.time);
  const handoff = policies.find(policy => policy.completion === PR_COMPLETIONS.LEAVE_OPEN);
  const obligation = policies.find(policy => [PR_COMPLETIONS.LEAVE_OPEN, PR_COMPLETIONS.REVIEW_THEN_MERGE].includes(policy.completion));
  if (!obligation) return { reason: null, policies };
  const release = policies.find(policy => policy.time > obligation.time
    && policy.agent.status === 'completed' && policy.agent.result?.success === true
    && policy.completion === PR_COMPLETIONS.MERGE_ON_GREEN
    && policy.prUrl && policy.prUrl === obligation.prUrl && (!prUrl || policy.prUrl === prUrl)
    && policy.tip && policy.tip === tip);
  return { release, obligation, policies, reason: handoff ? held : 'pr-completion-review-required' };
}

// A review run is bound to the one PR it was assigned (see completionDecision).
const reviewTarget = policy => policy.agent.metadata?.reviewLoopMergeTarget;
const retirementPr = policy => policy.prUrl || reviewTarget(policy)?.url;

export async function readBranchCompletionHold(input, deps = {}) {
  return (await readBranchCompletionHoldDetail(input, deps)).reason;
}

/** `readBranchCompletionHold` plus `unshipped`: a review-then-merge obligation
 * whose run ended before any PR was recorded for it (no open PR either). The
 * obligation gates the eventual merge, not the work: branch-reconcile may hand
 * such a branch to a coordinator to open its PR through the review workflow. */
export async function readBranchCompletionHoldDetail(input, deps = {}) {
  const readPolicies = deps.readPolicies || readBranchCompletionPolicies;
  const policyIndex = input.policyIndex === undefined
    ? indexBranchCompletionPolicies(input.repoPath, input.agents === undefined
      ? await readPolicies({ repoPath: input.repoPath, branch: input.branch }).catch(() => null) : input.agents)
    : input.policyIndex;
  const { execGit } = await import('../lib/execGit.js');
  const tip = input.tip !== undefined ? input.tip : (await execGit(['rev-parse', '--verify', `refs/heads/${input.branch}`], input.repoPath)
    .catch(() => null))?.stdout?.trim();
  const decision = completionDecision({ ...input, tip, policyIndex });
  // A saved receipt cannot authorize a later remote push this checkout has not
  // fetched. Only a potential explicit release needs a fresh forge read; offline
  // cleanup preserves the handoff when that read cannot establish the same head.
  if (tip && input.retirement === true && decision.obligation?.prUrl
    && await verifiedPolicyTip(input.repoPath, input.branch, decision.obligation.prUrl, { requireMerged: true, expectedTip: input.tip }).catch(() => null) === tip) return { reason: null };
  if (decision.release && await verifiedPolicyTip(input.repoPath, input.branch, decision.release.prUrl).catch(() => null) === tip) return { reason: null };
  if (input.retirement === true && await isVacuousReviewObligation(input, decision, tip)) return { reason: null };
  return { reason: decision.reason ?? null, unshipped: isUnshippedReviewObligation(input, decision) };
}

// No PR was ever opened for this review-then-merge obligation: nothing to
// review yet, and no leave-open handoff a human must answer.
const isUnshippedReviewObligation = (input, decision) => decision.reason === 'pr-completion-review-required' && !input.prUrl
  && !decision.policies.some(policy => policy.completion === PR_COMPLETIONS.LEAVE_OPEN || retirementPr(policy));

/** A review-then-merge run that never opened a PR and left no commit the default
 * branch lacks has nothing to review or merge, and no later receipt can name a
 * PR to release it. Strict ancestry, not patch equivalence: a squash- or
 * rebase-merged tip had a PR whose legacy record may simply lack its URL, and
 * that case still needs the scoped operator review. Every other hold (leave-open,
 * a recorded PR, unmerged commits, an unresolvable default branch) is kept.
 */
async function isVacuousReviewObligation(input, decision, tip) {
  if (!isUnshippedReviewObligation(input, decision) || !/^[a-f0-9]{40,64}$/i.test(tip || '')) return false;
  const { getDefaultBranch } = await import('./git.js');
  const base = await getDefaultBranch(input.repoPath, { strict: true }).catch(() => null);
  if (!base) return false;
  const { execGit } = await import('../lib/execGit.js');
  // A stale origin/<default> only makes the check stricter: whatever it
  // contains the current default contains too.
  for (const target of [`origin/${base}`, base]) {
    const ancestor = await execGit(['merge-base', '--is-ancestor', tip, target], input.repoPath, { ignoreExitCode: true })
      .then(result => result.exitCode === 0, () => false);
    if (ancestor) return true;
  }
  return false;
}

/** Called with task policy and forge-observed identity, never provider prose.
 * A receipt is a policy scope, not evidence that review or CI passed.
 */
export async function recordBranchCompletionPolicy({ agentId, task, repoPath, branch, prUrl }) {
  if (!branch || !prUrl || !explicitPrCompletion(task)) return;
  const { getAgentRecord, updateAgent } = await import('./cos/cosAgentLifecycle.js');
  const agent = await getAgentRecord(agentId);
  if (!agent) return;
  // The registered launch wins over a task edited during the run. Legacy
  // tasks may add a hold, but can never synthesize a release authority.
  const completion = agent.metadata?.prCompletionPolicy
    || (explicitPrCompletion(task) === PR_COMPLETIONS.LEAVE_OPEN ? PR_COMPLETIONS.LEAVE_OPEN : null);
  if (!completion) return;
  let tip = null;
  const target = agent.metadata?.reviewLoopMergeTarget;
  if (completion === PR_COMPLETIONS.MERGE_ON_GREEN && target?.branch === branch && target.url === prUrl && agent.metadata?.worktreeBranch === branch) {
    tip = await verifiedPolicyTip(repoPath, branch, prUrl).catch(() => null);
  }
  await updateAgent(agentId, { metadata: { branchCompletionPolicy: { branch, prUrl, completion, tip } } });
}

async function verifiedPolicyTip(repoPath, branch, prUrl, { requireMerged = false, expectedTip = null } = {}) {
  const { getOriginInfo } = await import('../lib/gitRemote.js');
  const { parsePullRequestUrl } = await import('../lib/gitForge.js');
  const origin = await getOriginInfo(repoPath);
  const pr = parsePullRequestUrl(prUrl);
  if (!pr || pr.host !== origin?.host || `${pr.owner}/${pr.repo}` !== origin.fullName) return null;
  const { execGit } = await import('../lib/execGit.js');
  const tip = expectedTip || (await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath)).stdout?.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(tip || '')) return null;
  const { readPullRequest } = await import('./prProbe.js');
  const remote = await readPullRequest(prUrl, 'url,state,headRefName,headRefOid,isCrossRepository', { repoPath });
  if (!remote) return null;
  return remote.url === prUrl && remote.headRefName === branch && remote.headRefOid === tip
    && remote.isCrossRepository === false && (!requireMerged || remote.state === 'MERGED') ? tip : null;
}
