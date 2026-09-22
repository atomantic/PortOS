import { describe, expect, it } from 'vitest';
import { claimContinuationBranch, claimContinuationPointer, claimContinuationWorkspace } from './claimContinuation.js';

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
