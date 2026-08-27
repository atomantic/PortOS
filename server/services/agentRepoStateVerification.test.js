/**
 * Tests for the post-completion repo-state audit.
 *
 * The failure this guards is the one the pure layer cannot see: cleanup returned
 * ZERO warnings, the completion path called the run a success, and the worktree
 * plus its branch are still on disk. Every case drives the real
 * `verifyAgentRepoState` against mocked git/forge answers and asserts what it
 * files — a recovery task, or deliberately nothing.
 *
 * The task-queue mocks return `getAllTasks`'s REAL `{user, cos}` shape via the
 * real `readAllTasksFlat`. An earlier revision mocked it as a bare array, which
 * hid a `tasks.some is not a function` throw that made the pending-owner escape
 * permanently false — the audit then filed a recovery task against every branch a
 * review-loop follow-up was queued to land.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./cos.js', () => ({
  addTask: vi.fn().mockResolvedValue({ id: 'task-recovery-1' }),
  getAllTasks: vi.fn().mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [] } }),
}));
vi.mock('./prWatcher.js', () => ({ readPendingMergePrs: vi.fn().mockReturnValue([]) }));
vi.mock('./worktreeManager.js', () => ({ listWorktrees: vi.fn().mockResolvedValue([]) }));
vi.mock('./branchReconcile.js', () => ({
  listRemoteHeads: vi.fn().mockResolvedValue(new Map()),
  driveToMerge: (pr) => `merge ${pr} from the repo root once CI is green`,
}));
vi.mock('./git.js', () => ({
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  isBranchMergedInto: vi.fn().mockResolvedValue(true),
  resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: null }),
}));
vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, detail: null }),
}));
vi.mock('./gitlab.js', () => ({
  findMergeRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, detail: null }),
}));
vi.mock('./apps.js', () => ({ getAppById: vi.fn().mockResolvedValue({ id: 'demo-app', name: 'Demo App' }) }));
vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({}),
  exists: vi.fn().mockResolvedValue(false),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));

import { verifyAgentRepoState, REPO_STATE_REMEDIATIONS } from './agentRepoStateVerification.js';
import { addTask, getAllTasks } from './cos.js';
import { listWorktrees } from './worktreeManager.js';
import { listRemoteHeads } from './branchReconcile.js';
import { isBranchMergedInto, resolveForgeForRepo } from './git.js';
import { findPullRequestForBranch } from './github.js';
import { findMergeRequestForBranch } from './gitlab.js';
import { getAppById } from './apps.js';
import { addNotification, exists as notificationExists } from './notifications.js';
import { readPendingMergePrs } from './prWatcher.js';
import { execGit } from '../lib/execGit.js';
import { existsSync } from 'fs';
import { REPO_STATE_ISSUES, REPO_STATE_SKIPS } from '../lib/repoStateExpectations.js';

const BRANCH = 'cos/task-x/agent-1';
const WORKTREE = '/repo/data/cos/worktrees/agent-1';

const agentState = (overrides = {}) => ({
  metadata: {
    isWorktree: true,
    sourceWorkspace: '/repo',
    worktreeBranch: BRANCH,
    workspacePath: WORKTREE,
    ...overrides,
  },
});

const task = (metadata = {}) => ({
  id: 'task-1',
  description: 'Do the thing',
  metadata: { app: 'demo-app', appName: 'Demo App', openPR: true, prCompletion: 'merge-on-green', ...metadata },
});

/** `git show-ref --verify refs/heads/<branch>` — exit 0 means the branch is present. */
const localBranch = (present) => execGit.mockResolvedValue({ exitCode: present ? 0 : 1, stdout: '', stderr: '' });

/** The `{user, cos}` shape `getAllTasks` really returns. Follow-ups land in `cos`. */
const queuedTasks = (tasks) => getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks } });

