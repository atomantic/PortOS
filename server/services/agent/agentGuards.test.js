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
import { withSpawnDedupGuard, withRunnerAgentCleanup, SPAWN_DEDUP_SKIP } from './agentGuards.js';
import { runnerAgents } from './agentState.js';

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
