/**
 * Focused unit tests for the agentGuards primitives in isolation (issue #2548).
 *
 * agentLifecycle.test.js drives these same helpers through the spawn/completion
 * lenses; here we pin their bare contract (against throwaway collections or the
 * import-free agentState maps) so a
 * regression in the helper is unambiguous and doesn't require the lifecycle
 * module's imports to load.
 */

import { describe, it, expect, vi } from 'vitest';
import { withSpawnDedupGuard, withRunnerAgentCleanup, withUpdateInProgressGuard, SPAWN_DEDUP_SKIP, SPAWN_UPDATE_SKIP } from './agentGuards.js';
import { runnerAgents, spawningTasks } from './agentState.js';

describe('withSpawnDedupGuard', () => {
  it('acquires, runs, and releases on success', async () => {
    const set = new Set();
    const seen = [];
    const result = await withSpawnDedupGuard(set, 'a', async () => {
      seen.push(set.has('a')); // held during fn
      return 42;
    });
    expect(seen).toEqual([true]);
    expect(result).toBe(42);
    expect(set.has('a')).toBe(false);
  });

  it('releases on throw and re-raises', async () => {
    const set = new Set();
    await expect(
      withSpawnDedupGuard(set, 'a', async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
    expect(set.has('a')).toBe(false);
  });

  it('short-circuits with SPAWN_DEDUP_SKIP when the key is already held', async () => {
    const set = new Set(['a']);
    let ran = false;
    const result = await withSpawnDedupGuard(set, 'a', async () => { ran = true; });
    expect(result).toBe(SPAWN_DEDUP_SKIP);
    expect(ran).toBe(false);
    expect(set.has('a')).toBe(true); // does not delete a guard it didn't acquire
  });

  it('SPAWN_DEDUP_SKIP is a distinct sentinel (not null/undefined)', () => {
    expect(typeof SPAWN_DEDUP_SKIP).toBe('symbol');
    expect(SPAWN_DEDUP_SKIP).not.toBeNull();
    expect(SPAWN_DEDUP_SKIP).not.toBeUndefined();
  });

  it('adds the guard synchronously before fn yields', async () => {
    const set = new Set();
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    const inflight = withSpawnDedupGuard(set, 'a', async () => { await gate; return 'done'; });
    // No await between the call and this assertion — the guard must already hold.
    expect(set.has('a')).toBe(true);
    releaseGate();
    await inflight;
    expect(set.has('a')).toBe(false);
  });
});

describe('withRunnerAgentCleanup', () => {
  it('runs fn, returns its value, and drops the entry with its Ollama hold', async () => {
    const releaseOllamaWork = vi.fn();
    runnerAgents.set('k', { v: 1, releaseOllamaWork });
    const result = await withRunnerAgentCleanup('k', async () => 'ok');
    expect(result).toBe('ok');
    expect(runnerAgents.has('k')).toBe(false);
    expect(releaseOllamaWork).toHaveBeenCalledTimes(1);
  });

  it('drops the entry even when fn throws, then re-raises', async () => {
    runnerAgents.set('k', { v: 1 });
    await expect(
      withRunnerAgentCleanup('k', async () => { throw new Error('fail'); })
    ).rejects.toThrow('fail');
    expect(runnerAgents.has('k')).toBe(false);
  });

  it('is a no-op when the key is absent', async () => {
    await withRunnerAgentCleanup('missing', async () => {});
    expect(runnerAgents.has('missing')).toBe(false);
  });
});

// ─── withUpdateInProgressGuard — the self-update spawn hold (issue #4124) ───

describe('withUpdateInProgressGuard — self-update spawn hold', () => {
  it('runs the spawn body when no update is in progress', async () => {
    let ran = false;
    const result = await withUpdateInProgressGuard(() => false, async () => {
      ran = true;
      return 'agent-1';
    });
    expect(ran).toBe(true);
    expect(result).toBe('agent-1');
  });

  it('returns SPAWN_UPDATE_SKIP without running the body while an update is in progress', async () => {
    let ran = false;
    const result = await withUpdateInProgressGuard(() => true, async () => {
      ran = true;
      return 'agent-2';
    });
    // The whole point: no agent process is created inside the window where
    // update.sh is about to pm2-delete this server. The task record is never
    // touched, so it stays `pending` and runs after the restart.
    expect(ran).toBe(false);
    expect(result).toBe(SPAWN_UPDATE_SKIP);
  });

  it('reads the flag on EVERY call, so the hold releases when the update settles', async () => {
    let updating = true;
    const isUpdating = () => updating;
    expect(await withUpdateInProgressGuard(isUpdating, async () => 'spawned')).toBe(SPAWN_UPDATE_SKIP);
    updating = false;
    expect(await withUpdateInProgressGuard(isUpdating, async () => 'spawned')).toBe('spawned');
  });

  it('uses a sentinel distinct from the dedup skip, so the two holds stay distinguishable', () => {
    expect(SPAWN_UPDATE_SKIP).not.toBe(SPAWN_DEDUP_SKIP);
  });

  it('checks the flag OUTSIDE the dedup guard, so a held task leaves no stranded guard entry', async () => {
    // Mirrors how spawnAgentForTask composes them. If the update check sat
    // inside withSpawnDedupGuard the task id would be added and removed for a
    // spawn that never happened — harmless today, but it would also mean the
    // dedup set churned once per held dispatch during the whole update window.
    const outcome = await withUpdateInProgressGuard(() => true, () =>
      withSpawnDedupGuard(spawningTasks, 'task-held', async () => 'agent-3'));
    expect(outcome).toBe(SPAWN_UPDATE_SKIP);
    expect(spawningTasks.has('task-held')).toBe(false);
  });
});
