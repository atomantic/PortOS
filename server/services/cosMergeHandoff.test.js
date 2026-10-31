import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Agent → server pending-merge handoff (#12247), end to end through the real
// admission service and the real pr-watcher coordinator over synthetic stores.
const f = vi.hoisted(() => ({
  state: null, tasks: {}, apps: new Map(), checkouts: {}, pr: null, foreign: new Set(), reviewers: [], optionalReviewers: [], queueWriteFailure: false, delivery: null,
}));
vi.mock('../lib/localReviewLifecycle.js', () => ({ localReviewLifecycle: async (_cwd, { prUrl }) => f.delivery?.receipt?.prUrl === prUrl ? f.delivery : { reusable: false } }));
vi.mock('./cosState.js', async () => {
  const { createFileWriteQueue } = await import('../lib/fileWriteQueue.js');
  return {
    withStateLock: createFileWriteQueue(),
    loadState: async () => f.state,
    saveState: async (state) => { f.state = state; },
    readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(f.state) }),
  };
});
vi.mock('./cosTaskStore.js', () => ({
  addTask: vi.fn(async () => ({ id: 'cleanup-recovery' })),
  getTaskById: async (id) => f.tasks[id] ?? null,
}));
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: async (path) => ({ host: 'github.com', fullName: f.foreign.has(path) ? 'example/other' : 'example/repo' }),
}));
vi.mock('../lib/execGit.js', () => ({
  execGit: async (args, cwd) => {
    const checkout = f.checkouts[cwd];
    if (!checkout) throw new Error('not a git checkout');
    if (args[0] === 'symbolic-ref') return { stdout: `${checkout.branch}\n` };
    if (args.includes('--git-path')) return { stdout: `${join(cwd, 'portos-review-status')}\n` };
    if (args[0] === 'rev-parse') return { stdout: `${checkout.head}\n` };
    throw new Error(`unexpected git ${args.join(' ')}`);
  },
}));
const execGhMock = vi.fn();
vi.mock('./github.js', () => ({
  execGh: (...args) => execGhMock(...args),
  ensureForgeReachable: async () => ({ ok: true, status: 'ok' }),
}));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async (cwd) => ({ cwd, env: {} }) }));
vi.mock('./apps.js', () => ({
  getAppById: async (id) => f.apps.get(id) ?? null,
  getActiveApps: async () => [...f.apps.values()],
  updateApp: async (id, patch) => { if (f.queueWriteFailure) throw new Error('disk unavailable'); const next = { ...f.apps.get(id), ...patch }; f.apps.set(id, next); return next; },
}));
vi.mock('./untrustedContent.js', () => ({ screenUntrustedContent: async () => ({ ok: true, screening: { safe: true } }) }));
vi.mock('./codeReview.js', () => ({
  resolveReviewLoopOptions: async () => ({ reviewers: f.reviewers, usernames: [], optionalReviewers: f.optionalReviewers, reviewerMaxRounds: {} }),
}));
const mergePrMock = vi.fn();
vi.mock('./git.js', () => ({ mergePR: (...args) => mergePrMock(...args) }));
const notifyMock = vi.fn(async () => ({ id: 'notification-1' }));
vi.mock('./notifications.js', () => ({
  addNotification: (...args) => notifyMock(...args),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));
const followUpMock = vi.fn(async () => ({ id: 'follow-up-1' }));
vi.mock('./agentWorktreeCleanup.js', () => ({ spawnReviewLoopFollowUp: (...args) => followUpMock(...args) }));
const cleanupMock = vi.fn();
vi.mock('./heldCheckoutRecovery.js', () => ({ retirePendingMergeCheckout: (...args) => cleanupMock(...args) }));

import { handoffPendingMerge, hasQueuedMergeHandoff } from './cosMergeHandoff.js';
import { processPendingMergePrs, readPendingMergePrs, nudgeLocalPendingMergePrs } from './prWatcher.js';
import { addTask } from './cosTaskStore.js';

const HEAD = 'a'.repeat(40);
const PR_URL = 'https://github.com/example/repo/pull/7';
let workspace;

const claimAgent = (id, branch) => ({
  id, taskId: `task-${id}`, startedAt: '2026-01-01T00:00:00.000Z', status: 'running',
  metadata: { sourceWorkspace: '/repos/source', claimPicksOwnBranch: true, claimBranches: [branch] },
});
const handoff = (overrides = {}) => handoffPendingMerge({ agentId: 'agent-1', prUrl: PR_URL, headSha: HEAD, worktreePath: workspace, ...overrides });
const pending = () => readPendingMergePrs(f.apps.get('app1'));
// A receipt starts an immediate sweep; joining it keeps each test's forge reads
// ordered. Imported at call time: the restart case resets the module registry.
const handedOff = async (overrides) => {
  const result = await handoff(overrides);
  await (await import('./prWatcher.js'))._sweepPendingMergeApp('app1');
  return result;
};
const greenChecks = () => { f.pr.statusCheckRollup = [{ conclusion: 'SUCCESS' }]; };

beforeAll(async () => { workspace = await mkdtemp(join(tmpdir(), 'merge-handoff-')); });
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

beforeEach(async () => {
  (await import('./prWatcher.js')).cancelHandoffFollowUps();
  (await import('./prWatcher.js')).setHandoffFollowUpGate(async () => null);
  cleanupMock.mockReset().mockResolvedValue({ ok: true, branchDeleted: true, archiveDir: '/archives/example' });
  f.state = { agents: { 'agent-1': claimAgent('agent-1', 'claim/issue-1'), 'agent-2': claimAgent('agent-2', 'claim/issue-2') } };
  f.tasks = Object.fromEntries(['agent-1', 'agent-2'].map((id) => [`task-${id}`, {
    id: `task-${id}`, status: 'in_progress', taskType: 'user', priority: 'MEDIUM', description: 'Example change',
    metadata: { app: 'app1', prCompletion: 'review-then-merge' },
  }]));
  f.apps = new Map([['app1', { id: 'app1', repoPath: '/repos/source', forgeAccount: null, mergeHandoffMinQueuedRuns: 3 }]]);
  f.checkouts = { [workspace]: { branch: 'claim/issue-1', head: HEAD } };
  f.foreign = new Set();
  f.reviewers = ['codex'];
  f.optionalReviewers = [];
  f.queueWriteFailure = false;
  f.delivery = null;
  f.pr = {
    number: 7, title: 'Example change', body: 'Closes #101', author: { login: 'example-user' },
    commits: [{ messageHeadline: 'fix: example', messageBody: '' }], state: 'OPEN', isDraft: false,
    isCrossRepository: false, headRefName: 'claim/issue-1', headRefOid: HEAD,
    mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', statusCheckRollup: [{ status: 'QUEUED' }],
  };
  await writeFile(join(workspace, 'portos-review-status'), `REVIEW_STATUS=clean\nREVIEW_HEAD=${HEAD}\n`);
  execGhMock.mockReset().mockImplementation(async (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(f.pr);
    if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/example.js b/example.js\n+const ok = true;';
    if (args[0] === 'api' && args.some(arg => arg.includes('/actions/runs?'))) return JSON.stringify({ total_count: 3, workflow_runs: [{ status: 'queued' }] });
    if (args[0] === 'api') return JSON.stringify({ number: 101, state: 'open', title: 'Example', body: 'Example need', assignees: [] });
    throw new Error('unexpected forge read');
  });
  mergePrMock.mockReset().mockResolvedValue({ success: true });
  notifyMock.mockClear();
  followUpMock.mockClear();
  addTask.mockClear();
});

describe('pending-merge handoff', () => {
  it('keeps original ownership by default and when backlog is unknown or below the configured threshold', async () => {
    delete f.apps.get('app1').mergeHandoffMinQueuedRuns;
    expect(await handoff()).toMatchObject({ queued: false, reason: 'ci-backlog-policy-disabled' });
    f.apps.get('app1').mergeHandoffMinQueuedRuns = 3;
    const forge = execGhMock.getMockImplementation();
    for (const [backlog, reason] of [[{}, 'ci-backlog-unreadable'], [{ total_count: 2, workflow_runs: [] }, 'ci-backlog-below-threshold']]) {
      execGhMock.mockImplementation(async args => args.some(arg => arg.includes('/actions/runs?')) ? JSON.stringify(backlog) : forge(args));
      expect(await handoff()).toMatchObject({ queued: false, reason });
    }
    expect(pending()).toEqual([]);
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it.each([
    { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] },
    { statusCheckRollup: [] }, { mergeable: 'CONFLICTING' }, { reviewDecision: 'REVIEW_REQUIRED' },
  ])('refuses an unhealthy or unverified current PR despite a repository backlog: %j', async change => {
    Object.assign(f.pr, change);
    expect(await handoff()).toMatchObject({ queued: false, reason: 'pr-not-waiting-on-healthy-ci' });
    expect(pending()).toEqual([]);
  });

  it('requires an available successor and a successfully persisted receipt', async () => {
    const watcher = await import('./prWatcher.js');
    watcher.cancelHandoffFollowUps();
    expect(await handoff()).toMatchObject({ queued: false, reason: 'merge-successor-unavailable' });
    watcher.setHandoffFollowUpGate(async () => null);
    f.queueWriteFailure = true;
    expect(await handoff()).toMatchObject({ queued: false, reason: 'queue-write-failed' });
    expect(pending()).toEqual([]);
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it('does not run the immediate receipt pass while paused', async () => {
    const result = await handedOff();
    greenChecks();
    const watcher = await import('./prWatcher.js');
    watcher.setHandoffFollowUpGate(async () => 'paused');
    await watcher.followUpHandoffReceipt('app1', result.receipt.id);
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(pending()).toHaveLength(1);
  });

  it('an on-demand local nudge recovers the existing conflicted receipt once and preserves remote-only/locked receipts', async () => {
    await handedOff();
    f.tasks['task-agent-1'].status = 'completed';
    const original = pending()[0];
    const untouched = ['remote-only', 'locked'].map((kind, i) => ({ ...structuredClone(original), prNumber: 80 + i,
      prUrl: `https://github.com/example/repo/pull/${80 + i}`, prBranch: `claim/${kind}`,
      handoff: { ...original.handoff, receiptId: kind }, ticks: 9 }));
    f.apps.get('app1').pendingMergePrs.push(...untouched);
    f.pr.mergeStateStatus = 'DIRTY';
    const local = { getBranches: async () => [{ name: 'claim/issue-1' }, { name: 'claim/locked' }],
      listWorktrees: async () => [{ branch: 'refs/heads/claim/locked', locked: true }] };
    const results = await Promise.all([nudgeLocalPendingMergePrs('app1', local), nudgeLocalPendingMergePrs('app1', local)]);
    expect(results[0]).toMatchObject({ escalated: 1, checked: 1 });
    expect(followUpMock).toHaveBeenCalledTimes(1);
    expect(pending()).toEqual(untouched);
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(await nudgeLocalPendingMergePrs('app1', local)).toMatchObject({ checked: 0 });
    expect(followUpMock).toHaveBeenCalledTimes(1);
  });

  it('waits for an active original claim before dispatching CI failure recovery and transfers custody once', async () => {
    await handedOff();
    f.pr.statusCheckRollup = [{ conclusion: 'FAILURE' }];
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ waiting: 1, escalated: 0 });
    expect(followUpMock).not.toHaveBeenCalled();
    f.tasks['task-agent-1'].status = 'completed';
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ escalated: 1 });
    await processPendingMergePrs(f.apps.get('app1'));
    expect(followUpMock).toHaveBeenCalledTimes(1);
    expect(pending()).toEqual([]);
  });

  it('retains a closed unmerged PR instead of dispatching recovery from its stale failed CI', async () => {
    await handedOff();
    f.tasks['task-agent-1'].status = 'completed';
    f.pr.state = 'CLOSED';
    f.pr.statusCheckRollup = [{ conclusion: 'CANCELLED' }];
    await processPendingMergePrs(f.apps.get('app1'));
    expect(pending()[0].recoveryBlocked).toBe('pr-closed-unmerged');
    expect(followUpMock).not.toHaveBeenCalled();
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it('preserves custody through forge outages past the polling budget and recovers when it returns', async () => {
    await handedOff();
    const forge = execGhMock.getMockImplementation();
    execGhMock.mockImplementation(async args => args[0] === 'pr' && args[1] === 'view' ? null : forge(args));
    pending()[0].ticks = 11;
    await processPendingMergePrs(f.apps.get('app1'));
    expect(pending()[0].attention).toBe('forge-unreadable');
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('retains its pending-merge receipt and continues checking'),
    }));
    await processPendingMergePrs(f.apps.get('app1'));
    expect(notifyMock).toHaveBeenCalledTimes(1);
    execGhMock.mockImplementation(forge);
    greenChecks();
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ merged: 1 });
    expect(pending()).toEqual([]);
  });

  it('names a cleanup recovery owner for a retained merged checkout and confirms cleanup after it finishes', async () => {
    await handedOff();
    f.tasks['task-agent-1'].status = 'completed';
    cleanupMock.mockResolvedValue({ ok: false, reason: 'retirement-submodule-not-uninitialized' });
    greenChecks();
    await processPendingMergePrs(f.apps.get('app1'));
    f.pr.state = 'MERGED';
    pending()[0].cleanup.retryAt = 0;
    await processPendingMergePrs(f.apps.get('app1'));
    expect(pending()[0].cleanup.recoveryTaskId).toBe('cleanup-recovery');
    expect(addTask).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('Prepare retained checkout'),
      context: expect.stringContaining('Do not delete the checkout or refs yourself.'),
    }), 'user');
    f.tasks['cleanup-recovery'] = { id: 'cleanup-recovery', status: 'completed' };
    await processPendingMergePrs(f.apps.get('app1'));
    cleanupMock.mockResolvedValue({ ok: true, branchDeleted: true });
    await processPendingMergePrs(f.apps.get('app1'));
    expect(pending()).toEqual([]);
  });

  it.each(['retirement-submodule-not-uninitialized', 'active-owner'])(
    'holds an unresolved completed recovery after one final retirement attempt: %s', async reason => {
      await handedOff();
      f.tasks['task-agent-1'].status = 'completed';
      f.pr.state = 'MERGED';
      cleanupMock.mockResolvedValue({ ok: false, reason: 'retirement-submodule-not-uninitialized' });
      await processPendingMergePrs(f.apps.get('app1'));
      pending()[0].cleanup.retryAt = 0;
      await processPendingMergePrs(f.apps.get('app1'));
      expect(pending()[0].cleanup.recoveryTaskId).toBe('cleanup-recovery');

      f.tasks['cleanup-recovery'] = { id: 'cleanup-recovery', status: 'completed' };
      await processPendingMergePrs(f.apps.get('app1'));
      cleanupMock.mockResolvedValue({ ok: false, reason });
      await processPendingMergePrs(f.apps.get('app1'));
      expect(pending()[0].cleanup).toMatchObject({
        status: 'held', reason, recoveryTaskId: 'cleanup-recovery', recoveryCompleted: true,
      });

      // Completion is not proof of preservation. Later sweeps keep the same
      // owner and refusal, even when the final attempt found a transient reason.
      for (let sweep = 0; sweep < 2; sweep += 1) {
        pending()[0].cleanup.retryAt = 0;
        await processPendingMergePrs(f.apps.get('app1'));
      }
      expect(pending()).toHaveLength(1);
      expect(pending()[0].cleanup.status).toBe('held');
      expect(cleanupMock).toHaveBeenCalledTimes(2);
      expect(addTask).toHaveBeenCalledTimes(1);
      expect(mergePrMock).not.toHaveBeenCalled();
    },
  );

  it('persists the verified binding and merges only that head once a concurrent lease releases, across a restart', async () => {
    const result = await handedOff();
    expect(result).toMatchObject({ queued: true, receipt: { appId: 'app1', prNumber: 7, headSha: HEAD, repository: 'github.com/example/repo' } });
    expect(f.state.agents['agent-1'].metadata.mergeHandoffReceipts).toBeUndefined();
    // The receipt's immediate sweep found CI pending and spent no tick budget.
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(pending()).toEqual([expect.objectContaining({
      prBranch: 'claim/issue-1', sourceAgentId: 'agent-1', ticks: 0,
      handoff: expect.objectContaining({ receiptId: result.receipt.id, headSha: HEAD, prCompletion: 'review-then-merge', reviewStatus: 'clean' }),
    })]);

    greenChecks();

    // A fresh server process drives the persisted queue entry to a pinned merge.
    vi.resetModules();
    const restarted = await import('./prWatcher.js');
    expect(await restarted.processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ merged: 1 });
    expect(mergePrMock).toHaveBeenCalledWith('/repos/source', 7, { forgeAccount: null, expectedHeadSha: HEAD });
    expect(pending()).toEqual([]);
  });

  it.each([
    ['an unregistered caller', () => ({ agentId: 'ghost' }), 'handoff-owner-unverified'],
    ['another run\'s branch', () => { f.pr.headRefName = 'claim/issue-2'; }, 'pr-branch-not-owned'],
    ['a PR in another repository', () => ({ prUrl: 'https://github.com/example/other/pull/7' }), 'pr-repository-mismatch'],
    ['a head that moved after review', () => { f.pr.headRefOid = 'b'.repeat(40); }, 'pr-head-moved'],
    ['a checkout not at the handed-off head', () => { f.checkouts[workspace].head = 'c'.repeat(40); }, 'checkout-head-unverified'],
    ['a checkout of another repository', () => { f.foreign.add(workspace); }, 'checkout-head-unverified'],
    ['a draft PR', () => { f.pr.isDraft = true; }, 'pr-draft'],
    ['a leave-open policy', () => { f.tasks['task-agent-1'].metadata.prCompletion = 'leave-open'; }, 'completion-policy-leaves-open'],
    ['a JIRA human handoff', () => { f.tasks['task-agent-1'].metadata.jiraTicketId = 'EX-1'; }, 'completion-policy-leaves-open'],
    ['blocked review evidence', () => writeFile(join(workspace, 'portos-review-status'), 'REVIEW_STATUS=review-blocked\n'), 'review-evidence-incomplete'],
    ['a clean verdict for an earlier head', () => writeFile(join(workspace, 'portos-review-status'), `REVIEW_STATUS=clean\nREVIEW_HEAD=${'f'.repeat(40)}\n`), 'review-evidence-incomplete'],
    ['missing required review evidence', () => rm(join(workspace, 'portos-review-status')), 'review-evidence-incomplete'],
  ])('refuses %s and queues nothing', async (_name, arrange, reason) => {
    const overrides = await arrange();
    expect(await handoff(overrides || {})).toMatchObject({ queued: false, reason, retryable: false });
    expect(pending()).toEqual([]);
  });

  it('accepts original completed pre-PR evidence after feedback pushes only for the bound PR', async () => {
    const oldHead = 'f'.repeat(40);
    await writeFile(join(workspace, 'portos-review-status'), `REVIEW_STATUS=clean\nREVIEW_HEAD=${oldHead}\n`);
    f.delivery = { reusable: true, receipt: { status: 'clean', reviewedHead: oldHead, prUrl: PR_URL } };
    expect((await handoffPendingMerge({ agentId: 'agent-1', prUrl: PR_URL, headSha: HEAD, worktreePath: workspace })).queued).toBe(true);
  });

  it('queues an all-optional roster on a clean status without a REVIEW_HEAD, but not blocked or a required reviewer', async () => {
    f.optionalReviewers = ['codex'];
    await writeFile(join(workspace, 'portos-review-status'), 'REVIEW_STATUS=clean\n');
    expect(await handoff()).toMatchObject({ queued: true });

    await writeFile(join(workspace, 'portos-review-status'), 'REVIEW_STATUS=review-blocked\n');
    expect(await handoff()).toMatchObject({ queued: false, reason: 'review-evidence-incomplete' });

    f.optionalReviewers = [];
    await writeFile(join(workspace, 'portos-review-status'), 'REVIEW_STATUS=clean\n');
    expect(await handoff()).toMatchObject({ queued: false, reason: 'review-evidence-incomplete' });
  });

  it.each(['\n', '\r\n'])('queues current-head optional quota/no-verdict evidence without inventing a clean verdict (line ending %j)', async (newline) => {
    f.optionalReviewers = ['codex'];
    await writeFile(join(workspace, 'portos-review-status'), `REVIEW_STATUS=optional-inconclusive${newline}REVIEW_HEAD=${HEAD}${newline}`);
    expect(await handedOff()).toMatchObject({ queued: true });
    expect(pending()[0].handoff).toMatchObject({ reviewStatus: 'optional-inconclusive', headSha: HEAD });
    greenChecks();
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ merged: 1 });
    expect(mergePrMock).toHaveBeenCalledWith('/repos/source', 7, { forgeAccount: null, expectedHeadSha: HEAD });
  });

  it.each([[[]], [['codex', 'claude']]])('refuses optional inconclusive evidence without an all-optional nonempty roster: %j', async (reviewers) => {
    f.reviewers = reviewers;
    f.optionalReviewers = ['codex'];
    await writeFile(join(workspace, 'portos-review-status'), `REVIEW_STATUS=optional-inconclusive\nREVIEW_HEAD=${HEAD}\n`);
    expect(await handoff()).toMatchObject({ queued: false, reason: 'review-evidence-incomplete' });
    expect(pending()).toEqual([]);
  });

  it.each([
    ['a required reviewer', `REVIEW_STATUS=optional-inconclusive\nREVIEW_HEAD=${HEAD}\n`, false],
    ['an earlier attempted head', `REVIEW_STATUS=optional-inconclusive\nREVIEW_HEAD=${'f'.repeat(40)}\n`],
    ['no attempted head', 'REVIEW_STATUS=optional-inconclusive\n'],
    ['a malformed head', 'REVIEW_STATUS=optional-inconclusive\nREVIEW_HEAD=invalid\n'],
    ['an empty duplicate status', `REVIEW_STATUS=optional-inconclusive\nREVIEW_STATUS=\nREVIEW_HEAD=${HEAD}\n`],
    ['duplicate heads', `REVIEW_STATUS=optional-inconclusive\nREVIEW_HEAD=${HEAD}\nREVIEW_HEAD=${HEAD}\n`],
    ['duplicate statuses', `REVIEW_STATUS=optional-inconclusive\nREVIEW_STATUS=clean\nREVIEW_HEAD=${HEAD}\n`],
    ['pending review', `REVIEW_STATUS=pending\nREVIEW_HEAD=${HEAD}\n`],
    ['unresolved findings', `REVIEW_STATUS=findings\nREVIEW_HEAD=${HEAD}\n`],
    ['a required availability block', `REVIEW_STATUS=review-blocked\nREVIEW_HEAD=${HEAD}\n`],
    ['an unspecified inconclusive result', `REVIEW_STATUS=inconclusive\nREVIEW_HEAD=${HEAD}\n`],
    ['empty evidence', ''],
    ['missing evidence', null],
  ])('refuses optional handoff with %s', async (_name, evidence, optional = true) => {
    f.optionalReviewers = optional ? ['codex'] : [];
    if (evidence === null) await rm(join(workspace, 'portos-review-status'));
    else await writeFile(join(workspace, 'portos-review-status'), evidence);
    expect(await handoff()).toMatchObject({ queued: false, reason: 'review-evidence-incomplete' });
    expect(pending()).toEqual([]);
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it('keeps an already-green PR with its original owner for immediate merge', async () => {
    greenChecks();
    expect(await handoff()).toMatchObject({ queued: false, reason: 'pr-not-waiting-on-healthy-ci' });
    expect(pending()).toEqual([]);
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it.each(['leave-open', 'draft', 'readOnly', 'blocked'])('honors a live coordinator %s hold after CI turns green', async hold => {
    await handedOff();
    greenChecks();
    // Change the owner during the final contribution read, proving that a
    // policy snapshot taken before remote assessment cannot authorize merge.
    const read = execGhMock.getMockImplementation();
    execGhMock.mockImplementation(async (...args) => {
      if (args[0][0] === 'pr' && args[0][1] === 'diff') {
        const task = f.tasks['task-agent-1'];
        if (hold === 'blocked') task.status = 'blocked';
        else if (hold === 'readOnly') task.metadata.readOnly = true;
        else task.metadata.prCompletion = hold;
      }
      return read(...args);
    });
    await processPendingMergePrs(f.apps.get('app1'));
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(pending()[0].recoveryBlocked).toEqual(expect.any(String));
    await processPendingMergePrs(f.apps.get('app1'));
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(followUpMock).not.toHaveBeenCalled();
  });

  it('defers an unreadable coordinating task without losing its receipt or retry budget', async () => {
    await handedOff();
    greenChecks();
    const task = f.tasks['task-agent-1'];
    delete f.tasks['task-agent-1'];
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ waiting: 1, merged: 0 });
    expect(pending()[0]).toMatchObject({ ticks: 0 });
    expect(mergePrMock).not.toHaveBeenCalled();
    f.tasks['task-agent-1'] = task;
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ merged: 1 });
    expect(pending()).toEqual([]);
  });

  it('does not transfer a human-held original claim to a new recovery task after CI fails', async () => {
    await handedOff();
    f.tasks['task-agent-1'].metadata.prCompletion = 'leave-open';
    f.pr.statusCheckRollup = [{ conclusion: 'FAILURE' }];
    await processPendingMergePrs(f.apps.get('app1'));
    expect(followUpMock).not.toHaveBeenCalled();
    expect(pending()[0].recoveryBlocked).toEqual(expect.any(String));
    greenChecks();
    await processPendingMergePrs(f.apps.get('app1'));
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('keeps merged cleanup owned and bounded after an archival refusal', async () => {
    cleanupMock.mockResolvedValue({ ok: false, reason: 'retirement-forge-unreadable' });
    await handedOff();
    greenChecks();
    await processPendingMergePrs(f.apps.get('app1'));
    expect(pending()[0]).toMatchObject({ cleanup: { status: 'pending', attempts: 1, reason: 'retirement-forge-unreadable' } });
    f.pr.state = 'MERGED';
    await processPendingMergePrs(f.apps.get('app1'));
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    // A process restart retains the retry time and the exact cleanup target.
    vi.resetModules();
    await (await import('./prWatcher.js')).processPendingMergePrs(f.apps.get('app1'));
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    const app = f.apps.get('app1');
    app.pendingMergePrs[0].cleanup.retryAt = 0;
    cleanupMock.mockResolvedValue({ ok: true, branchDeleted: true, archiveDir: '/archives/example' });
    await (await import('./prWatcher.js')).processPendingMergePrs(app);
    expect(pending()).toEqual([]);
  });

  it.each(['pr-completion-human-handoff', 'retirement-submodule-not-uninitialized'])('holds merged cleanup requiring explicit recovery: %s', async reason => {
    cleanupMock.mockResolvedValue({ ok: false, reason });
    await handedOff();
    greenChecks();
    await processPendingMergePrs(f.apps.get('app1'));
    expect(pending()[0].cleanup).toMatchObject({ status: 'held', reason });
    f.pr.state = 'MERGED';
    pending()[0].cleanup.retryAt = 0;
    await processPendingMergePrs(f.apps.get('app1'));
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(pending()).toHaveLength(1);
  });

  it('rechecks the queue after an overlapping sweep that read it before the receipt', async () => {
    let releaseRead;
    const blocked = new Promise((resolve) => { releaseRead = resolve; });
    const other = { ...f.pr, number: 8, headRefName: 'cos/other', headRefOid: 'b'.repeat(40), statusCheckRollup: [{ status: 'IN_PROGRESS' }] };
    const forge = execGhMock.getMockImplementation();
    execGhMock.mockImplementation(async (args) => (args[0] === 'pr' && args[1] === 'view' && args[2] === '8'
      ? blocked.then(() => JSON.stringify(other)) : forge(args)));
    f.apps.set('app1', { ...f.apps.get('app1'), pendingMergePrs: [{
      prUrl: 'https://github.com/example/repo/pull/8', prNumber: 8, prBranch: 'cos/other', ticks: 0,
      sourceTask: { id: 'task-other', priority: 'MEDIUM', description: 'Other change', metadata: { app: 'app1' } },
    }] });

    // The live module instance, the one the handoff's receipt sweep joins.
    const timer = (await import('./prWatcher.js')).processPendingMergePrs(f.apps.get('app1'));
    expect(await handoff()).toMatchObject({ queued: true });
    greenChecks();
    releaseRead();
    await timer;
    await vi.waitFor(() => expect(mergePrMock).toHaveBeenCalledWith('/repos/source', 7, { forgeAccount: null, expectedHeadSha: HEAD }));
    expect(pending().map((entry) => entry.prNumber)).toEqual([8]);
  });

  it('reports a queued receipt only for the exact handed-off PR, branch and head', async () => {
    await handedOff();
    const target = { prUrl: 'https://GitHub.com/Example/Repo/pull/7', prBranch: 'claim/issue-1', headSha: HEAD.toUpperCase() };
    expect(await hasQueuedMergeHandoff(target)).toBe(true);
    expect(await hasQueuedMergeHandoff({ ...target, headSha: 'b'.repeat(40) })).toBe(false);
    expect(await hasQueuedMergeHandoff({ ...target, prBranch: 'claim/issue-2' })).toBe(false);
    expect(await hasQueuedMergeHandoff({ ...target, prUrl: 'https://github.com/example/other/pull/7' })).toBe(false);
  });

  it('accepts a merge-on-green run with no local reviewers', async () => {
    f.tasks['task-agent-1'].metadata.prCompletion = 'merge-on-green';
    await rm(join(workspace, 'portos-review-status'));
    expect(await handedOff()).toMatchObject({ queued: true });
    expect(pending()[0]).toMatchObject({ handoff: { reviewStatus: 'not-configured', prCompletion: 'merge-on-green' }, followUp: { reviewers: [] } });
  });

  it('invalidates a binding whose head moved and dispatches the recorded review policy instead of merging', async () => {
    await handedOff();
    f.tasks['task-agent-1'].status = 'completed';
    f.pr.headRefOid = 'd'.repeat(40);
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ merged: 0, escalated: 1, invalidated: 1 });
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(followUpMock).toHaveBeenCalledWith(expect.objectContaining({
      prUrl: PR_URL, prBranch: 'claim/issue-1', prCompletion: 'review-then-merge', reviewers: ['codex'],
    }));
    expect(pending()).toEqual([]);
  });

  it('withholds the merge when the head moves inside the admission window', async () => {
    await handedOff();
    greenChecks();
    const views = [{ ...f.pr }, { ...f.pr, headRefOid: 'e'.repeat(40) }];
    const forge = execGhMock.getMockImplementation();
    execGhMock.mockImplementation(async (args) => (args[0] === 'pr' && args[1] === 'view'
      ? JSON.stringify(views.length > 1 ? views.shift() : views[0]) : forge(args)));
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ merged: 0 });
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(pending()).toEqual([expect.objectContaining({ ticks: 1, handoff: expect.objectContaining({ headSha: HEAD }) })]);
  });

  it('keeps the head binding when an unbound duplicate is queued for the same PR', async () => {
    await handedOff();
    const { queuePendingMerge } = await import('./prWatcher.js');
    const { handoff: _binding, followUp: _roster, ...unbound } = pending()[0];
    expect(await queuePendingMerge('app1', unbound)).toBe(true);
    expect(pending()[0].handoff).toMatchObject({ headSha: HEAD });
  });

  it('never merges an unreadable binding and hands it to the operator', async () => {
    await handedOff();
    f.apps.set('app1', { ...f.apps.get('app1'), pendingMergePrs: [{ ...pending()[0], handoff: { headSha: 'not-a-sha' } }] });
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ merged: 0, invalidated: 1 });
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ link: PR_URL, priority: 'high' }));
    expect(pending()[0].recoveryBlocked).toBe('handoff-binding-unreadable');
  });
});

