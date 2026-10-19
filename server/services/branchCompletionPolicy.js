/** Trusted completion handoffs survive the run that produced a branch.
 * Read the existing agent records, including archives; PR bodies, summaries and
 * shared forge logins never authorize reconciliation. No parallel policy store.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { PR_COMPLETIONS, explicitPrCompletion } from '../lib/prDisposition.js';

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
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
export async function readBranchCompletionPolicies({ repairIndex = true } = {}) {
  return readPolicies(repairIndex).catch(error => {
    const cause = error.cause ?? error;
    console.warn(`⚠️ Branch completion policy unavailable: ${cause.code ? `${cause.code} ` : ''}${cause.message}`);
    throw error.message === unavailable ? error : unavailableBecause(error);
  });
}

async function readPolicies(repairIndex) {
  const { readAgentsStateForSafetyCheck } = await import('./cosState.js');
  const snapshot = await readAgentsStateForSafetyCheck();
  if (!snapshot.trusted || !isPlainObject(snapshot.agents)) throw unavailableBecause(new Error('live agent state is untrusted'));
  const agents = new Map(Object.entries(snapshot.agents));
  if ([...agents].some(([id, agent]) => !isPlainObject(agent) || agent.id !== id)) throw unavailableBecause(new Error('live agent state has a mismatched record'));
  const dir = join(PATHS.cos, 'agents');
  const raw = await readFile(join(dir, 'index.json'), 'utf8').catch(async error => {
    if (error.code === 'ENOENT') {
      const entries = await readdir(dir).catch(missing => { if (missing.code === 'ENOENT') return []; throw missing; });
      if (entries.some(entry => /^\d{4}-\d{2}-\d{2}$/.test(entry) || (entry.startsWith('agent-') && !agents.has(entry)))) throw error;
      return '{}';
    }
    throw error;
  });
  const index = JSON.parse(raw);
  if (!isPlainObject(index)) throw unavailableBecause(new Error('agent index is not an object'));
  const entries = Object.entries(index).filter(([id]) => !agents.has(id));
  const dangling = [];
  // Bounded parallelism; never read transcripts or archive records here.
  for (let offset = 0; offset < entries.length; offset += 50) {
    await Promise.all(entries.slice(offset, offset + 50).map(async ([id, date]) => {
      if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw unavailableBecause(new Error('agent index has a malformed row'));
      const recordDir = join(dir, date, id);
      const content = await readFile(join(recordDir, 'metadata.json'), 'utf8').catch(async error => {
        // A row with no record directory at all is a legacy dangling pointer,
        // not a record that exists but cannot be trusted: it holds no policy.
        if (error.code === 'ENOENT' && await stat(recordDir).then(() => false, missing => missing.code === 'ENOENT')) return null;
        throw error;
      });
      if (content === null) { dangling.push(id); return; }
      const agent = JSON.parse(content);
      if (!isPlainObject(agent) || (agent.id || agent.agentId) !== id) throw unavailableBecause(new Error('archived agent record id mismatch'));
      agents.set(id, agent);
    }));
  }
  if (repairIndex && dangling.length) dropDanglingIndexRows(dangling);
  return [...agents.values()];
}

// Fire-and-forget repair of the source; the read above already ignores these rows.
function dropDanglingIndexRows(ids) {
  import('./cosAgentIndex.js')
    .then(({ removeDanglingAgentIndexEntries }) => removeDanglingAgentIndexEntries(ids))
    .then(count => { if (count) console.log(`🧹 Dropped ${count} agent-index row(s) with no archive directory`); })
    .catch(error => console.error(`❌ Failed to drop dangling agent-index rows: ${error.message}`));
}

/** Exact repo/branch identity. A known PR receipt never applies to another PR
 * on the same branch. Without a PR read (offline retirement), preserve it.
 * Only a later, completed, explicit policy for this exact PR and current tip
 * can release a handoff; an absent/default policy or PR prose cannot do so.
 */
function completionDecision({ repoPath, branch, prUrl, tip, agents }) {
  if (!Array.isArray(agents)) return { reason: unavailable };
  const policies = [];
  for (const agent of agents) {
    const meta = agent?.metadata || {};
    if (!samePath(meta.sourceWorkspace || meta.workspacePath, repoPath)) continue;
    const receipt = meta.branchCompletionPolicy;
    const completion = meta.prCompletionPolicy || (isTruthyMeta(meta.configReviewLoop) ? PR_COMPLETIONS.REVIEW_THEN_MERGE : null) || explicitPrCompletion({ metadata: {
      prCompletion: meta.prCompletion, jiraTicketId: meta.jiraTicketId,
      analysisType: meta.taskAnalysisType, reviewLoopLeaveOpen: meta.reviewLoopLeaveOpen,
    } });
    const bindings = [meta.claimBranches, meta.claimReleasedBranches];
    // A known policy with unreadable scope cannot become permission. Missing
    // legacy fields are valid; malformed present bindings retain an unknown hold.
    if ((receipt?.completion || completion) && bindings.some(value => value !== undefined
      && (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !name.trim())))) return { reason: unavailable };
    // Claim flows cut their own worktrees, so registration has no worktreeBranch.
    // Exact bound/released branches retain the task's hold even when a run exits
    // before finalization can capture a PR. Ownership release is not merge consent.
    const bound = bindings.flatMap(value => Array.isArray(value) ? value : []);
    const scopes = [meta.worktreeBranch, meta.jiraBranch, ...(bound.length ? bound : [meta.claimBranch])];
    const policy = receipt?.branch === branch ? receipt : {
      branch: scopes.includes(branch) ? branch : null,
      completion,
    };
    if (policy.branch !== branch || (prUrl && policy.prUrl && policy.prUrl !== prUrl)) continue;
    policies.push({ ...policy, agent, time: Date.parse(agent.startedAt) || 0 });
  }
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

