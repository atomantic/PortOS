/** Trusted completion handoffs survive the run that produced a branch.
 * Read the existing agent records, including archives; PR bodies, summaries and
 * shared forge logins never authorize reconciliation. No parallel policy store.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { PR_COMPLETIONS, explicitPrCompletion } from '../lib/prDisposition.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { checkoutSeedSchema, completedCheckoutReceiptValid } from './completedCheckoutEvidence.js';
import { isDeepStrictEqual } from 'node:util';

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

/** A fresh exact-head forge review may distinguish incarnations of a reused
 * branch. A timestamp alone never excludes an owner: its explicit private
 * checkout must also differ, and a policy for this PR remains relevant.
 */
const reviewTarget = policy => policy.agent.metadata?.reviewLoopMergeTarget;
const retirementPr = policy => policy.prUrl || reviewTarget(policy)?.url;

function continuedDelivery(policy, input) {
  if (policy.agent.status !== 'completed'
    || (policy.agent.result?.success !== true && policy.agent.result?.executionSuccess !== true)
    || policy.agent.result?.executionSuccess === false || policy.agent.result?.validationPassed === false
    || policy.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE || input.verifiedPrHead !== input.tip) return null;
  return input.deliveryContinuations?.find(proof => proof.agentId === policy.agent.id
    && proof.originalPrUrl === (retirementPr(policy) ?? null)
    && proof.prUrl === input.prUrl && proof.tip === input.tip
    && (!policy.tip || [proof.originalPrHead, proof.capturedHead].includes(policy.tip))
    && policy.agent.metadata?.completedCheckouts?.some(row => completedCheckoutReceiptValid(policy.agent, row)
      && samePath(row.repoPath, input.repoPath) && row.branch === input.branch && samePath(row.path, input.checkoutPath)
      && row.head === proof.capturedHead && row.capturedAt === proof.capturedAt
      && isDeepStrictEqual(row.incarnation, proof.checkoutIncarnation)
      && isDeepStrictEqual(row.incarnation, input.checkoutIncarnation))) || null;
}

/** A process interruption is not a code-delivery verdict. Only a fresh merged
 * exact-head PR and a server-captured original physical generation admit this
 * owner to explicit retirement review. Its execution failure remains unchanged.
 */
function reviewedOrphanCheckout(policy, input) {
  const agent = policy.agent;
  return agent.status === 'completed' && agent.result?.orphaned === true
    && agent.result.validationPassed !== false && retirementPr(policy) === input.prUrl
    && input.verifiedPrHead === input.tip && !!input.tip
    && agent.metadata?.completedCheckouts?.some(row => completedCheckoutReceiptValid(agent, row)
      && samePath(row.repoPath, input.repoPath) && row.branch === input.branch && samePath(row.path, input.checkoutPath)
      && row.head === input.tip && row.incarnation?.pointer && row.incarnation?.gitdir);
}

// A completed owner's captured generation may belong to a different checkout of the
// same delivered head. It cannot transfer its cleanup obligation to an explicit
// detached-copy review. Keep its result and original cleanup record unchanged.
const sameReviewedPath = (a, b, input) => samePath(a, b)
  || (typeof a === 'string' && typeof b === 'string' && Boolean(input.checkoutIdentities?.[a])
    && input.checkoutIdentities[a] === input.checkoutIdentities[b]);

function completedDetachedSiblingCapture(policy, input) {
  const agent = policy.agent;
  const normalCleanup = agent.result?.executionSuccess === true && agent.result.validationPassed === true
    && agent.result.cleanupPending === true && agent.result.taskOutcome?.recovery?.mode === 'cleanup';
  if (!/^[a-f0-9]{64}$/.test(input.detachedCheckoutIdentity || '')
    || input.verifiedPrHead !== input.tip || !input.tip || retirementPr(policy) !== input.prUrl
    || (policy.tip && policy.tip !== input.tip) || agent.status !== 'completed' || (agent.result?.orphaned !== true && !normalCleanup)
    || agent.result.validationPassed === false || policy.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE) return null;
  const captures = agent.metadata?.completedCheckouts?.filter(row => (row.version === 2 || (normalCleanup && row.version === 1)) && completedCheckoutReceiptValid(agent, row)
    && sameReviewedPath(row.repoPath, input.repoPath, input) && row.branch === input.branch && row.head === input.tip
    && sameReviewedPath(row.path, agent.metadata.workspacePath, input) && !sameReviewedPath(row.path, input.checkoutPath, input)
    && !sameReviewedPath(row.path, input.repoPath, input) && row.incarnation?.pointer
    && createHash('sha256').update(JSON.stringify(['dev', 'ino', 'birthtimeNs'].map(key => row.incarnation.pointer[key])))
      .digest('hex') !== input.detachedCheckoutIdentity);
  return captures?.length === 1 ? captures[0] : null;
}