// A receipt whose CI is still running gets a bounded follow-up poll instead of
// waiting up to a whole 30-minute timer interval after CI turns green.
describe('handoff follow-up poll', () => {
  let gate;
  let prWatcher;
  // setImmediate stays real: it drains the poll's promise chain between ticks.
  const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
  const forgeViews = () => execGhMock.mock.calls.filter(([args]) => args[0] === 'pr' && args[1] === 'view').length;
  const minutes = (n) => vi.advanceTimersByTimeAsync(n * 60 * 1000).then(settle);

  // The coordinator's lazy imports load from disk, which a setImmediate drain
  // does not wait for; warm them so a fresh worker settles like a warm one.
  beforeAll(() => Promise.all(['./prReviewerSecurity.js', '../lib/validation.js'].map((m) => import(m))));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    prWatcher = await import('./prWatcher.js');
    gate = vi.fn(async () => null);
    prWatcher.setHandoffFollowUpGate(gate);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    prWatcher.cancelHandoffFollowUps();
    // Spies first: one captured under fake timers must not outlive them.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const handOffPending = async () => {
    const result = await handoff();
    await settle();
    return result;
  };

  it('polls a pending head, merges it once CI turns green, then stops', async () => {
    await handOffPending();
    expect(vi.getTimerCount()).toBe(1);
    expect(mergePrMock).not.toHaveBeenCalled();

    await minutes(prWatcher.HANDOFF_FOLLOW_UP_INTERVAL_MS / 60000);
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    greenChecks();
    await minutes(prWatcher.HANDOFF_FOLLOW_UP_INTERVAL_MS / 60000);
    expect(mergePrMock).toHaveBeenCalledWith('/repos/source', 7, { forgeAccount: null, expectedHeadSha: HEAD });
    expect(pending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('every handed-off entry settled'));
  });

  it('never arms when the immediate pass already merged', async () => {
    greenChecks();
    await handOffPending();
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('extends the active poller for a second receipt instead of arming another timer', async () => {
    const first = await handOffPending();
    const second = await handOffPending();
    expect(second.receipt.id).not.toBe(first.receipt.id);
    expect(vi.getTimerCount()).toBe(1);

    greenChecks();
    await minutes(prWatcher.HANDOFF_FOLLOW_UP_INTERVAL_MS / 60000);
    expect(mergePrMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off, spends no tick budget, and hands back to the timer sweep at the cap', async () => {
    await handOffPending();
    await minutes(prWatcher.HANDOFF_FOLLOW_UP_FAST_POLLS);
    const fastReads = forgeViews();
    await minutes(prWatcher.HANDOFF_FOLLOW_UP_BACKOFF_MS / 60000 / 2);
    expect(forgeViews()).toBe(fastReads);

    await minutes(prWatcher.HANDOFF_FOLLOW_UP_CAP_MS / 60000);
    expect(vi.getTimerCount()).toBe(0);
    expect(pending()).toEqual([expect.objectContaining({ ticks: 0 })]);
    // Handing back to the timer sweep at the cap is the designed bounded wait, not a fault: stdout.
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('the timer sweep owns 1 entry'));
    expect(console.warn).not.toHaveBeenCalled();
    const finalReads = forgeViews();
    await minutes(60);
    expect(forgeViews()).toBe(finalReads);
  });

  it('skips a poll the daemon gate blocks without reading the forge', async () => {
    await handOffPending();
    const reads = forgeViews();
    gate.mockResolvedValue('daemon paused');
    await minutes(prWatcher.HANDOFF_FOLLOW_UP_INTERVAL_MS / 60000);
    expect(forgeViews()).toBe(reads);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('skipped: daemon paused'));
    expect(console.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops when the daemon stops', async () => {
    const armed = await handOffPending();
    const reads = forgeViews();
    prWatcher.cancelHandoffFollowUps();
    expect(vi.getTimerCount()).toBe(0);
    await minutes(10);
    expect(forgeViews()).toBe(reads);

    // A receipt while the daemon is stopped leaves the entry to the timer sweep.
    await handOffPending();
    expect(vi.getTimerCount()).toBe(0);
    // Declining to arm is the designed handoff to the timer sweep: stdout, not stderr.
    await prWatcher.followUpHandoffReceipt('app1', armed.receipt.id);
    expect(vi.getTimerCount()).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('not armed: CoS daemon is stopped'));
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('owns a throwing poll and keeps polling', async () => {
    await handOffPending();
    const read = f.apps.get.bind(f.apps);
    f.apps.get = () => { throw new Error('apps store unreadable'); };
    await minutes(prWatcher.HANDOFF_FOLLOW_UP_INTERVAL_MS / 60000);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('apps store unreadable'));
    expect(vi.getTimerCount()).toBe(1);

    f.apps.get = read;
    greenChecks();
    await minutes(prWatcher.HANDOFF_FOLLOW_UP_INTERVAL_MS / 60000);
    expect(mergePrMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Both ends of the bounded wait hand the entry to the timer sweep: designed, so stdout.
  it('drops the poll without a fault when the gate reports the daemon stopped', async () => {
    await handOffPending();
    gate.mockResolvedValue('daemon-stopped');
    await minutes(prWatcher.HANDOFF_FOLLOW_UP_INTERVAL_MS / 60000);
    expect(vi.getTimerCount()).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('stopped: CoS daemon is stopped'));
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('hands a poll that keeps throwing back to the timer sweep at the cap, logging each throw as an error', async () => {
    await handOffPending();
    f.apps.get = () => { throw new Error('apps store unreadable'); };
    await minutes(prWatcher.HANDOFF_FOLLOW_UP_CAP_MS / 60000 + prWatcher.HANDOFF_FOLLOW_UP_BACKOFF_MS / 60000);
    expect(vi.getTimerCount()).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('apps store unreadable'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('reached its cap; the timer sweep owns its entries'));
    expect(console.warn).not.toHaveBeenCalled();
  });
});
