import { beforeEach, describe, expect, it, vi } from 'vitest';

const forge = vi.hoisted(() => ({ probes: new Map(), evidence: new Map(), gitlab: new Map() }));
vi.mock('./apps.js', () => ({ getAppById: async () => ({ id: 'app', repoPath: '/repo' }) }));
vi.mock('./prProbe.js', () => ({ probePrForBranch: async (_repo, branch) => forge.probes.get(branch) }));
vi.mock('./heldCheckoutReview.js', () => ({ readRetirementForgeEvidence: async (_repo, branch) => forge.evidence.get(branch) }));
vi.mock('../lib/workTracker.js', () => ({ resolveAppForgeTarget: async () => ({ target: {
  forge: 'gitlab', fullName: 'group/sub/project', webHost: 'gitlab.example.com',
} }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ env: {} }) }));
vi.mock('./gitlab.js', () => ({ execGlab: async args => JSON.stringify(forge.gitlab.get(Number(args.at(-1).split('/').at(-1))) ?? null) }));

import { cleanupDeliveryProofMatches, cleanupRefillSourceMatches, proveSwarmCleanupDelivery } from './swarmCleanupDelivery.js';

const start = '2026-01-01T00:00:00.000Z';
const captured = '2026-01-01T00:01:00.000Z';
const complete = '2026-01-01T00:02:00.000Z';
const pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
const branches = ['claim/issue-1', 'claim/issue-2'];
const heads = ['a'.repeat(40), 'b'.repeat(40)];
const urls = ['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/2'];

function fixture() {
  const task = { id: 'swarm-task', taskType: 'internal', status: 'in_progress', metadata: {
    app: 'app', analysisType: 'claim-issue', perpetual: true, claimFlow: true, swarmCount: 6,
    claimedBy: 'local', claimedAt: start, lastSpawnedAt: start, totalSpawnCount: '1',
    deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-swarm',
    taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } },
  } };
  const agent = { id: 'agent-swarm', taskId: task.id, status: 'completed', startedAt: start, completedAt: complete,
    result: { success: false, executionSuccess: true, cleanupPending: true, deliveryRecoveryOwned: true,
      taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } },
    metadata: { instanceId: 'local', taskApp: 'app', taskAnalysisType: 'claim-issue', configClaimFlow: true, workspacePath: '/repo', isWorktree: false,
      claimBranches: branches, claimReleasedBranches: [], checkoutCapture: { status: 'captured' },
      completedCheckouts: branches.map((branch, index) => ({ version: 1, agentId: 'agent-swarm', startedAt: start,
        capturedAt: captured, repoPath: '/repo', path: `/worktrees/${index}`, branch, head: heads[index], incarnation: { pointer } })),
      completionTaskDispatch: { taskId: task.id, taskType: 'internal', expected: [
        ['claimedBy', 'local'], ['claimedAt', start], ['lastSpawnedAt', start], ['totalSpawnCount', 1],
      ] },
    } };
  return { task, agent };
}

beforeEach(() => {
  forge.probes.clear(); forge.evidence.clear(); forge.gitlab.clear();
  branches.forEach((branch, index) => {
    forge.probes.set(branch, { readable: true, cli: 'gh', prState: 'MERGED', prUrl: urls[index] });
    forge.evidence.set(branch, { scopeProof: 'exact-delivered-head', prHead: heads[index], prUrl: urls[index] });
  });
});

describe('verified swarm delivery while retirement is held', () => {
  it('requires every captured branch to have an exact merged head and preserves the cleanup outcome', async () => {
    const { task, agent } = fixture();
    const proof = await proveSwarmCleanupDelivery(task, agent, 'local');
    expect(proof).toEqual({ version: 1, branches: branches.map((branch, index) => ({ branch, head: heads[index], prUrl: urls[index] })) });
    agent.metadata.swarmCleanupDelivery = proof;
    expect(cleanupDeliveryProofMatches(task, agent, 'local')).toBe(true);
    expect(task.status).toBe('in_progress');
    expect(agent.result.cleanupPending).toBe(true);
  });

  it.each(['open', 'unreadable', 'different-head', 'missing-capture', 'changed-dispatch', 'wrong-instance', 'released-branch'])(
    'keeps the drain held when delivery or ownership is %s', async scenario => {
      const { task, agent } = fixture();
      if (scenario === 'open') forge.probes.get(branches[1]).prState = 'OPEN';
      if (scenario === 'unreadable') forge.probes.get(branches[1]).readable = false;
      if (scenario === 'different-head') forge.evidence.get(branches[1]).prHead = 'c'.repeat(40);
      if (scenario === 'missing-capture') agent.metadata.completedCheckouts.pop();
      if (scenario === 'changed-dispatch') task.metadata.totalSpawnCount = '2';
      if (scenario === 'released-branch') agent.metadata.claimReleasedBranches = ['claim/issue-3'];
      expect(await proveSwarmCleanupDelivery(task, agent, scenario === 'wrong-instance' ? 'other' : 'local')).toBeNull();
    });

  it('accepts a queued refill after receipt-backed retirement, but not after an unrelated task change', async () => {
    const { task, agent } = fixture();
    agent.metadata.swarmCleanupDelivery = await proveSwarmCleanupDelivery(task, agent, 'local');
    agent.result = { ...agent.result, success: true, cleanupPending: false, deferredDeliveryOutcome: agent.result.taskOutcome,
      taskOutcome: { status: 'completed' } };
    agent.metadata.repoStateVerification = { status: 'completed' };
    agent.metadata.cleanupOutcome = { status: 'verified', unresolved: 0 };
    task.status = 'completed';
    delete task.metadata.deliveryRecovery;
    delete task.metadata.deliveryRecoveryAgentId;
    // Settling the task clears its claim fields; the refill must still recognize it.
    delete task.metadata.claimedBy;
    delete task.metadata.claimedAt;
    expect(cleanupRefillSourceMatches(task, agent, 'local')).toBe(true);
    task.metadata.totalSpawnCount = '2';
    expect(cleanupRefillSourceMatches(task, agent, 'local')).toBe(false);
  });

  it.each(['exact', 'different-head', 'fork', 'wrong-project', 'unmerged'])(
    'verifies GitLab merged heads and same-project identity: %s', async scenario => {
      const { task, agent } = fixture();
      task.metadata.analysisType = agent.metadata.taskAnalysisType = 'claim-issue-gitlab';
      branches.forEach((branch, index) => {
        const url = `https://gitlab.example.com/group/sub/project/-/merge_requests/${index + 1}`;
        forge.probes.set(branch, { readable: true, cli: 'glab', prState: 'MERGED', prNumber: index + 1, prUrl: url });
        forge.gitlab.set(index + 1, { state: 'merged', project_id: 17, source_project_id: 17, target_project_id: 17,
          source_branch: branch, target_branch: 'main', sha: heads[index], web_url: url, merged_at: complete });
      });
      if (scenario === 'different-head') forge.gitlab.get(2).sha = 'c'.repeat(40);
      if (scenario === 'fork') forge.gitlab.get(2).source_project_id = 18;
      if (scenario === 'wrong-project') forge.probes.get(branches[1]).prUrl = 'https://gitlab.example.com/group/other/-/merge_requests/2';
      if (scenario === 'unmerged') forge.gitlab.get(2).state = 'opened';
      expect(Boolean(await proveSwarmCleanupDelivery(task, agent, 'local'))).toBe(scenario === 'exact');
    });
});
