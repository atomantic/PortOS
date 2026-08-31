import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cos.js', () => ({
  addTask: vi.fn().mockResolvedValue({ id: 'sys-1' }),
  getAllTasks: vi.fn().mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [] } }),
}));

const { addTask, getAllTasks } = await import('./cos.js');
const {
  fileInvestigationTask,
  investigationCircuitOpen,
  recentInvestigationCreations,
  resolveAutoInvestigationApproval,
  __resetInvestigationCircuit,
} = await import('./investigationTaskProducer.js');
const { INVESTIGATION_CIRCUIT_MAX_CREATIONS, INVESTIGATION_CIRCUIT_WINDOW_MS } = await import('../lib/investigationTasks.js');

const emptyBacklog = () => getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [] } });

const settledInvestigation = (fingerprint, agoMs = 60 * 60 * 1000) => ({
  id: 'sys-prior',
  status: 'completed',
  metadata: {
    isInvestigation: true,
    investigationFingerprint: fingerprint,
    updatedAt: new Date(Date.now() - agoMs).toISOString(),
  }
});

describe('fileInvestigationTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addTask.mockResolvedValue({ id: 'sys-1' });
    emptyBacklog();
    __resetInvestigationCircuit();
  });

  it('files unattended by default, with every marker the shared machinery reads', async () => {
    await fileInvestigationTask({
      fingerprint: 'auth-error:provider-failure:Example CLI',
      description: 'Investigate AI provider failure',
      priority: 'MEDIUM',
      affectedTasks: ['task-7'],
    });

    expect(addTask).toHaveBeenCalledWith({
      description: 'Investigate AI provider failure',
      priority: 'MEDIUM',
      useWorktree: true,
      openPR: true,
      prCompletion: 'merge-on-green',
      approvalRequired: false,
      approvalReason: null,
      isInvestigation: true,
      investigationFingerprint: 'auth-error:provider-failure:Example CLI',
      affectedTasks: ['task-7'],
    }, 'internal');
  });

  it('omits affectedTasks entirely when the failure has no originating task', async () => {
    await fileInvestigationTask({ fingerprint: 'unknown:critical-error:BOOM', description: 'Fix critical error' });
    expect(addTask.mock.calls[0][0]).not.toHaveProperty('affectedTasks');
  });

  it('holds for a human — and says why in the body — when the same cause is looping', async () => {
    getAllTasks.mockResolvedValue({
      user: { tasks: [] },
      cos: { tasks: [settledInvestigation('unknown:critical-error:BOOM')] }
    });

    const { approvalRequired, loopReason } = await fileInvestigationTask({
      fingerprint: 'unknown:critical-error:BOOM',
      description: 'Fix critical error',
    });

    expect({ approvalRequired, loopReason }).toEqual({ approvalRequired: true, loopReason: 'repeat-fingerprint' });
    expect(addTask.mock.calls[0][0]).toMatchObject({ approvalReason: 'investigation-loop:repeat-fingerprint' });
    expect(addTask.mock.calls[0][0].description).toContain('## Why this is held for you');
  });

  it('counts every producer against ONE storm counter', async () => {
    for (let i = 0; i < INVESTIGATION_CIRCUIT_MAX_CREATIONS; i++) {
      await fileInvestigationTask({ fingerprint: `unknown:critical-error:E${i}`, description: `Fix ${i}` });
    }
    expect(recentInvestigationCreations()).toBe(INVESTIGATION_CIRCUIT_MAX_CREATIONS);
    expect(investigationCircuitOpen()).toBe(true);
  });

  it('does not count a description-level duplicate as a new creation', async () => {
    addTask.mockResolvedValue({ id: 'sys-existing', duplicate: true });
    await fileInvestigationTask({ fingerprint: 'unknown:critical-error:BOOM', description: 'Fix critical error' });
    expect(recentInvestigationCreations()).toBe(0);
  });

  it('lets the circuit auto-close as creations age out of the window', async () => {
    await fileInvestigationTask({ fingerprint: 'unknown:critical-error:BOOM', description: 'Fix' });
    expect(recentInvestigationCreations()).toBe(1);
    expect(recentInvestigationCreations(Date.now() + INVESTIGATION_CIRCUIT_WINDOW_MS + 1)).toBe(0);
  });
});

describe('resolveAutoInvestigationApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetInvestigationCircuit();
  });

  it('fails OPEN to unattended when the backlog cannot be read', async () => {
    // A policy read that throws must never put the diagnosis back behind a human —
    // that stall is the whole thing this mechanism exists to remove.
    getAllTasks.mockRejectedValue(new Error('task file unreadable'));

    await expect(resolveAutoInvestigationApproval('unknown:task:none')).resolves.toMatchObject({
      approvalRequired: false, loopReason: null, approvalReason: null
    });
  });

  it('reuses a backlog the caller already read instead of reading it again', async () => {
    const verdict = await resolveAutoInvestigationApproval('unknown:critical-error:BOOM', {
      tasks: [settledInvestigation('unknown:critical-error:BOOM')]
    });

    expect(verdict.loopReason).toBe('repeat-fingerprint');
    expect(getAllTasks).not.toHaveBeenCalled();
  });
});
