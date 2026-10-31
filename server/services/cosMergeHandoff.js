/**
 * Hand a validated, published PR head to the pending-merge coordinator (#12247).
 *
 * A registered run that has pushed its head and satisfied its configured
 * reviews may stop waiting for CI. The server — never the request — binds the
 * repository, PR, exact head, completion policy and review evidence, persists
 * that binding on the app's pending-merge queue, and prWatcher merges only that
 * head under its own repository admission once required checks are green.
 * GitHub auto-merge is never enabled: it cannot take the local admission lease
 * at the deferred merge instant, and it can merge before unenforced checks run.
 */
import { randomUUID } from 'node:crypto';
import { localReviewLifecycle } from '../lib/localReviewLifecycle.js';
import { followUpRoster } from './mergeFollowUpPolicy.js';
import { readReviewEvidence } from './mergeReviewEvidence.js';
import { resolve } from 'node:path';
import { execGh } from './github.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { githubApiHost, githubRepoSpec } from '../lib/workTracker.js';
import { execGit } from '../lib/execGit.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { PR_COMPLETIONS, agentPrHeldForOperator, prHeldForOperator, resolvePrCompletion } from '../lib/prDisposition.js';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
// Transient: the caller may retry the same handoff. Everything else means the
// run keeps the PR on its own immediate CI/admission path.
const RETRYABLE = new Set(['ownership-unreadable', 'pr-unreadable', 'queue-write-failed']);
const refuse = (reason) => ({ queued: false, reason, retryable: RETRYABLE.has(reason) });
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && resolve(a) === resolve(b);

// The task's own app, else the single active app checked out at the run's
// source workspace; either must still point at the run's repository.
async function resolveHandoffApp(task, agent, repository, repositoryKey) {
  const { getAppById, getActiveApps } = await import('./apps.js');
  const source = agent.metadata?.sourceWorkspace;
  const byId = task.metadata?.app ? await getAppById(task.metadata.app).catch(() => null) : null;
  const candidates = byId ? [byId]
    : (await getActiveApps().catch(() => [])).filter((app) => source && samePath(app.repoPath, source));
  if (candidates.length !== 1 || !candidates[0]?.repoPath) return null;
  const origin = await getOriginInfo(candidates[0].repoPath).catch(() => null);
  return repositoryKey(origin) === repository ? candidates[0] : null;
}

// The checkout the run reviewed must be this repository, on the PR branch, at
// exactly the head being handed off.
async function checkoutAtHead(workspace, branch, head, repository, repositoryKey) {
  if (repositoryKey(await getOriginInfo(workspace).catch(() => null)) !== repository) return false;
  const [ref, sha] = await Promise.all([
    execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspace).catch(() => null),
    execGit(['rev-parse', '--verify', 'HEAD^{commit}'], workspace).catch(() => null),
  ]);
  return ref?.stdout?.trim() === branch && sha?.stdout?.trim().toLowerCase() === head;
}

// Keep the shared strict receipt parser used by external admission; only this
// local-review handoff layer adds historical PR-delivery completion evidence.
async function readDeliveryReviewEvidence(workspace, prUrl) {
  const review = await readReviewEvidence(workspace);
  return { ...review, delivery: prUrl ? await localReviewLifecycle(workspace, { prUrl }).catch(() => null) : null };
}

// Legacy evidence stays head-bound. A matching delivery receipt proves pre-PR
// completion without claiming that later commits were locally reviewed.
function reviewEvidenceAccepted({ status, head: reviewedHead, delivery }, head, policy, { reviewers = [], optionalReviewers = [] } = {}) {
  if (policy === PR_COMPLETIONS.MERGE_ON_GREEN) return status === null || status === 'clean';
  const allOptional = reviewers.length > 0 && reviewers.every((reviewer) => optionalReviewers.includes(reviewer));
  const completedDelivery = delivery?.reusable && ['clean', 'partial'].includes(delivery.receipt?.status);
  if (status === 'optional-inconclusive') return allOptional && (reviewedHead === head || completedDelivery);
  return status === 'clean' && (allOptional || reviewedHead === head || completedDelivery);
}

/** Read-only target check shared by orphan review and its eventual workspace launch.
 * This is permission to inspect one head, never merge admission or proof of review.
 */
