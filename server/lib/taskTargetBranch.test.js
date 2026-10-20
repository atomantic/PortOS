import { describe, expect, it } from 'vitest';
import { resolveTaskTargetBranch, resolveTaskRemoteBranch, shouldStripTaskTargetBranch } from './taskTargetBranch.js';

describe('task target branch', () => {
  it('prefers a retry or legacy explicit pointer', () => {
    expect(resolveTaskTargetBranch({
      existingBranch: 'cos/task-1/agent-1',
      reviewLoopFollowUp: true,
      reviewLoopPRBranch: 'cos/task-2/agent-2',
    })).toBe('cos/task-1/agent-1');
  });

  it('uses the canonical review-loop branch when no legacy duplicate exists', () => {
    expect(resolveTaskTargetBranch({
      reviewLoopFollowUp: true,
      reviewLoopPRBranch: 'cos/task-1/agent-1',
    })).toBe('cos/task-1/agent-1');
    expect(resolveTaskTargetBranch({
      reviewLoopFollowUp: 'true',
      reviewLoopPRBranch: 'cos/task-1/agent-1',
    })).toBe('cos/task-1/agent-1');
  });

  it('does not attach an original task merely because it carries PR metadata', () => {
    expect(resolveTaskTargetBranch({ reviewLoopPRBranch: 'cos/task-1/agent-1' })).toBeNull();
    expect(resolveTaskTargetBranch({ reviewLoopFollowUp: false, reviewLoopPRBranch: 'cos/task-1/agent-1' })).toBeNull();
  });

  it('strips only a retry-owned pointer at a terminal transition', () => {
    expect(shouldStripTaskTargetBranch({ resumedFromAgentId: 'agent-1' })).toBe(true);
    expect(shouldStripTaskTargetBranch({ reviewLoopFollowUp: true, reviewLoopPRBranch: 'cos/task-1/agent-1' })).toBe(false);
    expect(shouldStripTaskTargetBranch({ existingBranch: 'feature/x' })).toBe(false);
  });
});

// Local ownership and remote publication must remain distinct across persisted retries.
it('keeps fork PR identity stable through retry pointers and terminal stripping', () => {
  const metadata = { reviewLoopFollowUp: true, reviewLoopPRBranch: 'main',
    forkHead: { remoteUrl: 'https://github.com/contributor/example.git', ownerLogin: 'contributor' } };
  expect(resolveTaskTargetBranch(metadata)).toBe('fork/contributor/main');
  expect(resolveTaskRemoteBranch(metadata)).toBe('main');
  const retry = { ...metadata, existingBranch: 'fork/contributor/main', resumedFromAgentId: 'agent-before' };
  expect(resolveTaskTargetBranch(retry)).toBe('fork/contributor/main');
  expect(resolveTaskRemoteBranch(retry)).toBe('main');
  expect(shouldStripTaskTargetBranch(retry)).toBe(true);
  delete retry.existingBranch;
  expect(resolveTaskTargetBranch(retry)).toBe('fork/contributor/main');
  expect(resolveTaskRemoteBranch(retry)).toBe('main');
});
