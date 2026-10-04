import { describe, expect, it } from 'vitest';
import {
  CLAIM_AMBIGUOUS_OWNER_IDLE_MS,
  claimContinuationAdmission,
  claimContinuationBranch,
  claimContinuationPointer,
  claimContinuationWorkspace,
  claimOwnershipBinding,
} from './claimContinuation.js';

const ROOT = '/data/cos/worktrees';
const CLAIM = `${ROOT}/claim-portos-issue-42`;

describe('claimContinuationBranch', () => {
  it('names a GitHub or GitLab issue branch and a JIRA or plan branch', () => {
    expect(claimContinuationBranch('42')).toBe('claim/issue-42');
    expect(claimContinuationBranch('ACME-9')).toBe('claim/ACME-9');
    expect(claimContinuationBranch('fix-the-thing')).toBe('claim/fix-the-thing');
  });

  it('rejects a ref that is not a claim branch name', () => {
    expect(claimContinuationBranch('')).toBeNull();
    expect(claimContinuationBranch('12; rm')).toBeNull();
    expect(claimContinuationBranch(null)).toBeNull();
  });
});

describe('claimContinuationPointer', () => {
  const task = { id: 'task-1', metadata: { claimFlow: true, claimTarget: '42' } };
  const holder = { path: CLAIM, branch: 'refs/heads/claim/issue-42' };

  it('hands a relaunch the claim worktree the previous run left behind', () => {
    expect(claimContinuationPointer({
      task, agentId: 'agent-old', worktrees: [holder], agents: [], worktreesRoot: ROOT,
    })).toEqual({
      existingBranch: 'claim/issue-42',
      resumedFromAgentId: 'agent-old',
      resumeWorktreePath: CLAIM,
      claimResumeInPlace: true,
    });
  });

  it('leaves the relaunch clean when another live agent is in that worktree', () => {
    expect(claimContinuationPointer({
      task,
      agentId: 'agent-old',
      worktrees: [holder],
      agents: [{ id: 'agent-other', status: 'running', metadata: { workspacePath: CLAIM } }],
      worktreesRoot: ROOT,
    })).toBeNull();
  });

  it('ignores the predecessor itself, a lock, and a tree outside the claim root', () => {
    expect(claimContinuationPointer({
      task,
      agentId: 'agent-old',
      worktrees: [holder],
      agents: [{ id: 'agent-old', status: 'paused', workspacePath: CLAIM }],
      worktreesRoot: ROOT,
    })?.claimResumeInPlace).toBe(true);

    expect(claimContinuationPointer({
      task, agentId: 'agent-old', worktrees: [{ ...holder, locked: true }], agents: [], worktreesRoot: ROOT,
    })).toBeNull();

    expect(claimContinuationPointer({
      task,
      agentId: 'agent-old',
      worktrees: [{ path: '/elsewhere/claim-portos-issue-42', branch: 'refs/heads/claim/issue-42' }],
      agents: [],
      worktreesRoot: ROOT,
    })).toBeNull();
  });

  it('leaves the relaunch clean when a live agent registered this claim branch', () => {
    expect(claimContinuationPointer({
      task,
      agentId: 'agent-old',
      worktrees: [holder],
      agents: [{ id: 'agent-other', status: 'running', metadata: { claimBranch: 'claim/issue-42' } }],
      worktreesRoot: ROOT,
    })).toBeNull();
  });

  it('does nothing for a task that is not a pinned claim', () => {
    expect(claimContinuationPointer({
      task: { metadata: { claimFlow: true } },
      agentId: 'agent-old',
      worktrees: [holder],
      agents: [],
      worktreesRoot: ROOT,
    })).toBeNull();
  });
});

describe('claimContinuationWorkspace', () => {
  it('uses the claim directory in place when it is still on disk', () => {
    const workspace = claimContinuationWorkspace({
      metadata: {
        claimResumeInPlace: true,
        existingBranch: 'claim/issue-42',
        resumeWorktreePath: CLAIM,
      },
      pathExists: (path) => path === CLAIM,
      worktreesRoot: ROOT,
    });
    expect(workspace.workspacePath).toBe(CLAIM);
    expect(workspace.worktreeInfo.claimResumeInPlace).toBe(true);
    expect(workspace.worktreeInfo.branchName).toBe('claim/issue-42');
  });

  it('stays off the path when the directory is gone', () => {
    expect(claimContinuationWorkspace({
      metadata: { claimResumeInPlace: 'true', existingBranch: 'claim/issue-42', resumeWorktreePath: CLAIM },
      pathExists: () => false,
      worktreesRoot: ROOT,
    })).toBeNull();
  });
});

describe('claimOwnershipBinding', () => {
  it('binds a pinned claim run to its exact branch', () => {
    expect(claimOwnershipBinding({ metadata: { claimFlow: 'true', claimTarget: '42' } }))
      .toEqual({ claimBranch: 'claim/issue-42', claimPicksOwnBranch: false });
  });

  it('marks an unpinned claim run (issue picker or swarm orchestrator) as picking its own branch', () => {
    expect(claimOwnershipBinding({ metadata: { claimFlow: true, swarmCount: 4 } }))
      .toEqual({ claimBranch: null, claimPicksOwnBranch: true });
  });

  it('registers nothing for a task that is not a claim flow', () => {
    expect(claimOwnershipBinding({ metadata: { claimTarget: '42' } })).toBeNull();
  });
});