export async function validateCleanupReviewTarget({ target, workspacePath, requireCheckout = false, launchTaskId = null }) {
  if (!isPlainObject(target) || target.version !== 1 || !SHA_PATTERN.test(target.headSha || '')
    || !target.branch || !target.repoPath || !target.repository) return 'review-target-invalid';
  const pr = parsePullRequestUrl(target.prUrl);
  const { repositoryKey } = await import('./mergeHandoffOwner.js');
  if (!pr || repositoryKey({ host: pr.host, fullName: `${pr.owner}/${pr.repo}` }) !== target.repository
    || repositoryKey(await getOriginInfo(workspacePath).catch(() => null)) !== target.repository) return 'review-repository-changed';
  const local = await execGit(['rev-parse', '--verify', `refs/heads/${target.branch}^{commit}`], workspacePath).catch(() => null);
  if (local?.stdout?.trim() !== target.headSha) return 'review-head-moved';
  const repoSpec = githubRepoSpec({ host: pr.host, fullName: `${pr.owner}/${pr.repo}` });
  if (!repoSpec) return 'review-forge-unsupported';
  const { getTaskById } = await import('./cosTaskStore.js');
  const ownerTask = await getTaskById(target.ownerTaskId).catch(() => null);
  if (!ownerTask || prHeldForOperator(ownerTask)
    || resolvePrCompletion(ownerTask.metadata) !== target.prCompletion) return 'review-policy-held';
  if (ownerTask.status !== 'completed' && !(ownerTask.id === launchTaskId && ['pending', 'in_progress'].includes(ownerTask.status))) return 'review-task-not-completed';
  const { getAppById } = await import('./apps.js');
  const app = ownerTask.metadata?.app ? await getAppById(ownerTask.metadata.app).catch(() => null) : null;
  if (ownerTask.metadata?.app && (!app || !samePath(app.repoPath, target.repoPath))) return 'review-app-changed';
  const options = await resolveForgeExecOptions(target.repoPath, { forgeAccount: app?.forgeAccount });
  const raw = await execGh(['pr', 'view', String(pr.number), '--repo', repoSpec,
    '--json', 'number,state,isDraft,isCrossRepository,headRefName,headRefOid'], undefined,
  { cwd: options.cwd, env: options.env }).catch(() => null);
  const view = safeJSONParse(raw, null);
  if (!isPlainObject(view) || view.number !== pr.number) return 'review-pr-unreadable';
  if (view.state !== 'OPEN' || view.isDraft !== false || view.isCrossRepository !== false) return 'review-pr-held';
  if (view.headRefName !== target.branch || view.headRefOid !== target.headSha) return 'review-head-moved';
  if (requireCheckout) {
    if (!await checkoutAtHead(workspacePath, target.branch, target.headSha, target.repository, repositoryKey)) return 'review-checkout-changed';
    const status = await execGit(['status', '--porcelain=v1', '--untracked-files=all'], workspacePath).catch(() => null);
    if (!status || status.stdout.trim()) return 'review-checkout-dirty';
  }
  // Policy is checked after the potentially slow forge/checkout reads as well:
  // an operator hold arriving while those reads run must win before dispatch.
  const currentOwnerTask = await getTaskById(target.ownerTaskId).catch(() => null);
  if (!currentOwnerTask || currentOwnerTask.status !== ownerTask.status || currentOwnerTask.metadata?.app !== ownerTask.metadata?.app
    || prHeldForOperator(currentOwnerTask) || resolvePrCompletion(currentOwnerTask.metadata) !== target.prCompletion) return 'review-policy-held';
  if (launchTaskId) {
    const launchTask = await getTaskById(launchTaskId).catch(() => null);
    const saved = launchTask?.metadata?.cleanupReviewTarget;
    if (!launchTask || !['pending', 'in_progress'].includes(launchTask.status) || prHeldForOperator(launchTask)
      || !isPlainObject(saved) || Object.keys(target).some(key => saved[key] !== target[key])) return 'review-launch-task-changed';
  }
  return null;
}

const lowerLogin = (value) => String(value ?? '').replace(/^@+/, '').toLowerCase();

/** Non-optional `@login` reviewers of a roster, lower-cased and `@`-free. */
function requiredForgeLogins(roster) {
  const optional = new Set((roster.optionalReviewers || []).map(lowerLogin));
  return (roster.usernames || []).map(lowerLogin).filter((login) => login && !optional.has(login));
}

