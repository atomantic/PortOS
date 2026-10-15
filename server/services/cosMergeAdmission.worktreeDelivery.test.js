import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { generateTasksMarkdown, parseTasksMarkdown } from '../lib/taskParser.js';

// Generic, operator-configured CoS PR delivery (#11435): a live worktree run
// whose prompt told it to open and merge its own PR participates in repository
// merge admission through its spawn-time binding, never a caller claim.
const f = vi.hoisted(() => ({ state: null, disk: null, tasks: {}, branch: 'cos/task-1/agent-1', workspaceRepo: 'example/repo' }));
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: '/synthetic/agents',
  withStateLock: createFileWriteQueue(),
  loadState: async () => f.state,
  saveState: async state => { f.state = state; f.disk = structuredClone(state); },
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(f.disk) }),
}));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async id => f.tasks[id] ?? null }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async path => ({ host: 'github.com', fullName: path === '/repos/worktree' ? f.workspaceRepo : 'example/repo' }) }));
vi.mock('../lib/execGit.js', () => ({ execGit: async () => ({ stdout: f.branch, exitCode: 0 }) }));
import { buildAgentRegistration } from '../lib/agentRegistrationRecord.js';
import { registerAgent } from './cosAgentLifecycle.js';
import { claimMergeAdmission, withPendingMergeAdmission } from './cosMergeAdmission.js';

const BRANCH = 'cos/task-1/agent-1';
const admission = (action, token, extra = {}) => claimMergeAdmission({ agentId: 'agent-1', action, token, ...extra });
const persist = () => { f.disk = structuredClone(f.state); };

// The task round-trips through TASKS.md like a real queue entry, so metadata
// arrives with the string scalars admission must still interpret correctly.
async function launch({ metadata = {}, mergesOwnPr = true, prOpenedBy = 'agent-slashdo' } = {}) {
  const [task] = parseTasksMarkdown(generateTasksMarkdown([{ id: 'task-1', status: 'in_progress', priority: 'MEDIUM',
    description: 'Fix the example', metadata: { openPR: true, prCompletion: 'merge-on-green', ...metadata } }]));
  f.tasks[task.id] = { ...task, taskType: 'user' };
  await registerAgent('agent-1', task.id, buildAgentRegistration({ task: f.tasks[task.id], provider: { id: 'test' }, modelSelection: {},
    sourceWorkspace: '/repos/source', workspacePath: '/repos/worktree', worktreeInfo: { branchName: BRANCH },
    prOpenedBy, mergesOwnPr }));
  return f.tasks[task.id];
}

beforeEach(() => {
  f.state = { agents: {}, mergeAdmissions: {}, stats: { agentsSpawned: 0 } };
  f.tasks = {}; f.branch = BRANCH; f.workspaceRepo = 'example/repo'; persist();
});