const run = (overrides = {}) => verifyAgentRepoState({
  agentId: 'agent-1',
  task: task(),
  agentState: agentState(),
  success: true,
  prExpected: true,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  listWorktrees.mockResolvedValue([]);
  listRemoteHeads.mockResolvedValue(new Map());
  existsSync.mockReturnValue(false);
  isBranchMergedInto.mockResolvedValue(true);
  queuedTasks([]);
  getAppById.mockResolvedValue({ id: 'demo-app', name: 'Demo App' });
  readPendingMergePrs.mockReturnValue([]);
  resolveForgeForRepo.mockResolvedValue({ cli: 'gh', env: null });
  findPullRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
  findMergeRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
  notificationExists.mockResolvedValue(false);
  addTask.mockResolvedValue({ id: 'task-recovery-1' });
  localBranch(false);
});

describe('verifyAgentRepoState — clean runs', () => {
  it('files nothing when the worktree, branch and PR all landed', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/pr/1', detail: 'MERGED' });

    const result = await run();

    expect(result.verified).toBe(true);
    expect(result.issues).toEqual([]);
    expect(addTask).not.toHaveBeenCalled();
    expect(addNotification).not.toHaveBeenCalled();
  });

  it('reads the PR state from the list call rather than a second forge round trip', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/pr/1', detail: 'merged' });
    const result = await run();
    expect(result.observed.prState).toBe('MERGED');
    expect(findPullRequestForBranch).toHaveBeenCalledTimes(1);
  });
});

describe('verifyAgentRepoState — divergent runs', () => {
  it('files ONE recovery task for a leftover worktree and branch after a merged PR', async () => {
    // The reported failure shape: the agent merged its own PR (branch gone on the
    // forge) but its local branch and worktree survived cleanup silently.
    existsSync.mockReturnValue(true);
    localBranch(true);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/pr/1', detail: 'MERGED' });

    const result = await run();

    expect(result.verified).toBe(false);
    expect(result.issues.map(i => i.code)).toEqual([
      REPO_STATE_ISSUES.WORKTREE_PRESENT,
      REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
    ]);
    expect(addTask).toHaveBeenCalledTimes(1);
    const [payload, kind] = addTask.mock.calls[0];
    expect(kind).toBe('user');
    expect(payload.description).toContain(BRANCH);
    expect(payload.isRecovery).toBe(true);
    expect(payload.app).toBe('demo-app');
    // The recovery agent must not run in a worktree of its own — it is cleaning
    // worktrees up.
    expect(payload.useWorktree).toBe(false);
    // Remediation must be actionable without re-diagnosing, and must forbid
    // deleting unmerged work or touching a sibling agent's branch.
    expect(payload.context).toContain(`git worktree remove ${WORKTREE}`);
    expect(payload.context).toContain(`git branch -d ${BRANCH}`);
    expect(payload.context).toContain(`touch ONLY ${BRANCH}`);
    expect(addNotification).toHaveBeenCalledTimes(1);
  });

  it('finds a worktree git still tracks even when the directory is gone', async () => {
    listWorktrees.mockResolvedValue([{ path: WORKTREE, branch: `refs/heads/${BRANCH}` }]);
    const result = await run({ prExpected: false });
    expect(result.issues.map(i => i.code)).toEqual([REPO_STATE_ISSUES.WORKTREE_PRESENT]);
  });

  it('reports an unmerged PR the agent left open', async () => {
    localBranch(true);
    isBranchMergedInto.mockResolvedValue(false);
    listRemoteHeads.mockResolvedValue(new Map([[BRANCH, 'abc123']]));
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/pr/9', detail: 'OPEN' });

    const result = await run();

    expect(result.issues.map(i => i.code)).toEqual([
      REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
      REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT,
      REPO_STATE_ISSUES.BRANCH_UNMERGED,
      REPO_STATE_ISSUES.PR_UNMERGED,
    ]);
    expect(addTask.mock.calls[0][0].context).toContain('https://example.com/pr/9');
  });

  it('does not re-file when a recovery task for the branch already exists', async () => {
    existsSync.mockReturnValue(true);
    addTask.mockResolvedValue({ id: 'task-recovery-1', duplicate: true });

    const result = await run({ prExpected: false });

    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.recoveryTaskId).toBeNull();
  });

  it('does not stack a second notification for a branch already flagged', async () => {
    existsSync.mockReturnValue(true);
    notificationExists.mockResolvedValue(true);

    await run({ prExpected: false });

    expect(notificationExists).toHaveBeenCalledWith('agent_warning', 'branchName', BRANCH);
    expect(addNotification).not.toHaveBeenCalled();
  });
});

