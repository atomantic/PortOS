import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const f = vi.hoisted(() => ({ agents: [], tasks: {}, queue: [], live: [], pr: {}, head: '', dirty: '', roster: {}, pending: [], hold: null, duringForge: null }));
vi.mock('./branchCompletionPolicy.js', () => ({
  readBranchCompletionPolicies: async () => f.agents,
  readBranchCompletionHold: async () => f.hold,
}));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async id => f.tasks[id], getTaskView: async () => ({ user: { tasks: [] }, cos: { tasks: f.queue } }) }));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: async () => f.live }));
vi.mock('./mergeHandoffOwner.js', () => ({ repositoryKey: origin => origin ? `${origin.host}/${origin.fullName}`.toLowerCase() : null }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ host: 'github.com', fullName: 'example/repo' }) }));
vi.mock('../lib/execGit.js', () => ({ execGit: async (args, cwd) => ({ stdout: args.includes('--git-path') ? join(cwd, 'review-status')
  : args[0] === 'symbolic-ref' ? 'feature' : args[0] === 'status' ? f.dirty : f.head }) }));
vi.mock('./github.js', () => ({ execGh: async () => { f.duringForge?.(); return JSON.stringify(f.pr); } }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async cwd => ({ cwd, env: {} }) }));
vi.mock('./apps.js', () => ({ getAppById: async () => ({ id: 'app', repoPath: '/repo' }), getActiveApps: async () => [{ id: 'app', repoPath: '/repo' }] }));
vi.mock('./prWatcher.js', () => ({ readPendingMergePrs: () => f.pending }));
vi.mock('./codeReview.js', () => ({ resolveReviewLoopOptions: async () => f.roster }));
import { inspectCompletedOwnerReview, validateCleanupReviewTarget } from './cosMergeHandoff.js';
const head = 'a'.repeat(40);
const prUrl = 'https://github.com/example/repo/pull/7';
let workspace;
const inspect = overrides => inspectCompletedOwnerReview({ repoPath: '/repo', branch: 'feature', prUrl, headSha: head, worktreePath: workspace, ...overrides });
beforeAll(async () => { workspace = await mkdtemp(join(tmpdir(), 'completed-review-')); });
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });
beforeEach(async () => {
  f.agents = [{ id: 'owner', taskId: 'task', status: 'completed', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T01:00:00Z',
    metadata: { sourceWorkspace: '/repo', workspacePath: workspace, worktreeBranch: 'feature', prCompletionPolicy: 'review-then-merge' } }];
  f.tasks = { task: { id: 'task', status: 'completed', metadata: { app: 'app', prCompletion: 'review-then-merge' } } };
  f.duringForge = null; f.queue = []; f.live = []; f.pending = []; f.head = head; f.dirty = ''; f.hold = 'pr-completion-review-required';
  f.roster = { reviewers: ['codex'], optionalReviewers: [], usernames: [], reviewerMaxRounds: {}, reviewerModels: { codex: 'pinned' } };
  f.pr = { number: 7, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefName: 'feature', headRefOid: head };
  await rm(join(workspace, 'review-status'), { force: true });
});
describe('completed owner required review inspection', () => {
  it('keeps another instance owner separate even for the same repository branch and PR head', async () => {
    const foreign = structuredClone(f.agents[0]);
    foreign.id = 'other-instance-owner';
    foreign.metadata.sourceWorkspace = '/other-instance/repo';
    foreign.metadata.workspacePath = '/other-instance/worktree';
    f.agents.push(foreign);
    expect(await inspect()).toMatchObject({ disposition: 'review-required', agentId: 'owner' });
    f.agents = [foreign];
    expect(await inspect()).toMatchObject({ disposition: 'held', reason: 'review-owner-ambiguous' });
    expect(f.queue).toEqual([]);
    expect(f.pending).toEqual([]);
  });

  it('establishes a missing nonoptional review without creating merge admission or changing backlog policy', async () => {
    const result = await inspect();
    expect(result).toMatchObject({ disposition: 'review-required', agentId: 'owner', originalTask: { id: 'task' },
      roster: { reviewers: ['codex'], reviewerModels: { codex: 'pinned' } }, reviewTarget: { ownerId: 'owner', headSha: head, worktreePath: workspace } });
    expect(f.pending).toEqual([]);
    await writeFile(join(workspace, 'review-status'), `REVIEW_STATUS=clean\nREVIEW_HEAD=${head}\n`);
    expect(await inspect()).toMatchObject({ disposition: 'held', reason: 'review-recorded-handoff-missing' });
  });
  it('uses an exact claim branch binding when its completed swarm parent registered the source checkout', async () => {
    f.agents[0].metadata = { ...f.agents[0].metadata, workspacePath: '/repo', worktreeBranch: undefined, claimPicksOwnBranch: true, claimBranches: ['feature'] };
    expect(await inspect()).toMatchObject({ disposition: 'review-required', agentId: 'owner' });
    f.agents[0].metadata.claimBranches = ['another-branch'];
    expect((await inspect()).reason).toBe('review-owner-ambiguous');
  });
  it('does not turn optional or disabled reviews into a new code review', async () => {
    f.roster.optionalReviewers = ['codex'];
    expect(await inspect()).toMatchObject({ disposition: 'held', reason: 'review-required-roster-unproven' });
    f.tasks.task.metadata.prCompletion = 'merge-on-green'; f.hold = null;
    expect(await inspect()).toMatchObject({ disposition: 'held', reason: 'review-not-required', reviewTarget: { headSha: head } });
  });
  it('waits for a username-only reviewer and resumes only on a review of the bound head', async () => {
    f.roster = { reviewers: [], optionalReviewers: [], usernames: ['Alice'], reviewerMaxRounds: {} };
    const review = (over) => ({ author: { login: 'alice' }, state: 'COMMENTED', commit: { oid: head }, ...over });
    expect(await inspect()).toMatchObject({ disposition: 'held', reason: 'review-forge-unreadable' });
    for (const reviews of [[], [review({ commit: { oid: 'b'.repeat(40) } })], [review({ author: { login: 'mallory' } })],
      [review({ state: 'PENDING' })], [review({ state: 'DISMISSED' })]]) {
      f.pr = { ...f.pr, reviews };
      expect(await inspect()).toMatchObject({ disposition: 'held', reason: 'awaiting-forge-review' });
    }
    f.pr = { ...f.pr, reviews: [review()] };
    expect(await inspect()).toMatchObject({ disposition: 'review-required', reason: 'forge-review-submitted', agentId: 'owner',
      roster: { usernames: ['Alice'] }, reviewTarget: { headSha: head } });
    f.roster.optionalReviewers = ['@alice'];
    expect(await inspect()).toMatchObject({ disposition: 'held', reason: 'review-required-roster-unproven' });
  });
  it('preserves ambiguous owners, live holders, task holds and draft PRs', async () => {
    f.agents.push({ ...f.agents[0], id: 'second' });
    expect((await inspect()).reason).toBe('review-owner-ambiguous'); f.agents.pop();
    f.live = [{ id: 'active', status: 'running', workspacePath: workspace }];
    expect((await inspect()).reason).toBe('claim-owner-active'); f.live = [];
    f.agents[0].metadata.prCompletionPolicy = 'leave-open';
    expect((await inspect()).reason).toBe('review-policy-held'); f.agents[0].metadata.prCompletionPolicy = 'review-then-merge';
    f.tasks.task.metadata.prCompletion = 'leave-open';
    expect((await inspect()).reason).toBe('review-policy-held'); f.tasks.task.metadata.prCompletion = 'review-then-merge';
    f.pr.isDraft = true;
    expect((await inspect()).reason).toBe('review-pr-held');
  });
  it('rejects moved heads, dirty contents and unreadable review status', async () => {
    f.pr.headRefOid = 'b'.repeat(40);
    expect((await inspect()).reason).toBe('review-head-moved'); f.pr.headRefOid = head;
    f.dirty = '?? retained.txt';
    expect((await inspect()).reason).toBe('review-checkout-dirty'); f.dirty = '';
    await writeFile(join(workspace, 'review-status'), 'not a review');
    expect((await inspect()).reason).toBe('review-evidence-unreadable');
  });
  it('joins an exact persisted successor after an interrupted acknowledgement without adopting an unrelated task', async () => {
    const { reviewTarget } = await inspect();
    f.queue = [{ id: 'review', status: 'pending', metadata: { cleanupReviewTarget: reviewTarget } }];
    expect(await inspect()).toMatchObject({ disposition: 'join-existing', taskId: 'review', agentId: 'owner' });
    f.queue[0].metadata.cleanupReviewTarget = { ...reviewTarget, headSha: 'b'.repeat(40) };
    expect(await inspect()).toEqual({ disposition: 'held', reason: 'review-successor-exists' });
  });
  it('rechecks queued successor policy and target after slow workspace preparation', async () => {
    const { reviewTarget } = await inspect();
    f.tasks.review = { id: 'review', status: 'pending', metadata: { cleanupReviewTarget: reviewTarget, prCompletion: 'review-then-merge' } };
    const input = { target: reviewTarget, workspacePath: workspace, launchTaskId: 'review' };
    expect(await validateCleanupReviewTarget(input)).toBeNull();
    f.duringForge = () => { f.tasks.review.metadata.readOnly = true; };
    expect(await validateCleanupReviewTarget(input)).toBe('review-launch-task-changed');
    f.duringForge = null;
    f.tasks.review.metadata.readOnly = false;
    f.tasks.review.metadata.cleanupReviewTarget = { ...reviewTarget, headSha: 'b'.repeat(40) };
    expect(await validateCleanupReviewTarget(input)).toBe('review-launch-task-changed');
  });
  it('joins an existing exact-head handoff and preserves current task policy at launch', async () => {
    const { reviewTarget } = await inspect();
    f.pending = [{ prUrl, prBranch: 'feature', handoff: { headSha: head, agentId: 'owner', taskId: 'task', startedAt: f.agents[0].startedAt, repository: 'github.com/example/repo', receiptId: 'receipt' } }];
    expect(await inspect()).toMatchObject({ disposition: 'join-existing', appId: 'app' });
    f.tasks.task.metadata.readOnly = true;
    expect(await validateCleanupReviewTarget({ target: reviewTarget, workspacePath: workspace })).toBe('review-policy-held');
  });
});
