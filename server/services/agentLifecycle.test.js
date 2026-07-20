/**
 * Tests for the agent-lifecycle concurrency guards.
 *
 * The two guard primitives that gate every spawn + completion were extracted
 * into agentGuards.js (issue #2548) precisely so these tests drive the REAL
 * code path instead of a hand-copied replica of spawnAgentForTask /
 * handleAgentCompletion:
 *
 *   - withSpawnDedupGuard — the `spawningTasks` dedup guard that
 *     `spawnAgentForTask` wraps `runAgentSpawn` in. Acquires the guard
 *     synchronously before the first await, holds it across the ENTIRE spawn
 *     body (including the runner-enqueue handoff), and releases it in a
 *     finally. That is what closes the late-delete race where a concurrent
 *     `task:ready` re-emit spawned a SECOND agent for the same task id.
 *   - withMapEntryCleanup — the `runnerAgents` cleanup that
 *     `handleAgentCompletion` wraps its body in, so a throw from any
 *     completion step (completeAgent / updateTask / processAgentCompletion /
 *     finalizeAgent) can't strand the in-memory agent record.
 *
 * A thin set of source-level assertions at the bottom pins the remaining
 * non-negotiable orderings that live inside the ~470-LOC orchestrators and
 * have no behavioral seam — the handedOff pre-spawn/post-handoff split, the
 * federation claim/register ordering (#1563), the #989 app-review marker
 * release, the runner env merge (#2243) — plus the wiring invariant that the
 * orchestrators actually delegate to the extracted guards.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawningTasks, runnerAgents } from './agentState.js';
import { withSpawnDedupGuard, withMapEntryCleanup, SPAWN_DEDUP_SKIP } from './agentGuards.js';
import { isInternalTaskId } from '../lib/taskParser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_LIFECYCLE_SRC = readFileSync(join(__dirname, 'agentLifecycle.js'), 'utf-8');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  spawningTasks.clear();
  runnerAgents.clear();
});

// ─── withSpawnDedupGuard — the real spawn dedup guard ───────────────────────

describe('withSpawnDedupGuard — spawn dedup guard', () => {
  it('holds the guard for the duration of fn and releases it on success', async () => {
    const task = { id: 'task-ok' };
    let heldDuringFn = false;
    const result = await withSpawnDedupGuard(spawningTasks, task.id, async () => {
      heldDuringFn = spawningTasks.has(task.id);
      return 'agent-1';
    });
    expect(heldDuringFn).toBe(true);
    expect(result).toBe('agent-1');
    expect(spawningTasks.has(task.id)).toBe(false);
  });

  it('releases the guard even when fn throws (no leak on setup failure)', async () => {
    // The pre-widening bug: a throw from buildAgentPrompt / writeFile /
    // createAgentRun / registerAgent leaked spawningTasks forever, permanently
    // blocking every future spawn of that task id.
    await expect(
      withSpawnDedupGuard(spawningTasks, 'task-throw', async () => {
        throw new Error('buildAgentPrompt failed (ENOSPC)');
      })
    ).rejects.toThrow('buildAgentPrompt failed');
    expect(spawningTasks.has('task-throw')).toBe(false);
  });

  it('releases the guard on an early return null (detected-error path)', async () => {
    // Every detected-error early return inside runAgentSpawn (no provider,
    // claim yielded, max-spawns, lane-acquire, updateTask failure) returns null;
    // the guard must be released for each of them.
    const result = await withSpawnDedupGuard(spawningTasks, 'task-null', async () => null);
    expect(result).toBeNull();
    expect(spawningTasks.has('task-null')).toBe(false);
  });

  it('returns SPAWN_DEDUP_SKIP and does not touch the set when already held', async () => {
    spawningTasks.add('task-inflight'); // an earlier spawn is mid-flight
    let fnRan = false;
    const result = await withSpawnDedupGuard(spawningTasks, 'task-inflight', async () => {
      fnRan = true;
      return 'agent-2';
    });
    expect(result).toBe(SPAWN_DEDUP_SKIP);
    expect(fnRan).toBe(false); // the guarded body never ran
    expect(spawningTasks.has('task-inflight')).toBe(true); // pre-existing guard untouched
  });

  it('acquires the guard synchronously before the first await inside fn', async () => {
    // A `task:ready` re-emit can land while the first spawn is suspended at an
    // await (ensureInstanceId / getTaskById). The guard must be taken
    // synchronously — before fn yields — or the racer slips past the has()
    // check. Prove it: a second call issued with NO await between the two must
    // already see the guard held.
    const gate = deferred();
    const first = withSpawnDedupGuard(spawningTasks, 'task-sync', async () => {
      await gate.promise;
      return 'agent-first';
    });
    const second = await withSpawnDedupGuard(spawningTasks, 'task-sync', async () => 'agent-second');
    expect(second).toBe(SPAWN_DEDUP_SKIP);
    gate.resolve();
    expect(await first).toBe('agent-first');
  });
});

// ─── The reported late-delete race, driven by the real guard ────────────────

describe('spawnAgentForTask dedup — late-delete race (issue #2548 / #1563)', () => {
  it('a concurrent spawn landing during the handoff window is deduped (only ONE agent)', async () => {
    // Reproduce the reported race with the REAL guard. Call A holds the guard
    // across its whole body — including the runner-enqueue handoff, modelled
    // here by an awaited gate. Call B arrives DURING that handoff window: the
    // exact boundary (after the in_progress flip, before the runner accepted
    // the agent) where the pre-fix code had already released the guard and let
    // a second agent spawn. Because withSpawnDedupGuard holds the guard until
    // A's fn settles, B is deduped instead of spawning a duplicate.
    const taskId = 'task-race';
    const spawned = [];
    const handoffGate = deferred();
    let secondCall;

    const first = withSpawnDedupGuard(spawningTasks, taskId, async () => {
      // Inject the racer mid-handoff, while the guard is (correctly) still held.
      secondCall = withSpawnDedupGuard(spawningTasks, taskId, async () => {
        spawned.push('agent-second');
        return 'agent-second';
      });
      await handoffGate.promise; // runner-enqueue completing
      spawned.push('agent-first');
      return 'agent-first';
    });

    // Drain microtasks so A reaches the injection point + B runs its dedup path.
    await new Promise((r) => setImmediate(r));
    const secondResult = await secondCall;

    handoffGate.resolve();
    const firstResult = await first;

    expect(secondResult).toBe(SPAWN_DEDUP_SKIP); // racer deduped, no second agent
    expect(spawned).toEqual(['agent-first']);    // exactly ONE agent spawned
    expect(firstResult).toBe('agent-first');
    expect(spawningTasks.has(taskId)).toBe(false); // released once A settled
  });

  it('the guard is per-attempt, not sticky — a later spawn for the same id proceeds', async () => {
    // Sanity: after A completes and releases, a subsequent spawn for the same
    // task id (e.g. a retry) must not be permanently blocked.
    const taskId = 'task-seq';
    const a = await withSpawnDedupGuard(spawningTasks, taskId, async () => 'agent-a');
    const b = await withSpawnDedupGuard(spawningTasks, taskId, async () => 'agent-b');
    expect(a).toBe('agent-a');
    expect(b).toBe('agent-b');
    expect(spawningTasks.has(taskId)).toBe(false);
  });
});

// ─── withMapEntryCleanup — the real runnerAgents completion cleanup ──────────

describe('withMapEntryCleanup — runnerAgents completion cleanup', () => {
  it('runs the completion steps then deletes the map entry (happy path)', async () => {
    runnerAgents.set('agent-A', { taskId: 'task-A' });
    const steps = [];
    await withMapEntryCleanup(runnerAgents, 'agent-A', async () => {
      steps.push('completeAgent');
      steps.push('updateTask');
      steps.push('processAgentCompletion');
    });
    expect(steps).toEqual(['completeAgent', 'updateTask', 'processAgentCompletion']);
    expect(runnerAgents.has('agent-A')).toBe(false);
  });

  it('deletes the map entry even when an inner completion step throws', async () => {
    // A throw from completeAgent / updateTask / processAgentCompletion /
    // finalizeAgent must never leak the in-memory record — memory grows
    // unboundedly and a stale entry can re-trigger/misroute completion.
    runnerAgents.set('agent-B', { taskId: 'task-B' });
    await expect(
      withMapEntryCleanup(runnerAgents, 'agent-B', async () => {
        throw new Error('completeAgent failed: state save error');
      })
    ).rejects.toThrow('completeAgent failed');
    expect(runnerAgents.has('agent-B')).toBe(false);
  });

  it('propagates the inner error after cleanup (finally does not swallow it)', async () => {
    runnerAgents.set('agent-C', { taskId: 'task-C' });
    let caught;
    try {
      await withMapEntryCleanup(runnerAgents, 'agent-C', async () => {
        throw new Error('updateTask failed');
      });
    } catch (err) {
      caught = err;
    }
    expect(caught?.message).toBe('updateTask failed');
    expect(runnerAgents.has('agent-C')).toBe(false);
  });

  it('is safe when the entry was already removed (double-delete no-op)', async () => {
    // handleAgentCompletion's early-return branches (paused / unknown agent)
    // delete the entry before the guarded body; the finally delete must be a
    // harmless no-op if the key is already gone.
    const result = await withMapEntryCleanup(runnerAgents, 'agent-missing', async () => 'ok');
    expect(result).toBe('ok');
    expect(runnerAgents.has('agent-missing')).toBe(false);
  });
});

// ─── Wiring invariants: the orchestrators delegate to the guards ────────────
//
// The behavioral tests above cover the guards themselves; these two source
// checks pin that spawnAgentForTask / handleAgentCompletion actually route
// their guard/cleanup through the extracted helpers, so a refactor that
// re-inlines a hand-rolled try/finally (and re-opens the race) fails loudly.

describe('agentLifecycle — guard wiring', () => {
  it('spawnAgentForTask delegates the dedup guard to withSpawnDedupGuard(runAgentSpawn)', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    expect(idx, 'spawnAgentForTask must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 1200);
    expect(body).toMatch(
      /withSpawnDedupGuard\(\s*spawningTasks\s*,\s*task\.id\s*,\s*\(\)\s*=>\s*runAgentSpawn\(task\)\s*\)/
    );
    // The dedup-skip sentinel is honored (returns null to the caller).
    expect(body).toMatch(/SPAWN_DEDUP_SKIP/);
  });

  it('handleAgentCompletion delegates runnerAgents cleanup to withMapEntryCleanup', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('export async function handleAgentCompletion');
    expect(idx, 'handleAgentCompletion must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 60_000);
    expect(body).toMatch(/withMapEntryCleanup\(\s*runnerAgents\s*,\s*agentId\s*,/);
  });

  it('finalizeAgent stamps the LI execution verdict into the completion task write (#2779)', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('export async function finalizeAgent');
    expect(idx, 'finalizeAgent must exist').toBeGreaterThan(-1);
    const updateIdx = AGENT_LIFECYCLE_SRC.indexOf('await updateTask(task.id, taskUpdate, taskType)', idx);
    expect(updateIdx, 'finalizeAgent must persist the task via updateTask').toBeGreaterThan(idx);
    const body = AGENT_LIFECYCLE_SRC.slice(idx, updateIdx);
    // Verdict is derived from the persisted task's liProposal marker via the shared
    // builder (parity with the local #2765 write) and merged into taskUpdate.metadata
    // under LI_EXECUTION_VERDICT_KEY — BEFORE the updateTask call, so it federates in
    // the same write that marks the task terminal.
    expect(body).toMatch(/task\?\.metadata\?\.liProposal/);
    expect(body).toMatch(/buildLiExecutionVerdict\(/);
    expect(body).toMatch(/\[LI_EXECUTION_VERDICT_KEY\]:\s*verdict/);
  });
});

// ─── Non-negotiable orderings inside runAgentSpawn (no behavioral seam) ──────
//
// These pin control-flow orderings that live inside the ~470-LOC guarded spawn
// body and can't be reached without mocking its 40+ imports. Anchored on
// `runAgentSpawn` (the guarded body extracted from spawnAgentForTask, #2548).

const RUN_SPAWN_START = AGENT_LIFECYCLE_SRC.indexOf('async function runAgentSpawn');
const RUN_SPAWN_BODY = AGENT_LIFECYCLE_SRC.slice(RUN_SPAWN_START, RUN_SPAWN_START + 60_000);

describe('runAgentSpawn source — handedOff pre-spawn vs post-handoff split', () => {
  it('uses a mutable handedOff flag to distinguish the two failure modes', () => {
    // The flag is declared with `let` so the catch arm can read which side of
    // the spawn handoff a throw came from.
    expect(RUN_SPAWN_BODY).toMatch(/let\s+handedOff\s*=\s*false\s*;/);
    // The catch arm rethrows for post-handoff failures (a live agent may exist).
    expect(RUN_SPAWN_BODY).toMatch(/if\s*\(\s*handedOff\s*\)\s*\{[\s\S]{0,800}?throw\s+err\s*;/);
    // The pre-spawn branch runs cleanupOnError + re-emits job:spawn-failed for
    // autonomous-job tasks so cos.js can clear its job-level guard.
    expect(RUN_SPAWN_BODY).toMatch(/cleanupOnError\(err\.message\)/);
    expect(RUN_SPAWN_BODY).toMatch(/job:spawn-failed/);
    expect(RUN_SPAWN_BODY).toMatch(/task\.metadata\??\.jobId/);
  });

  it('sets handedOff = true BEFORE the first spawn helper invocation', () => {
    // Setting it after would misclassify a synchronous throw from building the
    // helper's argument object as a pre-spawn failure even though the helper
    // may have begun work.
    const flipIdx = RUN_SPAWN_BODY.indexOf('handedOff = true');
    expect(flipIdx, '`handedOff = true` must exist inside runAgentSpawn').toBeGreaterThan(-1);
    for (const helper of ['spawnTuiAgent(', 'spawnViaRunner(', 'spawnDirectly(']) {
      const idx = RUN_SPAWN_BODY.indexOf(helper);
      expect(idx, `${helper} must appear AFTER \`handedOff = true\``).toBeGreaterThan(flipIdx);
    }
  });
});

// Source-level assertion (issue #989): the synthetic app-review marker bound by
// `bindAppReviewAgent` before this spawn MUST be released on every
// pre-completion `return null` path, or the app reads "in review" until the next
// daemon restart. The shared `cleanupOnError` closure owns the release for the
// detected-error paths + the pre-spawn catch arm; the two earliest returns
// (max-spawns block, lane-acquire failure) release inline before cleanupOnError
// is defined.
describe('runAgentSpawn source — app-review marker release (issue #989)', () => {
  it('cleanupOnError releases the synthetic app-review marker', () => {
    const start = AGENT_LIFECYCLE_SRC.indexOf('const cleanupOnError =');
    expect(start, 'cleanupOnError must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(start, start + 900);
    expect(body, 'cleanupOnError must release the app-review marker').toMatch(
      /releaseAppReviewMarker\(task\.metadata\?\.app\)/
    );
  });

  it('every cleanupOnError call is awaited so the release persists before return null', () => {
    // A bare `cleanupOnError(` call would fire the async marker release without
    // awaiting it, racing the `return null`.
    const bareCalls = RUN_SPAWN_BODY.match(/(?<!await )(?<!const )cleanupOnError\(/g) || [];
    expect(bareCalls, 'all cleanupOnError calls must be awaited').toEqual([]);
  });

  it('the max-spawns and lane-acquire early returns release the marker inline', () => {
    const defIdx = AGENT_LIFECYCLE_SRC.indexOf('const cleanupOnError =', RUN_SPAWN_START);
    const prefix = AGENT_LIFECYCLE_SRC.slice(RUN_SPAWN_START, defIdx);
    const inlineReleases = prefix.match(/await releaseAppReviewMarker\(task\.metadata\?\.app\)/g) || [];
    expect(inlineReleases.length, 'max-spawns + lane-acquire returns must each release inline').toBe(2);
  });
});

// ─── runAgentSpawn — permanent provider-config failure blocks the task ───────
//
// A resolution failure marked `permanent` (an api-only provider pinned to an
// agent task, which has no file-writing harness) fails identically on every
// re-dispatch. Without a block, the task stays pending and silently re-fails
// forever. Pin that the permanent branch flips the task to blocked BEFORE the
// lease is released, so a federated peer can't be clobbered.
describe('runAgentSpawn source — permanent provider-config failure blocks the task', () => {
  it('the resolution-failure path blocks a permanent failure with a provider-config reason', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('const resolution = await resolveAgentProviderAndModel(task)');
    expect(idx, 'resolution call must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 2000);
    expect(body, 'gates the block on resolution.permanent').toMatch(/if\s*\(resolution\.permanent\)/);
    expect(body, 'flips the task to blocked').toMatch(/status:\s*'blocked'/);
    expect(body, 'tags the block category').toMatch(/blockedCategory:\s*'provider-config'/);
  });

  it('blocks BEFORE releasing the lease so a federated peer cannot be clobbered', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('const resolution = await resolveAgentProviderAndModel(task)');
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 2000);
    const permanentIdx = body.indexOf('if (resolution.permanent)');
    const cleanupIdx = body.indexOf('await cleanupOnError(resolution.error)');
    expect(permanentIdx, 'permanent block must exist').toBeGreaterThan(-1);
    expect(cleanupIdx, 'cleanupOnError must exist').toBeGreaterThan(-1);
    expect(permanentIdx, 'block must precede the lease release').toBeLessThan(cleanupIdx);
  });
});

// ─── Instance provenance stamping + claim ordering (issue #1563) ─────────────
//
// Every spawned agent records the producing machine's federation identity, and
// the cross-instance claim must be acquired (and re-checked against the fresh
// record) BEFORE the agent is registered — otherwise two peers spawn for the
// same task. These orderings live inside runAgentSpawn with no behavioral seam.
describe('runAgentSpawn source — instance provenance + claim ordering (#1563)', () => {
  it('imports the identity resolver from the instances service', () => {
    expect(AGENT_LIFECYCLE_SRC).toMatch(
      /import\s*\{\s*ensureInstanceId\s*\}\s*from\s*'\.\/instances\.js';/
    );
  });

  it('resolves instanceId via ensureInstanceId() before registering the agent', () => {
    const resolveIdx = RUN_SPAWN_BODY.indexOf('await ensureInstanceId()');
    const registerIdx = RUN_SPAWN_BODY.indexOf('registerAgent(agentId, task.id, {');
    expect(resolveIdx, '`await ensureInstanceId()` must exist inside runAgentSpawn').toBeGreaterThan(-1);
    expect(registerIdx, '`registerAgent(...)` must exist inside runAgentSpawn').toBeGreaterThan(-1);
    expect(resolveIdx, 'instanceId must be resolved BEFORE registerAgent is called').toBeLessThan(registerIdx);
  });

  it("refuses to spawn a task under another instance's live lease (claim guard)", () => {
    const guardIdx = RUN_SPAWN_BODY.indexOf('isClaimableBy(task.metadata, instanceId)');
    const registerIdx = RUN_SPAWN_BODY.indexOf('registerAgent(agentId, task.id, {');
    expect(guardIdx, 'must gate the spawn on isClaimableBy').toBeGreaterThan(-1);
    expect(guardIdx, 'the claim guard must run BEFORE registering the agent').toBeLessThan(registerIdx);
  });

  it('stamps the federation claim into the in_progress task update', () => {
    expect(AGENT_LIFECYCLE_SRC).toMatch(/\.\.\.buildClaim\(instanceId\)/);
  });

  it('acquires the claim (updateTask with buildClaim) BEFORE registering the agent', () => {
    const acquireIdx = RUN_SPAWN_BODY.indexOf('metadata: buildClaim(instanceId)');
    const registerIdx = RUN_SPAWN_BODY.indexOf('registerAgent(agentId, task.id, {');
    expect(acquireIdx, 'must acquire the claim via updateTask(buildClaim) up front').toBeGreaterThan(-1);
    expect(acquireIdx, 'claim must be acquired BEFORE registerAgent').toBeLessThan(registerIdx);
  });

  it('re-reads the freshest task and yields if claimed during dispatch', () => {
    const rereadIdx = RUN_SPAWN_BODY.indexOf('await getTaskById(task.id)');
    const recheckIdx = RUN_SPAWN_BODY.indexOf('!isClaimableBy(freshTask.metadata, instanceId)');
    expect(rereadIdx, 'must re-read the freshest persisted task before claiming').toBeGreaterThan(-1);
    expect(recheckIdx, 'must re-check claimability against the fresh metadata').toBeGreaterThan(rereadIdx);
  });

  it('releases the claim on a failed-setup early exit (cleanupOnError)', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('const cleanupOnError = async');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 1200);
    expect(fnBody.indexOf('claimAcquired'), 'cleanupOnError must gate on claimAcquired').toBeGreaterThan(-1);
    expect(fnBody.indexOf('buildRelease()'), 'cleanupOnError must release the claim via buildRelease').toBeGreaterThan(-1);
  });

  it('stamps instanceId into the registerAgent metadata', () => {
    const registerIdx = AGENT_LIFECYCLE_SRC.indexOf('registerAgent(agentId, task.id, {');
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
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnViaRunner');
    expect(fnStart, 'spawnViaRunner must exist').toBeGreaterThan(-1);
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 4000);
    const buildIdx = fnBody.indexOf('buildOpencodeEnvVars(provider, model)');
    expect(buildIdx, 'must build the opencode env from provider+model').toBeGreaterThan(-1);
    expect(fnBody).toMatch(/envVars:\s*\{[^}]*\.\.\.opencodeEnv[^}]*\}/);
    expect(fnBody.indexOf('...opencodeEnv'), 'opencodeEnv must be spread AFTER provider.envVars so it overrides the static config')
      .toBeGreaterThan(fnBody.indexOf('...provider.envVars'));
  });

  it("source: spawnViaRunner pins GH_TOKEN via resolveForgeTokenEnv so the runner-spawned agent's `gh` uses the repo-owner account", () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnViaRunner');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 4000);
    expect(fnBody).toContain('resolveForgeTokenEnv(workspacePath)');
    expect(fnBody).toMatch(/envVars:\s*\{[^}]*\.\.\.forgeTokenEnv[^}]*\}/);
    expect(fnBody.indexOf('...forgeTokenEnv'), 'forgeTokenEnv must be spread BEFORE provider.envVars')
      .toBeLessThan(fnBody.indexOf('...provider.envVars'));
  });
});

// ─── taskType normalization for direct task:ready emits (issue #2633) ────────
//
// Direct `task:ready` emitters (Creative Director bridge, dequeueNextTask,
// spawnPriority0OnDemand) publish task records with no `taskType`. Every
// claim/in_progress `updateTask` in runAgentSpawn falls back to
// `task.taskType || 'user'`, so an internal (`sys-*`) task without taskType
// would write to TASKS.md, miss the record, and return a truthy `{ error }`
// object the `if (!updateResult)` check silently swallowed. The fix normalizes
// taskType at the top of runAgentSpawn via the real isInternalTaskId classifier.
describe('taskType normalization — behavior (issue #2633)', () => {
  // Mirrors the normalization at the top of runAgentSpawn against the REAL
  // isInternalTaskId import, so a change to the internal-prefix list stays in
  // sync with what the spawn path routes on (inline-pure-logic pattern).
  const normalizeTaskType = (task) => {
    if (task && !task.taskType) {
      task.taskType = isInternalTaskId(task.id || '') ? 'internal' : 'user';
    }
    return task;
  };

  it('routes a sys-* id with no taskType to the internal file (COS-TASKS.md)', () => {
    const task = { id: 'sys-002', description: 'internal task' };
    normalizeTaskType(task);
    expect(task.taskType, "sys-* must resolve to 'internal' so updateTask targets COS-TASKS.md").toBe('internal');
  });

  it('routes cd-* and app-improve-* ids (other internal prefixes) to internal', () => {
    expect(normalizeTaskType({ id: 'cd-42' }).taskType).toBe('internal');
    expect(normalizeTaskType({ id: 'app-improve-9' }).taskType).toBe('internal');
  });

  it('leaves a user task-* id defaulting to user (unchanged spawn behavior)', () => {
    const task = { id: 'task-abc' };
    normalizeTaskType(task);
    expect(task.taskType).toBe('user');
  });

  it('preserves an already-present taskType (does not reclassify an explicit user task)', () => {
    const task = { id: 'sys-003', taskType: 'user' };
    normalizeTaskType(task);
    expect(task.taskType, 'an explicit taskType must win over id-based inference').toBe('user');
  });

  it('defaults a missing id to user rather than throwing', () => {
    expect(normalizeTaskType({}).taskType).toBe('user');
  });
});

describe('runAgentSpawn source — taskType normalization + claim-miss guard (issue #2633)', () => {
  it('normalizes taskType at the top, BEFORE the first claim updateTask', () => {
    const normalizeIdx = RUN_SPAWN_BODY.indexOf('isInternalTaskId(task.id');
    const firstUpdateIdx = RUN_SPAWN_BODY.indexOf('await updateTask(task.id');
    expect(normalizeIdx, 'runAgentSpawn must derive taskType from the id via isInternalTaskId').toBeGreaterThan(-1);
    expect(firstUpdateIdx, 'runAgentSpawn must call updateTask').toBeGreaterThan(-1);
    expect(normalizeIdx, 'taskType must be normalized BEFORE any updateTask write so every claim routes to the right file')
      .toBeLessThan(firstUpdateIdx);
  });

  it('only a null in_progress result is fatal — an { error } miss must NOT block the spawn', () => {
    // A truthy `{ error }` is EXPECTED for legitimately-unpersisted autonomous
    // emits (Priority 3 mission / Priority 4 idle-review tasks carry
    // taskType:'internal' but are never written to COS-TASKS.md). Blocking on it
    // would silently kill every mission/idle spawn — the pre-#2633 behavior
    // spawned them anyway, so the fatal guard must remain `!updateResult` only.
    const fatalIdx = RUN_SPAWN_BODY.indexOf('if (!updateResult) {');
    expect(fatalIdx, 'the fatal guard must be `!updateResult` alone — the { error } shape must not be fatal').toBeGreaterThan(-1);
    expect(RUN_SPAWN_BODY, 'the { error } shape must not be part of the fatal guard (it would block unpersisted mission/idle spawns)')
      .not.toContain('if (!updateResult || updateResult.error)');
  });

  it('warn-logs when the in_progress claim returns an { error } object so silent misses are visible', () => {
    const warnIdx = RUN_SPAWN_BODY.indexOf('if (updateResult?.error) {');
    expect(warnIdx, 'a silent { error } miss must be surfaced via a warn log').toBeGreaterThan(-1);
    const body = RUN_SPAWN_BODY.slice(warnIdx, warnIdx + 400);
    expect(body).toMatch(/emitLog\('warn'/);
    expect(body).toContain('updateResult.error');
  });
});