describe('verifyAgentRepoState — never fires', () => {
  it('is off for an app with verifyRepoStateOnCompletion: false', async () => {
    getAppById.mockResolvedValue({ id: 'demo-app', verifyRepoStateOnCompletion: false });
    existsSync.mockReturnValue(true);

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.DISABLED);
    expect(addTask).not.toHaveBeenCalled();
    // The switch must short-circuit the probes too, not just the reporting.
    expect(listWorktrees).not.toHaveBeenCalled();
    expect(findPullRequestForBranch).not.toHaveBeenCalled();
  });

  it('leaves a FAILED run alone so its retry can resume from the preserved branch', async () => {
    existsSync.mockReturnValue(true);
    const result = await run({ success: false });
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FAILED_RUN);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('defers while a review-loop follow-up still owns the branch', async () => {
    queuedTasks([{ status: 'pending', metadata: { reviewLoopFollowUp: true, reviewLoopPRBranch: BRANCH } }]);
    existsSync.mockReturnValue(true);

    const result = await run({ task: task({ prCompletion: 'review-then-merge' }) });

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('defers while a retry holds the branch as its resume pointer', async () => {
    queuedTasks([{ status: 'pending', metadata: { existingBranch: BRANCH } }]);
    existsSync.mockReturnValue(true);
    const result = await run();
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
  });

  it('defers while pr-watcher still holds the PR for a deterministic merge', async () => {
    // The merge-on-green GitHub path never spawns a follow-up TASK — it queues the
    // PR on the app record for the next watcher tick. Reading only the task queue
    // would call every one of those branches leaked.
    readPendingMergePrs.mockReturnValue([{ prBranch: BRANCH, prUrl: 'https://example.com/pr/2' }]);
    existsSync.mockReturnValue(true);

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('stands down when cleanup already raised a warning (it files its own recovery)', async () => {
    const result = await run({
      cleanupWarnings: ['Auto-merge failed for branch cos/task-x/agent-1 — branch preserved for manual recovery'],
    });
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.CLEANUP_WARNED);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('ignores a non-worktree run without reading the app record', async () => {
    const result = await run({ agentState: agentState({ isWorktree: false }) });
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.NOT_WORKTREE);
    expect(getAppById).not.toHaveBeenCalled();
    expect(getAllTasks).not.toHaveBeenCalled();
  });

  it('reports probe-incomplete, not "clean", when git could not be asked at all', async () => {
    // A firewalled host must not manufacture a recovery agent per run — and must
    // not be logged as a verified-clean repo either.
    listWorktrees.mockRejectedValue(new Error('not a git repository'));
    execGit.mockRejectedValue(new Error('git unavailable'));
    listRemoteHeads.mockResolvedValue(null);
    findPullRequestForBranch.mockResolvedValue({ status: 'unavailable', url: null, detail: null });

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.PROBE_INCOMPLETE);
    expect(result.verified).toBe(false);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('reports probe-incomplete when only SOME probes were unreadable', async () => {
    // The partial case is the dangerous one: worktree and branch both read clean,
    // so nothing diverged — but the forge never answered, so the PR could be
    // sitting open. Calling that "verified" is the absent-vs-empty conflation.
    findPullRequestForBranch.mockResolvedValue({ status: 'unavailable', url: null, detail: null });

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.PROBE_INCOMPLETE);
    expect(result.observed.unreadable).toContain('pull-request');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('still reports a divergence it COULD read alongside one it could not', async () => {
    // Partial knowledge does not suppress a finding — what was readable is fact.
    existsSync.mockReturnValue(true);
    findPullRequestForBranch.mockResolvedValue({ status: 'unavailable', url: null, detail: null });

    const result = await run();

    expect(result.issues.map(i => i.code)).toContain(REPO_STATE_ISSUES.WORKTREE_PRESENT);
    expect(addTask).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the app record cannot be read', async () => {
    // A transient apps.json failure must not override an explicit per-app opt-out.
    getAppById.mockRejectedValue(new Error('apps.json unreadable'));
    existsSync.mockReturnValue(true);

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.GATE_UNREADABLE);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('fails closed when the task queue cannot be read', async () => {
    // "Could not read the queue" must never become "nobody owns this branch" — a
    // follow-up queued to land it would get a recovery task filed against it.
    getAllTasks.mockRejectedValue(new Error('tasks file unreadable'));
    existsSync.mockReturnValue(true);

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.GATE_UNREADABLE);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('defers while a CHALLENGED task still holds the branch', async () => {
    // `challenged` is a parked-for-dispute status, not a terminal one: the task
    // keeps its branch and resumes on it.
    queuedTasks([{ status: 'challenged', metadata: { existingBranch: BRANCH } }]);
    existsSync.mockReturnValue(true);

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('reports an unmerged GitLab merge request', async () => {
    // GitLab is probed too — leaving it unasked would silently pass an open MR as
    // a clean repo. States come back lowercase from glab.
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab', env: null });
    findMergeRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://gitlab.example.com/mr/4', number: 4, detail: 'opened' });

    const result = await run();

    expect(findPullRequestForBranch).not.toHaveBeenCalled();
    expect(result.issues.map(i => i.code)).toEqual([REPO_STATE_ISSUES.PR_UNMERGED]);
    // The remediation must speak glab — a `gh pr merge` line is unrunnable there.
    // The real IID, not a `<iid>` placeholder the recovery agent cannot run.
    expect(addTask.mock.calls[0][0].context).toContain('glab mr merge 4 --yes --remove-source-branch');
    expect(addTask.mock.calls[0][0].context).not.toContain('gh pr merge');
  });

  it('does not claim unmerged work when the merge check could not be answered', async () => {
    // `isBranchMergedInto` fails CLOSED (`false`, not a throw) when it cannot read
    // a ref — right for its original caller, inverted into a false finding here.
    // An unresolvable ref must read as unknown, not as "carries unmerged commits".
    execGit.mockImplementation((args) => {
      if (args[0] === 'show-ref') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      // rev-parse --verify fails => the ref could not be resolved
      return Promise.resolve({ exitCode: 128, stdout: '', stderr: 'bad revision' });
    });
    isBranchMergedInto.mockResolvedValue(false);

    const result = await run({ prExpected: false });

    expect(isBranchMergedInto).not.toHaveBeenCalled();
    expect(result.observed.branchMerged).toBeNull();
    expect(result.issues.map(i => i.code)).not.toContain(REPO_STATE_ISSUES.BRANCH_UNMERGED);
    expect(result.observed.unreadable).toContain('branch-merged');
  });

  it('does not report a MERGED GitLab merge request', async () => {
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab', env: null });
    findMergeRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://gitlab.example.com/mr/4', detail: 'merged' });
    const result = await run();
    expect(result.verified).toBe(true);
  });
});

describe('remediation coverage', () => {
  it('has a remediation for every issue code', () => {
    // The map is what makes "a new check must say what to do about it" real — the
    // switch-with-default it replaced silently accepted a new code.
    expect(Object.keys(REPO_STATE_REMEDIATIONS).sort()).toEqual(Object.values(REPO_STATE_ISSUES).sort());
  });

  it('renders each remediation from the branch, worktree and PR in hand', () => {
    const ctx = { branchName: BRANCH, base: 'main', prUrl: 'https://example.com/pr/1', worktreePath: WORKTREE };
    for (const [code, render] of Object.entries(REPO_STATE_REMEDIATIONS)) {
      const text = render(ctx);
      expect(text, code).toBeTypeOf('string');
      expect(text.length, code).toBeGreaterThan(20);
    }
  });
});