const completedDetachedSibling = (policy, input) => Boolean(completedDetachedSiblingCapture(policy, input));

function reviewedIncarnation(input, policies) {
  if (!isAbsolute(input.checkoutPath || '') || samePath(input.checkoutPath, input.repoPath)
    || !input.prUrl || input.verifiedPrHead !== input.tip
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.tip || '')) return null;
  const owners = policies.filter(policy => policy.agent.status === 'completed' && (policy.agent.result?.success === true
    || completedCleanupForRetirement(policy, input) || reviewedOrphanCheckout(policy, input) || continuedDelivery(policy, input))
    && policy.completion === PR_COMPLETIONS.REVIEW_THEN_MERGE
    && (samePath(policy.agent.metadata?.workspacePath, input.checkoutPath) || completedCleanupForRetirement(policy, input)
      || reviewedOrphanCheckout(policy, input) || continuedDelivery(policy, input))
    && (retirementPr(policy) === input.prUrl || continuedDelivery(policy, input))
    && (!policy.tip || policy.tip === input.tip || continuedDelivery(policy, input))
    && (!reviewTarget(policy) || (reviewTarget(policy).branch === input.branch
      && (reviewTarget(policy).url === input.prUrl || continuedDelivery(policy, input))))
    && Number.isFinite(Date.parse(policy.agent.startedAt))
    && Date.parse(policy.agent.completedAt) >= Date.parse(policy.agent.startedAt));
  if (!owners.length) return null;
  const firstStarted = Math.min(...owners.map(policy => Date.parse(policy.agent.startedAt)));
  const identity = input.checkoutIdentities?.[input.checkoutPath];
  const prior = [];
  const current = policies.filter(policy => {
    const workspace = policy.agent.metadata?.workspacePath;
    const target = reviewTarget(policy);
    const unrelated = policy.agent.status === 'completed'
      && policy.completion !== PR_COMPLETIONS.LEAVE_OPEN
      && isAbsolute(workspace || '') && !samePath(workspace, input.repoPath) && !samePath(workspace, input.checkoutPath)
      && identity && input.checkoutIdentities?.[workspace] && input.checkoutIdentities[workspace] !== identity
      && input.checkoutIdentities[input.repoPath] && input.checkoutIdentities[workspace] !== input.checkoutIdentities[input.repoPath]
      && Number.isFinite(Date.parse(policy.agent.startedAt))
      && Date.parse(policy.agent.completedAt) >= Date.parse(policy.agent.startedAt)
      && Date.parse(policy.agent.completedAt) < firstStarted
      && policy.prUrl !== input.prUrl && target?.url !== input.prUrl
      && (!policy.prUrl || parsePullRequestUrl(policy.prUrl))
      && (!target || (target.branch === input.branch && parsePullRequestUrl(target.url)
        && (!policy.prUrl || policy.prUrl === target.url)));
    if (unrelated) prior.push(policy);
    return !unrelated;
  });
  return { current, prior };
}

/** Cleanup handoff is retirement evidence only under fresh merged-head and
 * server-captured checkout identity. It never grants merge/review authority.
 */
function completedCleanupForRetirement(policy, input) {
  const agent = policy.agent;
  const result = agent.result;
  const metadata = agent.metadata || {};
  const legacyCapture = metadata.completionCleanup === undefined && metadata.checkoutSeeds === undefined
    && metadata.checkoutCapture === undefined && (metadata.completedCheckouts === undefined
      || (Array.isArray(metadata.completedCheckouts) && metadata.completedCheckouts.every(row => row?.version === 1)));
  const integratedLegacyCleanup = legacyCapture && result?.executionSuccess === true
    && input.verifiedPrHead === input.tip && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.integratedCleanupHead || '');
  return (result?.cleanupPending === true || integratedLegacyCleanup)
    && (result.executionSuccess === true || result.cleanupDeliveryVerified === true) && result.validationPassed !== false
    && result.taskOutcome?.recovery?.mode === 'cleanup' && input.verifiedPrHead === input.tip && !!input.tip
    && (integratedLegacyCleanup || agent.metadata?.completedCheckouts?.some(row => (row.version === 1 || (row.version === 2 && completedCheckoutReceiptValid(agent, row))) && row.agentId === agent.id
      && row.repoPath === input.repoPath && row.branch === input.branch && row.path === input.checkoutPath
      && row.head === input.tip && row.incarnation?.pointer && row.incarnation?.gitdir));
}