// A review counts only when one of `logins` submitted it against exactly the
// bound head; drafts (PENDING) and withdrawn (DISMISSED) reviews never resume
// work. true/false is an answer, null means the forge could not be read.
async function forgeReviewSubmittedOnHead(target, logins, forgeAccount) {
  const pr = parsePullRequestUrl(target.prUrl);
  const repoSpec = pr && githubRepoSpec({ host: pr.host, fullName: `${pr.owner}/${pr.repo}` });
  if (!repoSpec) return null;
  const options = await resolveForgeExecOptions(target.repoPath, { forgeAccount });
  const raw = await execGh(['pr', 'view', String(pr.number), '--repo', repoSpec, '--json', 'reviews'], undefined,
    { cwd: options.cwd, env: options.env }).catch(() => null);
  const view = safeJSONParse(raw, null);
  if (!isPlainObject(view) || !Array.isArray(view.reviews)) return null;
  return view.reviews.some((review) => logins.includes(lowerLogin(review?.author?.login))
    && !['PENDING', 'DISMISSED'].includes(String(review?.state || '').toUpperCase())
    && String(review?.commit?.oid || '').toLowerCase() === target.headSha);
}

/** Resolve a genuinely missing required review without adopting a completed
 * owner into merge admission. Ambiguous history and optional/no-review policies
 * retain the branch; pending CI by itself never creates cognitive work.
 */
