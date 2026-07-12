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
 *    `cleanupOnError`, plus a set of post-fix tests that simulate uncaught
 *    throws from buildAgentPrompt / writeFile / createAgentRun /
 *    registerAgent and assert the widened try/catch/finally releases the
 *    guard regardless. The earlier partial-coverage gap (throws between
 *    `spawningTasks.add` and the narrow spawn-only try/finally leaking the
 *    guard forever) is closed by the outer try wrapping the whole spawn
 *    path.
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

// Source-level assertion (issue #989): the synthetic app-review marker bound by
// `bindAppReviewAgent` before this spawn MUST be released on every
// pre-completion `return null` path, or the app reads "in review" until the next
// daemon restart. The shared `cleanupOnError` closure owns the release for the
// four detected-error paths (provider resolution, prep deferred/blocked,
// updateTask failure) + the pre-spawn catch arm; the two earliest returns
// (max-spawns block, lane-acquire failure) release inline because they fire
// before `cleanupOnError` is defined.

describe('agentLifecycle source — app-review marker release (issue #989)', () => {
  it('cleanupOnError releases the synthetic app-review marker', () => {
    const start = AGENT_LIFECYCLE_SRC.indexOf('const cleanupOnError =');
    expect(start, 'cleanupOnError must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(start, start + 800);
    expect(body, 'cleanupOnError must release the app-review marker').toMatch(/releaseAppReviewMarker\(task\.metadata\?\.app\)/);
  });

  it('every cleanupOnError call is awaited so the release persists before return null', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);
    // No bare `cleanupOnError(` call may exist — only `await cleanupOnError(`
    // (and the `const cleanupOnError =` definition). A bare call would fire the
    // async marker release without awaiting it, racing the `return null`.
    const bareCalls = fnBody.match(/(?<!await )(?<!const )cleanupOnError\(/g) || [];
    expect(bareCalls, 'all cleanupOnError calls must be awaited').toEqual([]);
  });

  it('the max-spawns and lane-acquire early returns release the marker inline', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    // Slice from the function start up to where cleanupOnError is defined —
    // the two earliest `return null` paths live in this prefix.
    const defIdx = AGENT_LIFECYCLE_SRC.indexOf('const cleanupOnError =', fnStart);
    const prefix = AGENT_LIFECYCLE_SRC.slice(fnStart, defIdx);
    const inlineReleases = prefix.match(/await releaseAppReviewMarker\(task\.metadata\?\.app\)/g) || [];
    expect(inlineReleases.length, 'max-spawns + lane-acquire returns must each release inline').toBe(2);
  });
});

