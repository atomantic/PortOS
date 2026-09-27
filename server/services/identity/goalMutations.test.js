import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';

const h = vi.hoisted(() => ({ document: null, readBarrier: null, aiBarrier: null, mirror: null }));
// Detached snapshots reproduce real read/modify/write races without touching a
// filesystem, database, provider, or the user's MortalLoom store.
vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { digitalTwin: '/isolated-test/digital-twin' },
  ensureDir: async () => {},
  readJSONFileStrict: async path => {
    const value = path.endsWith('goals.json') ? structuredClone(h.document) : {};
    const barrier = path.endsWith('goals.json') && h.readBarrier;
    if (barrier) {
      h.readBarrier = null;
      barrier.entered.resolve();
      await barrier.release.promise;
    }
    return { ok: true, value };
  },
  readJSONFile: async () => structuredClone(h.document),
  atomicWrite: vi.fn(async (_path, value) => { h.document = structuredClone(value); })
}));
vi.mock('../mortalLoomStore.js', () => ({
  isMortalLoomEnabled: async () => h.mirror !== null,
  mlArrayIfEnabled: async () => structuredClone(h.mirror),
  mlReplace: vi.fn(async (_key, goals) => { h.mirror = structuredClone(goals); })
}));
vi.mock('../meatspaceCalendar.js', () => ({ getActivities: async () => [] }));
vi.mock('../genome.js', () => ({ getGenomeSummary: async () => null }));
vi.mock('../providers.js', () => ({ getActiveProvider: async () => ({ defaultModel: 'example' }), getProviderById: async () => null }));
vi.mock('../aiProvider.js', () => ({
  parseLLMJSON: JSON.parse,
  callProviderAISimple: async () => {
    h.aiBarrier.entered.resolve();
    await h.aiBarrier.release.promise;
    return { text: JSON.stringify({ status: 'on-track', assessment: 'Example assessment' }) };
  }
}));

import { atomicWrite } from '../../lib/fileUtils.js';
import { mutateGoals } from './store.js';
import * as goals from './goals.js';
import * as todos from './todos.js';

const barrier = () => ({ entered: Promise.withResolvers(), release: Promise.withResolvers() });
const goal = () => ({ id: 'example', title: 'Example goal', status: 'active', milestones: [], progress: 0, todos: [] });
beforeEach(() => {
  h.document = { goals: [goal()] };
  h.readBarrier = null;
  h.aiBarrier = null;
  h.mirror = null;
  vi.clearAllMocks();
});

describe('shared goal document writers', () => {
  it('retains todo and goal edits behind an overlapping progress/check-in write', async () => {
    const held = barrier();
    const progressing = mutateGoals(async doc => {
      held.entered.resolve();
      await held.release.promise;
      doc.goals[0].progress = 40;
      doc.goals[0].checkIns = [{ id: 'queued-check-in' }];
      return doc;
    });
    await held.entered.promise;
    const adding = todos.addTodo('example', { title: 'Practice' });
    const editing = goals.updateGoal('example', { title: 'Updated goal' });
    // Flush ready I/O on the isolated adapter while the first writer is held.
    await setImmediate();
    expect(atomicWrite).not.toHaveBeenCalled();
    held.release.resolve();
    const [, todo] = await Promise.all([progressing, adding, editing]);
    expect(h.document.goals[0]).toMatchObject({
      title: 'Updated goal', progress: 40,
      checkIns: [{ id: 'queued-check-in' }], todos: [{ id: todo.id, title: 'Practice' }]
    });
    await Promise.all([
      todos.updateTodo('example', todo.id, { status: 'done' }),
      goals.addProgressEntry('example', { date: '2026-01-01', note: 'Example progress' })
    ]);
    expect(h.document.goals[0].todos[0]).toMatchObject({ status: 'done', completedAt: expect.any(String) });
    expect(h.document.goals[0].progressLog).toHaveLength(1);
    await Promise.all([todos.deleteTodo('example', todo.id), goals.updateGoalProgress('example', 60)]);
    expect(h.document.goals[0]).toMatchObject({ todos: [], progress: 60 });
  });

  it('re-reads lazy normalization after a concurrent progress write and then stays read-only', async () => {
    h.readBarrier = barrier();
    const held = h.readBarrier;
    const reading = goals.getGoals();
    await held.entered.promise;
    await goals.addProgressEntry('example', { date: '2026-01-01', note: 'Retain me' });
    await goals.updateGoal('example', { title: 'Retain title' });
    held.release.resolve();
    expect((await reading).goals[0]).toMatchObject({ title: 'Retain title', progressLog: [{ note: 'Retain me' }], tags: [] });
    atomicWrite.mockClear();
    await goals.getGoals();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('keeps slow AI work outside the queue and appends to the latest goal', async () => {
    h.aiBarrier = barrier();
    const checking = goals.checkInGoal('example');
    await h.aiBarrier.entered.promise;
    await Promise.all([
      goals.updateGoal('example', { title: 'Edited during AI' }),
      todos.addTodo('example', { title: 'Added during AI' }),
      goals.updateGoalProgress('example', 25)
    ]);
    h.aiBarrier.release.resolve();
    const checkIn = await checking;
    expect(h.document.goals[0]).toMatchObject({ title: 'Edited during AI', progress: 25,
      todos: [{ title: 'Added during AI' }], checkIns: [{ id: checkIn.id }] });
  });

  it('does not resurrect a goal deleted during an AI check-in', async () => {
    h.aiBarrier = barrier();
    const checking = goals.checkInGoal('example');
    await h.aiBarrier.entered.promise;
    await goals.deleteGoal('example');
    h.aiBarrier.release.resolve();
    await expect(checking).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(h.document.goals).toEqual([]);
  });

  it('preserves missing-record results without writing or mirroring', async () => {
    expect(await todos.addTodo('missing', { title: 'Absent' })).toBeNull();
    expect(await todos.updateTodo('example', 'missing', { title: 'Absent' })).toBeNull();
    expect(await todos.deleteTodo('example', 'missing')).toBeNull();
    expect(await goals.completeMilestoneTask('example', 'missing', 'missing')).toBeNull();
    expect(atomicWrite).not.toHaveBeenCalled();
    await expect(goals.acceptGoalPhases('missing', [])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('mirrors the serialized final document and keeps explicit imports local', async () => {
    h.mirror = [goal()];
    await Promise.all([todos.addTodo('example', { title: 'Mirrored todo' }), goals.updateGoalProgress('example', 50)]);
    expect(h.mirror[0]).toMatchObject({ progress: 50, todos: [{ title: 'Mirrored todo' }] });
    await mutateGoals(doc => {
      doc.goals.push({ id: 'imported' });
      return doc;
    }, { localOnly: true });
    expect(h.document.goals.map(g => g.id)).toEqual(['example', 'imported']);
    expect(h.mirror.map(g => g.id)).toEqual(['example']);
  });
});
