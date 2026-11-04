import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ state: null, task: null }));
vi.mock('../services/cosAgentArchive.js', () => ({}));
vi.mock('../services/cosAgentFeedback.js', () => ({}));
vi.mock('../services/cosAgentIndex.js', () => ({}));
vi.mock('../services/cosAgentLifecycle.js', () => ({}));
vi.mock('../services/cosHealthMonitor.js', () => ({}));
vi.mock('../services/agentOrchestrator.js', () => ({}));
vi.mock('../services/cosTaskStore.js', () => ({ getTaskById: vi.fn(async () => fixture.task) }));
vi.mock('../services/cosState.js', () => ({
  withStateLock: async work => work(),
  loadState: async () => fixture.state,
  saveState: vi.fn(async state => { fixture.state = structuredClone(state); }),
}));
vi.mock('../services/cosEvents.js', () => ({ cosEvents: { emit: vi.fn() } }));
vi.mock('../services/agentAppWorkspace.js', () => ({ getAppDataForTask: vi.fn() }));
vi.mock('../lib/workTracker.js', async importOriginal => ({ ...await importOriginal(), resolveAppForgeTarget: vi.fn() }));
vi.mock('../services/instanceIdentity.js', () => ({ getInstanceId: vi.fn() }));
vi.mock('../services/forgeAuth.js', () => ({ resolveForgeForRepo: vi.fn() }));
vi.mock('../services/github.js', () => ({ execGh: vi.fn() }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));

import router from './cosAgentRoutes.js';
import { saveState } from '../services/cosState.js';
import { getAppDataForTask } from '../services/agentAppWorkspace.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { getInstanceId } from '../services/instanceIdentity.js';
import { resolveForgeForRepo } from '../services/forgeAuth.js';
import { execGh } from '../services/github.js';
import { execGit } from '../lib/execGit.js';
import { verifyClaimDisposition } from '../services/claimDisposition.js';

const target = { forge: 'github', fullName: 'example/project', webHost: 'github.example.test', apiHost: 'github.example.test', repoSpec: 'github.example.test/example/project' };
const input = { agentId: 'agent-picker', issueNumber: 42 };
const call = (body = input) => new Promise(resolve => {
  const req = { app: { get: () => null }, method: 'POST', url: '/claim-selection', body, headers: {} };
  router.handle(req, { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { resolve({ status: this.statusCode, body: value }); } },
    error => resolve({ status: error?.status || 404, error }));
});
const agent = () => fixture.state.agents[input.agentId];
const verify = () => verifyClaimDisposition({ task: fixture.task, agent: structuredClone(agent()),
  reportedOutcome: { status: 'no-action-needed' }, success: true });
let repository;

beforeEach(() => {
  vi.resetAllMocks();
  fixture.task = { id: 'example-task', taskType: 'internal', metadata: {
    app: 'example', claimFlow: true, totalSpawnCount: 2, failureCount: 1,
  } };
  fixture.state = { agents: { [input.agentId]: {
    id: input.agentId, taskId: fixture.task.id, status: 'running', startedAt: '2026-10-01T09:00:00Z',
    metadata: { configClaimFlow: true, claimPicksOwnBranch: true, isWorktree: false,
      instanceId: 'example-instance', workspacePath: '/example/project', claimBranches: [] },
  } } };
  getAppDataForTask.mockResolvedValue({ repoPath: '/example/project' });
  resolveAppForgeTarget.mockResolvedValue({ tracker: 'github', target });
  getInstanceId.mockResolvedValue('example-instance');
  resolveForgeForRepo.mockResolvedValue({ cli: 'gh' });
  execGit.mockResolvedValue({ exitCode: 0, stdout: '' });
  repository = { nameWithOwner: target.fullName, defaultBranchRef: { name: 'main', target: { oid: 'a'.repeat(40) } },
    issue: { number: 42, state: 'OPEN', repository: { nameWithOwner: target.fullName },
      labels: { nodes: [{ name: 'blocked' }] }, timelineItems: { nodes: [
        { __typename: 'LabeledEvent', label: { name: 'blocked' }, actor: { login: 'example' }, createdAt: '2026-10-01T10:00:00Z' },
      ] } } };
  execGh.mockImplementation(async args => args[1] === 'graphql'
    ? JSON.stringify({ data: { repository } }) : JSON.stringify({ login: 'example' }));
});