// ─── spawnAgentForTask — permanent provider-config failure blocks the task ───
//
// A resolution failure marked `permanent` (an api-only provider pinned to an
// agent task, which has no file-writing harness) fails identically on every
// re-dispatch. Without a block, the task stays pending and silently re-fails
// forever — the layered-intelligence "sits pending, never picked up" bug. Pin
// that the permanent branch flips the task to blocked so it stops re-dispatching.
describe('agentLifecycle source — permanent provider-config failure blocks the task', () => {
  it('the resolution-failure path blocks a permanent failure with a provider-config reason', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('const resolution = await resolveAgentProviderAndModel(task)');
    expect(idx, 'resolution call must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 2000);
    expect(body, 'gates the block on resolution.permanent').toMatch(/if\s*\(resolution\.permanent\)/);
    expect(body, 'flips the task to blocked').toMatch(/status:\s*'blocked'/);
    expect(body, 'tags the block category').toMatch(/blockedCategory:\s*'provider-config'/);
  });

  it('blocks BEFORE releasing the lease so a federated peer cannot be clobbered', () => {
    // The block write must run while the instance still holds the federation
    // lease and land BEFORE cleanupOnError releases it — otherwise a peer could
    // claim + start the task in the gap and have its live in_progress clobbered
    // to blocked. Pin the ordering: `if (resolution.permanent)` precedes the
    // `await cleanupOnError` inside the resolution-failure branch.
    const idx = AGENT_LIFECYCLE_SRC.indexOf('const resolution = await resolveAgentProviderAndModel(task)');
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 2000);
    const permanentIdx = body.indexOf('if (resolution.permanent)');
    const cleanupIdx = body.indexOf('await cleanupOnError(resolution.error)');
    expect(permanentIdx, 'permanent block must exist').toBeGreaterThan(-1);
    expect(cleanupIdx, 'cleanupOnError must exist').toBeGreaterThan(-1);
    expect(permanentIdx, 'block must precede the lease release').toBeLessThan(cleanupIdx);
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

  // ─── Widened try/catch/finally coverage ─────────────────────────────────
  //
  // Pre-fix, `spawnAgentForTask`'s try/finally only wrapped the final
  // `spawnViaRunner` / `spawnDirectly` calls. The ~400 LOC above
  // (buildAgentPrompt, writeFile, createAgentRun, registerAgent, etc.) was
  // not inside any try/catch — an uncaught throw on any of those paths
  // leaked `spawningTasks` forever, permanently blocking future spawns of
  // that task id.
  //
  // The fix widens the try to wrap from just after `spawningTasks.add` all
  // the way through the spawn call, with a `catch` arm that invokes
  // `cleanupOnError` and a `finally` that releases the guard
  // unconditionally. These tests replicate the post-fix flow with an
  // injected throw at each of the four documented async steps and assert
  // the guard is released. They match the inline-replica convention used
  // throughout this file (see the file header).

  async function simulateFixedSpawnPath({ taskId, agentId, throwAt, jobId = null, throwsAfterHandoff = false }) {
    spawningTasks.add(taskId);
    const harness = makeCleanupHarness(taskId, agentId);
    const jobSpawnFailedEmissions = [];
    let handedOff = false;
    try {
      // The injected step models the production flow: when
      // `throwsAfterHandoff` is set, we flip `handedOff` before throwing
      // to simulate a spawn-helper rejection (the helper may have already
      // created a live agent). Otherwise we throw before handoff to model
      // a pre-spawn setup failure (buildAgentPrompt / writeFile / etc.).
      if (throwsAfterHandoff) handedOff = true;
      await throwAt();
      handedOff = true;  // matches the production `handedOff = true` flip just before the spawn helper call
      return { result: 'spawned', harness, jobSpawnFailedEmissions };
    } catch (err) {
      if (handedOff) {
        // Spawn-helper rejection — re-throw to mirror production. Finally
        // still releases the dedup guard; the spawn helper's own
        // on('error') handler is responsible for lane/execution cleanup.
        throw err;
      }
      harness.cleanupOnError(err.message);
      // Mirror the production catch arm: when the task was queued by an
      // autonomous job, re-emit `job:spawn-failed` so cos.js clears its
      // job-level spawn guard.
      if (jobId) jobSpawnFailedEmissions.push({ jobId });
      return { result: null, harness, jobSpawnFailedEmissions };
    } finally {
      spawningTasks.delete(taskId);
    }
  }

  function expectGuardReleased({ result, harness }, message) {
    expect(result).toBeNull();
    expect(harness.released).toHaveLength(1);
    expect(harness.errored[0].message).toBe(message);
    expect(harness.completed[0].success).toBe(false);
  }

  it('releases the dedup guard when buildAgentPrompt throws', async () => {
    // Production reference: `buildAgentPrompt(task, ...)` call.
    const msg = 'prompt build failed (ENOSPC)';
    const outcome = await simulateFixedSpawnPath({
      taskId: 'task-prompt-throw',
      agentId: 'agent-prompt',
      throwAt: async () => { throw new Error(msg); },
    });
    expect(spawningTasks.has('task-prompt-throw')).toBe(false);
    expectGuardReleased(outcome, msg);
  });

  it('releases the dedup guard when writeFile(prompt) throws', async () => {
    // Production reference: `writeFile(join(agentDir, 'prompt.txt'), prompt)`.
    const msg = 'writeFile failed (EACCES)';
    const outcome = await simulateFixedSpawnPath({
      taskId: 'task-writefile-throw',
      agentId: 'agent-writefile',
      throwAt: async () => { throw new Error(msg); },
    });
    expect(spawningTasks.has('task-writefile-throw')).toBe(false);
    expectGuardReleased(outcome, msg);
  });

  it('releases the dedup guard when createAgentRun throws', async () => {
    // Production reference: `createAgentRun(agentId, task, ...)`.
    const msg = 'createAgentRun failed (DB write)';
    const outcome = await simulateFixedSpawnPath({
      taskId: 'task-runs-throw',
      agentId: 'agent-runs',
      throwAt: async () => { throw new Error(msg); },
    });
    expect(spawningTasks.has('task-runs-throw')).toBe(false);
    expectGuardReleased(outcome, msg);
  });

  it('releases the dedup guard when registerAgent throws', async () => {
    // Production reference: `registerAgent(agentId, task.id, {...})`.
    const msg = 'registerAgent failed (state mutex lost)';
    const outcome = await simulateFixedSpawnPath({
      taskId: 'task-register-throw',
      agentId: 'agent-register',
      throwAt: async () => { throw new Error(msg); },
    });
    expect(spawningTasks.has('task-register-throw')).toBe(false);
    expectGuardReleased(outcome, msg);
  });

  it('emits job:spawn-failed when an autonomous-job task throws mid-setup', async () => {
    // Pre-widening, the throw propagated to subAgentSpawner's `task:ready`
    // catch (subAgentSpawner.js:158-168) which emitted `job:spawn-failed`
    // so cos.js could clear `spawningJobIds` and re-register the cron
    // schedule. The widened catch consumes the throw locally — without
    // re-emitting that event here, the job-level guard would stick until
    // its 5-minute safety timeout.
    const outcome = await simulateFixedSpawnPath({
      taskId: 'task-job-throw',
      agentId: 'agent-job',
      jobId: 'job-cron-42',
      throwAt: async () => { throw new Error('writeFile failed (EACCES)'); },
    });
    expect(outcome.result).toBeNull();
    expect(outcome.jobSpawnFailedEmissions).toEqual([{ jobId: 'job-cron-42' }]);
  });

  it('does not emit job:spawn-failed for non-autonomous-job tasks', async () => {
    const outcome = await simulateFixedSpawnPath({
      taskId: 'task-user-throw',
      agentId: 'agent-user',
      throwAt: async () => { throw new Error('prompt build failed'); },
    });
    expect(outcome.result).toBeNull();
    expect(outcome.jobSpawnFailedEmissions).toEqual([]);
  });

  it('re-throws when a spawn helper rejects after handoff (live agent may exist)', async () => {
    // Pre-fix: a spawn helper's rejection propagated to subAgentSpawner's
    // task:ready catch, which logged + (if jobId) emitted job:spawn-failed.
    // The widened structure preserves this — once `handedOff` flips true,
    // the catch arm re-throws so the helper's own on('error') handler owns
    // lane/execution cleanup. The dedup guard is still released in finally.
    await expect(simulateFixedSpawnPath({
      taskId: 'task-handoff-throw',
      agentId: 'agent-handoff',
      jobId: 'job-cron-99',
      throwsAfterHandoff: true,
      throwAt: async () => { throw new Error('runner rejected spawn'); },
    })).rejects.toThrow('runner rejected spawn');
    // Critically, after the re-throw, the dedup guard must still be cleared.
    expect(spawningTasks.has('task-handoff-throw')).toBe(false);
  });

  // Source-level assertions: the catch arm distinguishes the two failure
  // modes via the `handedOff` flag, calls cleanupOnError + emits
  // job:spawn-failed on the pre-spawn branch, and rethrows on the
  // post-handoff branch. Any future refactor that drops either branch
  // breaks loudly here.
  it('source: spawnAgentForTask uses handedOff flag to distinguish pre-spawn vs post-handoff failures', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);
    // The flag is declared with `let` so we can mutate it inside the try.
    expect(fnBody).toMatch(/let\s+handedOff\s*=\s*false\s*;/);
    // The catch arm gates on the flag and rethrows for handoff failures.
    expect(fnBody).toMatch(/if\s*\(\s*handedOff\s*\)\s*\{[\s\S]{0,800}?throw\s+err\s*;/);
    // Pre-spawn branch (the else case) still calls cleanupOnError and
    // re-emits job:spawn-failed for autonomous jobs.
    expect(fnBody).toMatch(/cleanupOnError\(err\.message\)/);
    expect(fnBody).toMatch(/job:spawn-failed/);
    expect(fnBody).toMatch(/task\.metadata\??\.jobId/);
  });

  // Source-level assertion: `handedOff = true` must be set BEFORE the
  // first spawn helper invocation (spawnTuiAgent / spawnViaRunner /
  // spawnDirectly). Setting it after would mean a synchronous throw from
  // building the helper's argument object falls into the pre-spawn cleanup
  // branch, which is wrong if the helper has already begun work.
  it('source: handedOff = true precedes the first spawn helper invocation', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);
    const flipIdx = fnBody.indexOf('handedOff = true');
    expect(flipIdx, '`handedOff = true` must exist inside spawnAgentForTask').toBeGreaterThan(-1);
    for (const helper of ['spawnTuiAgent(', 'spawnViaRunner(', 'spawnDirectly(']) {
      const idx = fnBody.indexOf(helper);
      expect(idx, `${helper} must appear AFTER \`handedOff = true\``).toBeGreaterThan(flipIdx);
    }
  });
});

