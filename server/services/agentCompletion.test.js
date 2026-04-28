import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('./cosAgents.js', () => ({
  updateAgent: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('./cos.js', () => ({
  getConfig: vi.fn().mockResolvedValue({ appReviewCooldownMs: 1800000 })
}));
vi.mock('./appActivity.js', () => ({
  startAppCooldown: vi.fn().mockResolvedValue(undefined),
  markAppReviewCompleted: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('./cosEvents.js', () => ({
  emitLog: vi.fn()
}));
vi.mock('./memoryExtractor.js', () => ({
  extractAndStoreMemories: vi.fn().mockResolvedValue({ created: 0, pendingApproval: 0 })
}));

import { processAgentCompletion } from './agentCompletion.js';
import * as appActivity from './appActivity.js';

describe('processAgentCompletion - cooldown handling for recovery tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bumps cooldown for normal app improvement tasks', async () => {
    const task = {
      id: 'sys-abc',
      description: '[App Improvement: PortOS] Code Quality Review',
      metadata: { app: 'portos-default' }
    };
    await processAgentCompletion('agent-1', task, true, 'output text...');

    expect(appActivity.markAppReviewCompleted).toHaveBeenCalledWith('portos-default', 1, 1);
    expect(appActivity.startAppCooldown).toHaveBeenCalledWith('portos-default', 1800000);
  });

  it('does NOT bump cooldown when task.metadata.isRecovery is true', async () => {
    const task = {
      id: 'task-xyz',
      description: '[Recovery] Investigate and retry failed PR for branch foo',
      metadata: { app: 'portos-default', isRecovery: true }
    };
    await processAgentCompletion('agent-2', task, true, 'output');

    expect(appActivity.markAppReviewCompleted).not.toHaveBeenCalled();
    expect(appActivity.startAppCooldown).not.toHaveBeenCalled();
  });

  it('does NOT bump cooldown when description starts with [Recovery] (back-compat)', async () => {
    // Existing in-flight tasks created before isRecovery metadata was added
    const task = {
      id: 'task-legacy',
      description: '[Recovery] Resolve merge conflict and clean up stale branch foo in BarnHub',
      metadata: { app: 'barnhub-app-id' } // no isRecovery flag
    };
    await processAgentCompletion('agent-3', task, true, 'output');

    expect(appActivity.markAppReviewCompleted).not.toHaveBeenCalled();
    expect(appActivity.startAppCooldown).not.toHaveBeenCalled();
  });

  it('still bumps cooldown when description merely mentions recovery (not at start)', async () => {
    const task = {
      id: 'sys-mentions',
      description: 'Improve test coverage and document the [Recovery] flow',
      metadata: { app: 'some-app' }
    };
    await processAgentCompletion('agent-4', task, true, 'output');

    expect(appActivity.markAppReviewCompleted).toHaveBeenCalled();
    expect(appActivity.startAppCooldown).toHaveBeenCalled();
  });

  it('skips cooldown logic entirely for tasks without an app', async () => {
    const task = {
      id: 'task-no-app',
      description: 'Generic user task',
      metadata: {}
    };
    await processAgentCompletion('agent-5', task, true, 'output');

    expect(appActivity.markAppReviewCompleted).not.toHaveBeenCalled();
    expect(appActivity.startAppCooldown).not.toHaveBeenCalled();
  });
});
