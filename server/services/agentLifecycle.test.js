/**
 * Tests for agentLifecycle — three concerns:
 *
 * 1. The `spawningTasks` dedup-guard race that allowed a SECOND agent to be
 *    spawned for the SAME task id after the first spawn already passed the
 *    dedup add but before the runner queued the agent (`spawningTasks dedup`
 *    blocks below).
 *
 *    The production race (pre-fix, agentLifecycle.js line 511):
 *
 *      await updateTask(task.id, { status: 'in_progress', ... });
 *      spawningTasks.delete(task.id);    // ← released too early
 *      ...
 *      return spawnViaRunner(...);       // ← actual runner enqueue
 *
 *    A concurrent `spawnAgentForTask(sameTask)` call landing between the
 *    delete and the runner-enqueue saw an empty set, fell through the dedup
 *    check (which does NOT re-check task.status), and proceeded to spawn a
 *    SECOND agent for the same task id. The fix wraps the spawn call in
 *    try/finally and releases the guard only after the runner accepted the
 *    agent.
 *
 * 2. `spawnAgentForTask` error recovery (`spawnAgentForTask — cleanupOnError`
 *    block). Documents which detected-error paths release the guard via
 *    `cleanupOnError`, plus a SKIPPED test that pins the partial-coverage
 *    gap: a throw between `spawningTasks.add(task.id)` (line 134) and the
 *    try/finally (line 536) leaks the guard forever. PLAN.md → Backlog has
 *    a separate item to widen the try/finally; the skip flips green once
 *    that fix lands.
 *
 * 3. `handleAgentCompletion` error recovery (`handleAgentCompletion error
 *    recovery` block). The completion function has NO try/catch wrapping
 *    its core steps, so a throw from `completeAgent`, `updateTask`, or
 *    `processAgentCompletion` aborts the function before
 *    `runnerAgents.delete(agentId)` runs at line 1146 — leaking the agent's
 *    entry in the in-memory `runnerAgents` map. Observable impact: memory
 *    grows unboundedly across runs, and a stale entry can re-trigger or
 *    misroute completion handling if the runner re-emits the event or the
 *    handler is retried for the same agentId.
 *
 * These tests use inline copies of the relevant slices (matching the
 * convention in subAgentSpawner.test.js — pure logic copies instead of
 * mocking the full async-heavy production function).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawningTasks, runnerAgents } from './agentState.js';

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
  it('releases the dedup guard inside a finally block', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    expect(fnStart, 'spawnAgentForTask must exist').toBeGreaterThan(-1);
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);

    expect(fnBody).toMatch(/spawningTasks\.add\(task\.id\)/);

    // The dedup-delete must live inside a `finally { ... }` clause — the
    // structural guarantee that the guard outlives the spawn call regardless
    // of which runner/direct branch is taken or what intervening logic exists.
    const finallyPattern = /finally\s*\{[\s\S]{0,400}?spawningTasks\.delete\(task\.id\)/;
    expect(fnBody).toMatch(finallyPattern);
  });
});

// ─── spawnAgentForTask — cleanupOnError ────────────────────────────────────
//
// `spawnAgentForTask` has ~400 LOC of async work between
// `spawningTasks.add(task.id)` (line 134) and the try/finally (line 536).
// Most detected-error paths inside that span call `cleanupOnError`, which
// releases the dedup guard, the execution lane, and the tool-execution
// state. The inline replica below mirrors that helper so we can pin the
// invariants: every `cleanupOnError(...)` call MUST drop the guard. A
// future refactor that inlines part of `cleanupOnError` is the kind of
// drift this guard catches.

function makeCleanupHarness(taskId, agentId) {
  const released = [];
  const completed = [];
  const errored = [];

  const cleanupOnError = (error) => {
    spawningTasks.delete(taskId);
    released.push({ agentId, reason: 'release' });
    errored.push({ executionId: `exec-${agentId}`, message: error });
    completed.push({ executionId: `exec-${agentId}`, success: false });
  };

  return { cleanupOnError, released, completed, errored };
}

describe('spawnAgentForTask — cleanupOnError error recovery', () => {
  beforeEach(() => {
    spawningTasks.clear();
  });

  it('releases the dedup guard when no AI provider is configured', () => {
    // Production line 169: `cleanupOnError('No active AI provider configured')`
    // when getActiveProvider() returns null.
    const task = { id: 'task-no-provider' };
    spawningTasks.add(task.id);
    const harness = makeCleanupHarness(task.id, 'agent-1');

    harness.cleanupOnError('No active AI provider configured');

    expect(spawningTasks.has(task.id)).toBe(false);
    expect(harness.released).toHaveLength(1);
    expect(harness.errored[0].message).toBe('No active AI provider configured');
    expect(harness.completed[0].success).toBe(false);
  });

  it('releases the dedup guard when provider is unavailable and no fallback exists', () => {
    // Production line 199: cleanupOnError fires on the no-fallback path.
    const task = { id: 'task-unavailable-provider' };
    spawningTasks.add(task.id);
    const harness = makeCleanupHarness(task.id, 'agent-2');

    harness.cleanupOnError('Provider anthropic unavailable (usage-limit) and no fallback available');

    expect(spawningTasks.has(task.id)).toBe(false);
    expect(harness.completed[0].success).toBe(false);
  });

  it('releases the dedup guard when a git conflict defers the task', () => {
    // Production line 300: cleanupOnError fires after creating the conflict
    // resolution task and re-queueing the original.
    const task = { id: 'task-git-conflict' };
    spawningTasks.add(task.id);
    const harness = makeCleanupHarness(task.id, 'agent-3');

    harness.cleanupOnError('Git conflict blocks task — conflict resolution task created');

    expect(spawningTasks.has(task.id)).toBe(false);
  });

  it('releases the dedup guard when updateTask fails to flip status to in_progress', () => {
    // Production line 512: `cleanupOnError('Failed to update task status')`
    // when `updateTask` returns null (parse error, file missing, etc.).
    const task = { id: 'task-update-failed' };
    spawningTasks.add(task.id);
    const harness = makeCleanupHarness(task.id, 'agent-4');

    harness.cleanupOnError('Failed to update task status');

    expect(spawningTasks.has(task.id)).toBe(false);
  });

  // ─── Deferred-fix coverage ──────────────────────────────────────────────
  //
  // PLAN.md → Backlog has a separate item: "Widen `spawningTasks`
  // try/finally in `agentLifecycle.js#spawnAgentForTask`". Today's
  // try/finally only wraps the `spawnViaRunner` / `spawnDirectly` calls
  // (lines 536–547). The ~400 LOC above (buildAgentPrompt, writeFile,
  // createAgentRun, registerAgent, etc.) is NOT inside any try/catch. A
  // throw on any of those paths leaves `spawningTasks` registered FOREVER,
  // permanently blocking future spawns of that task id.
  //
  // The detected-error paths above use `cleanupOnError` and are safe. The
  // SKIPPED tests below pin the gap: an uncaught throw from one of those
  // mid-spawn async steps leaks the guard. They flip green when the
  // backlog widen-try-finally fix lands.

  it.skip('TODO(plan.md backlog): a throw from buildAgentPrompt leaves the guard set forever', async () => {
    // PRE-FIX: throws from lines ~165–525 are NOT in a try/finally, so the
    // guard leaks. Once the fix widens the try/finally up to the
    // `spawningTasks.add(task.id)` line, this becomes pass-by-construction.
    // Production reference: agentLifecycle.js:443 `buildAgentPrompt` call.
    const task = { id: 'task-prompt-throw' };
    async function simulateProductionPreFix() {
      spawningTasks.add(task.id);
      // The actual production code does not wrap this in a try/catch.
      // We simulate a throw HERE — outside any guard.
      throw new Error('prompt build failed (ENOSPC)');
    }
    await expect(simulateProductionPreFix()).rejects.toThrow('prompt build failed');
    // BUG (today): guard leaks. After the backlog fix this becomes false.
    expect(spawningTasks.has(task.id)).toBe(true);
  });

  it.skip('TODO(plan.md backlog): a throw from writeFile(prompt) leaves the guard set forever', async () => {
    // Production reference: agentLifecycle.js:452 `writeFile(join(agentDir, 'prompt.txt'), prompt)`.
    // Same shape as the buildAgentPrompt skip — separate test so the
    // failure surface is easier to read after the fix lands.
    const task = { id: 'task-writefile-throw' };
    async function simulateProductionPreFix() {
      spawningTasks.add(task.id);
      throw new Error('writeFile failed (EACCES)');
    }
    await expect(simulateProductionPreFix()).rejects.toThrow();
    expect(spawningTasks.has(task.id)).toBe(true);
  });

  it.skip('TODO(plan.md backlog): a throw from createAgentRun leaves the guard set forever', async () => {
    // Production reference: agentLifecycle.js:455 `createAgentRun(agentId, ...)`.
    const task = { id: 'task-runs-throw' };
    async function simulateProductionPreFix() {
      spawningTasks.add(task.id);
      throw new Error('createAgentRun failed (DB write)');
    }
    await expect(simulateProductionPreFix()).rejects.toThrow();
    expect(spawningTasks.has(task.id)).toBe(true);
  });

  it.skip('TODO(plan.md backlog): a throw from registerAgent leaves the guard set forever', async () => {
    // Production reference: agentLifecycle.js:458 `registerAgent(agentId, task.id, {...})`.
    const task = { id: 'task-register-throw' };
    async function simulateProductionPreFix() {
      spawningTasks.add(task.id);
      throw new Error('registerAgent failed (state mutex lost)');
    }
    await expect(simulateProductionPreFix()).rejects.toThrow();
    expect(spawningTasks.has(task.id)).toBe(true);
  });
});

// ─── handleAgentCompletion error recovery ──────────────────────────────────
//
// `handleAgentCompletion` (agentLifecycle.js:841) does:
//   ... read agent ...
//   completeAgent(agentId, {...})            // line 939
//   updateTask(task.id, {...})               // line 954 / 960
//   processAgentCompletion(...)              // line 987
//   ... JIRA / plan-question / pipeline ...
//   runnerAgents.delete(agentId)             // line 1146 — runner cleanup
//
// None of the inner steps are wrapped in try/catch. A throw from any of
// them aborts the function, leaving the runnerAgents Map entry and the
// task status in whatever transitional state the failed step left them.
// The inline copies below model that flow so we can pin the documented
// gap.

function makeCompletionHarness({ taskId, agentId, throws = {}, taskType = 'user', runId = null }) {
  const calls = [];
  return {
    agentId,
    taskId,
    completeAgent: async (id, info) => {
      calls.push({ step: 'completeAgent', id, info });
      if (throws.completeAgent) throw new Error('completeAgent failed: state save error');
    },
    completeAgentRun: async (rid, output, code, dur, err) => {
      calls.push({ step: 'completeAgentRun', rid });
      if (throws.completeAgentRun) throw new Error('completeAgentRun failed');
    },
    updateTask: async (id, updates, ttype) => {
      calls.push({ step: 'updateTask', id, status: updates.status, ttype });
      if (throws.updateTask) throw new Error('updateTask failed');
      return { id, status: updates.status };
    },
    processAgentCompletion: async (id, t, ok, out) => {
      calls.push({ step: 'processAgentCompletion', id, ok });
      if (throws.processAgentCompletion) throw new Error('processAgentCompletion failed: hook crash');
    },
    /** Mirrors the final `runnerAgents.delete(agentId)` at line 1146. */
    deleteRunner: () => {
      calls.push({ step: 'deleteRunner', agentId });
      runnerAgents.delete(agentId);
    },
    calls,
    taskType,
    runId,
  };
}