// ─── Instance provenance stamping (issue #1563, acceptance criterion 1) ──────
//
// Every spawned agent must record the producing machine's federation identity
// so that, once CoS agent history federates across peers (the rest of #1563),
// a node pair can attribute each agent + its worktree branch to the instance
// that produced it — the prerequisite for never duplicating agent work. The
// stamp rides in the `registerAgent` metadata and propagates into the
// completed-agent archive's `metadata.json` automatically, since `completeAgent`
// serializes `.metadata`. These source-level assertions break loudly if a
// future refactor drops the stamp.
describe('agentLifecycle — instance provenance stamping (#1563)', () => {
  it('source: imports the identity resolver from the instances service', () => {
    expect(AGENT_LIFECYCLE_SRC).toMatch(
      /import\s*\{\s*ensureInstanceId\s*\}\s*from\s*'\.\/instances\.js';/
    );
  });

  it('source: resolves instanceId via ensureInstanceId() before registering the agent', () => {
    // Resolution is delegated to the shared `ensureInstanceId()` helper in
    // instances.js (which handles the boot-time `unknown` sentinel cold path)
    // and is reused by the #1563 claim guard at the top of the spawn. The
    // contract is unchanged: the id is resolved before registerAgent stamps it.
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);
    const resolveIdx = fnBody.indexOf('await ensureInstanceId()');
    const registerIdx = fnBody.indexOf('registerAgent(agentId, task.id, {');
    expect(resolveIdx, '`await ensureInstanceId()` must exist inside spawnAgentForTask').toBeGreaterThan(-1);
    expect(registerIdx, '`registerAgent(...)` must exist inside spawnAgentForTask').toBeGreaterThan(-1);
    expect(resolveIdx, 'instanceId must be resolved BEFORE registerAgent is called').toBeLessThan(registerIdx);
  });

  it('source: refuses to spawn a task under another instance\'s live lease (claim guard)', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);
    const guardIdx = fnBody.indexOf('isClaimableBy(task.metadata, instanceId)');
    const registerIdx = fnBody.indexOf('registerAgent(agentId, task.id, {');
    expect(guardIdx, 'must gate the spawn on isClaimableBy').toBeGreaterThan(-1);
    expect(guardIdx, 'the claim guard must run BEFORE registering the agent').toBeLessThan(registerIdx);
  });

  it('source: stamps the federation claim into the in_progress task update', () => {
    expect(AGENT_LIFECYCLE_SRC).toMatch(/\.\.\.buildClaim\(instanceId\)/);
  });

  it('source: acquires the claim (updateTask with buildClaim) BEFORE registering the agent', () => {
    // Codex review fix: the lease must be taken up front, not only at the
    // in_progress flip after worktree/agent setup, so a peer's claim that
    // synced in is honored before this instance commits to spawning.
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);
    const acquireIdx = fnBody.indexOf('metadata: buildClaim(instanceId)');
    const registerIdx = fnBody.indexOf('registerAgent(agentId, task.id, {');
    expect(acquireIdx, 'must acquire the claim via updateTask(buildClaim) up front').toBeGreaterThan(-1);
    expect(acquireIdx, 'claim must be acquired BEFORE registerAgent').toBeLessThan(registerIdx);
  });

  it('source: re-reads the freshest task and yields if claimed during dispatch', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);
    const rereadIdx = fnBody.indexOf('await getTaskById(task.id)');
    const recheckIdx = fnBody.indexOf('!isClaimableBy(freshTask.metadata, instanceId)');
    expect(rereadIdx, 'must re-read the freshest persisted task before claiming').toBeGreaterThan(-1);
    expect(recheckIdx, 'must re-check claimability against the fresh metadata').toBeGreaterThan(rereadIdx);
  });

  it('source: acquires the spawningTasks dedup guard before the first await', () => {
    // The guard must be taken synchronously (before `await ensureInstanceId()`
    // or `await getTaskById()`), or a concurrent task:ready re-emit could slip
    // past the has() check while this call is suspended and spawn a duplicate.
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);
    const addIdx = fnBody.indexOf('spawningTasks.add(task.id)');
    // The first awaited CALL in the function (anchor on the real statement, not
    // the word "await" in a comment) is the identity resolution.
    const firstAwaitIdx = fnBody.indexOf('await ensureInstanceId()');
    expect(addIdx, 'spawningTasks.add must exist').toBeGreaterThan(-1);
    expect(firstAwaitIdx, 'await ensureInstanceId() must exist').toBeGreaterThan(-1);
    expect(addIdx, 'the dedup guard must be acquired BEFORE the first await').toBeLessThan(firstAwaitIdx);
  });

  it('source: releases the spawn guard if identity resolution rejects', () => {
    // ensureInstanceId() runs after spawningTasks.add but before the main
    // try/finally, so a rejection must not strand the task in spawningTasks.
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);
    const tryIdx = fnBody.indexOf('instanceId = await ensureInstanceId();');
    const catchSlice = fnBody.slice(tryIdx, tryIdx + 260);
    expect(tryIdx, 'ensureInstanceId must be awaited').toBeGreaterThan(-1);
    expect(catchSlice, 'a catch around ensureInstanceId must release the guard').toMatch(/catch[\s\S]*spawningTasks\.delete\(task\.id\)/);
  });

  it('source: releases the claim on a failed-setup early exit (cleanupOnError)', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('const cleanupOnError = async');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 1200);
    expect(fnBody.indexOf('claimAcquired'), 'cleanupOnError must gate on claimAcquired').toBeGreaterThan(-1);
    expect(fnBody.indexOf('buildRelease()'), 'cleanupOnError must release the claim via buildRelease').toBeGreaterThan(-1);
  });

  it('source: stamps instanceId into the registerAgent metadata', () => {
    const registerIdx = AGENT_LIFECYCLE_SRC.indexOf('registerAgent(agentId, task.id, {');
    // The metadata object literal opens at registerIdx; assert `instanceId,`
    // appears within it (before the workspacePath field that follows).
    const metaSlice = AGENT_LIFECYCLE_SRC.slice(registerIdx, registerIdx + 400);
    expect(metaSlice).toMatch(/\binstanceId,/);
    expect(metaSlice.indexOf('instanceId,')).toBeLessThan(metaSlice.indexOf('workspacePath'));
  });
});