export async function inspectCompletedOwnerReview({ agentId = null, repoPath, branch, prUrl, headSha, worktreePath }) {
  const held = reason => ({ disposition: 'held', reason });
  const { readBranchCompletionPolicies, readBranchCompletionHold } = await import('./branchCompletionPolicy.js');
  const agents = await readBranchCompletionPolicies({ repairIndex: false }).catch(() => null);
  if (!agents) return held('review-ownership-unreadable');
  const scopes = agent => {
    const m = agent.metadata || {};
    return [m.worktreeBranch, m.jiraBranch, m.claimBranch, m.branchCompletionPolicy?.branch,
      ...(Array.isArray(m.claimBranches) ? m.claimBranches : []), ...(Array.isArray(m.claimReleasedBranches) ? m.claimReleasedBranches : [])];
  };
  const owners = agents.filter(agent => samePath(agent.metadata?.sourceWorkspace || agent.metadata?.workspacePath, repoPath) && scopes(agent).includes(branch));
  if (owners.length !== 1 || (agentId && owners[0].id !== agentId)) return held('review-owner-ambiguous');
  const agent = owners[0];
  if (agent.status !== 'completed' || !agent.id || !agent.taskId || !Number.isFinite(Date.parse(agent.startedAt))
    || !(Date.parse(agent.completedAt) >= Date.parse(agent.startedAt))) return held('review-owner-not-completed');
  const { getTaskById, getTaskView } = await import('./cosTaskStore.js');
  const task = await getTaskById(agent.taskId).catch(() => null);
  if (!task || task.id !== agent.taskId || task.status !== 'completed') return held('review-task-not-completed');
  const policy = resolvePrCompletion(task.metadata);
  if (agentPrHeldForOperator(agent, task)) return held('review-policy-held');
  const policyHold = await readBranchCompletionHold({ repoPath, branch, prUrl, tip: headSha, agents });
  if (policyHold !== (policy === PR_COMPLETIONS.REVIEW_THEN_MERGE ? 'pr-completion-review-required' : null)) return held('review-policy-unproven');
  const { repositoryKey } = await import('./mergeHandoffOwner.js');
  const repository = repositoryKey(await getOriginInfo(repoPath).catch(() => null));
  const app = await resolveHandoffApp(task, agent, repository, repositoryKey);
  if (!app) return held('review-app-unresolved');
  const recordedWorkspace = agent.metadata?.workspacePath || agent.workspacePath;
  const claimCutsCheckout = isTruthyMeta(agent.metadata?.claimPicksOwnBranch) || Boolean(agent.metadata?.claimBranch);
  // Claim/swarm parents register the source workspace, then bind their child
  // branches. That source path is not a claim checkout ownership receipt.
  if (!worktreePath || samePath(worktreePath, repoPath)) return held('review-checkout-not-private');
  if (recordedWorkspace && !samePath(recordedWorkspace, worktreePath)
    && !(claimCutsCheckout && samePath(recordedWorkspace, repoPath))) return held('review-checkout-owner-mismatch');
  const recordedPr = agent.metadata?.branchCompletionPolicy?.prUrl || agent.metadata?.reviewLoopMergeTarget?.url;
  if (recordedPr && prIdentity(recordedPr) !== prIdentity(prUrl)) return held('review-owner-pr-mismatch');
  const target = { version: 1, repository, repoPath, branch, prUrl, headSha, worktreePath,
    ownerId: agent.id, ownerStartedAt: agent.startedAt, ownerTaskId: task.id, prCompletion: policy };
  const invalid = await validateCleanupReviewTarget({ target, workspacePath: worktreePath, requireCheckout: true });
  if (invalid) return held(invalid);
  const { readClaimOwnershipAgents } = await import('./cosClaimOwnership.js');
  const { claimCheckoutOwnerReason } = await import('../lib/claimContinuation.js');
  const live = await readClaimOwnershipAgents().catch(() => null);
  const ownerReason = claimCheckoutOwnerReason({ branchName: branch, holderPath: worktreePath, sourceWorkspace: repoPath, agents: live });
  if (ownerReason) return held(ownerReason);
  const queue = await getTaskView({ kind: 'queue' }).catch(() => null);
  if (!queue || !Array.isArray(queue.user?.tasks) || !Array.isArray(queue.cos?.tasks)) return held('review-successors-unreadable');
  const successor = [...queue.user.tasks, ...queue.cos.tasks].find(row => row.id !== task.id && row.status !== 'completed'
    && (prIdentity(row.metadata?.reviewLoopPRUrl) === prIdentity(prUrl)
      || prIdentity(row.metadata?.cleanupReviewTarget?.prUrl) === prIdentity(prUrl)));
  if (successor) {
    const bound = successor.metadata?.cleanupReviewTarget;
    if (isPlainObject(bound) && Object.keys(target).every(key => bound[key] === target[key])
      && ['pending', 'in_progress'].includes(successor.status)) {
      return { disposition: 'join-existing', reason: 'review-successor-exists', taskId: successor.id, agentId: agent.id, reviewTarget: target };
    }
    return held('review-successor-exists');
  }
  const { readPendingMergePrs } = await import('./prWatcher.js');
  const handoff = readPendingMergePrs(app).find(entry => prIdentity(entry.prUrl) === prIdentity(prUrl) && entry.prBranch === branch
    && entry.handoff?.headSha === headSha && entry.handoff?.agentId === agent.id && entry.handoff?.taskId === task.id
    && entry.handoff?.startedAt === agent.startedAt && entry.handoff?.repository === repository && entry.handoff?.receiptId);
  if (handoff) return { disposition: 'join-existing', reason: 'review-handoff-exists', appId: app.id };
  if (policy === PR_COMPLETIONS.MERGE_ON_GREEN) return { ...held('review-not-required'), agentId: agent.id, originalTask: task,
    roster: await followUpRoster(task, policy), reviewTarget: target };
  const roster = await followUpRoster(task, PR_COMPLETIONS.REVIEW_THEN_MERGE);
  if (!roster.reviewers?.some(reviewer => !roster.optionalReviewers?.includes(reviewer))) {
    // A username-only roster has no local verdict to prove: the review is a forge
    // event. Resume only when a required login has reviewed this exact head.
    const logins = requiredForgeLogins(roster);
    if (!logins.length) return held('review-required-roster-unproven');
    const reviewed = await forgeReviewSubmittedOnHead(target, logins, app.forgeAccount);
    if (reviewed === null) return held('review-forge-unreadable');
    if (!reviewed) return held('awaiting-forge-review');
    return { disposition: 'review-required', reason: 'forge-review-submitted', agentId: agent.id, originalTask: task, roster, reviewTarget: target };
  }
  const review = await readDeliveryReviewEvidence(worktreePath, target.prUrl);
  if (review.status === 'unreadable') return held('review-evidence-unreadable');
  if (reviewEvidenceAccepted(review, headSha, PR_COMPLETIONS.REVIEW_THEN_MERGE, roster)) return { ...held('review-recorded-handoff-missing'), agentId: agent.id, originalTask: task, roster, reviewTarget: target };
  return { disposition: 'review-required', reason: 'required-review-missing', agentId: agent.id, originalTask: task, roster, reviewTarget: target };
}

