import { describe, it, expect } from 'vitest';
import {
  SPAWN_CLAIM_GRACE_MS,
  runningAgentsByTaskId,
  isSpawningTask,
  withoutSpawningTasks,
  countSpawningTasks,
  unclaimedTaskIds,
  settleTaskSourceSpawnWindow,
} from './cosSpawnWindow.js';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const running = (taskId, ageMs = 0, extra = {}) => ({
  id: `agent-${taskId}`, taskId, status: 'running', startedAt: new Date(NOW - ageMs).toISOString(), ...extra,
});
const pending = (id) => ({ id, status: 'pending' });
const at = { now: NOW };

describe('cosSpawnWindow', () => {
  it('moves a mid-spawn task to the active side and leaves real backlog queued', () => {
    // The defect this module exists for: the agent registers as `running` a beat
    // before its task leaves `pending`, and a status module counting each list on
    // its own read "1 pending" AND "1 active" for one task.
    const tasks = [pending('user/42'), pending('sys-7')];
    const agents = runningAgentsByTaskId([running('sys-7')]);

    expect(withoutSpawningTasks(tasks, agents, at).map((t) => t.id)).toEqual(['user/42']);
    expect(countSpawningTasks(tasks, agents, at)).toBe(1);
    expect(unclaimedTaskIds(['user/42', 'sys-7'], agents, at)).toEqual(['user/42']);
  });

  it('hands a task back as queued once its holder is too old to be mid-spawn', () => {
    // A zombie agent record on a still-pending task is a BROKEN state, not a
    // spawn in flight. Settling it as active forever would hide the stuck task
    // from every count AND drop it out of the list that renders its "Run now".
    const tasks = [pending('user/42')];
    const fresh = runningAgentsByTaskId([running('user/42', SPAWN_CLAIM_GRACE_MS - 1)]);
    const stale = runningAgentsByTaskId([running('user/42', SPAWN_CLAIM_GRACE_MS)]);

    expect(withoutSpawningTasks(tasks, fresh, at)).toEqual([]);
    expect(withoutSpawningTasks(tasks, stale, at)).toEqual(tasks);
  });

  it('treats an agent that never recorded a start as stale, never as mid-spawn', () => {
    // Same direction as the bound above: an unmeasurable claim may not be the
    // thing that hides a task from the queue it is actually sitting in.
    const agents = runningAgentsByTaskId([{ id: 'agent-1', taskId: 'user/42', status: 'running' }]);
    expect(isSpawningTask(pending('user/42'), agents, at)).toBe(false);
  });

  it('ignores an agent that is not running, so a finished run cannot hide a real backlog', () => {
    for (const status of ['completed', 'paused', 'failed']) {
      const agents = runningAgentsByTaskId([{ ...running('user/42'), status }]);
      expect(withoutSpawningTasks([pending('user/42')], agents, at)).toHaveLength(1);
    }
  });

  it('never settles a task that is not pending', () => {
    // in_progress / blocked / completed tasks are already counted by their own
    // status; settling them here would double-discount a running task.
    const agents = runningAgentsByTaskId([running('user/42')]);
    for (const status of ['in_progress', 'blocked', 'completed', 'challenged']) {
      expect(isSpawningTask({ id: 'user/42', status }, agents, at)).toBe(false);
    }
  });

  it('reads a missing agent list and a missing task list as nothing, not as a throw', () => {
    // Every caller reaches this off a `.catch(() => null)` read, so a failed probe
    // must degrade to "no claims to settle" rather than take the status route down.
    const agents = runningAgentsByTaskId(null);
    expect(agents.size).toBe(0);
    expect(withoutSpawningTasks(null, agents, at)).toEqual([]);
    expect(unclaimedTaskIds(undefined, agents, at)).toEqual([]);
    expect(isSpawningTask(pending('user/42'), null, at)).toBe(false);
  });

  it('recognizes a holder that names its task only in metadata', () => {
    // `agentManagement.js`'s resume/relaunch paths read both spellings; a
    // settlement that saw fewer holders than they do would disagree with them.
    const agents = runningAgentsByTaskId([
      { id: 'agent-1', status: 'running', startedAt: new Date(NOW).toISOString(), metadata: { taskId: 'user/42' } },
    ]);
    expect(isSpawningTask(pending('user/42'), agents, at)).toBe(true);
  });

  describe('settleTaskSourceSpawnWindow', () => {
    const source = () => ({
      type: 'user',
      tasks: [pending('user/42'), pending('user/43'), { id: 'user/7', status: 'in_progress' }],
      grouped: {
        pending: [pending('user/42'), pending('user/43')],
        in_progress: [{ id: 'user/7', status: 'in_progress' }],
      },
    });

    it('regroups a mid-spawn task so a raw grouped.pending count is already honest', () => {
      // This is what spares every consumer of GET /api/cos/tasks from having to
      // know the window exists — the count they already write is the right one.
      const agents = runningAgentsByTaskId([running('user/42')]);

      const settled = settleTaskSourceSpawnWindow(source(), agents, at);

      expect(settled.grouped.pending.map((t) => t.id)).toEqual(['user/43']);
      expect(settled.grouped.in_progress.map((t) => t.id)).toEqual(['user/7', 'user/42']);
      expect(settled.tasks.find((t) => t.id === 'user/42')).toMatchObject({ status: 'pending', spawning: true });
      expect(settled.tasks.find((t) => t.id === 'user/43').spawning).toBeUndefined();
    });

    it('leaves a source with nothing mid-spawn exactly as it was', () => {
      const untouched = source();
      expect(settleTaskSourceSpawnWindow(untouched, runningAgentsByTaskId([]), at)).toBe(untouched);
      expect(settleTaskSourceSpawnWindow(null, runningAgentsByTaskId([]), at)).toBeNull();
    });
  });
});