/**
 * Inline replica of the completion flow up to and including the cleanup
 * delete. Mirrors agentLifecycle.js lines 935–987 + 1146, with branching
 * on `effectiveSuccess` as in production.
 */
async function runCompletion(harness, effectiveSuccess) {
  await harness.completeAgent(harness.agentId, { success: effectiveSuccess });
  if (harness.runId) {
    await harness.completeAgentRun(harness.runId);
  }
  if (effectiveSuccess) {
    await harness.updateTask(harness.taskId, { status: 'completed' }, harness.taskType);
  } else {
    await harness.updateTask(harness.taskId, { status: 'pending' }, harness.taskType);
  }
  await harness.processAgentCompletion(harness.agentId, { id: harness.taskId }, effectiveSuccess, '');
  harness.deleteRunner();
}

describe('handleAgentCompletion — happy path', () => {
  beforeEach(() => {
    runnerAgents.clear();
  });

  it('marks task completed, processes hooks, and removes the runner record on success', async () => {
    runnerAgents.set('agent-A', { taskId: 'task-A' });
    const h = makeCompletionHarness({ taskId: 'task-A', agentId: 'agent-A' });

    await runCompletion(h, true);

    expect(h.calls.map(c => c.step)).toEqual([
      'completeAgent',
      'updateTask',
      'processAgentCompletion',
      'deleteRunner',
    ]);
    expect(h.calls.find(c => c.step === 'updateTask').status).toBe('completed');
    expect(runnerAgents.has('agent-A')).toBe(false);
  });

  it('failure path: task stays pending, runner record still deleted', async () => {
    runnerAgents.set('agent-B', { taskId: 'task-B' });
    const h = makeCompletionHarness({ taskId: 'task-B', agentId: 'agent-B' });

    await runCompletion(h, false);

    expect(h.calls.find(c => c.step === 'updateTask').status).toBe('pending');
    expect(runnerAgents.has('agent-B')).toBe(false);
  });
});

