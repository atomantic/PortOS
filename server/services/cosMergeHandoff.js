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
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execGh } from './github.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { githubRepoSpec } from '../lib/workTracker.js';
import { execGit } from '../lib/execGit.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { PR_COMPLETIONS, leavesPrForHuman, resolvePrCompletion } from '../lib/prDisposition.js';

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

// The worktree-private status the review phase writes: `REVIEW_STATUS=<verdict>`
// plus `REVIEW_HEAD=<sha>`, the commit its final round reviewed. status null =
// no file (no local reviewers ran); 'unreadable' covers an unreadable or empty file.
async function readReviewEvidence(workspace) {
  const gitPath = await execGit(['rev-parse', '--git-path', 'portos-review-status'], workspace).catch(() => null);
  const relative = gitPath?.stdout?.trim();
  if (!relative) return { status: 'unreadable', head: null };
  const content = await readFile(resolve(workspace, relative), 'utf-8').catch((err) => (err.code === 'ENOENT' ? null : undefined));
  if (content === null) return { status: null, head: null };
  const values = (pattern) => [...String(content ?? '').matchAll(pattern)].map((m) => m[1]);
  const statuses = values(/^REVIEW_STATUS=(\S+)\s*$/gm);
  const heads = values(/^REVIEW_HEAD=(\S+)\s*$/gm);
  return {
    status: statuses.length === 0 ? 'unreadable' : statuses.find((status) => status !== 'clean') ?? 'clean',
    head: heads.length === 1 ? heads[0].toLowerCase() : null,
  };
}

// A clean verdict counts only for the head it reviewed; merge-on-green runs no
// reviewers, so there only a recorded block or unreadable status refuses.
function reviewEvidenceAccepted({ status, head: reviewedHead }, head, policy) {
  if (policy === PR_COMPLETIONS.MERGE_ON_GREEN) return status === null || status === 'clean';
  return status === 'clean' && reviewedHead === head;
}

async function followUpRoster(task, policy) {
  if (policy !== PR_COMPLETIONS.REVIEW_THEN_MERGE) return { reviewers: [], usernames: [], optionalReviewers: [], reviewerMaxRounds: {} };
  const [{ resolveReviewLoopOptions }, { normalizeReviewers }] = await Promise.all([
    import('./codeReview.js'), import('../lib/validation.js'),
  ]);
  const options = await resolveReviewLoopOptions(task.metadata, { normalize: normalizeReviewers });
  return {
    reviewers: options.reviewers, usernames: options.usernames,
    optionalReviewers: options.optionalReviewers, reviewerMaxRounds: options.reviewerMaxRounds,
  };
}

/**
 * @param {{ agentId: string, prUrl: string, headSha: string, worktreePath?: string }} input
 * @returns {Promise<{ queued: true, receipt: object }|{ queued: false, reason: string, retryable: boolean }>}
 */
export async function handoffPendingMerge({ agentId, prUrl, headSha, worktreePath = null }) {
  const head = String(headSha || '').toLowerCase();
  const pr = parsePullRequestUrl(prUrl);
  if (!pr || !SHA_PATTERN.test(head)) return refuse('handoff-target-invalid');

  const { resolveMergeHandoffOwner, repositoryKey } = await import('./cosMergeAdmission.js');
  const owner = await resolveMergeHandoffOwner(agentId);
  if (owner.refused) return refuse(owner.refused);
  const { agent, task, repository } = owner;
  const prOrigin = { host: pr.host, fullName: `${pr.owner}/${pr.repo}` };
  if (repositoryKey(prOrigin) !== repository) return refuse('pr-repository-mismatch');
  const repoSpec = githubRepoSpec(prOrigin);
  if (!repoSpec) return refuse('forge-unsupported');

  const policy = resolvePrCompletion(task.metadata);
  if (policy === PR_COMPLETIONS.LEAVE_OPEN || agent.metadata?.prCompletionPolicy === PR_COMPLETIONS.LEAVE_OPEN
    || leavesPrForHuman(task) || isTruthyMeta(task.metadata?.reviewLoopLeaveOpen) || isTruthyMeta(task.metadata?.readOnly)) {
    return refuse('completion-policy-leaves-open');
  }

  const app = await resolveHandoffApp(task, agent, repository, repositoryKey);
  if (!app) return refuse('pending-merge-app-unresolved');

  const forgeExec = await resolveForgeExecOptions(app.repoPath, { forgeAccount: app.forgeAccount });
  const raw = await execGh([
    'pr', 'view', String(pr.number), '--repo', repoSpec,
    '--json', 'number,state,isDraft,isCrossRepository,headRefName,headRefOid',
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
  const review = await readReviewEvidence(workspace);
  if (!reviewEvidenceAccepted(review, head, policy)) return refuse('review-evidence-incomplete');

  const receipt = {
    id: randomUUID(), appId: app.id, prUrl, prNumber: pr.number, headSha: head, repository,
    queuedAt: new Date().toISOString(),
  };
  const { queuePendingMerge } = await import('./prWatcher.js');
  const queued = await queuePendingMerge(app.id, {
    prUrl, prNumber: pr.number, prBranch: view.headRefName, sourceAgentId: agentId,
    sourceTask: {
      id: task.id || null,
      priority: task.priority || 'MEDIUM',
      description: task.description || 'CoS automated task',
      metadata: {
        app: app.id, provider: task.metadata?.provider, providerId: task.metadata?.providerId,
        model: task.metadata?.model, effort: task.metadata?.effort,
      },
    },
    handoff: {
      receiptId: receipt.id, agentId, startedAt: agent.startedAt, taskId: agent.taskId, repository,
      headSha: head, prCompletion: policy, reviewStatus: review.status ?? 'not-configured', acceptedAt: receipt.queuedAt,
    },
    followUp: await followUpRoster(task, policy),
  }).catch((err) => {
    console.error(`❌ Pending-merge handoff for PR #${pr.number} could not be persisted: ${err.message}`);
    return false;
  });
  if (!queued) return refuse('queue-write-failed');
  console.log(`🤝 PR #${pr.number} handed to the pending-merge coordinator at ${head.slice(0, 12)} by ${agentId}`);
  return { queued: true, receipt };
}
