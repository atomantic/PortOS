import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

/**
 * Tests for feature agents scheduling and task generation.
 */

const tempRoot = createTempDataRoot('portos-feature-agent-due-');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});
vi.mock('./cos/cosTaskStore.js', () => ({ addTask: vi.fn() }));
vi.mock('./cos/cos.js', () => ({ forceSpawnTask: vi.fn() }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn() }));

const { generateTaskFromFeatureAgent, getDueFeatureAgents } = await import('./featureAgents.js');

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('Feature Agent Scheduling (getDueFeatureAgents)', () => {
  const baseAgent = {
    id: 'fa-sched',
    status: 'active',
    currentAgentId: null,
    lastRunAt: null,
    schedule: { mode: 'continuous', pauseBetweenRunsMs: 60000 }
  };

  const isDue = async (agent) => {
    mkdirSync(join(tempRoot, 'cos'), { recursive: true });
    writeFileSync(join(tempRoot, 'cos', 'feature-agents.json'), JSON.stringify({ version: 1, agents: [agent] }));
    return (await getDueFeatureAgents()).some(a => a.id === agent.id);
  };

  it('should be due when never run before', async () => {
    expect(await isDue(baseAgent)).toBe(true);
  });

  it('should not be due when recently run (continuous)', async () => {
    expect(await isDue({ ...baseAgent, lastRunAt: new Date().toISOString() })).toBe(false);
  });

  it('should be due when pause elapsed (continuous)', async () => {
    expect(await isDue({ ...baseAgent, lastRunAt: new Date(Date.now() - 120000).toISOString() })).toBe(true);
  });

  it('should respect interval mode', async () => {
    const agent = {
      ...baseAgent,
      schedule: { mode: 'interval', intervalMs: 3600000 },
      lastRunAt: new Date(Date.now() - 1800000).toISOString() // 30min ago
    };
    expect(await isDue(agent)).toBe(false);
    expect(await isDue({ ...agent, lastRunAt: new Date(Date.now() - 7200000).toISOString() })).toBe(true);
  });

  it('should skip non-active agents', async () => {
    expect(await isDue({ ...baseAgent, status: 'draft' })).toBe(false);
    expect(await isDue({ ...baseAgent, status: 'paused' })).toBe(false);
  });

  it('should skip standby agents', async () => {
    expect(await isDue({ ...baseAgent, autonomyLevel: 'standby' })).toBe(false);
  });

  it('should skip agents already running', async () => {
    expect(await isDue({ ...baseAgent, currentAgentId: 'agent-123' })).toBe(false);
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
  const agent = {
    id: 'fa-abc123',
    name: 'UI Agent',
    description: 'Polish UI',
    priority: 'HIGH',
    appId: 'app-001',
    providerId: 'prov-1',
    model: 'opus',
    effort: 'high'
  };

  it('should generate task with correct metadata', () => {
    const task = generateTaskFromFeatureAgent(agent);
    expect(task.metadata.featureAgentId).toBe('fa-abc123');
    expect(task.metadata.featureAgentRun).toBe(true);
    expect(task.metadata.app).toBe('app-001');
    expect(task.metadata.effort).toBe('high');
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
