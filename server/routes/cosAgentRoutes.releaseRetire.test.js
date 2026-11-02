import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit, assertGitWorkSettled } from '../lib/execGit.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real route, host-control gate, ownership transaction and Git; the agent/task
// stores and the forge are the only synthetic seams.
const fixture = vi.hoisted(() => ({ state: null, queue: null, task: null, taskUpdates: [], active: [], pulls: [], releaseTip: '', tipError: false, failTaskUpdate: false }));
vi.mock('../lib/fileUtils.js', async original => makePathsProxy(await original(), { dataRoot: lazyTempDataRoot('release-retire-') }));
vi.mock('../services/cosAgentArchive.js', () => ({}));
vi.mock('../services/cosAgentFeedback.js', () => ({}));
vi.mock('../services/cosAgentIndex.js', () => ({}));
vi.mock('../services/cosHealthMonitor.js', () => ({}));
vi.mock('../services/agentOrchestrator.js', () => ({}));
vi.mock('../services/cosAgentLifecycle.js', () => ({ getAgentRecord: async id => fixture.state.agents[id] }));
vi.mock('../services/agentState.js', () => ({ getActiveAgentIds: () => fixture.active }));
vi.mock('../services/cosEvents.js', () => ({ cosEvents: { emit: vi.fn() } }));
vi.mock('../services/cosState.js', () => ({
  loadState: async () => structuredClone(fixture.state),
  readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: fixture.state.agents }),
  withStateLock: work => fixture.queue(work),
  saveState: async state => { fixture.state = structuredClone(state); },
}));
vi.mock('../services/cosTaskStore.js', () => ({
  getTaskById: async () => fixture.task && structuredClone(fixture.task),
  updateTask: async (id, patch, type, options) => {
    fixture.taskUpdates.push({ id, patch, type, options });
    if (fixture.failTaskUpdate) return { error: 'synthetic task store outage' };
    if (options.expectedStatus !== fixture.task.status) return { statusChanged: true };
    fixture.task = { ...fixture.task, status: patch.status, metadata: { ...fixture.task.metadata, ...patch.metadata } };
    return fixture.task;
  },
}));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ isGithub: true, host: 'github.com', fullName: 'example/repo' }) }));
vi.mock('../services/forgeExecOptions.js', () => ({ resolveForgeExecOptions: async cwd => ({ cwd, env: {} }) }));
vi.mock('../services/github.js', () => ({ execGh: async args => {
  const query = args.at(-1);
  if (query.includes('/pulls?')) return JSON.stringify(fixture.pulls);
  if (query.endsWith('/git/ref/heads/release')) {
    if (fixture.tipError) throw new Error('synthetic forge outage');
    return JSON.stringify({ ref: 'refs/heads/release', object: { type: 'commit', sha: fixture.releaseTip } });
  }
  throw new Error('Unexpected synthetic forge query');
} }));

import routes from './cosAgentRoutes.js';
import { hostControlRouteGate } from '../services/authGate.js';
import { readClaimOwnershipAgents } from '../services/cosClaimOwnership.js';

const branch = 'codex/release-agent-original';
const reason = 'Abandon the pre-hardening candidate and cut a fresh release';
const git = async (args, cwd) => (await execGit(args, cwd)).stdout.trim();
let scratch, repo, other, head, cutoff, auth;
const startedAt = '2026-01-01T00:00:00.000Z';
const holdOf = () => fixture.state.agents['agent-held'].metadata.releaseCandidateRecovery;
const auditedCall = (body = { action: 'retire', reason }, id = 'agent-held') => {
  const app = express();
  app.use((req, _res, next) => { req.portosAuthContext = auth; next(); });
  app.use(express.json());
  // The audited HOST_CONTROL_ROUTES list gates this route in production.
  app.use(hostControlRouteGate);
  app.use('/api/cos', routes);
  app.use(errorMiddleware);
  return request(app).post(`/api/cos/agents/${id}/release-candidate`).send(body);
};

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fixture.queue = createFileWriteQueue();
  fixture.active = []; fixture.pulls = []; fixture.taskUpdates = []; fixture.tipError = false; fixture.failTaskUpdate = false;
  auth = { enabled: true, authenticated: true, method: 'session' };
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'release-retire-')));
  repo = join(scratch, 'repo'); other = join(scratch, 'other');
  await materializeGitRepo(repo);
  await materializeGitRepo(other);
  await writeFile(join(repo, 'package.json'), '{"version":"1.2.3"}\n');
  await git(['add', 'package.json'], repo); await git(['commit', '-m', 'prepared fixture'], repo);
  cutoff = await git(['rev-parse', 'HEAD'], repo);
  await git(['switch', '-c', branch], repo);
  await git(['commit', '--allow-empty', '-m', `chore: pin release candidate\n\nRelease-Cut: ${cutoff}\nRelease-Base: ${cutoff}\nRelease-Previous-Tag: v1.2.2\nRelease-Previous-Commit: ${cutoff}`], repo);
  head = await git(['rev-parse', 'HEAD'], repo);
  await git(['switch', '-'], repo);
  fixture.releaseTip = cutoff;
  const workspace = { isWorktree: false, workspacePath: repo, instanceId: 'example-instance', taskAnalysisType: 'do-release' };
  fixture.state = { agents: {
    'agent-original': { id: 'agent-original', taskId: 'release-task', status: 'completed', startedAt, completedAt: startedAt,
      metadata: { ...workspace, releaseCandidate: { version: 1, branch, startedAt, reservedAt: startedAt },
        completedCheckouts: [{ branch, path: join(scratch, 'candidate') }] } },
    'agent-held': { id: 'agent-held', taskId: 'release-task', status: 'completed', startedAt: '2026-01-02T00:00:00.000Z',
      metadata: { ...workspace, resumedFromAgentId: 'agent-original', releaseCandidateRecovery: { version: 1, status: 'held',
        predecessorAgentId: 'agent-original', reason: 'candidate-contemporaneous-lineage-missing', nextStep: 'Resolve the hold.' } } },
  } };
  fixture.task = { id: 'release-task', taskType: 'internal', status: 'blocked', metadata: { analysisType: 'do-release', app: 'example', blockedCategory: 'task-approval' } };
});

