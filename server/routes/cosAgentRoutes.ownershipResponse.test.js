import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { promisify } from 'node:util';
import { execFile } from '../lib/childProcess.js';
import { startLoopbackServer, closeLoopbackServer } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const fixture = vi.hoisted(() => ({ state: null, apiBase: '', unreadable: false, stateGate: null, onStateQueued: null }));
vi.mock('../services/cos.js', () => ({}));
vi.mock('../services/agentOrchestrator.js', () => ({}));
vi.mock('../services/apps.js', () => ({ getAppById: async () => ({ repoPath: '/synthetic/repo' }) }));
vi.mock('../services/cosState.js', () => ({
  readAgentsStateForSafetyCheck: async () => ({ trusted: !fixture.unreadable, agents: fixture.unreadable ? null : fixture.state.agents }),
  withStateLock: async work => {
    if (fixture.stateGate) { fixture.onStateQueued(); await fixture.stateGate; }
    return work();
  },
  loadState: async () => structuredClone(fixture.state),
  saveState: async (state) => { fixture.state = structuredClone(state); },
}));
vi.mock('../services/branchCompletionPolicy.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readBranchCompletionHold: input => actual.readBranchCompletionHold(input, {
    readPolicies: async () => Object.values(fixture.state.agents),
  }) };
});
vi.mock('../services/cosEvents.js', () => ({ cosEvents: { emit: vi.fn() } }));
vi.mock('../services/cosAgentLifecycle.js', () => ({
  getAgents: async () => fixture.unreadable ? null : Object.values(fixture.state.agents),
}));
vi.mock('../services/agentState.js', () => ({ getActiveAgentIds: () => [] }));
vi.mock('../services/worktreeManager.js', async (importOriginal) => ({
  ...await importOriginal(),
  listWorktrees: async () => [{ branch: 'refs/heads/claim/issue-101', path: '/synthetic/repo/worktree' }],
}));
vi.mock('../services/github.js', () => ({
  execGh: vi.fn(), ensureForgeReachable: vi.fn(),
  getIssueDispatchHint: async () => ({ status: 'unavailable', model: null, effort: null }),
}));
vi.mock('../lib/networkExposure.js', () => ({ localApiBaseUrl: () => fixture.apiBase }));

import routes from './cosAgentRoutes.js';
import { formatInFlightForPrompt } from '../services/branchReconcile.js';
import { updateClaimOwnership, withClaimOwnershipLock, CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS } from '../services/cosClaimOwnership.js';

const execute = promisify(execFile);
const coordinator = 'synthetic-coordinator';
const branch = 'claim/issue-101';
let server;

beforeEach(async () => {
  fixture.unreadable = false;
  fixture.stateGate = fixture.onStateQueued = null;
  fixture.state = { agents: {
    [coordinator]: { id: coordinator, status: 'running', workspacePath: '/synthetic/repo', metadata: {} },
  } };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const app = express();
  // Synthetic authorization only: no real install credential or runtime state.
  app.use((req, res, next) => req.get('Authorization') === 'Bearer synthetic-test-token'
    ? next() : res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }));
  app.use(express.json());
  app.use('/api/cos', routes);
  app.use(errorMiddleware);
  server = await startLoopbackServer(app);
  fixture.apiBase = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await closeLoopbackServer(server);
  server = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Exercise the command handed to a coordinator, including shell quoting and
// curl's output boundary. Split the HTTP header delimiter as bytes; the body
// is never trimmed, concatenated with diagnostics, or repaired before parsing.
async function captureRecheck({ token = 'synthetic-test-token', agentId = coordinator } = {}) {
  const prompt = await formatInFlightForPrompt([
    { branch, state: 'ABANDONED_WIP', worktreePath: '/synthetic/repo/worktree' },
  ], { defaultBranch: 'main', actions: {}, appId: 'synthetic-app' });
  const command = prompt.match(/^- Recheck: `([^\n]+)`$/m)[1].replace('{agentId}', agentId);
  const { stdout, stderr } = await execute('sh', ['-c', `${command} --dump-header - --max-time 10`], {
    encoding: 'buffer', timeout: 15000,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORTOS_API_TOKEN: token },
  });
  expect(stderr.length).toBe(0);
  const separator = stdout.indexOf(Buffer.from('\r\n\r\n'));
  expect(separator).toBeGreaterThan(0);
  const headerText = stdout.subarray(0, separator).toString('utf8');
  const body = stdout.subarray(separator + 4);
  const status = Number(headerText.match(/^HTTP\/\S+ (\d+)/)[1]);
  expect(headerText).toMatch(/content-type: application\/json/i);
  expect(Number(headerText.match(/content-length: (\d+)/i)[1])).toBe(body.length);
  return { status, body, parsed: JSON.parse(body.toString('utf8')) };
}

