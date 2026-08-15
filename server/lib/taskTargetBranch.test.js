import { describe, expect, it } from 'vitest';
import { resolveTaskTargetBranch, shouldStripTaskTargetBranch } from './taskTargetBranch.js';

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
