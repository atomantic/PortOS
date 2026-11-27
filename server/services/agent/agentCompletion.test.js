import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../cos/cosAgentLifecycle.js', () => ({
  updateAgent: vi.fn().mockResolvedValue(undefined)
}));
// getConfig moved to cosState.js (cos.js re-exports it) to break an import
// cycle, and agentCompletion.js imports it from there — so this mock has to
// name cosState.js or it intercepts nothing and the real loadState() runs,
// reading data/cos/ and asserting against the running install's config.
// importOriginal keeps cosState's other exports intact; only getConfig is stubbed.
vi.mock('../cos/cosState.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getConfig: vi.fn().mockResolvedValue({ appReviewCooldownMs: 1800000 })
}));
vi.mock('../appActivity.js', () => ({
  startAppCooldown: vi.fn().mockResolvedValue(undefined),
  updateAppActivity: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../cos/cosEvents.js', () => ({
  emitLog: vi.fn()
}));
vi.mock('../memoryExtractor.js', () => ({
  extractAndStoreMemories: vi.fn().mockResolvedValue({ created: 0, pendingApproval: 0 })
}));
vi.mock('../malwareScanReports.js', () => ({
  finalizeMalwareScan: vi.fn().mockResolvedValue(null)
}));

import { processAgentCompletion } from './agentCompletion.js';
import * as appActivity from '../appActivity.js';
import { updateAgent } from '../cos/cosAgentLifecycle.js';
import { getConfig } from '../cos/cosState.js';
import { extractAndStoreMemories } from '../memoryExtractor.js';

describe('processAgentCompletion - memory extraction', () => {
  const agentId = 'agent-memory-test';
  const task = {
    id: 'task-memory-test',
    description: 'Review the sample report',
    metadata: { app: 'example-app' }
  };
  const output = 'The sample report includes a written decision log, clear review deadlines, and an owner for each follow-up.';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { created: 2, pendingApproval: 0 },
    { created: 0, pendingApproval: 3 }
  ])('persists nonempty extraction counts (%j)', async counts => {
    extractAndStoreMemories.mockResolvedValueOnce(counts);

    await processAgentCompletion(agentId, task, true, output);

    expect(extractAndStoreMemories).toHaveBeenCalledExactlyOnceWith(agentId, task.id, output, task);
    expect(updateAgent).toHaveBeenCalledExactlyOnceWith(agentId, {
      memoryExtraction: { ...counts, extractedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) }
    });
  });

  it('starts the app cooldown even if memory extraction rejects', async () => {
    extractAndStoreMemories.mockRejectedValueOnce(new Error('Memory storage unavailable'));

    await processAgentCompletion(agentId, task, true, output);

    expect(extractAndStoreMemories).toHaveBeenCalledExactlyOnceWith(agentId, task.id, output, task);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(appActivity.startAppCooldown).toHaveBeenCalledExactlyOnceWith('example-app', 1800000);
  });

  it.each([
    { claimFlow: 'true' },
    { analysisType: 'claim-issue' },
    { taskAnalysisType: 'claim-issue-gitlab' },
  ])('does not learn from a claim transcript (%j)', async metadata => {
    await processAgentCompletion(agentId, { ...task, metadata: { ...task.metadata, ...metadata } }, true, 'transcript '.repeat(30));
    expect(extractAndStoreMemories).not.toHaveBeenCalled();
    expect(appActivity.startAppCooldown).toHaveBeenCalledWith('example-app', 1800000);
  });

  it('does not extract memories from a failed run with long output', async () => {
    await processAgentCompletion(agentId, task, false, 'x'.repeat(200));
    expect(extractAndStoreMemories).not.toHaveBeenCalled();
  });

  it('does not extract memories from successful output at or below the minimum length', async () => {
    await processAgentCompletion(agentId, task, true, 'x'.repeat(100));
    expect(extractAndStoreMemories).not.toHaveBeenCalled();
  });
});

describe('processAgentCompletion - cooldown handling for recovery tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps private assessment output out of memory extraction and app improvement scoring', async () => {
    await processAgentCompletion('agent-private-test', {
      metadata: { analysisType: 'private-security-assessment', app: 'example' },
    }, true, 'private evidence '.repeat(20));
    expect(extractAndStoreMemories).not.toHaveBeenCalled();
    expect(appActivity.startAppCooldown).not.toHaveBeenCalled();
  });

  it('bumps cooldown for normal app improvement tasks', async () => {
    const task = {
      id: 'sys-abc',
      description: '[App Improvement: PortOS] Code Quality Review',
      metadata: { app: 'portos-default' }
    };
    await processAgentCompletion('agent-1', task, true, 'output text...');

    expect(appActivity.startAppCooldown).toHaveBeenCalledWith('portos-default', 1800000);
  });

  it('preserves an explicit zero app review cooldown', async () => {
    getConfig.mockResolvedValueOnce({ appReviewCooldownMs: 0 });
    const task = {
      id: 'sys-zero-cooldown',
      description: '[App Improvement: Example App] Code Quality Review',
      metadata: { app: 'example-app' }
    };

    await processAgentCompletion('agent-zero', task, true, 'output');

    expect(appActivity.startAppCooldown).toHaveBeenCalledWith('example-app', 0);
  });

  it('does NOT bump cooldown when task.metadata.isRecovery is true', async () => {
    const task = {
      id: 'task-xyz',
      description: '[Recovery] Investigate and retry failed PR for branch foo',
      metadata: { app: 'portos-default', isRecovery: true }
    };
    await processAgentCompletion('agent-2', task, true, 'output');

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

    expect(appActivity.startAppCooldown).not.toHaveBeenCalled();
  });

  it('still bumps cooldown when description merely mentions recovery (not at start)', async () => {
    const task = {
      id: 'sys-mentions',
      description: 'Improve test coverage and document the [Recovery] flow',
      metadata: { app: 'some-app' }
    };
    await processAgentCompletion('agent-4', task, true, 'output');

    expect(appActivity.startAppCooldown).toHaveBeenCalled();
  });

  it('skips cooldown logic entirely for tasks without an app', async () => {
    const task = {
      id: 'task-no-app',
      description: 'Generic user task',
      metadata: {}
    };
    await processAgentCompletion('agent-5', task, true, 'output');

    expect(appActivity.startAppCooldown).not.toHaveBeenCalled();
  });
});
