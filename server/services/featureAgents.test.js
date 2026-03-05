import { describe, it, expect } from 'vitest';

/**
 * Tests for feature agents pure logic.
 * Uses inline function copies to avoid complex mocking (same pattern as subAgentSpawner.test.js).
 */

const MIN_BACKOFF_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

describe('Feature Agent Backoff Calculation', () => {
  function calculateBackoff(consecutiveIdles) {
    return Math.min(
      MIN_BACKOFF_MS * Math.pow(2, consecutiveIdles - 1),
      MAX_BACKOFF_MS
    );
  }

  it('should start at 1 hour for first idle', () => {
    expect(calculateBackoff(1)).toBe(60 * 60 * 1000);
  });

  it('should double for each consecutive idle', () => {
    expect(calculateBackoff(2)).toBe(2 * 60 * 60 * 1000);
    expect(calculateBackoff(3)).toBe(4 * 60 * 60 * 1000);
  });

  it('should cap at 24 hours', () => {
    expect(calculateBackoff(10)).toBe(MAX_BACKOFF_MS);
    expect(calculateBackoff(100)).toBe(MAX_BACKOFF_MS);
  });
});

describe('Feature Agent Scheduling Logic', () => {
  function isDue(agent, now) {
    if (agent.status !== 'active') return false;
    if (agent.currentAgentId) return false;

    if (agent.backoff?.currentDelayMs) {
      const nextAllowed = new Date(agent.backoff.lastIdleAt).getTime() + agent.backoff.currentDelayMs;
      if (now < nextAllowed) return false;
    }

    const lastRun = agent.lastRunAt ? new Date(agent.lastRunAt).getTime() : 0;
    const mode = agent.schedule?.mode || 'continuous';

    if (mode === 'continuous') {
      const pause = agent.schedule?.pauseBetweenRunsMs || 60000;
      return now - lastRun >= pause;
    } else if (mode === 'interval') {
      const interval = agent.schedule?.intervalMs || 3600000;
      return now - lastRun >= interval;
    }
    return false;
  }

  const baseAgent = {
    status: 'active',
    currentAgentId: null,
    backoff: null,
    lastRunAt: null,
    schedule: { mode: 'continuous', pauseBetweenRunsMs: 60000 }
  };

  it('should be due when never run before', () => {
    expect(isDue(baseAgent, Date.now())).toBe(true);
  });

  it('should not be due when recently run (continuous)', () => {
    const agent = { ...baseAgent, lastRunAt: new Date().toISOString() };
    expect(isDue(agent, Date.now())).toBe(false);
  });

  it('should be due when pause elapsed (continuous)', () => {
    const agent = {
      ...baseAgent,
      lastRunAt: new Date(Date.now() - 120000).toISOString()
    };
    expect(isDue(agent, Date.now())).toBe(true);
  });

  it('should respect interval mode', () => {
    const agent = {
      ...baseAgent,
      schedule: { mode: 'interval', intervalMs: 3600000 },
      lastRunAt: new Date(Date.now() - 1800000).toISOString() // 30min ago
    };
    expect(isDue(agent, Date.now())).toBe(false);

    const oldAgent = {
      ...agent,
      lastRunAt: new Date(Date.now() - 7200000).toISOString() // 2h ago
    };
    expect(isDue(oldAgent, Date.now())).toBe(true);
  });

  it('should skip non-active agents', () => {
    expect(isDue({ ...baseAgent, status: 'draft' }, Date.now())).toBe(false);
    expect(isDue({ ...baseAgent, status: 'paused' }, Date.now())).toBe(false);
  });

  it('should skip agents already running', () => {
    const agent = { ...baseAgent, currentAgentId: 'agent-123' };
    expect(isDue(agent, Date.now())).toBe(false);
  });

  it('should skip agents in backoff', () => {
    const agent = {
      ...baseAgent,
      backoff: {
        currentDelayMs: 3600000,
        lastIdleAt: new Date().toISOString(),
        consecutiveIdles: 1
      }
    };
    expect(isDue(agent, Date.now())).toBe(false);
  });

  it('should allow agents past backoff window', () => {
    const agent = {
      ...baseAgent,
      backoff: {
        currentDelayMs: 3600000,
        lastIdleAt: new Date(Date.now() - 7200000).toISOString(),
        consecutiveIdles: 1
      }
    };
    expect(isDue(agent, Date.now())).toBe(true);
  });
});

describe('Feature Agent State Transitions', () => {
  function canResume(status) {
    return status === 'paused';
  }

  function canActivate(status) {
    return status !== 'active';
  }

  it('should only resume from paused', () => {
    expect(canResume('paused')).toBe(true);
    expect(canResume('active')).toBe(false);
    expect(canResume('draft')).toBe(false);
    expect(canResume('error')).toBe(false);
  });

  it('should activate from any non-active state', () => {
    expect(canActivate('draft')).toBe(true);
    expect(canActivate('paused')).toBe(true);
    expect(canActivate('active')).toBe(false);
  });
});

describe('Feature Agent Task Generation', () => {
  function generateTaskFromFeatureAgent(agent) {
    return {
      id: `fa-run-${agent.id}-${Date.now()}`,
      description: `[Feature Agent] ${agent.name}: ${agent.description}`,
      priority: agent.priority || 'MEDIUM',
      status: 'pending',
      taskType: 'internal',
      approvalRequired: false,
      metadata: {
        featureAgentId: agent.id,
        featureAgentRun: true,
        app: agent.appId,
        provider: agent.providerId || undefined,
        model: agent.model || undefined
      }
    };
  }

  const agent = {
    id: 'fa-abc123',
    name: 'UI Agent',
    description: 'Polish UI',
    priority: 'HIGH',
    appId: 'app-001',
    providerId: 'prov-1',
    model: 'opus'
  };

  it('should generate task with correct metadata', () => {
    const task = generateTaskFromFeatureAgent(agent);
    expect(task.metadata.featureAgentId).toBe('fa-abc123');
    expect(task.metadata.featureAgentRun).toBe(true);
    expect(task.metadata.app).toBe('app-001');
  });

  it('should use agent priority', () => {
    const task = generateTaskFromFeatureAgent(agent);
    expect(task.priority).toBe('HIGH');
  });

  it('should default to MEDIUM priority', () => {
    const task = generateTaskFromFeatureAgent({ ...agent, priority: undefined });
    expect(task.priority).toBe('MEDIUM');
  });

  it('should be an internal pending task', () => {
    const task = generateTaskFromFeatureAgent(agent);
    expect(task.taskType).toBe('internal');
    expect(task.status).toBe('pending');
    expect(task.approvalRequired).toBe(false);
  });

  it('should include feature agent description', () => {
    const task = generateTaskFromFeatureAgent(agent);
    expect(task.description).toContain('UI Agent');
    expect(task.description).toContain('Polish UI');
  });
});
