import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Agent → server pending-merge handoff (#12247), end to end through the real
// admission service and the real pr-watcher coordinator over synthetic stores.
const f = vi.hoisted(() => ({
  state: null, tasks: {}, apps: new Map(), checkouts: {}, pr: null, foreign: new Set(),
}));
vi.mock('./cosState.js', async () => {
  const { createFileWriteQueue } = await import('../lib/fileWriteQueue.js');
  return {
    withStateLock: createFileWriteQueue(),
    loadState: async () => f.state,
    saveState: async (state) => { f.state = state; },
    readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(f.state) }),
  };
});
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async (id) => f.tasks[id] ?? null }));
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
  updateApp: async (id, patch) => { const next = { ...f.apps.get(id), ...patch }; f.apps.set(id, next); return next; },
}));
vi.mock('./untrustedContent.js', () => ({ screenUntrustedContent: async () => ({ ok: true, screening: { safe: true } }) }));
vi.mock('./codeReview.js', () => ({
  resolveReviewLoopOptions: async () => ({ reviewers: ['codex'], usernames: [], optionalReviewers: [], reviewerMaxRounds: {} }),
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

import { handoffPendingMerge } from './cosMergeHandoff.js';
import { processPendingMergePrs, readPendingMergePrs } from './prWatcher.js';
import { claimMergeAdmission } from './cosMergeAdmission.js';

const HEAD = 'a'.repeat(40);
const PR_URL = 'https://github.com/example/repo/pull/7';
let workspace;

const claimAgent = (id, branch) => ({
  id, taskId: `task-${id}`, startedAt: '2026-01-01T00:00:00.000Z', status: 'running',
  metadata: { sourceWorkspace: '/repos/source', claimPicksOwnBranch: true, claimBranches: [branch] },
});
const handoff = (overrides = {}) => handoffPendingMerge({ agentId: 'agent-1', prUrl: PR_URL, headSha: HEAD, worktreePath: workspace, ...overrides });
const pending = () => readPendingMergePrs(f.apps.get('app1'));

beforeAll(async () => { workspace = await mkdtemp(join(tmpdir(), 'merge-handoff-')); });
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

beforeEach(async () => {
  f.state = { agents: { 'agent-1': claimAgent('agent-1', 'claim/issue-1'), 'agent-2': claimAgent('agent-2', 'claim/issue-2') }, mergeAdmissions: {} };
  f.tasks = Object.fromEntries(['agent-1', 'agent-2'].map((id) => [`task-${id}`, {
    id: `task-${id}`, status: 'in_progress', taskType: 'user', priority: 'MEDIUM', description: 'Example change',
    metadata: { app: 'app1', prCompletion: 'review-then-merge' },
  }]));
  f.apps = new Map([['app1', { id: 'app1', repoPath: '/repos/source', forgeAccount: null }]]);
  f.checkouts = { [workspace]: { branch: 'claim/issue-1', head: HEAD } };
  f.foreign = new Set();
  f.pr = {
    number: 7, title: 'Example change', body: 'Closes #101', author: { login: 'example-user' },
    commits: [{ messageHeadline: 'fix: example', messageBody: '' }], state: 'OPEN', isDraft: false,
    isCrossRepository: false, headRefName: 'claim/issue-1', headRefOid: HEAD,
    mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  };
  await writeFile(join(workspace, 'portos-review-status'), 'REVIEW_STATUS=clean\n');
  execGhMock.mockReset().mockImplementation(async (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(f.pr);
    if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/example.js b/example.js\n+const ok = true;';
    if (args[0] === 'api') return JSON.stringify({ number: 101, state: 'open', title: 'Example', body: 'Example need', assignees: [] });
    throw new Error('unexpected forge read');
  });
  mergePrMock.mockReset().mockResolvedValue({ success: true });
  notifyMock.mockClear();
  followUpMock.mockClear();
});

describe('pending-merge handoff', () => {
  it('persists the verified binding and merges only that head once a concurrent lease releases, across a restart', async () => {
    const result = await handoff();
    expect(result).toMatchObject({ queued: true, receipt: { appId: 'app1', prNumber: 7, headSha: HEAD, repository: 'github.com/example/repo' } });
    expect(pending()).toEqual([expect.objectContaining({
      prBranch: 'claim/issue-1', sourceAgentId: 'agent-1', ticks: 0,
      handoff: expect.objectContaining({ receiptId: result.receipt.id, headSha: HEAD, prCompletion: 'review-then-merge', reviewStatus: 'clean' }),
    })]);

    // Another run holds repository admission: the coordinator waits without
    // spending its budget and never merges around the lease.
    const lease = await claimMergeAdmission({ agentId: 'agent-2', action: 'acquire' });
    expect(lease.admitted).toBe(true);
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ waiting: 1, merged: 0 });
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(pending()[0].ticks).toBe(0);
    await claimMergeAdmission({ agentId: 'agent-2', action: 'release', token: lease.token, outcome: 'merged' });

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
    ['missing required review evidence', () => rm(join(workspace, 'portos-review-status')), 'review-evidence-incomplete'],
  ])('refuses %s and queues nothing', async (_name, arrange, reason) => {
    const overrides = await arrange();
    expect(await handoff(overrides || {})).toMatchObject({ queued: false, reason, retryable: false });
    expect(pending()).toEqual([]);
  });

  it('accepts a merge-on-green run with no local reviewers', async () => {
    f.tasks['task-agent-1'].metadata.prCompletion = 'merge-on-green';
    await rm(join(workspace, 'portos-review-status'));
    expect(await handoff()).toMatchObject({ queued: true });
    expect(pending()[0]).toMatchObject({ handoff: { reviewStatus: 'not-configured', prCompletion: 'merge-on-green' }, followUp: { reviewers: [] } });
  });

  it('invalidates a binding whose head moved and dispatches the recorded review policy instead of merging', async () => {
    await handoff();
    f.pr.headRefOid = 'd'.repeat(40);
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ merged: 0, escalated: 1, invalidated: 1 });
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(followUpMock).toHaveBeenCalledWith(expect.objectContaining({
      prUrl: PR_URL, prBranch: 'claim/issue-1', prCompletion: 'review-then-merge', reviewers: ['codex'],
    }));
    expect(pending()).toEqual([]);
  });

  it('withholds the merge when the head moves inside the admission window', async () => {
    await handoff();
    const views = [{ ...f.pr }, { ...f.pr, headRefOid: 'e'.repeat(40) }];
    const forge = execGhMock.getMockImplementation();
    execGhMock.mockImplementation(async (args) => (args[0] === 'pr' && args[1] === 'view'
      ? JSON.stringify(views.length > 1 ? views.shift() : views[0]) : forge(args)));
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ merged: 0 });
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(pending()).toEqual([expect.objectContaining({ ticks: 1, handoff: expect.objectContaining({ headSha: HEAD }) })]);
  });

  it('never merges an unreadable binding and hands it to the operator', async () => {
    await handoff();
    f.apps.set('app1', { ...f.apps.get('app1'), pendingMergePrs: [{ ...pending()[0], handoff: { headSha: 'not-a-sha' } }] });
    expect(await processPendingMergePrs(f.apps.get('app1'))).toMatchObject({ merged: 0, invalidated: 1 });
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ link: PR_URL, priority: 'high' }));
    expect(pending()).toEqual([]);
  });
});