// The ownership race from the swarm collision: a pointer is made while the
// checkout is idle, then an owner appears. Each case is a synthetic two-owner
// lifecycle — no live process or instance data.
describe('claimContinuationAdmission', () => {
  const SOURCE = '/repos/app-x';
  const task = { id: 'task-1', metadata: { claimFlow: true, claimTarget: '42' } };
  const holder = { path: CLAIM, branch: 'refs/heads/claim/issue-42' };
  const pointer = claimContinuationPointer({
    task, agentId: 'agent-dead', worktrees: [holder], agents: [], worktreesRoot: ROOT, sourceWorkspace: SOURCE,
  });
  const metadata = { ...pointer, resumedFromAgentId: 'agent-dead' };
  const admit = (overrides = {}) => claimContinuationAdmission({
    metadata, agentId: 'agent-new', sourceWorkspace: SOURCE, worktrees: [holder], agents: [], holderIdleMs: null, ...overrides,
  });

  it('admits a surviving claim whose previous owner is gone', () => {
    expect(pointer).not.toBeNull();
    expect(admit()).toEqual({ admit: true });
    expect(admit({
      agents: [{ id: 'agent-dead', status: 'paused', metadata: { claimBranch: 'claim/issue-42' } }],
    })).toEqual({ admit: true });
  });

  it('refuses once a running or paused owner registers the branch after the pointer was made', () => {
    for (const status of ['running', 'paused']) {
      expect(admit({
        agents: [{ id: 'agent-other', status, metadata: { claimBranch: 'claim/issue-42', sourceWorkspace: SOURCE } }],
      })).toEqual({ admit: false, reason: 'owner-active' });
    }
  });

  it('refuses when another agent works inside the checkout', () => {
    expect(admit({
      agents: [{ id: 'agent-other', status: 'running', metadata: { workspacePath: `${CLAIM}/server` } }],
    })).toEqual({ admit: false, reason: 'owner-active' });
  });

  it('ignores a completed owner and one bound to a different branch', () => {
    expect(admit({
      agents: [
        { id: 'agent-a', status: 'completed', metadata: { claimBranch: 'claim/issue-42' } },
        { id: 'agent-b', status: 'running', metadata: { claimBranch: 'claim/issue-43' } },
      ],
    })).toEqual({ admit: true });
  });

  describe('a swarm orchestrator whose children cut their own trees', () => {
    const orchestrator = {
      id: 'agent-swarm', status: 'running', metadata: { claimPicksOwnBranch: true, sourceWorkspace: SOURCE },
    };

    it('refuses while the checkout shows recent activity or its idleness is unknown', () => {
      expect(admit({ agents: [orchestrator], holderIdleMs: 30_000 })).toEqual({ admit: false, reason: 'owner-ambiguous' });
      expect(admit({ agents: [orchestrator], holderIdleMs: null })).toEqual({ admit: false, reason: 'owner-ambiguous' });
    });

    it('admits once the checkout has been quiet past the idle window', () => {
      expect(admit({ agents: [orchestrator], holderIdleMs: CLAIM_AMBIGUOUS_OWNER_IDLE_MS })).toEqual({ admit: true });
    });

    it('does not suspect an orchestrator working in a different repository', () => {
      const elsewhere = { ...orchestrator, metadata: { ...orchestrator.metadata, sourceWorkspace: '/repos/other' } };
      expect(admit({ agents: [elsewhere] })).toEqual({ admit: true });
    });

    it('refuses a registered owner at any idleness', () => {
      expect(admit({
        agents: [orchestrator, { id: 'agent-other', status: 'running', metadata: { claimBranch: 'claim/issue-42' } }],
        holderIdleMs: Number.MAX_SAFE_INTEGER,
      })).toEqual({ admit: false, reason: 'owner-active' });
    });
  });

  it('fails closed on unreadable ownership, a vanished holder, or a changed branch', () => {
    expect(admit({ agents: null })).toEqual({ admit: false, reason: 'ownership-unreadable' });
    expect(admit({ worktrees: null })).toEqual({ admit: false, reason: 'ownership-unreadable' });
    expect(admit({ worktrees: [] })).toEqual({ admit: false, reason: 'holder-missing' });
    expect(admit({ worktrees: [{ path: CLAIM, branch: 'refs/heads/claim/issue-43' }] }))
      .toEqual({ admit: false, reason: 'branch-changed' });
    expect(admit({ worktrees: [{ path: CLAIM, detached: true }] })).toEqual({ admit: false, reason: 'branch-changed' });
    expect(admit({ worktrees: [{ ...holder, locked: true }] })).toEqual({ admit: false, reason: 'holder-locked' });
    expect(admit({ metadata: { ...metadata, resumeWorktreePath: undefined } }))
      .toEqual({ admit: false, reason: 'pointer-incomplete' });
  });
});