/** A retry moves the original checkout rather than creating another generation.
 * A completed cleanup successor can settle its captured ancestors' retirement
 * obligations; their execution failures and task budgets remain historical facts.
 */
function resumedCleanupPolicies(policies, input) {
  if (input.verifiedPrHead !== input.tip) return policies;
  const byId = new Map(policies.map(policy => [policy.agent.id, policy]));
  const proofs = new Map();
  const receipt = (policy, incarnation) => {
    const agent = policy.agent;
    if (agent.status !== 'completed' || !agent.taskId || agent.result?.validationPassed === false
      || policy.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE || retirementPr(policy) !== input.prUrl
      || (policy.tip && policy.tip !== input.tip)) return null;
    const rows = agent.metadata?.completedCheckouts?.filter(row => completedCheckoutReceiptValid(agent, row)
      && samePath(row.repoPath, input.repoPath) && row.branch === input.branch && row.head === input.tip
      && samePath(row.path, agent.metadata.workspacePath) && isDeepStrictEqual(row.incarnation, incarnation));
    return rows?.length === 1 ? rows[0] : null;
  };
  for (const successor of policies) {
    // A detached copy never owned this task's original generation. Validate
    // its completed sibling first, then compare ancestors within that captured
    // original generation; retain the copy identity on the derived proof.
    const sibling = completedDetachedSiblingCapture(successor, input);
    if (sibling && !checkoutSeedSchema.shape.incarnation.safeParse(sibling.incarnation).success) continue;
    const context = sibling ? { ...input, checkoutPath: sibling.path, checkoutIncarnation: sibling.incarnation } : input;
    if (!context.checkoutIncarnation || !completedCleanupForRetirement(successor, context) || !receipt(successor, context.checkoutIncarnation)) continue;
    let child = successor;
    const seen = new Set([child.agent.id]);
    while (child.agent.metadata?.resumedFromAgentId) {
      const parent = byId.get(child.agent.metadata.resumedFromAgentId);
      if (!parent || seen.has(parent.agent.id) || parent.agent.taskId !== successor.agent.taskId
        || !(Date.parse(parent.agent.completedAt) <= Date.parse(child.agent.startedAt)) || !receipt(parent, context.checkoutIncarnation)) break;
      seen.add(parent.agent.id);
      proofs.set(parent.agent.id, { successorAgentId: successor.agent.id, taskId: successor.agent.taskId,
        checkoutIncarnation: context.checkoutIncarnation,
        ...(sibling && { detachedCheckoutIdentity: input.detachedCheckoutIdentity }) });
      child = parent;
    }
  }
  return policies.map(policy => proofs.has(policy.agent.id) ? { ...policy, resumedCleanup: proofs.get(policy.agent.id) } : policy);
}

/** Operator review settles successful completed review obligations. PR-bound
 * obligations additionally need a fresh exact-head, exact-checkout incarnation.
 * This is review evidence, never unattended consent or a saved policy rewrite.
 */
