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
import { checkoutSeedSchema, completedCheckoutReceiptValid, sameTaskRetirementBinding } from './completedCheckoutEvidence.js';
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
    // A review run is bound to the one PR it was assigned. Without that scope a
    // reused branch (the quality-snapshot publisher) inherits every past run's
    // obligation on every later PR, and none of them can ever be released.
    const target = meta.reviewLoopMergeTarget?.branch === branch ? meta.reviewLoopMergeTarget.url : undefined;
    const policy = receipt?.branch === branch ? receipt : {
      branch: scopes.includes(branch) ? branch : null,
      completion,
      ...(target && { prUrl: target }),
    };
    if (policy.branch !== branch || (prUrl && policy.prUrl && policy.prUrl !== prUrl)) continue;
    // A review-then-merge run whose assigned PR the forge verified MERGED has
    // nothing left to review or merge. A human handoff is never discharged.
    if (policy.completion === PR_COMPLETIONS.REVIEW_THEN_MERGE && agent.status === 'completed'
      && meta.mergedReviewFollowUp?.status === 'verified' && target
      && meta.mergedReviewFollowUp.prUrl === target && (policy.prUrl ?? target) === target) continue;
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

/** Validate a persisted review-task handoff, not an inferred physical-owner edge.
 * Both explicit resume chains remain bound to the same captured generation. */
export function reviewedDeliveryHandoffValid(input, agents, handoff, agentId) {
  const task = handoff?.task, meta = task?.metadata;
  const review = handoff?.reviewChain, source = handoff?.sourceChain;
  if (!Array.isArray(agents) || !Array.isArray(review) || !Array.isArray(source)
    || !review.length || !source.length || review.length + source.length > 25
    || review[0] !== agentId || source.at(-1) !== meta?.sourceAgentId
    || task?.status !== 'completed' || ![true, 'true'].includes(meta?.reviewLoopFollowUp)
    || meta.reviewLoopPRUrl !== input.prUrl || meta.reviewLoopPRBranch !== input.branch
    || meta.reviewLoopLeaveOpen === true || meta.reviewLoopLeaveOpen === 'true'
    || !meta.sourceTaskId || task.id === meta.sourceTaskId) return false;
  const byId = new Map(agents.map(agent => [agent?.id, agent]));
  const ids = [...review, ...source];
  if (byId.size !== agents.length || new Set(ids).size !== ids.length) return false;
  const current = byId.get(source[0]);
  const instance = current?.metadata?.instanceId;
  if (!instance || instance === 'unknown') return false;
  for (const chain of [review, source]) {
    for (let index = 0; index < chain.length; index++) {
      const agent = byId.get(chain[index]);
      if (!agent || agent.status !== 'completed' || agent.metadata?.instanceId !== instance
        || agent.taskId !== (chain === review ? task.id : meta.sourceTaskId)
        || agent.result?.executionSuccess === false || agent.result?.validationPassed === false
        || (agent.result?.success !== true && agent.result?.executionSuccess !== true)
        || agent.metadata?.blocker || agent.result?.taskOutcome?.recovery?.mode === 'approval') return false;
      const captures = agent.metadata.completedCheckouts?.filter(row => completedCheckoutReceiptValid(agent, row)
        && samePath(row.repoPath, input.repoPath) && row.branch === input.branch
        && samePath(row.path, agent.metadata.workspacePath) && isDeepStrictEqual(row.incarnation, input.checkoutIncarnation));
      if (captures?.length !== 1) return false;
      if (chain === review && (agent.metadata.reviewLoopMergeTarget?.url !== input.prUrl
        || agent.metadata.reviewLoopMergeTarget?.branch !== input.branch)) return false;
      if (index && (byId.get(chain[index - 1]).metadata.resumedFromAgentId !== agent.id
        || !(Date.parse(agent.completedAt) <= Date.parse(byId.get(chain[index - 1]).startedAt)))) return false;
    }
  }
  const original = byId.get(source.at(-1)), firstReview = byId.get(review.at(-1));
  return samePath(current.metadata.workspacePath, input.checkoutPath)
    && !firstReview.metadata.resumedFromAgentId
    && Date.parse(original.completedAt) <= Date.parse(firstReview.startedAt)
    && Date.parse(byId.get(review[0]).completedAt) <= Date.parse(current.startedAt);
}

