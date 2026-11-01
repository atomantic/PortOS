import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ rows: [], prs: [], unavailable: false, requests: [], origin: null }));
vi.mock('node:fs/promises', async original => ({ ...await original(), realpath: async path => path }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => fixture.origin }));
vi.mock('./completedCheckoutEvidence.js', async original => ({ ...await original(),
  captureSeededCompletionCheckouts: async () => fixture.rows }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({}) }));
vi.mock('./github.js', () => ({ execGh: async args => {
  fixture.requests.push(args.at(-1));
  if (fixture.unavailable) throw new Error('synthetic forge failure');
  return JSON.stringify(fixture.prs);
} }));
vi.mock('./releaseSynchronization.js', () => ({ verifyInlineReleaseDelivery: async () => ({ verified: false, reason: 'sync pending' }) }));

import { verifyReleaseDelivery } from './releaseDeliveryGate.js';

let agent;
const noAction = { status: 'no-action-needed', reason: 'No release entries remain.' };
beforeEach(() => {
  const seed = { agentId: 'agent-release', startedAt: '2026-01-01T00:00:00Z', branch: 'codex/release-example' };
  agent = { id: seed.agentId, taskId: 'task-release', startedAt: seed.startedAt, status: 'running',
    metadata: { taskAnalysisType: 'do-release', isWorktree: false, workspacePath: '/repo',
      releaseCandidate: { version: 1, branch: seed.branch }, checkoutSeeds: [seed] } };
  fixture.rows = [{ branch: seed.branch, repoPath: '/repo' }];
  fixture.prs = [];
  fixture.requests = [];
  fixture.unavailable = false;
  fixture.origin = { isGithub: true, host: 'github.com', fullName: 'example/repo' };
});

describe('managed release delivery without a receipt', () => {
  it('holds a claimed successful release until its publication is recorded', async () => {
    expect(await verifyReleaseDelivery(agent, { status: 'completed' })).toMatchObject({ verified: false,
      reason: expect.stringContaining('no verified publication receipt') });
    expect(fixture.requests).toEqual([]);
  });

  it('accepts explicit no-action only after checking the captured candidate has no promotion PR', async () => {
    expect(await verifyReleaseDelivery(agent, noAction)).toEqual({ verified: true });
    expect(fixture.requests).toEqual(['repos/example/repo/pulls?state=all&head=example%3Acodex%2Frelease-example&base=release&per_page=100']);
    fixture.prs = [{ number: 42, merged: true }];
    expect(await verifyReleaseDelivery(agent, noAction)).toMatchObject({ verified: false, reason: expect.stringContaining('promotion PR') });
    fixture.prs = [{ number: 43, state: 'open' }];
    expect(await verifyReleaseDelivery(agent, noAction)).toMatchObject({ verified: false, reason: expect.stringContaining('promotion PR') });
    fixture.prs = Array.from({ length: 100 }, () => ({}));
    expect(await verifyReleaseDelivery(agent, noAction)).toMatchObject({ verified: false, reason: expect.stringContaining('history is unverified') });
  });

  it('holds unavailable forge or missing checkout evidence', async () => {
    fixture.unavailable = true;
    expect(await verifyReleaseDelivery(agent, noAction)).toMatchObject({ verified: false, reason: expect.stringContaining('unavailable') });
    fixture.unavailable = false;
    fixture.rows = [];
    expect(await verifyReleaseDelivery(agent, noAction)).toMatchObject({ verified: false, reason: expect.stringContaining('checkout is unverified') });
  });

  it('holds a new PortOS coordinator without a bound candidate but leaves unmanaged runs unchanged', async () => {
    delete agent.metadata.releaseCandidate;
    agent.metadata.taskApp = 'portos-default';
    agent.metadata.releaseCandidateLifecycle = { version: 1, stage: 'registered' };
    expect(await verifyReleaseDelivery(agent, noAction)).toMatchObject({ verified: false, reason: expect.stringContaining('not captured') });
    agent.metadata.taskApp = 'other-app';
    expect(await verifyReleaseDelivery(agent, noAction)).toBeNull();
  });

  it('keeps verified historical receipts and refuses malformed or unknown managed receipts', async () => {
    for (const version of [1, undefined]) {
      agent.metadata.releasePublication = { status: 'verified', identity: 'a'.repeat(64), synchronizationHandoffVersion: version };
      expect(await verifyReleaseDelivery(agent, noAction)).toBeNull();
    }
    for (const receipt of [{ status: 'verified', identity: 'bad', synchronizationHandoffVersion: 1 },
      { status: 'unverified', identity: 'a'.repeat(64), synchronizationHandoffVersion: 1 },
      { status: 'verified', identity: 'a'.repeat(64), synchronizationHandoffVersion: 3 }]) {
      agent.metadata.releasePublication = receipt;
      expect(await verifyReleaseDelivery(agent, noAction)).toMatchObject({ verified: false, reason: expect.stringContaining('invalid or unsupported') });
    }
    agent.metadata.releasePublication = { synchronizationHandoffVersion: 2 };
    expect(await verifyReleaseDelivery(agent, noAction)).toMatchObject({ verified: false, reason: 'sync pending' });
  });
});
