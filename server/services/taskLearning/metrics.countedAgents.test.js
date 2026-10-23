import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-in for learning.json so the real recordTaskCompletion /
// backfillFromHistory run end to end without touching the install's data.
const mem = vi.hoisted(() => ({ data: null }));

vi.mock('./store.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    loadLearningData: vi.fn(async () => structuredClone(mem.data)),
    saveLearningData: vi.fn(async (d) => { mem.data = structuredClone(d); }),
  };
});
vi.mock('../cosAgentLifecycle.js', () => ({ getAgents: vi.fn(async () => mem.agents) }));
vi.mock('../layeredIntelligenceOutcomes.js', () => ({ recordProposalExecution: vi.fn(async () => {}) }));

import { recordTaskCompletion } from './metrics.js';
import { backfillFromHistory } from './lifecycle.js';
import { COUNTED_AGENT_IDS_CAP } from './store.js';

const agent = (id, success = true) => ({
  id,
  status: 'completed',
  taskId: `task-${id}`,
  metadata: { taskType: 'internal', modelTier: 'medium', taskDescription: `task ${id}` },
  result: { success, duration: 1000 },
});
const taskOf = (a) => ({ id: a.taskId, description: a.metadata.taskDescription, taskType: a.metadata.taskType, metadata: a.metadata });
const freshData = () => ({
  version: 2, byTaskType: {}, byTaskTypeExecution: {}, byModelTier: {}, errorPatterns: {},
  failureSignatures: {}, routingAccuracy: {}, environmentalFailures: {}, correlationWindow: [],
  totals: { completed: 0, succeeded: 0, failed: 0, totalDurationMs: 0, avgDurationMs: 0 },
});

describe('completion ledger (#13095)', () => {
  beforeEach(() => {
    mem.data = freshData();
    mem.agents = [];
  });

  it('running backfill twice leaves the metrics identical to running it once', async () => {
    mem.agents = [agent('a1'), agent('a2', false), agent('a3')];
    expect(await backfillFromHistory()).toBe(3);
    const once = structuredClone(mem.data);
    expect(once.totals.completed).toBe(3);

    expect(await backfillFromHistory()).toBe(0);
    expect(mem.data).toEqual(once);
  });

  it('a live completion does not double-count an agent a backfill already counted, and vice versa', async () => {
    const a = agent('a1');
    mem.agents = [a];
    await backfillFromHistory();
    await recordTaskCompletion(a, taskOf(a));
    expect(mem.data.totals.completed).toBe(1);

    const b = agent('b1');
    await recordTaskCompletion(b, taskOf(b));
    mem.agents = [b];
    expect(await backfillFromHistory()).toBe(0);
    expect(mem.data.totals.completed).toBe(2);
    expect(Object.values(mem.data.byTaskType)[0].completed).toBe(2);
  });

  it('bounds the ledger to the newest ids', async () => {
    mem.data.countedAgentIds = Array.from({ length: COUNTED_AGENT_IDS_CAP }, (_, i) => `old-${i}`);
    const a = agent('fresh');
    await recordTaskCompletion(a, taskOf(a));
    expect(mem.data.countedAgentIds).toHaveLength(COUNTED_AGENT_IDS_CAP);
    expect(mem.data.countedAgentIds.at(-1)).toBe('fresh');
    expect(mem.data.countedAgentIds[0]).toBe('old-1');
  });
});