/**
 * @param {{ agentId: string, prUrl: string, headSha: string, worktreePath?: string }} input
 * @returns {Promise<{ queued: true, receipt: object }|{ queued: false, reason: string, retryable: boolean }>}
 */
export async function handoffPendingMerge({ agentId, prUrl, headSha, worktreePath = null }) {
  const head = String(headSha || '').toLowerCase();
  const pr = parsePullRequestUrl(prUrl);
  if (!pr || !SHA_PATTERN.test(head)) return refuse('handoff-target-invalid');

  const { resolveMergeHandoffOwner, repositoryKey } = await import('./mergeHandoffOwner.js');
  const owner = await resolveMergeHandoffOwner(agentId);
  if (owner.refused) return refuse(owner.refused);
  const { agent, task, repository } = owner;
  const prOrigin = { host: pr.host, fullName: `${pr.owner}/${pr.repo}` };
  if (repositoryKey(prOrigin) !== repository) return refuse('pr-repository-mismatch');
  const repoSpec = githubRepoSpec(prOrigin);
  if (!repoSpec) return refuse('forge-unsupported');

  const policy = resolvePrCompletion(task.metadata);
  if (agentPrHeldForOperator(agent, task)) {
    return refuse('completion-policy-leaves-open');
  }

  const app = await resolveHandoffApp(task, agent, repository, repositoryKey);
  if (!app) return refuse('pending-merge-app-unresolved');

  // Default ownership stays with the run. Operators opt in only after choosing
  // a queued-run threshold appropriate for their CI runner capacity.
  const threshold = app.mergeHandoffMinQueuedRuns;
  if (!Number.isSafeInteger(threshold) || threshold < 1) return refuse('ci-backlog-policy-disabled');

  const forgeExec = await resolveForgeExecOptions(app.repoPath, { forgeAccount: app.forgeAccount });
  const raw = await execGh([
    'pr', 'view', String(pr.number), '--repo', repoSpec,
    '--json', 'number,state,isDraft,isCrossRepository,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup',
  ], undefined, { cwd: forgeExec.cwd, env: forgeExec.env, backoffKey: repoSpec }).catch(() => null);
  const view = raw === null ? null : safeJSONParse(raw, null);
  if (!isPlainObject(view) || view.number !== pr.number) return refuse('pr-unreadable');
  if (String(view.state || '').toUpperCase() !== 'OPEN') return refuse('pr-not-open');
  if (view.isDraft !== false) return refuse('pr-draft');
  if (view.isCrossRepository !== false) return refuse('pr-cross-repository');
  if (typeof view.headRefName !== 'string' || !owner.owns(view.headRefName)) return refuse('pr-branch-not-owned');
  if (String(view.headRefOid || '').toLowerCase() !== head) return refuse('pr-head-moved');

  // A registered checkout outranks a request-named one; a claim run cuts its
  // own, so it names the path and the server verifies what is there.
  const workspace = owner.workspacePath || worktreePath;
  if (!workspace || !await checkoutAtHead(workspace, view.headRefName, head, repository, repositoryKey)) {
    return refuse('checkout-head-unverified');
  }
  const review = await readDeliveryReviewEvidence(workspace, prUrl);
  const roster = await followUpRoster(task, policy);
  if (!reviewEvidenceAccepted(review, head, policy, roster)) return refuse('review-evidence-incomplete');

  const checks = view.statusCheckRollup;
  const pending = new Set(['QUEUED', 'WAITING', 'REQUESTED', 'PENDING', 'EXPECTED']);
  const green = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const healthy = check => (!check?.conclusion || green.has(check.conclusion))
    && (pending.has(check?.status || check?.state) || check?.status === 'IN_PROGRESS' || green.has(check?.conclusion || check?.state));
  if (view.mergeable !== 'MERGEABLE' || !['', 'APPROVED'].includes(view.reviewDecision ?? '')
    || !Array.isArray(checks) || !checks.length || !checks.every(healthy)
    || !checks.some(check => pending.has(check?.status || check?.state))) return refuse('pr-not-waiting-on-healthy-ci');
  const { mergeHandoffSuccessorBlocked } = await import('./prWatcher.js');
  if (await mergeHandoffSuccessorBlocked()) return refuse('merge-successor-unavailable');

  // Read server-side evidence, never a caller's assertion that CI is busy.
  // Unknown/unsupported backlog keeps the original owner waiting.
  const backlogRaw = await execGh(['api', '--hostname', githubApiHost(pr.host),
    `repos/${pr.owner}/${pr.repo}/actions/runs?status=queued&per_page=1`], undefined,
  { cwd: forgeExec.cwd, env: forgeExec.env, backoffKey: repoSpec }).catch(() => null);
  const backlog = backlogRaw === null ? null : safeJSONParse(backlogRaw, null);
  if (!Number.isSafeInteger(backlog?.total_count) || backlog.total_count < 0
    || !Array.isArray(backlog.workflow_runs)) return refuse('ci-backlog-unreadable');
  if (backlog.total_count < threshold) return refuse('ci-backlog-below-threshold');
  const backlogEvidence = { queuedRuns: backlog.total_count, minimumQueuedRuns: threshold, observedAt: new Date().toISOString() };

  const receipt = {
    id: randomUUID(), appId: app.id, prUrl, prNumber: pr.number, headSha: head, repository,
    queuedAt: new Date().toISOString(),
  };
  const { queuePendingMerge, followUpHandoffReceipt } = await import('./prWatcher.js');
  const queued = await queuePendingMerge(app.id, {
    prUrl, prNumber: pr.number, prBranch: view.headRefName, sourceAgentId: agentId,
    sourceTask: {
      id: task.id || null,
      priority: task.priority || 'MEDIUM',
      description: task.description || 'CoS automated task',
      metadata: {
        app: app.id, provider: task.metadata?.provider, providerId: task.metadata?.providerId,
        model: task.metadata?.model, effort: task.metadata?.effort,
        reviewLoopFollowUp: isTruthyMeta(task.metadata?.reviewLoopFollowUp),
      },
    },
    handoff: {
      receiptId: receipt.id, agentId, startedAt: agent.startedAt, taskId: agent.taskId, repository,
      headSha: head, worktreePath: workspace, backlog: backlogEvidence, prCompletion: policy, reviewStatus: review.status ?? 'not-configured', acceptedAt: receipt.queuedAt,
    },
    followUp: roster,
  }).catch((err) => {
    console.error(`❌ Pending-merge handoff for PR #${pr.number} could not be persisted: ${err.message}`);
    return false;
  });
  if (!queued) return refuse('queue-write-failed');
  console.log(`🤝 PR #${pr.number} handed to the pending-merge coordinator at ${head.slice(0, 12)} by ${agentId}`);
  // Detached: the receipt must not wait on forge reads. One immediate pass
  // merges a head whose CI already settled; a still-pending entry gets the
  // bounded follow-up poll, and the 30-minute timer owns it after that.
  followUpHandoffReceipt(app.id, receipt.id);
  return { queued: true, receipt, coordination: {
    ownerTaskId: task.id, status: 'queued-for-merge',
    wake: 'immediate, then 1 minute for five polls, then 2 minutes for up to 45 minutes; 30-minute recovery sweep',
  } };
}

