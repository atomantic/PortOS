/**
 * Tests for agentLifecycle — focused on the `spawningTasks` dedup-guard race
 * that allowed a SECOND agent to be spawned for the SAME task id after the
 * first spawn already passed the dedup add but before the runner queued the
 * agent.
 *
 * The production race (pre-fix, agentLifecycle.js line 511):
 *
 *   await updateTask(task.id, { status: 'in_progress', ... });
 *   spawningTasks.delete(task.id);    // ← released too early
 *   ...
 *   return spawnViaRunner(...);       // ← actual runner enqueue
 *
 * A concurrent `spawnAgentForTask(sameTask)` call landing between the delete
 * and the runner-enqueue saw an empty set, fell through the dedup check
 * (which does NOT re-check task.status), and proceeded to spawn a SECOND
 * agent for the same task id. The fix wraps the spawn call in try/finally
 * and releases the guard only after the runner accepted the agent.
 *
 * These tests use inline copies of the dedup slice (matching the convention
 * in subAgentSpawner.test.js — pure logic copies instead of mocking the
 * full async-heavy production function).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawningTasks } from './agentState.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_LIFECYCLE_SRC = readFileSync(join(__dirname, 'agentLifecycle.js'), 'utf-8');

// ─── Inline replicas of the dedup slice ──────────────────────────────────────

/**
 * Pre-fix spawn: delete BEFORE the runner-enqueue async work.
 * Mirrors agentLifecycle.js pre-fix flow (lines 499 → 511 → 528–536).
 */
async function unfixedSpawn(task, hooks) {
  // line 113 — dedup check
  if (spawningTasks.has(task.id)) {
    hooks.onDuplicate?.(task.id);
    return null;
  }

  // line 134 — guard add (sync)
  spawningTasks.add(task.id);

  // simulate all the async work between line 134 and line 499 (config load,
  // provider resolve, prompt build, registerAgent, etc.)
  await hooks.preUpdateWork();

  // line 499 — task status flipped to in_progress
  await hooks.updateTaskStatus(task.id, 'in_progress');

  // line 511 — guard released BEFORE the runner enqueue (the bug)
  spawningTasks.delete(task.id);

  // simulate any sync between 511 and the spawn call
  hooks.postDeletePreSpawn?.();

  // line 528–536 — actually queue the runner; this is the work that should
  // have been inside the guard window.
  const agentId = await hooks.runnerEnqueue(task.id);
  hooks.onSpawn?.(agentId, task.id);
  return agentId;
}

/**
 * Post-fix spawn: guard wraps the runner-enqueue via try/finally.
 * Mirrors agentLifecycle.js post-fix flow.
 */
async function fixedSpawn(task, hooks) {
  if (spawningTasks.has(task.id)) {
    hooks.onDuplicate?.(task.id);
    return null;
  }

  spawningTasks.add(task.id);

  await hooks.preUpdateWork();
  await hooks.updateTaskStatus(task.id, 'in_progress');

  // Hook into the same "post-update / pre-spawn" boundary as the unfixed
  // variant, but inside the guard window. This is the exact spot where the
  // pre-fix code dropped the guard.
  hooks.postDeletePreSpawn?.();

  try {
    const agentId = await hooks.runnerEnqueue(task.id);
    hooks.onSpawn?.(agentId, task.id);
    return agentId;
  } finally {
    spawningTasks.delete(task.id);
  }
}

// ─── Test harness ────────────────────────────────────────────────────────────

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Build a hooks object whose `runnerEnqueue` blocks on an external gate, so a
 * second `spawnAgentForTask` call can be injected between the dedup-delete
 * (pre-fix) and the runner-enqueue completing. The gate is read at call time
 * (not captured) so callers can mutate `hooks.gate` to release the block.
 */
function makeHooks(opts = {}) {
  const hooks = {
    gate: opts.gate ?? null,
    onDuplicate: opts.onDuplicate,
    onSpawn: opts.onSpawn,
    onRunnerEnqueueEntered: opts.onRunnerEnqueueEntered,
    postDeletePreSpawn: opts.postDeletePreSpawn,
    preUpdateWork: async () => {},
    updateTaskStatus: async () => {},
    runnerEnqueue: async (taskId) => {
      hooks.onRunnerEnqueueEntered?.(taskId);
      if (hooks.gate) await hooks.gate;
      return `agent-${taskId.slice(-6)}-${Math.random().toString(36).slice(2, 6)}`;
    },
  };
  return hooks;
}