/** A moved pathname is not a new generation when exact captured administration
 * and an explicit completed same-task, same-instance resume chain agree. */
function resumedDeliveryPath(policy, input, proof) {
  const chain = proof.resumeChain;
  if (!Array.isArray(chain) || chain.length < 2 || chain.length > 25
    || new Set(chain).size !== chain.length || chain.at(-1) !== policy.agent.id || !Array.isArray(input.agents)) return false;
  const byId = new Map(input.agents.map(agent => [agent?.id, agent]));
  if (byId.size !== input.agents.length) return false;
  const records = chain.map(id => byId.get(id));
  const instance = policy.agent.metadata?.instanceId;
  if (!instance || instance === 'unknown' || !policy.agent.taskId) return false;
  for (let index = 0; index < records.length; index++) {
    const agent = records[index];
    if (!agent || agent.status !== 'completed' || agent.taskId !== policy.agent.taskId
      || agent.metadata?.instanceId !== instance || agent.result?.validationPassed === false
      || agent.result?.executionSuccess === false || (agent.result?.success !== true && agent.result?.executionSuccess !== true)
      || agent.result?.taskOutcome?.recovery?.mode === 'approval' || agent.metadata?.blocker) return false;
    const captures = agent.metadata.completedCheckouts?.filter(row => completedCheckoutReceiptValid(agent, row)
      && samePath(row.repoPath, input.repoPath) && row.branch === input.branch
      && samePath(row.path, agent.metadata.workspacePath) && isDeepStrictEqual(row.incarnation, input.checkoutIncarnation));
    if (captures?.length !== 1 || (index === 0 && !samePath(captures[0].path, input.checkoutPath))) return false;
    if (index > 0 && (records[index - 1].metadata.resumedFromAgentId !== agent.id
      || !(Date.parse(agent.completedAt) <= Date.parse(records[index - 1].startedAt)))) return false;
  }
  return true;
}

/** The original captured generation can outlive a PR's final rewritten head.
 * Reuse its fresh complete-content forge proof, never another checkout's receipt.
 * Explicit resume history preserves each prior run's failed execution verdict. */