describe('agentLifecycle — runner OpenCode Ollama env (#2243 / #2190)', () => {
  it('source: imports buildOpencodeEnvVars from opencodeConfig', () => {
    expect(AGENT_LIFECYCLE_SRC).toMatch(
      /import\s*\{\s*buildOpencodeEnvVars\s*\}\s*from\s*'\.\.\/lib\/opencodeConfig\.js';/
    );
  });

  it('source: spawnViaRunner merges buildOpencodeEnvVars into the runner envVars so --model ollama/<id> is accepted', () => {
    // The direct-spawn path and the "Run Prompt" path already inject the dynamic
    // OPENCODE_CONFIG_CONTENT (models map); the runner path omitted it, so an
    // OpenCode Ollama CoS task on the runner rejected the model even after the
    // spawn succeeded. Assert the merge exists inside spawnViaRunner and that the
    // env passed to the runner unions it.
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnViaRunner');
    expect(fnStart, 'spawnViaRunner must exist').toBeGreaterThan(-1);
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 4000);
    const buildIdx = fnBody.indexOf('buildOpencodeEnvVars(provider, model)');
    expect(buildIdx, 'must build the opencode env from provider+model').toBeGreaterThan(-1);
    // The spread must reach the envVars handed to spawnAgentViaRunner.
    expect(fnBody).toMatch(/envVars:\s*\{[^}]*\.\.\.opencodeEnv[^}]*\}/);
    expect(fnBody.indexOf('...opencodeEnv'), 'opencodeEnv must be spread AFTER provider.envVars so it overrides the static config')
      .toBeGreaterThan(fnBody.indexOf('...provider.envVars'));
  });

  it('source: spawnViaRunner pins GH_TOKEN via resolveForgeTokenEnv so the runner-spawned agent\'s `gh` uses the repo-owner account', () => {
    // The direct and TUI spawn paths inject the owner-matched GH_TOKEN; the
    // runner path must too, or a codex/CLI agent under the runner opens its PR
    // as gh's mutable active-user (the multi-account "must be a collaborator"
    // failure). Assert the resolve+spread exists inside spawnViaRunner.
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnViaRunner');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 4000);
    expect(fnBody).toContain('resolveForgeTokenEnv(workspacePath)');
    expect(fnBody).toMatch(/envVars:\s*\{[^}]*\.\.\.forgeTokenEnv[^}]*\}/);
    // forgeTokenEnv before provider.envVars so an explicit provider GH_TOKEN wins.
    expect(fnBody.indexOf('...forgeTokenEnv'), 'forgeTokenEnv must be spread BEFORE provider.envVars')
      .toBeLessThan(fnBody.indexOf('...provider.envVars'));
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
 * delete. Mirrors agentLifecycle.js handleAgentCompletion with the
 * try/finally added so `deleteRunner()` ALWAYS runs even when an inner
 * step throws. This is the behavioral contract enforced by the
 * regression tests below.
 */