/**
 * Does the pending-merge queue hold a verified handoff of exactly this PR head?
 * Completion and cleanup read it as a pending end state (#12247): the branch is
 * the coordinator's until it merges or recovers. False on anything unreadable,
 * so a missed receipt degrades to the ordinary open-PR handling.
 *
 * @param {{ prUrl: string, prBranch: string, headSha: string }} target
 * @returns {Promise<boolean>}
 */
export async function hasQueuedMergeHandoff({ prUrl, prBranch, headSha }) {
  const head = String(headSha || '').toLowerCase();
  const target = prIdentity(prUrl);
  if (!target || !prBranch || !SHA_PATTERN.test(head)) return false;
  const [{ getActiveApps }, { readPendingMergePrs }] = await Promise.all([import('./apps.js'), import('./prWatcher.js')]);
  const apps = await getActiveApps().catch(() => []);
  return apps.some((app) => readPendingMergePrs(app).some((entry) => entry?.prBranch === prBranch
    && prIdentity(entry.prUrl) === target && isPlainObject(entry.handoff) && entry.handoff.headSha === head));
}

// Forge URLs differ in case and trailing segments; the PR they name does not.
function prIdentity(url) {
  const pr = parsePullRequestUrl(url);
  return pr ? `${pr.host}/${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase() : null;
}