function representedOriginalContinuation(policy, input) {
  const forge = input.retirementForge;
  if (!/^[a-f0-9]{64}$/.test(input.detachedCheckoutIdentity || '')
    || !knownPhysicalIdentity(input.detachedCheckoutGitdir) || !isAbsolute(input.detachedCheckoutGitdir.path || '')
    || policy.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE || retirementPr(policy) !== input.prUrl
    || (policy.tip && policy.tip !== input.tip)
    || forge?.scopeProof !== 'represented-detached-head' || forge.prUrl !== input.prUrl
    || forge.detachedRepresentation?.sourceHead !== input.tip
    || forge.detachedRepresentation.deliveredHead !== input.verifiedPrHead
    || forge.prHead !== input.verifiedPrHead || !Array.isArray(input.agents)) return null;
  const byId = new Map(input.agents.map(agent => [agent?.id, agent]));
  if (byId.size !== input.agents.length) return null;
  const capture = agent => {
    const meta = agent?.metadata;
    if (agent?.status !== 'completed' || agent.result?.executionSuccess !== true
      || agent.result.validationPassed === false || agent.result.executionInterruption || meta?.executionInterruption
      || meta?.blocker || agent.result.taskOutcome?.recovery?.mode === 'approval'
      || meta?.isWorktree !== true || meta.prCompletionPolicy !== PR_COMPLETIONS.REVIEW_THEN_MERGE
      || meta.reviewLoopMergeTarget?.url !== input.prUrl || meta.reviewLoopMergeTarget.branch !== input.branch
      || (meta.branchCompletionPolicy && (meta.branchCompletionPolicy.prUrl !== input.prUrl
        || meta.branchCompletionPolicy.branch !== input.branch || meta.branchCompletionPolicy.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE
        || (meta.branchCompletionPolicy.tip && meta.branchCompletionPolicy.tip !== input.tip)))
      || !samePath(meta.sourceWorkspace, input.repoPath)) return null;
    const rows = meta.completedCheckouts?.filter(row => completedCheckoutReceiptValid(agent, row)
      && row.head === input.tip && row.branch === input.branch && samePath(row.repoPath, input.repoPath)
      && samePath(row.path, meta.workspacePath) && knownPhysicalIdentity(row.incarnation?.pointer)
      && isDeepStrictEqual(row.incarnation.gitdir, input.detachedCheckoutGitdir)
      && createHash('sha256').update(JSON.stringify(['dev', 'ino', 'birthtimeNs'].map(key => row.incarnation.pointer[key])))
        .digest('hex') === input.detachedCheckoutIdentity);
    return rows?.length === 1 ? rows[0] : null;
  };
  const owners = input.agents.filter(agent => samePath(agent?.metadata?.workspacePath, input.checkoutPath) && capture(agent));
  if (owners.length !== 1) return null;
  let current = owners[0];
  const original = policy.agent, instance = current.metadata.instanceId, chain = [], seen = new Set();
  if (!instance || instance === 'unknown' || !current.taskId) return null;
  while (current && chain.length < 25 && !seen.has(current.id)) {
    const row = capture(current);
    if (!row || current.taskId !== original.taskId || current.metadata.instanceId !== instance
      || !Number.isFinite(Date.parse(current.startedAt)) || !(Date.parse(current.completedAt) >= Date.parse(current.startedAt))) return null;
    seen.add(current.id); chain.push(current.id);
    if (current.id === original.id) return { kind: 'captured-represented-delivery', agentId: original.id,
      originalPrUrl: retirementPr(policy) ?? null, prUrl: input.prUrl, tip: input.tip,
      deliveredHead: input.verifiedPrHead, detachedRepresentation: forge.detachedRepresentation,
      capturedHead: row.head, capturedAt: row.capturedAt, checkoutIncarnation: row.incarnation, resumeChain: chain };
    const parent = byId.get(current.metadata.resumedFromAgentId);
    if (!parent || !(Date.parse(parent.completedAt) <= Date.parse(current.startedAt))) return null;
    current = parent;
  }
  return null;
}