describe('generated ownership recheck raw HTTP response (#11348)', () => {
  it('returns exactly one JSON document and reserves the branch for the registered coordinator', async () => {
    const capture = await captureRecheck();
    expect(capture.status).toBe(200);
    expect(capture.body.toString('hex')).toBe('7b2261646d6974746564223a747275657d');
    expect(capture.parsed).toEqual({ admitted: true });
    expect(fixture.state.agents[coordinator].metadata.claimBranches).toEqual([branch]);
    fixture.state.agents.picker = { id: 'picker', status: 'running', workspacePath: '/synthetic/repo',
      metadata: { sourceWorkspace: '/synthetic/repo', claimBranch: 'claim/issue-100', claimPicksOwnBranch: false } };
    expect(await updateClaimOwnership({ action: 'bind', agentId: 'picker', branch }))
      .toEqual({ bound: false, reason: 'owner-active' });
  });

  it.each(['claim-owner-active', 'ownership-unreadable', 'owner-unknown', 'pr-completion-human-handoff', 'pr-completion-review-required'])('preserves the %s refusal as complete JSON without reserving', async (reason) => {
    if (reason === 'claim-owner-active') {
      fixture.state.agents.owner = { id: 'owner', status: 'running', metadata: { claimBranches: [branch] } };
    }
    if (reason === 'ownership-unreadable') fixture.unreadable = true;
    if (reason.startsWith('pr-completion-')) {
      fixture.state.agents.handoff = { id: 'handoff', status: 'completed', metadata: {
        sourceWorkspace: '/synthetic/repo', worktreeBranch: branch,
        prCompletionPolicy: reason === 'pr-completion-human-handoff' ? 'leave-open' : 'review-then-merge',
      } };
    }
    const before = structuredClone(fixture.state);
    const capture = await captureRecheck({ agentId: reason === 'owner-unknown' ? 'unknown' : coordinator });
    expect(capture.status).toBe(200);
    expect(capture.body.toString('utf8')).toBe(JSON.stringify({ admitted: false, reason }));
    expect(capture.parsed).toEqual({ admitted: false, reason });
    expect(fixture.state).toEqual(before);
  });

  it('returns a bounded JSON refusal for a queued reservation and cannot reserve after the response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let resume;
    fixture.stateGate = new Promise(resolve => { resume = resolve; });
    const queued = new Promise(resolve => { fixture.onStateQueued = resolve; });
    const before = structuredClone(fixture.state);
    const response = fetch(`${fixture.apiBase}/api/cos/claim-ownership`, {
      method: 'POST', headers: { Authorization: 'Bearer synthetic-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check', appId: 'synthetic-app', branch, agentId: coordinator }),
    });
    await queued;
    await vi.advanceTimersByTimeAsync(CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS);
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ admitted: false, reason: 'state-queue-timeout', retryAfterMs: 5000 });
    resume();
    await withClaimOwnershipLock(() => {});
    expect(fixture.state).toEqual(before);
  });

  it('keeps an HTTP authentication error separate from admission and leaves ownership unchanged', async () => {
    const before = structuredClone(fixture.state);
    const capture = await captureRecheck({ token: 'invalid-synthetic-token' });
    expect(capture.status).toBe(401);
    expect(capture.parsed).toEqual({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    expect(fixture.state).toEqual(before);
  });

  it('serializes route validation errors without granting admission or changing ownership', async () => {
    const before = structuredClone(fixture.state);
    const capture = await captureRecheck({ agentId: '' });
    expect(capture.status).toBe(400);
    expect(capture.parsed).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(capture.parsed.admitted).toBeUndefined();
    expect(fixture.state).toEqual(before);
  });
});