describe('pre-claim selection through completion', () => {
  it('persists server-bound candidates and verifies an operator stand-down after reload without a claim', async () => {
    const before = structuredClone(fixture);
    expect(await call()).toEqual({ status: 200, body: { recorded: true, issues: [42] } });
    expect(await call()).toEqual({ status: 200, body: { recorded: true, issues: [42] } });
    expect(agent().metadata.claimSelection).toMatchObject({ version: 1, agentId: input.agentId,
      taskId: fixture.task.id, instanceId: 'example-instance', repoPath: '/example/project',
      repository: 'github.example.test/example/project', tracker: 'github', issues: [42] });
    const { claimSelection, ...unchanged } = agent().metadata;
    expect(unchanged).toEqual(before.state.agents[input.agentId].metadata);
    expect(fixture.task).toEqual(before.task);
    fixture.state = JSON.parse(JSON.stringify(fixture.state));
    expect(await verify()).toMatchObject({ status: 'verified', issues: [{ issue: 42, disposition: 'operator-blocked' }] });
    expect(execGit.mock.calls[0][0]).toEqual(['status', '--porcelain', '--untracked-files=all']);
    expect(execGit.mock.calls[0][1]).toBe('/example/project');
  });

  it.each([
    { ...input, taskId: 'other-task' }, { ...input, repoPath: '/other/repo' },
    { ...input, issueNumber: '42' }, { ...input, issueNumber: 0 },
  ])('rejects caller-selected scope or invalid issue numbers: %j', async body => {
    expect((await call(body)).status).toBe(400);
    expect(saveState).not.toHaveBeenCalled();
  });

  it.each([
    ['finished run', () => { agent().status = 'completed'; }],
    ['different task', () => { fixture.task.id = 'other-task'; }],
    ['different app repository', () => { getAppDataForTask.mockResolvedValue({ repoPath: '/other/project' }); }],
    ['different instance', () => { getInstanceId.mockResolvedValue('other-instance'); }],
    ['already bound child', () => { agent().metadata.claimBranches = ['claim/issue-43']; }],
  ])('does not record a candidate for %s', async (_name, mutate) => {
    mutate();
    expect((await call()).body.recorded).toBe(false);
    expect(saveState).not.toHaveBeenCalled();
  });

  it('does not report a record when persistence fails', async () => {
    saveState.mockRejectedValueOnce(new Error('synthetic write failure'));
    expect((await call()).status).not.toBe(200);
    expect(agent().metadata.claimSelection).toBeUndefined();
  });

  it.each([
    ['missing selection', () => { delete agent().metadata.claimSelection; }],
    ['cross-task selection', () => { agent().metadata.claimSelection.taskId = 'other-task'; }],
    ['cross-repository selection', () => { agent().metadata.claimSelection.repository = 'github.example.test/other/project'; }],
    ['changed instance', () => { getInstanceId.mockResolvedValue('other-instance'); }],
    ['unreadable selection', () => { agent().metadata.claimSelection.issues = '42'; }],
  ])('refuses completion before forge reads for %s', async (_name, mutate) => {
    await call();
    mutate();
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'selected-issue-unverified' });
    expect(execGh).not.toHaveBeenCalled();
  });

  it('keeps live authority, actionable work and dirty-checkout checks after selection', async () => {
    await call();
    repository.issue.timelineItems.nodes[0].actor.login = 'outside-contributor';
    expect(await verify()).toMatchObject({ status: 'unverified' });
    repository.issue.timelineItems.nodes[0].actor.login = 'example';
    repository.issue.labels.nodes = [];
    expect(await verify()).toMatchObject({ status: 'unverified' });
    repository.issue.labels.nodes = [{ name: 'blocked' }];
    execGit.mockResolvedValue({ exitCode: 0, stdout: ' M unfinished.js' });
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'checkout-has-undelivered-work' });
  });

  it('cannot conceal a later unfinished child behind the recorded parked candidate', async () => {
    await call();
    agent().metadata.claimBranches = ['claim/issue-43'];
    expect(await verify()).toMatchObject({ status: 'unverified' });
    expect(execGh.mock.calls[0][0]).toContain('number=43');
  });

  it('requires a verified disposition for every recorded candidate', async () => {
    await call();
    expect((await call({ ...input, issueNumber: 43 })).body).toEqual({ recorded: true, issues: [42, 43] });
    expect(await verify()).toMatchObject({ status: 'unverified' });
    expect(execGh.mock.calls.at(-1)[0]).toContain('number=43');
  });
});
