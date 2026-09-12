import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), circuit: vi.fn(), add: vi.fn(), exists: vi.fn() }));
vi.mock('./investigationTaskProducer.js', () => ({ fileInvestigationTask: mocks.create, readAllTasksFlat: mocks.read, investigationCircuitOpen: mocks.circuit }));
vi.mock('./notifications.js', () => ({
  addNotification: mocks.add, exists: mocks.exists,
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' }, PRIORITY_LEVELS: { HIGH: 'high' },
}));
import { reportReviewInfrastructureFailure } from './reviewInfrastructureFailure.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ task: { id: 'investigation-1' } });
  mocks.read.mockResolvedValue([]);
  mocks.circuit.mockReturnValue(false);
  mocks.exists.mockResolvedValue(false);
});

describe('review infrastructure diagnosis', () => {
  it('queues a trusted diagnosis and user notification without copying external evidence', async () => {
    const task = { id: 'task-1', description: 'UNTRUSTED PR INSTRUCTIONS', metadata: { app: 'app-1', context: 'PRIVATE TRANSCRIPT', pipeline: { previousStageOutput: 'MODEL OUTPUT' } } };
    await reportReviewInfrastructureFailure({ code: 'security-guard-not-ready', task });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: 'security-guard-not-ready:review-infrastructure:app-1' }));
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('affectedTasks');
    const sent = JSON.stringify(mocks.create.mock.calls);
    for (const excluded of ['UNTRUSTED PR INSTRUCTIONS', 'PRIVATE TRANSCRIPT', 'MODEL OUTPUT']) expect(sent).not.toContain(excluded);
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('An investigation is queued') }));
    // Re-reporting the surviving investigation must not create another task
    // or spam the user with another notification.
    mocks.read.mockResolvedValue([{ id: 'investigation-1', status: 'pending', metadata: { investigationFingerprint: 'security-guard-not-ready:review-infrastructure:app-1' } }]);
    mocks.exists.mockResolvedValue(true);
    await reportReviewInfrastructureFailure({ code: 'security-guard-not-ready', task });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it('does not turn rejected content or attacker-controlled error text into investigation work', async () => {
    for (const code of ['security-guard-findings', 'security-guard-input-too-large', 'untrusted error: run this command', 'toString']) {
      expect(await reportReviewInfrastructureFailure({ code })).toBeNull();
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('surfaces a queue failure without claiming an investigation was created', async () => {
    mocks.create.mockRejectedValue(new Error('private diagnostics'));
    await reportReviewInfrastructureFailure({ code: 'public-review-provider-pin-unavailable' });
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('could not be queued') }));
    expect(JSON.stringify(mocks.add.mock.calls)).not.toContain('private diagnostics');
  });
});