/** A new operator review may settle completed legacy review obligations only.
 * This is evidence for the scoped retirement caller, never unattended consent.
 */
export function reviewedRetirementPolicy(input) {
  const decision = completionDecision(input);
  if (decision.reason === unavailable || decision.reason === held) return { reason: decision.reason };
  const policies = decision.policies || [];
  if (policies.some(p => p.agent.status !== 'completed' || p.agent.result?.success !== true
    || p.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE || p.prUrl)) {
    return { reason: 'retirement-policy-not-legacy-completed' };
  }
  return { reason: null, policies: policies.map(p => ({
    id: p.agent.id || p.agent.agentId, startedAt: p.agent.startedAt,
    completedAt: p.agent.completedAt, status: p.agent.status, success: p.agent.result.success,
    branch: p.branch, completion: p.completion,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id))) };
}

/** A verified merged receipt may settle automatic completion obligations, but
 * never a human handoff or an owner that has not finished. The caller separately
 * proves the exact merged head and archives the checkout before retirement.
 */
export function mergedReceiptRetirementPolicy(input) {
  const decision = completionDecision(input);
  if (decision.reason === unavailable || decision.reason === held) return { reason: decision.reason };
  const policies = decision.policies || [];
  if (policies.some(policy => policy.agent.status !== 'completed')) return { reason: 'retirement-policy-owner-active' };
  return { reason: null, receiptHead: input.tip, policies: policies.map(policy => ({
    id: policy.agent.id || policy.agent.agentId, startedAt: policy.agent.startedAt,
    status: policy.agent.status, branch: policy.branch, completion: policy.completion,
    prUrl: policy.prUrl ?? null, tip: policy.tip ?? null,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id))) };
}

export async function readBranchCompletionHold(input, deps = {}) {
  const readPolicies = deps.readPolicies || readBranchCompletionPolicies;
  const agents = input.agents ?? await readPolicies().catch(() => null);
  const { execGit } = await import('../lib/execGit.js');
  const tip = input.tip ?? (await execGit(['rev-parse', '--verify', `refs/heads/${input.branch}`], input.repoPath)
    .catch(() => null))?.stdout?.trim();
  const decision = completionDecision({ ...input, tip, agents });
  // A saved receipt cannot authorize a later remote push this checkout has not
  // fetched. Only a potential explicit release needs a fresh forge read; offline
  // cleanup preserves the handoff when that read cannot establish the same head.
  if (input.retirement === true && decision.obligation?.prUrl
    && await verifiedPolicyTip(input.repoPath, input.branch, decision.obligation.prUrl, { requireMerged: true }).catch(() => null) === tip) return null;
  if (decision.release && await verifiedPolicyTip(input.repoPath, input.branch, decision.release.prUrl).catch(() => null) === tip) return null;
  return decision.reason;
}

/** Called with task policy and forge-observed identity, never provider prose.
 * A receipt is a policy scope, not evidence that review or CI passed.
 */
export async function recordBranchCompletionPolicy({ agentId, task, repoPath, branch, prUrl }) {
  if (!branch || !prUrl || !explicitPrCompletion(task)) return;
  const { getAgentRecord, updateAgent } = await import('./cosAgentLifecycle.js');
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

async function verifiedPolicyTip(repoPath, branch, prUrl, { requireMerged = false } = {}) {
  const { getOriginInfo } = await import('../lib/gitRemote.js');
  const { parsePullRequestUrl } = await import('../lib/gitForge.js');
  const origin = await getOriginInfo(repoPath);
  const pr = parsePullRequestUrl(prUrl);
  if (!pr || pr.host !== origin?.host || `${pr.owner}/${pr.repo}` !== origin.fullName) return null;
  const { execGit } = await import('../lib/execGit.js');
  const tip = (await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath)).stdout?.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(tip || '')) return null;
  const { resolveForgeExecOptions } = await import('./forgeExecOptions.js');
  const { execGh } = await import('./github.js');
  const { cwd, env } = await resolveForgeExecOptions(repoPath);
  const remote = JSON.parse(await execGh(['pr', 'view', prUrl, '--json', 'url,state,headRefName,headRefOid,isCrossRepository'], undefined, { cwd, env }));
  return remote.url === prUrl && remote.headRefName === branch && remote.headRefOid === tip
    && remote.isCrossRepository === false && (!requireMerged || remote.state === 'MERGED') ? tip : null;
}