function continuedDelivery(policy, input) {
  const represented = representedOriginalContinuation(policy, input);
  if (represented) return represented;
  if (policy.agent.status !== 'completed'
    || (policy.agent.result?.success !== true && policy.agent.result?.executionSuccess !== true)
    || policy.agent.result?.executionSuccess === false || policy.agent.result?.validationPassed === false
    || ![PR_COMPLETIONS.REVIEW_THEN_MERGE, PR_COMPLETIONS.MERGE_ON_GREEN].includes(policy.completion)
    || input.verifiedPrHead !== input.tip) return null;
  return input.deliveryContinuations?.find(proof => proof.agentId === policy.agent.id
    && proof.originalPrUrl === (retirementPr(policy) ?? null)
    && proof.prUrl === input.prUrl && proof.tip === input.tip
    && (!policy.tip || [proof.originalPrHead, proof.capturedHead].includes(policy.tip))
    && policy.agent.metadata?.completedCheckouts?.some(row => completedCheckoutReceiptValid(policy.agent, row)
      && samePath(row.repoPath, input.repoPath) && row.branch === input.branch
      && (samePath(row.path, input.checkoutPath) || resumedDeliveryPath(policy, input, proof)
        || reviewedDeliveryHandoffValid(input, input.agents, proof.reviewHandoff, policy.agent.id))
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

function knownPhysicalIdentity(value) {
  return value && ['dev', 'ino', 'birthtimeNs'].every(key => typeof value[key] === 'string')
    && /^(0|[1-9]\d*)$/.test(value.dev)
    && /^[1-9]\d*$/.test(value.ino) && /^[1-9]\d*$/.test(value.birthtimeNs);
}

// A pinned claim reserves its branch before its TUI receives a prompt. A
// runner-confirmed paste failure cannot own a later, server-captured generation
// of the same task. A recorded binding or ambiguous identity remains a hold.
function precreationStartupFailure(policy, input, policies) {
  const agent = policy.agent, meta = agent.metadata || {}, result = agent.result || {};
  const started = Date.parse(agent.startedAt), ended = Date.parse(agent.completedAt);
  const incarnation = input.checkoutIncarnation, forge = input.retirementForge;
  if (agent.status !== 'completed' || result.success !== false || result.executionSuccess !== false
    || result.completionReason !== 'paste-not-rendered' || result.errorAnalysis?.completionReason !== 'paste-not-rendered'
    || result.errorAnalysis?.category !== 'startup-failure' || result.errorAnalysis?.origin !== 'runner'
    || result.orphaned === true || result.validationPassed === false
    || policy.completion !== PR_COMPLETIONS.MERGE_ON_GREEN || meta.configClaimFlow !== true
    || meta.isWorktree !== false || meta.claimPicksOwnBranch !== false || meta.claimSelectionPending !== true
    || meta.claimBranch !== input.branch || !samePath(meta.workspacePath, input.repoPath) || meta.sourceWorkspace != null
    || meta.branchCompletionPolicy != null || meta.reviewLoopMergeTarget != null || meta.prDeliveryTarget != null || meta.recoveryMergeTarget != null
    || ['claimBranches', 'claimReleasedBranches', 'checkoutSeeds', 'checkoutCapture', 'completedCheckouts'].some(key => Object.hasOwn(meta, key))
    || typeof agent.taskId !== 'string' || !agent.taskId || typeof meta.instanceId !== 'string' || !meta.instanceId || meta.instanceId === 'unknown'
    || !Number.isFinite(started) || !Number.isFinite(ended) || started > ended
    || !isAbsolute(input.checkoutPath || '') || samePath(input.checkoutPath, input.repoPath)
    || !checkoutSeedSchema.shape.incarnation.safeParse(incarnation).success
    || !isAbsolute(incarnation.gitdir.path) || !knownPhysicalIdentity(incarnation.pointer) || !knownPhysicalIdentity(incarnation.gitdir)
    || forge?.scopeProof !== 'exact-delivered-head' || forge.prUrl !== input.prUrl
    || !parsePullRequestUrl(input.prUrl) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.tip || '')
    || forge.prHead !== input.tip || input.verifiedPrHead !== input.tip) return false;
  // Compare conservatively past the end of the stored millisecond.
  const after = (BigInt(ended) + 1n) * 1_000_000n;
  if (BigInt(incarnation.pointer.birthtimeNs) <= after || BigInt(incarnation.gitdir.birthtimeNs) <= after) return false;
  return policies.some(candidate => {
    const next = candidate.agent, nextMeta = next.metadata || {};
    return next.id !== agent.id && next.taskId === agent.taskId && nextMeta.instanceId === meta.instanceId
      && candidate.completion === PR_COMPLETIONS.MERGE_ON_GREEN && next.status === 'completed'
      && next.result?.success === true && next.result?.executionSuccess === true && next.result?.validationPassed !== false
      && Date.parse(next.startedAt) > ended && Date.parse(next.completedAt) >= Date.parse(next.startedAt)
      && Array.isArray(nextMeta.completedCheckouts) && nextMeta.completedCheckouts.some(row => completedCheckoutReceiptValid(next, row)
        && samePath(row.repoPath, input.repoPath) && row.branch === input.branch && samePath(row.path, input.checkoutPath)
        && row.head === input.tip && isDeepStrictEqual(row.incarnation, incarnation));
  });
}

function distinctCapturedAdministration(incarnation, current) {
  return checkoutSeedSchema.shape.incarnation.safeParse(incarnation).success
    && isAbsolute(incarnation.gitdir.path) && knownPhysicalIdentity(incarnation.pointer)
    && knownPhysicalIdentity(incarnation.gitdir) && knownPhysicalIdentity(current)
    && ['dev', 'ino', 'birthtimeNs'].some(key => incarnation.gitdir[key] !== current[key]);
}

function separatelyDeliveredCheckout(policy, input) {
  const forge = input.retirementForge;
  if (!input.detachedCheckoutIdentity && forge?.scopeProof === 'exact-delivered-head'
    && forge.prHead === input.tip && input.verifiedPrHead === input.tip
    && policy.agent.status === 'completed' && policy.completion === PR_COMPLETIONS.REVIEW_THEN_MERGE
    && policy.agent.result?.executionSuccess === true && policy.agent.result.validationPassed !== false
    && policy.agent.result.taskOutcome?.recovery?.mode !== 'approval' && !policy.agent.metadata?.blocker
    && retirementPr(policy) === input.prUrl) {
    const rows = policy.agent.metadata?.completedCheckouts?.filter(row => completedCheckoutReceiptValid(policy.agent, row)
      && samePath(row.repoPath, input.repoPath) && row.branch === input.branch
      && samePath(row.path, policy.agent.metadata.workspacePath) && !sameReviewedPath(row.path, input.checkoutPath, input)
      && (!policy.tip || [row.head, input.tip].includes(policy.tip))
      && (!reviewTarget(policy) || reviewTarget(policy).branch === input.branch)
      && distinctCapturedAdministration(row.incarnation, input.checkoutIncarnation?.gitdir)
      && !isDeepStrictEqual(row.incarnation.pointer, input.checkoutIncarnation?.pointer)
      && input.namedSiblingCaptures?.some(proof => proof.agentId === policy.agent.id
        && proof.capturedHead === row.head && proof.capturedAt === row.capturedAt && proof.path === row.path
        && isDeepStrictEqual(proof.incarnation, row.incarnation)
        && isDeepStrictEqual(proof.checkoutIncarnation, input.checkoutIncarnation)));
    return rows?.length === 1 ? { ...rows[0], releasedCopyIncarnation: input.checkoutIncarnation } : null;
  }

  if (forge?.scopeProof !== 'represented-detached-head' || forge.detachedRepresentation?.sourceHead !== input.tip
    || forge.detachedRepresentation.deliveredHead !== input.verifiedPrHead
    || completedDetachedSibling(policy, input) || policy.resumedCleanup
    || policy.agent.status !== 'completed' || policy.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE
    || retirementPr(policy) !== input.prUrl || !/^[a-f0-9]{64}$/.test(input.detachedCheckoutIdentity || '')) return null;
  const rows = policy.agent.metadata?.completedCheckouts?.filter(row => completedCheckoutReceiptValid(policy.agent, row)
    && samePath(row.repoPath, input.repoPath) && row.branch === input.branch
    && samePath(row.path, policy.agent.metadata.workspacePath) && !sameReviewedPath(row.path, input.checkoutPath, input)
    && distinctCapturedAdministration(row.incarnation, input.detachedCheckoutGitdir) && createHash('sha256')
      .update(JSON.stringify(['dev', 'ino', 'birthtimeNs'].map(key => row.incarnation.pointer[key])))
      .digest('hex') !== input.detachedCheckoutIdentity
    && input.detachedSiblingCaptures?.some(proof => proof.agentId === policy.agent.id
      && proof.capturedHead === row.head && proof.capturedAt === row.capturedAt && proof.path === row.path
      && proof.detachedCheckoutIdentity === input.detachedCheckoutIdentity && isDeepStrictEqual(proof.incarnation, row.incarnation)));
  return rows?.length === 1 ? rows[0] : null;
}

/** A merged PR whose rewritten head contains the exact local tip shipped every
 * local commit. That settles this checkout's obligation only; the owner's
 * recorded verdict stays unchanged. Bound to the reviewed tip and PR head. */
function ancestorDeliveredCheckout(policy, input) {
  const forge = input.retirementForge, agent = policy.agent, target = reviewTarget(policy);
  if (input.detachedCheckoutIdentity || forge?.scopeProof !== 'ancestor-of-delivered-head' || forge.prUrl !== input.prUrl
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.tip || '') || forge.deliveredAncestorHead !== input.tip
    || forge.prHead !== input.verifiedPrHead || input.verifiedPrHead === input.tip
    || agent.status !== 'completed' || !agent.result || agent.result.validationPassed === false
    || agent.result.taskOutcome?.recovery?.mode === 'approval' || agent.metadata?.blocker
    || ![PR_COMPLETIONS.REVIEW_THEN_MERGE, PR_COMPLETIONS.MERGE_ON_GREEN].includes(policy.completion)
    || (retirementPr(policy) && retirementPr(policy) !== input.prUrl)
    || (policy.tip && ![input.tip, input.verifiedPrHead].includes(policy.tip))
    || (target && (target.branch !== input.branch || target.url !== input.prUrl))) return null;
  return { tip: input.tip, prHead: input.verifiedPrHead };
}

function reviewedIncarnation(input, policies) {
  if (!isAbsolute(input.checkoutPath || '') || samePath(input.checkoutPath, input.repoPath)
    || !input.prUrl || (input.verifiedPrHead !== input.tip && !policies.some(policy => representedOriginalContinuation(policy, input)))
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
  const primaryIdentity = input.checkoutIdentities?.[input.repoPath];
  const superseding = owners.find(owner => exactCleanupHandoff(owner, input));
  const prior = [];
  const supersededBy = new Map();
  // Explicitly resumed owners are this checkout's history even after a move.
  // A mismatching PR must hold, rather than masquerade as unrelated history.
  const resumedOwners = new Set(policies.map(policy => policy.agent.metadata?.resumedFromAgentId).filter(Boolean));
  const current = policies.filter(policy => {
    const workspace = policy.agent.metadata?.workspacePath;
    const target = reviewTarget(policy);
    const separateCheckout = !samePath(workspace, input.repoPath)
      && identity && input.checkoutIdentities?.[workspace] && input.checkoutIdentities[workspace] !== identity
      && primaryIdentity && input.checkoutIdentities[workspace] !== primaryIdentity;
    // A coordinator running in the primary checkout (a swarm) has no separate
    // physical identity. It is history only when a later exact cleanup handoff
    // for this tip/PR/checkout generation superseded it and it never captured this tip.
    const supersededCoordinator = !separateCheckout && superseding && samePath(workspace, input.repoPath)
      && identity && primaryIdentity && identity !== primaryIdentity && !capturedTip(policy, input.tip);
    const unrelated = policy.agent.status === 'completed' && !resumedOwners.has(policy.agent.id)
      && policy.completion !== PR_COMPLETIONS.LEAVE_OPEN
      && isAbsolute(workspace || '') && !samePath(workspace, input.checkoutPath)
      && (separateCheckout || supersededCoordinator)
      && Number.isFinite(Date.parse(policy.agent.startedAt))
      && Date.parse(policy.agent.completedAt) >= Date.parse(policy.agent.startedAt)
      && Date.parse(policy.agent.completedAt) < firstStarted
      && policy.prUrl !== input.prUrl && target?.url !== input.prUrl
      && (!policy.prUrl || parsePullRequestUrl(policy.prUrl))
      && (!target || (target.branch === input.branch && parsePullRequestUrl(target.url)
        && (!policy.prUrl || policy.prUrl === target.url)));
    if (unrelated) {
      prior.push(policy);
      if (!separateCheckout) supersededBy.set(policy.agent.id, superseding.agent.id);
    }
    return !unrelated;
  });
  return { current, prior, supersededBy };
}

/** A completed cleanup handoff whose own receipt binds this exact PR, merged
 * tip and server-captured checkout generation. */
function exactCleanupHandoff(policy, input) {
  const agent = policy.agent;
  return completedCleanupForRetirement(policy, input) && retirementPr(policy) === input.prUrl
    && (!policy.tip || policy.tip === input.tip)
    && agent.metadata.completedCheckouts?.some(row => completedCheckoutReceiptValid(agent, row)
      && samePath(row.repoPath, input.repoPath) && row.branch === input.branch && samePath(row.path, input.checkoutPath)
      && row.head === input.tip && isDeepStrictEqual(row.incarnation, input.checkoutIncarnation)) === true;
}

// Unreadable capture history, including a row without a well-formed head,
// cannot prove the run never held this tip.
function capturedTip(policy, tip) {
  const rows = policy.agent.metadata?.completedCheckouts;
  if (rows !== undefined && !Array.isArray(rows)) return true;
  return policy.tip === tip || policy.agent.metadata?.branchCompletionPolicy?.tip === tip
    || (rows || []).some(row => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row?.head || '') || row.head === tip);
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
      && samePath(row.repoPath, input.repoPath) && row.branch === input.branch && samePath(row.path, input.checkoutPath)
      && row.head === input.tip && row.incarnation?.pointer && row.incarnation?.gitdir));
}