describe('generic worktree PR delivery merge admission', () => {
  it.each(['agent-slashdo', 'agent-inline'])('an authorized %s run acquires, checks and releases admission for its own PR', async prOpenedBy => {
    await launch({ prOpenedBy });
    const agent = f.state.agents['agent-1'];
    expect(agent.metadata.prDeliveryTarget).toEqual({ branch: BRANCH, workspacePath: '/repos/worktree' });
    expect(agent.metadata.claimBranch).toBeUndefined();
    const lease = await admission('acquire');
    expect(lease).toMatchObject({ admitted: true, repository: 'github.com/example/repo' });
    expect(await admission('check', lease.token)).toMatchObject({ admitted: true });
    f.branch = 'main'; // gh may switch away after deleting the merged branch.
    expect(await admission('release', lease.token, { outcome: 'merged' })).toMatchObject({ released: true });
    expect(f.disk.mergeAdmissions).toEqual({});
    // Admission never promoted the generic run to claim authority.
    expect(f.state.agents['agent-1'].metadata.claimPicksOwnBranch).toBeUndefined();
  });

  it('excludes and is excluded by active claim and sweep leases', async () => {
    await launch();
    f.state.agents.claim = { id: 'claim', taskId: 'claim-task', status: 'running', startedAt: new Date().toISOString(),
      metadata: { claimPicksOwnBranch: true, sourceWorkspace: '/repos/source' } }; persist();
    const claim = await claimMergeAdmission({ agentId: 'claim', action: 'acquire' });
    expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'owner-active-or-unverified' });
    await claimMergeAdmission({ agentId: 'claim', action: 'release', token: claim.token, outcome: 'merged' });
    await withPendingMergeAdmission({ host: 'github.com', fullName: 'example/repo' }, async () => {
      expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'owner-active-or-unverified' });
    });
    const generic = await admission('acquire');
    expect(generic.admitted).toBe(true);
    expect((await claimMergeAdmission({ agentId: 'claim', action: 'acquire' })).admitted).toBe(false);
    expect((await withPendingMergeAdmission({ host: 'github.com', fullName: 'example/repo' }, vi.fn())).admitted).toBe(false);
  });

  it('refuses a check after the run has stopped verifying, even with its own token', async () => {
    const task = await launch();
    const lease = await admission('acquire');
    task.status = 'completed';
    expect(await admission('check', lease.token)).toMatchObject({ admitted: false, reason: 'claim-owner-unverified' });
    // Releasing an owned token stays possible so the lease cannot strand.
    expect(await admission('release', lease.token, { outcome: 'leave-open' })).toMatchObject({ released: true });
  });

  it.each([
    'absent-agent', 'completed-agent', 'absent-task', 'completed-task', 'other-task', 'unbound', 'portos-owned',
    'open-pr-revoked', 'leave-open', 'human-handoff', 'review-follow-up', 'fork', 'changed-registration',
    'moved-workspace', 'source-as-worktree', 'unrelated-workspace', 'changed-checkout', 'unreadable-checkout',
  ])('refuses %s despite caller-supplied repository and branch claims', async mode => {
    const task = await launch(mode === 'unbound' ? { mergesOwnPr: false } : mode === 'portos-owned' ? { prOpenedBy: 'portos' } : {});
    const agent = f.state.agents['agent-1'];
    if (mode === 'absent-agent') delete f.state.agents['agent-1'];
    if (mode === 'completed-agent') agent.status = 'completed';
    if (mode === 'absent-task') delete f.tasks[task.id];
    if (mode === 'completed-task') task.status = 'completed';
    if (mode === 'other-task') agent.taskId = 'task-2';
    if (mode === 'open-pr-revoked') task.metadata.openPR = 'false';
    if (mode === 'leave-open') task.metadata.prCompletion = 'leave-open';
    if (mode === 'human-handoff') task.metadata.jiraTicketId = 'EX-1';
    if (mode === 'review-follow-up') task.metadata.reviewLoopFollowUp = true;
    if (mode === 'fork') task.metadata.forkHead = { owner: 'contributor', repo: 'repo', branch: BRANCH };
    if (mode === 'changed-registration') agent.metadata.worktreeBranch = 'another/branch';
    if (mode === 'moved-workspace') agent.metadata.workspacePath = '/repos/elsewhere';
    if (mode === 'source-as-worktree') agent.metadata.sourceWorkspace = '/repos/worktree';
    if (mode === 'unrelated-workspace') f.workspaceRepo = 'example/other';
    if (mode === 'changed-checkout') f.branch = 'another/branch';
    if (mode === 'unreadable-checkout') f.branch = '';
    persist();
    expect(await admission('acquire', undefined, { repository: 'github.com/example/repo', branch: BRANCH, prUrl: 'https://github.com/example/repo/pull/1' }))
      .toMatchObject({ admitted: false, reason: 'claim-owner-unverified' });
    expect(f.disk.mergeAdmissions).toEqual({});
  });
});
