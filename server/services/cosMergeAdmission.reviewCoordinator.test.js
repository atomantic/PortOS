import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { generateTasksMarkdown, parseTasksMarkdown } from '../lib/taskParser.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';

const f = vi.hoisted(() => ({ state: null, disk: null, tasks: {}, branch: 'feature/fix', workspaceRepo: 'example/repo' }));
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: '/synthetic/agents',
  withStateLock: createFileWriteQueue(),
  loadState: async () => f.state,
  saveState: async state => { f.state = state; f.disk = structuredClone(state); },
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(f.disk) }),
}));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./cos.js', () => ({
  addTask: async task => { f.tasks[task.id] = { ...parseTasksMarkdown(generateTasksMarkdown([task]))[0], taskType: 'internal' }; return task; },
  forceSpawnTask: vi.fn(), getAgents: async () => [], updateTask: vi.fn(),
}));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async id => f.tasks[id] }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async path => ({ host: 'github.com', fullName: path === '/repos/worktree' ? f.workspaceRepo : 'example/repo' }) }));
vi.mock('../lib/execGit.js', () => ({ execGit: async () => ({ stdout: f.branch, exitCode: 0 }) }));
vi.mock('./git.js', () => ({ parsePullRequestUrl }));
vi.mock('./worktreeManager.js', () => ({ removeWorktree: vi.fn(), classifyWorktreeDirt: vi.fn(), listWorktrees: vi.fn() }));
import { spawnReviewLoopFollowUp } from './agentWorktreeCleanup.js';
import { buildAgentRegistration } from '../lib/agentRegistrationRecord.js';
import { registerAgent } from './cosAgentLifecycle.js';
import { claimMergeAdmission, withPendingMergeAdmission } from './cosMergeAdmission.js';

const admission = (action, token, extra = {}) => claimMergeAdmission({ agentId: 'review-agent', action, token, ...extra });
async function launch(overrides = {}) {
  const task = await spawnReviewLoopFollowUp({ originalAgentId: 'original', originalTask: { id: 'original-task' },
    prUrl: 'https://github.com/example/repo/pull/42', prBranch: 'feature/fix',
    sourceWorkspace: '/repos/source', reviewers: [], ...overrides });
  const persisted = f.tasks[task.id];
  const metadata = buildAgentRegistration({ task: persisted, provider: { id: 'test' }, modelSelection: {},
    sourceWorkspace: '/repos/source', workspacePath: '/repos/worktree', worktreeInfo: { branchName: 'feature/fix' } });
  await registerAgent('review-agent', task.id, metadata);
  return persisted;
}
const persist = () => { f.disk = structuredClone(f.state); };
beforeEach(() => {
  f.state = { agents: {}, mergeAdmissions: {}, stats: { agentsSpawned: 0 } };
  f.tasks = {}; f.branch = 'feature/fix'; f.workspaceRepo = 'example/repo'; persist();
});

describe('registered review-loop merge coordinator', () => {
  it('creates and registers a non-claim follow-up that acquires, checks and releases repository admission', async () => {
    await launch();
    expect(f.state.agents['review-agent'].metadata.claimPicksOwnBranch).not.toBe(true);
    const lease = await admission('acquire');
    expect(lease).toMatchObject({ admitted: true, repository: 'github.com/example/repo' });
    expect(await admission('check', lease.token)).toMatchObject({ admitted: true });
    f.branch = 'main'; // gh may switch away after deleting the merged branch.
    expect(await admission('release', lease.token, { outcome: 'merged' })).toMatchObject({ released: true });
    expect(f.disk.mergeAdmissions).toEqual({});
  });

  it('preserves active claim and sweep lease exclusion in both directions', async () => {
    await launch();
    f.state.agents.claim = { id: 'claim', taskId: 'claim-task', status: 'running', startedAt: new Date().toISOString(),
      metadata: { claimPicksOwnBranch: true, sourceWorkspace: '/repos/source' } }; persist();
    const claim = await claimMergeAdmission({ agentId: 'claim', action: 'acquire' });
    expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'owner-active-or-unverified' });
    await claimMergeAdmission({ agentId: 'claim', action: 'release', token: claim.token, outcome: 'merged' });
    await withPendingMergeAdmission({ host: 'github.com', fullName: 'example/repo' }, async () => {
      expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'owner-active-or-unverified' });
    });
    const review = await admission('acquire');
    expect((await claimMergeAdmission({ agentId: 'claim', action: 'acquire' })).admitted).toBe(false);
    expect((await withPendingMergeAdmission({ host: 'github.com', fullName: 'example/repo' }, vi.fn())).admitted).toBe(false);
    await admission('release', review.token, { outcome: 'merged' });
  });

  it.each(['absent-agent', 'completed-agent', 'absent-task', 'completed-task', 'user-task', 'unregistered-target',
    'changed-target', 'unrelated-pr', 'unrelated-workspace', 'changed-checkout', 'changed-registration', 'leave-open', 'fork'])
  ('refuses %s despite caller-supplied repository and branch claims', async mode => {
    const task = await launch();
    const agent = f.state.agents['review-agent'];
    if (mode === 'absent-agent') delete f.state.agents['review-agent'];
    if (mode === 'completed-agent') agent.status = 'completed';
    if (mode === 'absent-task') delete f.tasks[task.id];
    if (mode === 'completed-task') task.status = 'completed';
    if (mode === 'user-task') task.taskType = 'user';
    if (mode === 'unregistered-target') delete agent.metadata.reviewLoopMergeTarget;
    if (mode === 'changed-target') task.metadata.reviewLoopPRBranch = 'other';
    if (mode === 'unrelated-pr') {
      task.metadata.reviewLoopPRUrl = 'https://github.com/example/other/pull/42';
      task.metadata.reviewLoopPRRepo = 'other';
      agent.metadata.reviewLoopMergeTarget.url = task.metadata.reviewLoopPRUrl;
    }
    if (mode === 'unrelated-workspace') f.workspaceRepo = 'example/other';
    if (mode === 'changed-checkout') f.branch = 'another/branch';
    if (mode === 'changed-registration') agent.metadata.worktreeBranch = 'another/branch';
    if (mode === 'leave-open') task.metadata.reviewLoopLeaveOpen = true;
    if (mode === 'fork') task.metadata.forkHead = { owner: 'contributor', repo: 'repo', branch: 'feature/fix' };
    persist();
    expect(await admission('acquire', undefined, { repository: 'github.com/example/repo', branch: 'feature/fix' }))
      .toMatchObject({ admitted: false, reason: 'claim-owner-unverified' });
    expect(f.disk.mergeAdmissions).toEqual({});
  });
});