export function reviewedRetirementPolicy(input) {
  // Keep mismatching known PRs until explicit incarnation checks establish
  // unrelated history; a current checkout's handoff must never be filtered out.
  const decision = completionDecision({ ...input, prUrl: undefined });
  if (decision.reason === unavailable) return { reason: decision.reason };
  const resumed = resumedCleanupPolicies(decision.policies || [], input);
  const incarnation = reviewedIncarnation(input, resumed);
  const policies = incarnation?.current || resumed;
  if (policies.some(p => p.completion === PR_COMPLETIONS.LEAVE_OPEN)) return { reason: held };
  if (policies.some(p => p.agent.status !== 'completed' || (p.agent.result?.success !== true && !completedCleanupForRetirement(p, input)
    && !reviewedOrphanCheckout(p, input) && !completedDetachedSibling(p, input) && !continuedDelivery(p, input) && !p.resumedCleanup)
    || p.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE
    || (retirementPr(p) && !continuedDelivery(p, input)
      && ((!incarnation && !completedDetachedSibling(p, input)
        && !(input.detachedCheckoutIdentity && p.resumedCleanup?.detachedCheckoutIdentity === input.detachedCheckoutIdentity)) || retirementPr(p) !== input.prUrl))
    || (reviewTarget(p) && (reviewTarget(p).branch !== input.branch || (p.prUrl && p.prUrl !== reviewTarget(p).url)))
    || (incarnation && p.tip && p.tip !== input.tip && !continuedDelivery(p, input)))) {
    return { reason: 'retirement-policy-not-legacy-completed' };
  }
  return { reason: null, ...(input.integratedCleanupHead && { integratedCleanupHead: input.integratedCleanupHead }), policies: policies.map(p => ({
    id: p.agent.id || p.agent.agentId, startedAt: p.agent.startedAt,
    completedAt: p.agent.completedAt, status: p.agent.status, success: p.agent.result.success,
    ...(p.resumedCleanup && { resumedCleanup: p.resumedCleanup }),
    ...(continuedDelivery(p, input) && { continuedDelivery: continuedDelivery(p, input) }),
    ...(reviewedOrphanCheckout(p, input) && { orphanedExecution: true }),
    ...(completedDetachedSibling(p, input) && { ...(p.agent.result?.orphaned === true ? { orphanedSibling: true } : { completedSibling: true }), detachedCheckoutIdentity: input.detachedCheckoutIdentity }),
    branch: p.branch, completion: p.completion,
    ...(incarnation && { prUrl: retirementPr(p) ?? null, tip: p.tip ?? null, workspacePath: p.agent.metadata?.workspacePath ?? null }),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  ...(incarnation && {
    reviewedPr: { prUrl: input.prUrl, tip: input.tip, checkoutPath: input.checkoutPath },
    priorCheckouts: incarnation.prior.map(p => ({
      id: p.agent.id || p.agent.agentId, startedAt: p.agent.startedAt, completedAt: p.agent.completedAt,
      status: p.agent.status, success: p.agent.result?.success ?? null, completion: p.completion ?? null,
      workspacePath: p.agent.metadata.workspacePath, prUrl: retirementPr(p) ?? null,
      checkoutIdentity: input.checkoutIdentities[p.agent.metadata.workspacePath],
    })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  }) };
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
    && await verifiedPolicyTip(input.repoPath, input.branch, decision.obligation.prUrl, { requireMerged: true, expectedTip: input.tip }).catch(() => null) === tip) return null;
  if (decision.release && await verifiedPolicyTip(input.repoPath, input.branch, decision.release.prUrl).catch(() => null) === tip) return null;
  if (input.retirement === true && await isVacuousReviewObligation(input, decision, tip)) return null;
  return decision.reason;
}

/** A review-then-merge run that never opened a PR and left no commit the default
 * branch lacks has nothing to review or merge, and no later receipt can name a
 * PR to release it. Strict ancestry, not patch equivalence: a squash- or
 * rebase-merged tip had a PR whose legacy record may simply lack its URL, and
 * that case still needs the scoped operator review. Every other hold (leave-open,
 * a recorded PR, unmerged commits, an unresolvable default branch) is kept.
 */
async function isVacuousReviewObligation(input, decision, tip) {
  if (decision.reason !== 'pr-completion-review-required' || input.prUrl
    || !/^[a-f0-9]{40,64}$/i.test(tip || '')
    || decision.policies.some(policy => policy.completion === PR_COMPLETIONS.LEAVE_OPEN || retirementPr(policy))) return false;
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

async function verifiedPolicyTip(repoPath, branch, prUrl, { requireMerged = false, expectedTip = null } = {}) {
  const { getOriginInfo } = await import('../lib/gitRemote.js');
  const { parsePullRequestUrl } = await import('../lib/gitForge.js');
  const origin = await getOriginInfo(repoPath);
  const pr = parsePullRequestUrl(prUrl);
  if (!pr || pr.host !== origin?.host || `${pr.owner}/${pr.repo}` !== origin.fullName) return null;
  const { execGit } = await import('../lib/execGit.js');
  const tip = expectedTip || (await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath)).stdout?.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(tip || '')) return null;
  const { resolveForgeExecOptions } = await import('./forgeExecOptions.js');
  const { execGh } = await import('./github.js');
  const { cwd, env } = await resolveForgeExecOptions(repoPath);
  const remote = JSON.parse(await execGh(['pr', 'view', prUrl, '--json', 'url,state,headRefName,headRefOid,isCrossRepository'], undefined, { cwd, env }));
  return remote.url === prUrl && remote.headRefName === branch && remote.headRefOid === tip
    && remote.isCrossRepository === false && (!requireMerged || remote.state === 'MERGED') ? tip : null;
}