beforeEach(() => {
  spawningTasks.clear();
});

// ─── Sanity checks (both implementations should agree) ───────────────────────

describe('spawningTasks dedup — sanity', () => {
  it('blocks a synchronous second call (unfixed)', async () => {
    const task = { id: 'task-sync-1' };
    const dupes = [];
    const spawned = [];
    const hooks = makeHooks({
      onDuplicate: (id) => dupes.push(id),
      onSpawn: (agentId, id) => spawned.push({ agentId, id }),
    });

    // First call: starts, adds to guard, awaits preUpdateWork.
    const first = unfixedSpawn(task, hooks);
    // Second call BEFORE first's first await yields any further than initial
    // microtask: dedup must reject.
    const second = unfixedSpawn(task, hooks);
    await Promise.all([first, second]);

    expect(dupes).toEqual(['task-sync-1']);
    expect(spawned).toHaveLength(1);
  });

  it('blocks a synchronous second call (fixed)', async () => {
    const task = { id: 'task-sync-2' };
    const dupes = [];
    const spawned = [];
    const hooks = makeHooks({
      onDuplicate: (id) => dupes.push(id),
      onSpawn: (agentId, id) => spawned.push({ agentId, id }),
    });

    const first = fixedSpawn(task, hooks);
    const second = fixedSpawn(task, hooks);
    await Promise.all([first, second]);

    expect(dupes).toEqual(['task-sync-2']);
    expect(spawned).toHaveLength(1);
  });
});

// ─── The race the user reported ──────────────────────────────────────────────

describe('spawningTasks dedup — late-delete race', () => {
  it('unfixed: a second call between delete-from-guard and runner-enqueue spawns a SECOND agent (bug repro)', async () => {
    const task = { id: 'task-race-unfixed' };
    const dupes = [];
    const spawned = [];

    // Gate the runner-enqueue of the FIRST call so we can inject the second
    // call after the guard has been released but before the runner accepted
    // the agent.
    const runnerGate = deferred();
    let injectedSecondCall;

    const hooks = makeHooks({
      gate: runnerGate.promise,
      onDuplicate: (id) => dupes.push(id),
      onSpawn: (agentId, id) => spawned.push({ agentId, id }),
    });
    // Pre-fix flow: the guard is released BEFORE this hook fires (production
    // line 511 happens before lines 528–536). Inject the second call here.
    // It must NOT be deduped because the bug already released the guard.
    hooks.postDeletePreSpawn = () => {
      // Second call uses its own hooks instance with NO gate so its runner
      // resolves immediately — we want to observe whether it spawned at all.
      const secondHooks = makeHooks({
        onDuplicate: (id) => dupes.push(id),
        onSpawn: (agentId, id) => spawned.push({ agentId, id }),
      });
      injectedSecondCall = unfixedSpawn(task, secondHooks);
    };

    const first = unfixedSpawn(task, hooks);

    // Drain the microtask queue so the first call reaches its
    // `postDeletePreSpawn` hook (which fires the second call).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // At this point: the second call has already executed its full dedup
    // path. If the bug is present, it spawned a second agent.
    expect(injectedSecondCall).toBeDefined();
    const secondAgentId = await injectedSecondCall;

    // Now let the first call's runner-enqueue complete.
    runnerGate.resolve();
    const firstAgentId = await first;

    // BUG: two distinct agents were spawned for the same task id.
    expect(dupes).toEqual([]);                    // dedup did NOT fire on the racer
    expect(spawned).toHaveLength(2);              // ← TWO agents spawned, same task
    expect(spawned[0].id).toBe(task.id);
    expect(spawned[1].id).toBe(task.id);
    expect(firstAgentId).toBeTruthy();
    expect(secondAgentId).toBeTruthy();
    expect(firstAgentId).not.toBe(secondAgentId);
  });

  it('fixed: the same race is closed — the second call is deduped, only ONE agent spawns', async () => {
    const task = { id: 'task-race-fixed' };
    const dupes = [];
    const spawned = [];

    const runnerGate = deferred();
    let injectedSecondCall;

    const hooks = makeHooks({
      gate: runnerGate.promise,
      onDuplicate: (id) => dupes.push(id),
      onSpawn: (agentId, id) => spawned.push({ agentId, id }),
    });
    // Same boundary as the unfixed test — but now the guard is held until
    // the runner-enqueue resolves (try/finally), so the injected second
    // call must hit the dedup-has-check.
    hooks.postDeletePreSpawn = () => {
      const secondHooks = makeHooks({
        onDuplicate: (id) => dupes.push(id),
        onSpawn: (agentId, id) => spawned.push({ agentId, id }),
      });
      injectedSecondCall = fixedSpawn(task, secondHooks);
    };

    const first = fixedSpawn(task, hooks);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(injectedSecondCall).toBeDefined();
    const secondResult = await injectedSecondCall;

    runnerGate.resolve();
    const firstAgentId = await first;

    // FIX: the racer was deduped, only the first call produced an agent.
    expect(dupes).toEqual([task.id]);
    expect(secondResult).toBeNull();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].id).toBe(task.id);
    expect(firstAgentId).toBeTruthy();
  });

  it('fixed: a runner-enqueue rejection still releases the guard (finally)', async () => {
    const task = { id: 'task-race-throw' };
    const hooks = {
      preUpdateWork: async () => {},
      updateTaskStatus: async () => {},
      runnerEnqueue: async () => { throw new Error('runner crashed'); },
    };

    await expect(fixedSpawn(task, hooks)).rejects.toThrow('runner crashed');

    // Critical: the guard must NOT leak across a thrown spawn, otherwise a
    // legitimate follow-up call for the same task id would be incorrectly
    // deduped forever.
    expect(spawningTasks.has(task.id)).toBe(false);
  });
});