afterEach(async () => {
  vi.restoreAllMocks();
  assertGitWorkSettled(scratch);
  await rm(scratch, { recursive: true, force: true });
});
afterAll(cleanupTempDataRoots);

const refusal = async (body, expected) => {
  const before = structuredClone(fixture.state);
  const response = await auditedCall(body);
  expect(response.body).toEqual({ retired: false, reason: expected });
  expect(fixture.state).toEqual(before);
  expect(fixture.taskUpdates).toEqual([]);
  expect(fixture.task.status).toBe('blocked');
};

describe('POST /agents/:id/release-candidate retire (#14773)', () => {
  it('records an operator receipt on the hold and task and retires the continuation without touching history', async () => {
    const predecessor = structuredClone(fixture.state.agents['agent-original']);
    const response = await auditedCall();
    expect(response.status).toBe(200);
    const receipt = response.body.reconciliation;
    expect(response.body).toMatchObject({ retired: true, taskId: 'release-task' });
    expect(receipt).toMatchObject({ version: 1, action: 'retire', operator: 'operator-session', reason,
      priorHold: { reason: 'candidate-contemporaneous-lineage-missing', predecessorAgentId: 'agent-original' },
      candidate: { cutoff, pin: head, head, releaseBase: cutoff, branch, path: join(scratch, 'candidate') } });
    expect(holdOf()).toMatchObject({ status: 'held', reason: 'candidate-contemporaneous-lineage-missing', reconciliation: receipt });
    expect(fixture.state.agents['agent-original']).toEqual(predecessor);
    expect(fixture.task).toMatchObject({ status: 'completed', metadata: { resolution: 'candidate-reconciled', releaseCandidateReconciliation: receipt } });
    expect(await readClaimOwnershipAgents()).toHaveLength(2);
    expect(await git(['rev-parse', branch], repo)).toBe(head);

    // A repeated request completes idempotently; a different decision is refused.
    expect(await (await auditedCall()).body).toMatchObject({ retired: true, reconciliation: receipt });
    expect(fixture.taskUpdates).toHaveLength(1);
    expect((await auditedCall({ action: 'retire', reason: 'A different decision entirely' })).body)
      .toEqual({ retired: false, reason: 'candidate-already-reconciled' });
  });

  it('finishes the task update when it failed after the receipt was recorded', async () => {
    fixture.failTaskUpdate = true;
    expect((await auditedCall()).body).toEqual({ retired: false, reason: 'candidate-task-changed' });
    expect(holdOf().reconciliation).toBeDefined();
    expect(fixture.task.status).toBe('blocked');
    fixture.failTaskUpdate = false;
    // A retry never closes a task that something resumed in the meantime.
    fixture.task.status = 'in_progress';
    expect((await auditedCall()).body).toEqual({ retired: false, reason: 'candidate-task-unverified' });
    expect(fixture.task.status).toBe('in_progress');
    fixture.task.status = 'blocked';
    fixture.pulls = [{ number: 9, state: 'open', merged_at: null }];
    expect((await auditedCall()).body).toEqual({ retired: false, reason: 'candidate-promotion-exists' });
    fixture.pulls = [];
    expect((await auditedCall()).body).toMatchObject({ retired: true, reconciliation: holdOf().reconciliation });
    expect(fixture.task.status).toBe('completed');
  });

  it('records the local operator when no password is set', async () => {
    auth = { enabled: false, authenticated: true, method: null };
    const response = await auditedCall();
    // A password-free install admits only a genuine local connection; the
    // synthetic loopback peer here is one.
    expect(response.body.reconciliation?.operator).toBe('local-operator');
  });

  it('refuses a scoped peer credential before any evidence is read', async () => {
    auth = { enabled: true, authenticated: true, method: 'peer', peerId: 'example-peer' };
    const response = await auditedCall();
    expect(response.status).toBe(403);
    expect(holdOf().reconciliation).toBeUndefined();
    expect(fixture.taskUpdates).toEqual([]);
  });

  it('refuses an unauthenticated caller', async () => {
    auth = { enabled: true, authenticated: false, method: null };
    expect((await auditedCall()).status).toBe(403);
    expect(holdOf().reconciliation).toBeUndefined();
  });

  it('rejects a missing or unbounded reason and unknown fields', async () => {
    for (const body of [{ action: 'retire' }, { action: 'retire', reason: 'short' }, { action: 'retire', reason: 'x'.repeat(501) },
      { action: 'retire', reason: 'line one\nline two here' }, { action: 'retire', reason, operator: 'someone' }]) {
      expect((await auditedCall(body)).status).toBe(400);
    }
    expect(holdOf().reconciliation).toBeUndefined();
  });

  it('refuses holds that are not insufficient historical evidence', async () => {
    for (const held of ['candidate-process-proof-unavailable', 'candidate-attempt-unsettled', 'candidate-owner-ambiguous']) {
      holdOf().reason = held;
      await refusal(undefined, 'candidate-hold-not-reconcilable');
    }
  });

  it('refuses an agent that has no held recovery', async () => {
    delete fixture.state.agents['agent-held'].metadata.releaseCandidateRecovery;
    await refusal(undefined, 'candidate-not-held');
  });

  it('refuses while a release or synchronization of the same repository is live', async () => {
    fixture.state.agents['agent-live'] = { id: 'agent-live', taskId: 'other-task', status: 'running', startedAt,
      metadata: { isWorktree: false, workspacePath: repo, taskAnalysisType: 'release-sync' } };
    await refusal(undefined, 'release-active');
    fixture.state.agents['agent-live'].status = 'completed';
    fixture.active = ['agent-live'];
    await refusal(undefined, 'release-active');
    fixture.active = [];
    fixture.state.agents['agent-held'].status = 'running';
    await refusal(undefined, 'release-active');
  });

  it('is unaffected by a live release of another repository', async () => {
    fixture.state.agents['agent-elsewhere'] = { id: 'agent-elsewhere', taskId: 'elsewhere-task', status: 'running', startedAt,
      metadata: { isWorktree: false, workspacePath: other, taskAnalysisType: 'do-release' } };
    expect((await auditedCall()).body).toMatchObject({ retired: true });
    expect(fixture.state.agents['agent-elsewhere'].metadata.releaseCandidateRecovery).toBeUndefined();
  });

  it('refuses an open or merged promotion PR but retires past a closed unmerged one', async () => {
    fixture.pulls = [{ number: 7, state: 'open', merged_at: null }];
    await refusal(undefined, 'candidate-promotion-exists');
    fixture.pulls = [{ number: 7, state: 'closed', merged_at: '2026-01-03T00:00:00Z' }];
    await refusal(undefined, 'candidate-promotion-exists');
    fixture.pulls = [{ number: 7, state: 'closed', merged_at: null }];
    expect((await auditedCall()).body.retired).toBe(true);
  });

  it('fails closed when the PR listing may be truncated', async () => {
    fixture.pulls = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, state: 'closed', merged_at: null }));
    await refusal(undefined, 'candidate-publication-ambiguous');
  });

  it('refuses when the release base moved or the forge is unavailable', async () => {
    fixture.releaseTip = 'f'.repeat(40);
    await refusal(undefined, 'candidate-release-base-changed');
    fixture.tipError = true;
    await refusal(undefined, 'candidate-forge-unavailable');
  });

  it('refuses a candidate whose identity cannot be read from Git', async () => {
    await git(['branch', '-D', branch], repo);
    await refusal(undefined, 'candidate-identity-unavailable');
  });

  it('refuses a task that is no longer waiting', async () => {
    fixture.task.status = 'in_progress';
    const before = structuredClone(fixture.state);
    expect((await auditedCall()).body).toEqual({ retired: false, reason: 'candidate-task-unverified' });
    expect(fixture.state).toEqual(before);
  });
});