/** A retry moves the original checkout rather than creating another generation.
 * A completed cleanup successor can settle its captured ancestors' retirement
 * obligations; their execution failures and task budgets remain historical facts.
 */
function preservedResumedSource(proof, row, input) {
  if (proof.kind !== 'preserved-resumed-source') return true;
  const saved = proof.sourcePreservation;
  return saved?.sourceHead === row.head && saved.retainedHead === row.head
    && saved.retainedRef === `refs/portos/retained-checkout-source/${row.head}`
    && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(saved.base || '')
    && saved.targetHead === (input.retirementForge?.targetHead ?? input.retirementForge?.defaultHead)
    && Number.isInteger(saved.sourceCommits) && saved.sourceCommits > 0 && saved.sourceCommits <= 64
    && Number.isInteger(saved.deltaBytes) && saved.deltaBytes >= 0 && saved.deltaBytes <= 64 * 1024
    && /^[a-f0-9]{64}$/.test(saved.deltaSha256 || '');
}

function resumedCleanupPolicies(policies, input) {
  if (input.verifiedPrHead !== input.tip) return policies;
  const byId = new Map(policies.map(policy => [policy.agent.id, policy]));
  const proofs = new Map();
  // Claims may discover their PR only during retirement. A missing saved URL
  // retains the exact task, capture and generation requirements below.
  const receipt = (policy, incarnation, successor = null) => {
    const agent = policy.agent;
    if (agent.status !== 'completed' || !agent.taskId || agent.result?.validationPassed === false
      || policy.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE
      || (retirementPr(policy) && retirementPr(policy) !== input.prUrl)
      || (policy.tip && policy.tip !== input.tip && !successor)) return null;
    const rewritten = row => successor && input.resumedDeliveries?.some(proof =>
      proof.agentId === agent.id && proof.successorAgentId === successor.agent.id && proof.taskId === agent.taskId
      && proof.capturedHead === row.head && proof.capturedAt === row.capturedAt
      && proof.prUrl === input.prUrl && proof.tip === input.tip && preservedResumedSource(proof, row, input)
      && (!policy.tip || policy.tip === row.head) && isDeepStrictEqual(proof.checkoutIncarnation, incarnation));
    const rows = agent.metadata?.completedCheckouts?.filter(row => completedCheckoutReceiptValid(agent, row)
      && samePath(row.repoPath, input.repoPath) && row.branch === input.branch && (!policy.tip || policy.tip === row.head)
      && (row.head === input.tip || rewritten(row))
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
        || !(Date.parse(parent.agent.completedAt) <= Date.parse(child.agent.startedAt)) || !receipt(parent, context.checkoutIncarnation, successor)) break;
      seen.add(parent.agent.id);
      const retained = input.resumedDeliveries?.find(proof => proof.kind === 'preserved-resumed-source'
        && proof.agentId === parent.agent.id && proof.successorAgentId === successor.agent.id
        && proof.taskId === parent.agent.taskId && proof.prUrl === input.prUrl && proof.tip === input.tip
        && isDeepStrictEqual(proof.checkoutIncarnation, context.checkoutIncarnation));
      proofs.set(parent.agent.id, { successorAgentId: successor.agent.id, taskId: successor.agent.taskId,
        checkoutIncarnation: context.checkoutIncarnation,
        ...(retained && { sourcePreservation: retained.sourcePreservation }),
        ...(sibling && { detachedCheckoutIdentity: input.detachedCheckoutIdentity }) });
      child = parent;
    }
  }
  for (const proof of input.resumedDeliveries || []) {
    if (proof.kind !== 'same-task-generation' || proof.prUrl !== input.prUrl || proof.tip !== input.tip
      || !isDeepStrictEqual(proof.checkoutIncarnation, input.checkoutIncarnation)) continue;
    const parent = byId.get(proof.agentId), successor = byId.get(proof.successorAgentId);
    if (!parent || !successor || parent.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE
      || successor.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE || proof.taskId !== parent.agent.taskId
      || proof.originalPolicyTip !== (parent.tip ?? null)) continue;
    const binding = sameTaskRetirementBinding(parent.agent, successor.agent, input);
    if (!binding || proof.capturedHead !== (binding.sourceCapture?.head ?? null)
      || proof.capturedAt !== (binding.sourceCapture?.capturedAt ?? null)
      || proof.sourceSeededAt !== (binding.sourceSeed?.seededAt ?? null)
      || proof.successorCapturedAt !== binding.successorCapture.capturedAt) continue;
    proofs.set(parent.agent.id, { successorAgentId: successor.agent.id, taskId: parent.agent.taskId,
      checkoutIncarnation: input.checkoutIncarnation, evidence: 'server-seeded-task-generation',
      ...(binding.sourceSeed && { sourceCaptureUnknown: true }) });
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
  const allPolicies = decision.policies || [];
  const resumed = resumedCleanupPolicies(allPolicies.filter(policy => !precreationStartupFailure(policy, input, allPolicies)), input);
  const incarnation = reviewedIncarnation(input, resumed);
  const policies = incarnation?.current || resumed;
  if (policies.some(p => p.completion === PR_COMPLETIONS.LEAVE_OPEN)) return { reason: held };
  if (policies.some(p => !separatelyDeliveredCheckout(p, input) && !ancestorDeliveredCheckout(p, input) && (p.agent.status !== 'completed' || (p.agent.result?.success !== true && !completedCleanupForRetirement(p, input)
    && !reviewedOrphanCheckout(p, input) && !completedDetachedSibling(p, input) && !continuedDelivery(p, input) && !p.resumedCleanup)
    || (p.completion !== PR_COMPLETIONS.REVIEW_THEN_MERGE
      && !(p.completion === PR_COMPLETIONS.MERGE_ON_GREEN && continuedDelivery(p, input)))
    || (retirementPr(p) && !continuedDelivery(p, input)
      && ((!incarnation && !completedDetachedSibling(p, input)
        && !(input.detachedCheckoutIdentity && p.resumedCleanup?.detachedCheckoutIdentity === input.detachedCheckoutIdentity)) || retirementPr(p) !== input.prUrl))
    || (reviewTarget(p) && (reviewTarget(p).branch !== input.branch || (p.prUrl && p.prUrl !== reviewTarget(p).url)))
    || (incarnation && p.tip && p.tip !== input.tip && !continuedDelivery(p, input) && !p.resumedCleanup)))) {
    return { reason: 'retirement-policy-not-legacy-completed' };
  }
  return { reason: null, ...(input.integratedCleanupHead && { integratedCleanupHead: input.integratedCleanupHead }),
    ...(input.detachedCheckoutGitdir && { detachedCheckoutGitdir: input.detachedCheckoutGitdir }), policies: policies.map(p => ({
    id: p.agent.id || p.agent.agentId, startedAt: p.agent.startedAt,
    completedAt: p.agent.completedAt, status: p.agent.status, success: p.agent.result.success,
    ...(p.resumedCleanup && { resumedCleanup: p.resumedCleanup }),
    ...(separatelyDeliveredCheckout(p, input) && { retainedSiblingObligation: separatelyDeliveredCheckout(p, input) }),
    ...(continuedDelivery(p, input) && { continuedDelivery: continuedDelivery(p, input) }),
    ...(ancestorDeliveredCheckout(p, input) && { deliveredAncestor: ancestorDeliveredCheckout(p, input) }),
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
      ...(incarnation.supersededBy.has(p.agent.id) && { supersededBy: incarnation.supersededBy.get(p.agent.id) }),
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
  return (await readBranchCompletionHoldDetail(input, deps)).reason;
}

/** `readBranchCompletionHold` plus `unshipped`: a review-then-merge obligation
 * whose run ended before any PR was recorded for it (no open PR either). The
 * obligation gates the eventual merge, not the work: branch-reconcile may hand
 * such a branch to a coordinator to open its PR through the review workflow. */
export async function readBranchCompletionHoldDetail(input, deps = {}) {
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