// ─── Regression guard against the buggy ordering ────────────────────────────
//
// Source-level assertion: the production `spawnAgentForTask` MUST release the
// dedup guard inside a `finally` after the spawn call, NOT immediately after
// the `updateTask` that flips the task to in_progress. The pre-fix code
// released the guard between `updateTask` and `spawnViaRunner`/`spawnDirectly`
// — a window in which a concurrent `task:ready` re-emit could race past the
// dedup-has-check and spawn a duplicate agent.
//
// If a future refactor reverts the delete to its pre-fix position, this test
// flips red and points the dev at the race the structural change re-opened.

describe('agentLifecycle source — spawningTasks delete placement', () => {
  it('releases the dedup guard inside a finally that wraps the spawn call', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    expect(fnStart, 'spawnAgentForTask must exist').toBeGreaterThan(-1);

    // Slice from the function start to the first closing top-level `}`.
    // The function body is ~430 lines; grab enough to cover it.
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);

    // The function must contain `spawningTasks.add(task.id)` (the guard add).
    expect(fnBody).toMatch(/spawningTasks\.add\(task\.id\)/);

    // ANTI-PATTERN: a `spawningTasks.delete(task.id)` immediately after the
    // `updateTask(... 'in_progress' ...)` await (the pre-fix shape). The
    // negative lookahead allows the `delete` only inside an `if (!update…)`
    // / `cleanupOnError` branch.
    const buggyPattern = /await\s+updateTask\([\s\S]{0,800}?status:\s*['"]in_progress['"][\s\S]{0,800}?\}\s*,\s*task\.taskType[\s\S]{0,200}?\)\s*;\s*spawningTasks\.delete\(task\.id\)/;
    expect(fnBody).not.toMatch(buggyPattern);

    // The spawn-call section (spawnViaRunner / spawnDirectly) must be wrapped
    // in a try/finally with the dedup delete in the finally clause.
    const tryFinallyPattern = /try\s*\{[\s\S]*?spawnViaRunner[\s\S]*?spawnDirectly[\s\S]*?\}\s*finally\s*\{\s*spawningTasks\.delete\(task\.id\)\s*;?\s*\}/;
    expect(fnBody).toMatch(tryFinallyPattern);
  });
});