async function runCompletion(harness, effectiveSuccess) {
  try {
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
  } finally {
    harness.deleteRunner();
  }
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

describe('handleAgentCompletion — error recovery (try/finally guard)', () => {
  beforeEach(() => {
    runnerAgents.clear();
  });

  it('a throw from completeAgent still removes the runner record (finally guard)', async () => {
    // handleAgentCompletion wraps the entire completion sequence in
    // try/finally so a throw from any inner step cannot leak the
    // runnerAgents Map entry. The error still propagates to the caller —
    // the finally only guards in-memory state.
    runnerAgents.set('agent-C', { taskId: 'task-C' });
    const h = makeCompletionHarness({
      taskId: 'task-C',
      agentId: 'agent-C',
      throws: { completeAgent: true },
    });

    await expect(runCompletion(h, true)).rejects.toThrow('completeAgent failed');

    expect(runnerAgents.has('agent-C')).toBe(false);
    // Downstream steps did not run, but the finally fired deleteRunner.
    expect(h.calls.map(c => c.step)).toEqual(['completeAgent', 'deleteRunner']);
  });

  it('a throw from updateTask still removes the runner record', async () => {
    runnerAgents.set('agent-D', { taskId: 'task-D' });
    const h = makeCompletionHarness({
      taskId: 'task-D',
      agentId: 'agent-D',
      throws: { updateTask: true },
    });

    await expect(runCompletion(h, true)).rejects.toThrow('updateTask failed');

    expect(runnerAgents.has('agent-D')).toBe(false);
    expect(h.calls.map(c => c.step)).toEqual(['completeAgent', 'updateTask', 'deleteRunner']);
  });

  it('a throw from processAgentCompletion (hook dispatch) still removes the runner record', async () => {
    runnerAgents.set('agent-E', { taskId: 'task-E' });
    const h = makeCompletionHarness({
      taskId: 'task-E',
      agentId: 'agent-E',
      throws: { processAgentCompletion: true },
    });

    await expect(runCompletion(h, true)).rejects.toThrow('processAgentCompletion failed');

    expect(runnerAgents.has('agent-E')).toBe(false);
    expect(h.calls.find(c => c.step === 'completeAgent')).toBeDefined();
    expect(h.calls.find(c => c.step === 'updateTask')).toBeDefined();
    expect(h.calls.find(c => c.step === 'deleteRunner')).toBeDefined();
  });

  it('a throw from completeAgentRun still removes the runner record', async () => {
    runnerAgents.set('agent-F', { taskId: 'task-F' });
    const h = makeCompletionHarness({
      taskId: 'task-F',
      agentId: 'agent-F',
      runId: 'run-123',
      throws: { completeAgentRun: true },
    });

    await expect(runCompletion(h, true)).rejects.toThrow('completeAgentRun failed');

    expect(runnerAgents.has('agent-F')).toBe(false);
  });
});

// Source-level regression: the runner-cleanup `runnerAgents.delete(agentId)`
// MUST live inside a `finally` clause so it survives a throw from any step
// of the completion sequence.
describe('agentLifecycle source — try/finally guard', () => {
  it('handleAgentCompletion wraps the body in try/finally with runnerAgents.delete inside finally', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function handleAgentCompletion');
    expect(fnStart, 'handleAgentCompletion must exist').toBeGreaterThan(-1);
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 60_000);
    expect(fnBody).toMatch(/finally\s*\{[\s\S]{0,200}?runnerAgents\.delete\(agentId\)/);
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