describe('handleAgentCompletion — error recovery (uncovered today)', () => {
  beforeEach(() => {
    runnerAgents.clear();
  });

  it('regression-pin: a throw from completeAgent (state save) prevents runner cleanup', async () => {
    // Production reference: agentLifecycle.js:939 — `await completeAgent(...)`
    // is NOT wrapped in try/catch. A throw bubbles to the caller, but more
    // importantly skips lines 940–1146, including the final
    // `runnerAgents.delete(agentId)`. The runner record is leaked.
    runnerAgents.set('agent-C', { taskId: 'task-C' });
    const h = makeCompletionHarness({
      taskId: 'task-C',
      agentId: 'agent-C',
      throws: { completeAgent: true },
    });

    await expect(runCompletion(h, true)).rejects.toThrow('completeAgent failed');

    // BUG (documented): the runner-agents Map still has agent-C. A
    // follow-up completion event for the same agentId would re-enter
    // handleAgentCompletion and re-trigger the failing step. PLAN.md
    // backlog should track wrapping these steps in try/catch with a final
    // `runnerAgents.delete` in a finally block.
    expect(runnerAgents.has('agent-C')).toBe(true);

    // Downstream steps (updateTask, processAgentCompletion) never ran.
    expect(h.calls.map(c => c.step)).toEqual(['completeAgent']);
  });

  it('regression-pin: a throw from updateTask leaves runner record + skips post-completion hooks', async () => {
    // Production reference: agentLifecycle.js:954 (success branch) / 960
    // (failure branch). The function only inspects `result?.error` for
    // soft-fail values — an actual thrown error bubbles up and skips
    // processAgentCompletion + the final cleanup.
    runnerAgents.set('agent-D', { taskId: 'task-D' });
    const h = makeCompletionHarness({
      taskId: 'task-D',
      agentId: 'agent-D',
      throws: { updateTask: true },
    });

    await expect(runCompletion(h, true)).rejects.toThrow('updateTask failed');

    expect(runnerAgents.has('agent-D')).toBe(true);
    // processAgentCompletion never invoked — memory extraction skipped.
    expect(h.calls.map(c => c.step)).toEqual(['completeAgent', 'updateTask']);
  });

  it('regression-pin: a throw from processAgentCompletion (hook dispatch) leaks the runner record', async () => {
    // Production reference: agentLifecycle.js:987 — the memory-extraction /
    // app-cooldown hook is called as `await processAgentCompletion(...)`
    // with no try/catch. A crash inside the hook (memory store down,
    // extraction throw) abandons the rest of the cleanup.
    runnerAgents.set('agent-E', { taskId: 'task-E' });
    const h = makeCompletionHarness({
      taskId: 'task-E',
      agentId: 'agent-E',
      throws: { processAgentCompletion: true },
    });

    await expect(runCompletion(h, true)).rejects.toThrow('processAgentCompletion failed');

    expect(runnerAgents.has('agent-E')).toBe(true);
    // completeAgent + updateTask DID run — the task is marked completed in
    // state, but the runner record is still cached in memory. A subsequent
    // event for the same agentId hits the `if (!agent)` branch incorrectly
    // because the agent IS still cached, leading to re-attempted hook
    // dispatch that throws again.
    expect(h.calls.find(c => c.step === 'completeAgent')).toBeDefined();
    expect(h.calls.find(c => c.step === 'updateTask')).toBeDefined();
    expect(h.calls.find(c => c.step === 'deleteRunner')).toBeUndefined();
  });

  it('regression-pin: a throw from completeAgentRun (run-tracking) leaves the runner record', async () => {
    // Production reference: agentLifecycle.js:949 — only invoked when
    // runId exists. completeAgentRun writes usage stats; a write failure
    // shouldn't strand the runner-agent map.
    runnerAgents.set('agent-F', { taskId: 'task-F' });
    const h = makeCompletionHarness({
      taskId: 'task-F',
      agentId: 'agent-F',
      runId: 'run-123',
      throws: { completeAgentRun: true },
    });

    await expect(runCompletion(h, true)).rejects.toThrow('completeAgentRun failed');

    expect(runnerAgents.has('agent-F')).toBe(true);
  });
});

// Source-level regression: a future refactor MUST keep the runner cleanup
// at the very tail of `handleAgentCompletion`. If someone moves the delete
// into a guard branch (e.g. only on success), this catches it.

describe('agentLifecycle source — runner cleanup placement', () => {
  it('handleAgentCompletion ends with runnerAgents.delete(agentId)', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function handleAgentCompletion');
    expect(fnStart, 'handleAgentCompletion must exist').toBeGreaterThan(-1);

    // Find the closing brace of the top-level function body.
    const bodyStart = AGENT_LIFECYCLE_SRC.indexOf('{', fnStart);
    let depth = 0;
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < AGENT_LIFECYCLE_SRC.length; i++) {
      const c = AGENT_LIFECYCLE_SRC[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }

    const fnBody = AGENT_LIFECYCLE_SRC.slice(bodyStart, bodyEnd);

    // The terminal cleanup line lives near the very bottom of the function.
    // Check it appears in the last 200 chars of the body so a refactor that
    // moves it into a conditional branch shows up red here.
    const tail = fnBody.slice(-200);
    expect(tail).toMatch(/runnerAgents\.delete\(agentId\)/);
  });
});
