import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  agent: null, task: null, state: null, schedule: null,
  valid: true, parked: false, automatic: true,
  request: vi.fn(), queue: vi.fn(), acknowledge: vi.fn(), mark: vi.fn(),
}));

vi.mock('./cosState.js', async original => ({ ...await original(),
  loadState: async () => f.state, isDaemonRunning: () => true,
  isImprovementEnabled: () => true, canQueueImprovementTasks: () => f.automatic,
}));
vi.mock('./cosTaskStore.js', async original => ({ ...await original(),
  getTaskById: async () => f.task, getCosTasks: async () => ({ tasks: [f.task] }),
}));
vi.mock('./cosTaskGenerator.js', async original => ({ ...await original(),
  queueEligibleImprovementTasks: (...args) => f.queue(...args),
}));
vi.mock('./cosAgentLifecycle.js', async original => ({ ...await original(),
  getAgentRecord: async () => f.agent,
  markSwarmCleanupContinuationIssued: (...args) => f.mark(...args),
}));
vi.mock('./instanceIdentity.js', async original => ({ ...await original(), getInstanceId: async () => 'local' }));
vi.mock('./swarmCleanupDelivery.js', () => ({
  cleanupRefillSourceMatches: () => f.valid, validCleanupRefillSource: async () => f.valid,
}));
vi.mock('./taskSchedule.js', async original => ({ ...await original(),
  loadSchedule: async () => f.schedule, isPerpetualParkActive: async () => f.parked,
  queuePerpetualRefill: (...args) => f.request(...args), acknowledgeSwarmCleanupRefill: (...args) => f.acknowledge(...args),
}));

import { perpetualRefillPlan } from './cos.js';
import { refillDeliveredCleanupSwarm } from './swarmCleanupRefill.js';
const refill = (agentId, options) => refillDeliveredCleanupSwarm(agentId, { refillPlan: perpetualRefillPlan, ...options });

beforeEach(() => {
  vi.clearAllMocks();
  f.valid = true; f.parked = false; f.automatic = true;
  f.state = { paused: false, agents: {}, config: {} };
  f.task = { id: 'source-task', status: 'in_progress', metadata: { app: 'app', analysisType: 'claim-issue' } };
  f.agent = { id: 'agent-source', taskId: f.task.id, metadata: { taskApp: 'app', taskAnalysisType: 'claim-issue',
    taskOnDemand: true, taskOnDemandOrigin: 'user', swarmCleanupDelivery: { version: 1, branches: [{ branch: 'claim/issue-1', head: 'a'.repeat(40) }] } } };
  f.schedule = { tasks: { 'claim-issue': { enabled: true, perpetual: true } } };
  f.request.mockResolvedValue({ id: 'request-1' });
  f.queue.mockResolvedValue({ continuationSatisfied: true });
  f.acknowledge.mockResolvedValue(true);
  f.mark.mockImplementation(async () => { f.agent.metadata.swarmCleanupDelivery.continuationIssued = true; return true; });
});

describe('cleanup-held swarm continuation', () => {
  it('continues the manual drain once and retains the cleanup task', async () => {
    const wake = vi.fn(async () => {});
    await Promise.all([refill('agent-source', { wake }), refill('agent-source', { wake })]);
    await refill('agent-source', { wake });
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith('claim-issue', 'app', { cleanupSourceAgentId: 'agent-source' });
    expect(f.acknowledge).toHaveBeenCalledWith('agent-source');
    expect(wake).toHaveBeenCalledOnce();
    expect(f.task.status).toBe('in_progress');
  });

  it('uses the scheduled admission path and keeps its app and task scope', async () => {
    f.agent.metadata.taskOnDemand = false;
    const wake = vi.fn(async () => {});
    await refill('agent-source', { wake });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.queue.mock.calls[0][2]).toMatchObject({ continuationSourceAgentId: 'agent-source',
      perpetualContinuation: { taskType: 'claim-issue', appId: 'app' } });
    expect(wake).toHaveBeenCalledOnce();
  });

  it.each(['unverified', 'paused', 'automatic-disabled', 'busy'])(
    'does not spend a continuation when its source or admission is %s', async condition => {
      if (condition === 'unverified') f.valid = false;
      if (condition === 'paused') f.state.paused = true;
      if (condition === 'automatic-disabled') { f.agent.metadata.taskOnDemand = false; f.automatic = false; }
      if (condition === 'busy') { f.agent.metadata.taskOnDemand = false; f.queue.mockResolvedValue({ continuationSatisfied: false }); }
      const wake = vi.fn(async () => {});
      await refill('agent-source', { wake });
      expect(f.mark).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
    });

  it('does not turn a quota burn into a backlog drain', async () => {
    f.agent.metadata.taskOnDemandOrigin = 'quota-burn';
    const wake = vi.fn(async () => {});
    await refill('agent-source', { wake });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.queue).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });
});
