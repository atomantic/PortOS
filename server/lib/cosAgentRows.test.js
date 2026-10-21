import { describe, expect, it, vi } from 'vitest';
import { agentRowColumns, planAgentSave } from './cosAgentRows.js';

describe('agentRowColumns', () => {
  it('projects columns from a full agent record', () => {
    const cols = agentRowColumns({
      taskId: 'task-1',
      status: 'running',
      startedAt: '2026-10-20T18:00:00.000Z',
      completedAt: '2026-10-20T18:05:00.000Z',
      pid: 12345,
    });
    expect(cols).toEqual({
      taskId: 'task-1',
      status: 'running',
      startedAt: '2026-10-20T18:00:00.000Z',
      completedAt: '2026-10-20T18:05:00.000Z',
      pid: 12345,
    });
  });

  it('handles null, undefined, or missing properties cleanly', () => {
    expect(agentRowColumns(null)).toEqual({
      taskId: null,
      status: 'unknown',
      startedAt: null,
      completedAt: null,
      pid: null,
    });
    expect(agentRowColumns({ pid: -1, startedAt: 'invalid-date' })).toEqual({
      taskId: null,
      status: 'unknown',
      startedAt: null,
      completedAt: null,
      pid: null,
    });
  });
});

describe('planAgentSave', () => {
  const agent = (n, extra = {}) => ({
    id: `agent-${n}`,
    status: 'running',
    output: [`line ${n}`],
    ...extra,
  });

  describe('unhinted save (changedAgentIds omitted)', () => {
    it('serializes all records and returns upserts for new/changed and deletes for missing', () => {
      const a1 = agent(1);
      const a2 = agent(2);
      const serializer = vi.fn(JSON.stringify);

      const first = planAgentSave({
        persisted: new Map(),
        next: { 'agent-1': a1, 'agent-2': a2 },
        serialize: serializer,
      });

      expect(serializer).toHaveBeenCalledTimes(2);
      expect(first.upserts.map((u) => u.id)).toEqual(['agent-1', 'agent-2']);
      expect(first.deletes).toEqual([]);

      // Second save: agent-1 unchanged, agent-2 modified, agent-3 added
      serializer.mockClear();
      const a2Modified = { ...a2, status: 'completed' };
      const a3 = agent(3);

      const second = planAgentSave({
        persisted: first.persisted,
        next: { 'agent-1': a1, 'agent-2': a2Modified, 'agent-3': a3 },
        serialize: serializer,
      });

      // All 3 were serialized to diff
      expect(serializer).toHaveBeenCalledTimes(3);
      // Only modified/added are upserted
      expect(second.upserts.map((u) => u.id)).toEqual(['agent-2', 'agent-3']);
      expect(second.deletes).toEqual([]);
    });

    it('identifies deleted records when absent or undefined in next', () => {
      const persisted = new Map([
        ['agent-1', JSON.stringify(agent(1))],
        ['agent-2', JSON.stringify(agent(2))],
      ]);

      const plan = planAgentSave({
        persisted,
        next: { 'agent-1': agent(1), 'agent-2': undefined },
      });

      expect(plan.deletes).toEqual(['agent-2']);
      expect(plan.upserts).toEqual([]);
      expect([...plan.persisted.keys()]).toEqual(['agent-1']);
    });
  });

  describe('hinted save (changedAgentIds provided)', () => {
    it('serializes only the hinted records and avoids serializing untouched records', () => {
      const a1 = agent(1);
      const a2 = agent(2);
      const a3 = agent(3);
      const persisted = new Map([
        ['agent-1', JSON.stringify(a1)],
        ['agent-2', JSON.stringify(a2)],
        ['agent-3', JSON.stringify(a3)],
      ]);

      const serializer = vi.fn(JSON.stringify);
      const a2Updated = { ...a2, output: ['new output'] };

      const plan = planAgentSave({
        persisted,
        next: { 'agent-1': a1, 'agent-2': a2Updated, 'agent-3': a3 },
        changedAgentIds: ['agent-2'],
        serialize: serializer,
      });

      // ONLY agent-2 was serialized! agent-1 and agent-3 were NOT serialized.
      expect(serializer).toHaveBeenCalledTimes(1);
      expect(serializer).toHaveBeenCalledWith(a2Updated);
      expect(plan.upserts.map((u) => u.id)).toEqual(['agent-2']);
      expect(plan.deletes).toEqual([]);
      expect(plan.persisted.get('agent-1')).toBe(persisted.get('agent-1'));
      expect(plan.persisted.get('agent-2')).toBe(JSON.stringify(a2Updated));
      expect(plan.persisted.get('agent-3')).toBe(persisted.get('agent-3'));
    });

    it('serializes newly added records even if omitted from changedAgentIds', () => {
      const a1 = agent(1);
      const persisted = new Map([['agent-1', JSON.stringify(a1)]]);

      const serializer = vi.fn(JSON.stringify);
      const a2New = agent(2);

      const plan = planAgentSave({
        persisted,
        next: { 'agent-1': a1, 'agent-2': a2New },
        changedAgentIds: [], // hint omitted a2New
        serialize: serializer,
      });

      // agent-2 was serialized because it is a newly added key
      expect(serializer).toHaveBeenCalledTimes(1);
      expect(serializer).toHaveBeenCalledWith(a2New);
      expect(plan.upserts.map((u) => u.id)).toEqual(['agent-2']);
      expect(plan.persisted.has('agent-2')).toBe(true);
    });

    it('deletes removed records even if omitted from changedAgentIds', () => {
      const a1 = agent(1);
      const a2 = agent(2);
      const persisted = new Map([
        ['agent-1', JSON.stringify(a1)],
        ['agent-2', JSON.stringify(a2)],
      ]);

      const serializer = vi.fn(JSON.stringify);
      const plan = planAgentSave({
        persisted,
        next: { 'agent-1': a1 }, // agent-2 removed
        changedAgentIds: ['agent-1'],
        serialize: serializer,
      });

      expect(serializer).toHaveBeenCalledTimes(1); // only agent-1 serialized
      expect(plan.deletes).toEqual(['agent-2']);
      expect(plan.persisted.has('agent-2')).toBe(false);
    });

    it('handles changedAgentIds as Set, Array, or single string', () => {
      const a1 = agent(1);
      const persisted = new Map([['agent-1', JSON.stringify(a1)]]);
      const updated = { ...a1, status: 'completed' };

      const plan1 = planAgentSave({
        persisted,
        next: { 'agent-1': updated },
        changedAgentIds: new Set(['agent-1']),
      });
      expect(plan1.upserts).toHaveLength(1);

      const plan2 = planAgentSave({
        persisted,
        next: { 'agent-1': updated },
        changedAgentIds: 'agent-1',
      });
      expect(plan2.upserts).toHaveLength(1);
    });

    it('a hint that omits a really-changed record cannot lose that change on the next unhinted save', () => {
      const a1 = agent(1);
      const a2 = agent(2);
      const persisted = new Map([
        ['agent-1', JSON.stringify(a1)],
        ['agent-2', JSON.stringify(a2)],
      ]);

      // Both records change in memory
      const a1Updated = { ...a1, status: 'completed' };
      const a2Updated = { ...a2, status: 'completed' };
      const workingSet = { 'agent-1': a1Updated, 'agent-2': a2Updated };

      // Step 1: Hinted save that only includes agent-1
      const hintedPlan = planAgentSave({
        persisted,
        next: workingSet,
        changedAgentIds: ['agent-1'],
      });

      expect(hintedPlan.upserts.map((u) => u.id)).toEqual(['agent-1']);
      // Notice: agent-2 in hintedPlan.persisted MUST still hold its OLD serialization!
      expect(hintedPlan.persisted.get('agent-2')).toBe(persisted.get('agent-2'));

      // Step 2: Unhinted save against the persisted map returned by step 1
      const unhintedPlan = planAgentSave({
        persisted: hintedPlan.persisted,
        next: workingSet,
      });

      // The unhinted save detects agent-2 as changed because it wasn't saved in step 1!
      expect(unhintedPlan.upserts.map((u) => u.id)).toEqual(['agent-2']);
      expect(unhintedPlan.persisted.get('agent-2')).toBe(JSON.stringify(a2Updated));
    });
  });
});
