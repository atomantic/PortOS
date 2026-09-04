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
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawningTasks, runnerAgents } from './agentState.js';
import { withSpawnDedupGuard, withMapEntryCleanup, withUpdateInProgressGuard, SPAWN_DEDUP_SKIP, SPAWN_UPDATE_SKIP } from './agentGuards.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { PROVIDER_CONFIG_BLOCKED_CATEGORY, PAUSED_BLOCKED_CATEGORIES, USER_DECISION_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_LIFECYCLE_SRC = readFileSync(join(__dirname, 'agentLifecycle.js'), 'utf-8');
// finalizeAgent + stampLiExecutionVerdict moved to their own module (issue #2837)
// so both spawners can import them without cycling back through the lifecycle
// orchestrator. The source-level assertions below follow them there.
const AGENT_FINALIZATION_SRC = readFileSync(join(__dirname, 'agentFinalization.js'), 'utf-8');

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

  // Issue #4124: `/api/update/execute` refuses to start while an agent is live,
  // but `update.sh` then runs git pull / submodule update / npm install for
  // seconds before `pm2 delete`. This is the last-line gate for a spawn landing
  // in THAT window.
  it('spawnAgentForTask wraps the spawn in withUpdateInProgressGuard(isUpdateInProgress)', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    expect(idx, 'spawnAgentForTask must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 1200);
    expect(body).toMatch(/withUpdateInProgressGuard\(\s*isUpdateInProgress\s*,/);
    expect(body).toMatch(/SPAWN_UPDATE_SKIP/);
    // The synchronous mirror, not a re-implemented disk read.
    expect(AGENT_LIFECYCLE_SRC).toMatch(/import \{ isUpdateInProgress \} from '\.\/updateChecker\.js'/);
  });

  it('fails closed before spawning when public-review security screening is incomplete', () => {
    expect(AGENT_LIFECYCLE_SRC).toContain('public-review-security-scan-incomplete');
    expect(AGENT_LIFECYCLE_SRC).toContain('public-review-no-cleared-prs');
    expect(AGENT_LIFECYCLE_SRC).toContain('public-review-eligibility-incomplete');
    // The provider-unsupported categories moved to `publicReviewProviderBlock`
    // with the gate decision itself; their exact values are asserted there
    // (providerVendors.publicReview.test.js).
    expect(AGENT_LIFECYCLE_SRC).toMatch(/if \(scanBlock\) \{[\s\S]*?status: 'blocked'/);
    expect(AGENT_LIFECYCLE_SRC).toMatch(/expected fail-closed safety outcome/);
    const gateStart = AGENT_LIFECYCLE_SRC.indexOf('const scanBlock = publicReviewScanBlock(task)');
    const gateEnd = AGENT_LIFECYCLE_SRC.indexOf('const postureBlock = publicReviewProviderBlock(provider, publicReviewPosture', gateStart);
    expect(gateEnd).toBeGreaterThan(gateStart);
    expect(AGENT_LIFECYCLE_SRC.slice(gateStart, gateEnd)).not.toContain("cosEvents.emit('agent:error'");
  });

  // #5830 collapsed the two per-stage provider gates into one and dropped the
  // `publicReview &&` guard with them, so an ORDINARY task — posture `null`,
  // which no vendor declares a recipe for — was blocked at spawn with
  // "has no enforced null public-content review mode". The decision now lives
  // in `publicReviewProviderBlock` (unit-tested in
  // providerVendors.publicReview.test.js), which returns null for a task that
  // requested no posture. Pin the call so the caller cannot re-derive it from a
  // boolean support check and reintroduce the same collapse.
  it('asks the posture helper for the provider gate rather than re-deriving it', () => {
    expect(AGENT_LIFECYCLE_SRC).toContain('const postureBlock = publicReviewProviderBlock(provider, publicReviewPosture)');
    expect(AGENT_LIFECYCLE_SRC).toMatch(/if \(postureBlock\) \{[\s\S]*?status: 'blocked'/);
    // The helper owns the blocked category too, so the gate cannot pick its own.
    expect(AGENT_LIFECYCLE_SRC).toContain('const { reason, category } = postureBlock;');
    // The reason text belongs to the helper — building it here means the gate
    // decided for itself whether the posture was supported.
    expect(AGENT_LIFECYCLE_SRC).not.toContain('public-content review mode');
    expect(AGENT_LIFECYCLE_SRC).not.toMatch(/supportsPublicReviewPosture\(/);
  });
});

// ─── Coverage guard for the self-update spawn gate (issue #4124) ────────────
//
// The gate is argued to cover EVERY path that can start an agent because those
// paths funnel through exactly two chokepoints: `task:ready` → subAgentSpawner's
// listener → `spawnAgentForTask` → one of the three low-level spawn helpers.
// Gating fewer files than "every spawn engine" is only sound while that funnel
// holds, so pin it: a new direct caller of `spawnAgentForTask` or of a spawn
// helper would bypass the gate and must fail here rather than in production.

describe('self-update spawn gate — funnel coverage (#4124)', () => {
  const SERVICES_DIR = __dirname;

  /** Every non-test .js under server/services (recursively), with its source. */
  const serviceSources = () => {
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
        out.push({ path: full, src: readFileSync(full, 'utf-8') });
      }
    };
    walk(SERVICES_DIR);
    return out;
  };

  /**
   * Files whose source invokes `name(` somewhere other than its own
   * declaration, relative to server/services and sorted. Listing the DEFINING
   * file too keeps the assertions non-vacuous: a regex that silently stopped
   * matching would drop that file and fail, instead of passing as an empty set.
   */
  const invokersOf = (name) => serviceSources()
    .filter(({ src }) => new RegExp(`(?<!function )\\b${name}\\(`).test(src))
    .map(({ path }) => path.slice(SERVICES_DIR.length + 1))
    .sort();

  it('spawnAgentForTask is invoked from exactly one place — the gated task:ready listener', () => {
    expect(
      invokersOf('spawnAgentForTask'),
      'a new caller of spawnAgentForTask must also carry the self-update hold (see subAgentSpawner.js)'
    ).toEqual(['agentLifecycle.js', 'subAgentSpawner.js']);
  });

  it('the three low-level spawn helpers are invoked only from the gated dispatch', () => {
    // If any other module called these directly it would create an agent
    // process without passing spawnAgentForTask's update guard at all.
    for (const helper of ['spawnTuiAgent', 'spawnViaRunner', 'spawnDirectly']) {
      expect(
        invokersOf(helper),
        `${helper} must stay reachable only through spawnAgentForTask`
      ).toEqual(['agentLifecycle.js']);
    }
  });

  it('subAgentSpawner holds the dispatch on the synchronous update flag', () => {
    const src = readFileSync(join(SERVICES_DIR, 'subAgentSpawner.js'), 'utf-8');
    expect(src).toMatch(/import \{ isUpdateInProgress \} from '\.\/updateChecker\.js'/);
    // The dispatch body lives in `handleTaskReady`, the named function the
    // `task:ready` registration wraps in a `.catch` (a plain EventEmitter would
    // otherwise leak an async listener's rejection).
    const idx = src.indexOf('async function handleTaskReady');
    expect(idx, 'the task:ready dispatch must exist').toBeGreaterThan(-1);
    const spawnIdx = src.indexOf('await spawnAgentForTask(task)', idx);
    expect(spawnIdx).toBeGreaterThan(idx);
    // The hold is BEFORE the spawn, and before the (awaited) runner probe — a
    // synchronous check can't be raced by anything in between.
    const preamble = src.slice(idx, spawnIdx);
    expect(preamble).toMatch(/if \(isUpdateInProgress\(\)\) \{\s*return holdTask\(task,/);
    expect(preamble.indexOf('isUpdateInProgress()')).toBeLessThan(preamble.indexOf('isRunnerReachable()'));
  });

  it('handleAgentCompletion delegates runnerAgents cleanup to withMapEntryCleanup', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('export async function handleAgentCompletion');
    expect(idx, 'handleAgentCompletion must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 60_000);
    expect(body).toMatch(/withMapEntryCleanup\(\s*runnerAgents\s*,\s*agentId\s*,/);
  });

  // A tracked agent can already be terminal by the time its completion event
  // lands: a runner-backed TUI is finalized by spawnTuiAgent's `finish()`, which
  // then kills the session — and the runner reports THAT as an exit-143
  // completion. Without this guard the event ran a second finalizeAgent that
  // overwrote a sentinel-signalled success with a `startup-failure` verdict.
  it('handleAgentCompletion bails on a duplicate completion for an already-terminal record', () => {
    const body = trackedCompletionPreamble();
    // Reads the PERSISTED record — the in-memory maps say nothing about whether
    // another owner already wrote the terminal record.
    expect(body).toMatch(/await getAgentRecord\(agentId\)/);
    expect(body).toMatch(/persistedAgent && persistedAgent\.status !== 'running'/);
  });

  // The record backs BOTH the terminal-status guard and the PR-ownership check,
  // and `getAgent` (the transcript-hydrating reader) would line-split a completed
  // run's whole output.txt — megabytes on the very path the guard exists to catch,
  // plus a possible metadata.json rewrite via repairCodexTaskSummary.
  it('handleAgentCompletion reads the record once, via the transcript-free reader', () => {
    const body = trackedCompletionPreamble();
    expect(body).toMatch(/const persistedAgent = await getAgentRecord\(agentId\)/);
    // Imported unaliased, so `getAgent` can't be smuggled back in under this name.
    expect(AGENT_LIFECYCLE_SRC).toMatch(/import \{[^}]*\bgetAgentRecord\b[^}]*\} from '\.\/cos\.js'/);
    expect(AGENT_LIFECYCLE_SRC).not.toMatch(/getAgent as getAgentRecord/);
    // Exactly one read for the whole tracked path.
    const reads = AGENT_LIFECYCLE_SRC.match(/await getAgentRecord\(agentId\)/g) || [];
    expect(reads).toHaveLength(1);
  });

  it('finalizeAgent stamps the LI execution verdict into the completion task write (#2779)', () => {
    const idx = AGENT_FINALIZATION_SRC.indexOf('export async function finalizeAgent');
    expect(idx, 'finalizeAgent must exist').toBeGreaterThan(-1);
    const updateIdx = AGENT_FINALIZATION_SRC.indexOf('await updateTask(task.id, taskUpdate, taskType)', idx);
    expect(updateIdx, 'finalizeAgent must persist the task via updateTask').toBeGreaterThan(idx);
    const body = AGENT_FINALIZATION_SRC.slice(idx, updateIdx);
    // The verdict is stamped into taskUpdate via the shared helper BEFORE the updateTask
    // call, so it federates in the same write that marks the task terminal.
    expect(body).toMatch(/await stampLiExecutionVerdict\(taskUpdate, task, \{ success, validationPassed, errorAnalysis \}\)/);
  });

  it('stampLiExecutionVerdict builds the verdict from the task liProposal marker via the shared builder (#2779)', () => {
    const idx = AGENT_FINALIZATION_SRC.indexOf('async function stampLiExecutionVerdict');
    expect(idx, 'stampLiExecutionVerdict must exist').toBeGreaterThan(-1);
    const body = AGENT_FINALIZATION_SRC.slice(idx, idx + 1500);
    // Derived from the persisted task's liProposal marker via the shared builder (parity
    // with the local #2765 write) and merged into taskUpdate.metadata under the verdict key.
    expect(body).toMatch(/task\?\.metadata\?\.liProposal/);
    expect(body).toMatch(/buildLiExecutionVerdict\(/);
    expect(body).toMatch(/\[LI_EXECUTION_VERDICT_KEY\]:\s*verdict/);
  });

  it('the post-restart recovery completion path also stamps the LI verdict (#2779, codex P2)', () => {
    // A hand-off that finished while the server was down completes via this bypass, not
    // finalizeAgent — it must still stamp so the outcome federates to the originating peer.
    // End-anchored on the statement that follows the branch rather than a fixed
    // char count: a fixed window silently shrinks its coverage every time the
    // branch grows, and a later addition pushed the assertions below out of it.
    const body = recoveryBranchSource();
    // Success path stamps a clean completion…
    expect(body).toMatch(/await stampLiExecutionVerdict\(\{ status: 'completed' \}, task, \{ success \}\)/);
    // …and the FAILURE path re-reads the task after orphan recovery and stamps the failure
    // verdict when recovery settled it into terminal `blocked` (codex P2 round 2).
    expect(body).toMatch(/settled\.status === 'blocked' && settled\.metadata\?\.liProposal/);
    expect(body).toMatch(/await stampLiExecutionVerdict\(\{\}, settled, \{ success: false \}\)/);
  });

  // This bypass never runs worktree cleanup, so the dead run's tree is still on
  // disk when the task is requeued. Without the dead agent's metadata,
  // handleOrphanedTask can't tell the retry what to resume, and it builds a fresh
  // worktree off the default branch and redoes work sitting right there.
  //
  // `startedAt` rides along for the same class of reason (#3637): it is the window
  // the orphan path's commit probe needs, and without it the probe is skipped and a
  // run that DID commit before dying is requeued as if it had produced nothing.
  it('the post-restart recovery path hands the dead agent’s metadata to the retry handler', () => {
    const body = recoveryBranchSource();
    expect(body).toMatch(/handleOrphanedTask\([^)]*\{\s*agentMetadata: cosAgent\.metadata,\s*agentStartedAt: cosAgent\.startedAt\s*\}\)/);
  });
});

/**
 * Source of the post-restart recovery path. It was an inline `if (!agent)`
 * branch of handleAgentCompletion until #3872 split it into its own function;
 * the slice follows it there rather than re-anchoring on a neighbouring
 * statement inside the router, so the window is the whole function body and
 * cannot silently shrink as the path grows.
 */
function recoveryBranchSource() {
  const start = AGENT_LIFECYCLE_SRC.indexOf('async function completeUntrackedAgentFromCosState');
  expect(start, 'post-restart recovery path must exist').toBeGreaterThan(-1);
  const end = AGENT_LIFECYCLE_SRC.indexOf('export async function handleAgentCompletion', start);
  expect(end, 'end anchor (the router that dispatches into it) must exist').toBeGreaterThan(start);
  return AGENT_LIFECYCLE_SRC.slice(start, end);
}

/**
 * Source of the TRACKED completion preamble in handleAgentCompletion — from
 * entering the withMapEntryCleanup body to the first real work it does. Both
 * anchors are real statements, so the window can't silently widen to swallow the
 * rest of the completion body as the function grows.
 */
function trackedCompletionPreamble() {
  const start = AGENT_LIFECYCLE_SRC.indexOf('withMapEntryCleanup(runnerAgents, agentId,');
  expect(start, 'withMapEntryCleanup wrapper must exist').toBeGreaterThan(-1);
  const end = AGENT_LIFECYCLE_SRC.indexOf("Normalize the agent's task shape", start);
  expect(end, 'end anchor (task-shape normalization) must exist').toBeGreaterThan(start);
  return AGENT_LIFECYCLE_SRC.slice(start, end);
}

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

describe('runAgentSpawn source — durable TUI ownership (#3202)', () => {
  it('routes TUI providers through the runner when it is available', () => {
    expect(RUN_SPAWN_BODY).toMatch(
      /const executionMode = !spawnHeadless \? \(dispatchUseRunner \? 'runner-tui' : 'tui'\)/
    );
    expect(RUN_SPAWN_BODY).toMatch(/spawnTuiAgent\(\{[\s\S]{0,1000}?useDurableRunner:\s*dispatchUseRunner/);
    expect(RUN_SPAWN_BODY).not.toMatch(/useRunner:\s*isTui\s*\?\s*false\s*:\s*useRunner/);
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
    // The category is the SHARED constant, not a hand-written literal: the pause
    // and reaper-exemption sets in lib/taskBlockCategories.js key on the same
    // value, and a stamp-site literal is exactly how those three drift apart.
    expect(body, 'tags the block category from the shared constant').toMatch(/blockedCategory:\s*PROVIDER_CONFIG_BLOCKED_CATEGORY,/);
    expect(body, 'does not re-hardcode the literal').not.toMatch(/blockedCategory:\s*'provider-config'/);
    expect(AGENT_LIFECYCLE_SRC, 'imports the shared constant').toMatch(/import \{[^}]*PROVIDER_CONFIG_BLOCKED_CATEGORY[^}]*\} from '\.\.\/lib\/taskBlockCategories\.js'/);
  });

  // The block only does its job if the vocabulary module agrees it is a config
  // PAUSE (keeps the resume pointer) and a user DECISION (exempt from the 14-day
  // auto-expiry). Pin both memberships here, at the stamp site, so removing one
  // fails beside the code that depends on it.
  it('the stamped category is a config pause the reaper leaves alone', () => {
    expect(PROVIDER_CONFIG_BLOCKED_CATEGORY).toBe('provider-config');
    expect(PAUSED_BLOCKED_CATEGORIES.has(PROVIDER_CONFIG_BLOCKED_CATEGORY), 'keeps its resume pointer').toBe(true);
    expect(USER_DECISION_BLOCKED_CATEGORIES.has(PROVIDER_CONFIG_BLOCKED_CATEGORY), 'never auto-expired to completed').toBe(true);
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

  // #4520: a task pinned to a specific federated instance runs ONLY there. The
  // pin is a standing decision, so it gates the spawn ahead of the opportunistic
  // lease check — and is re-checked against the fresh record, because a
  // reassignment can sync in between the dequeue and the claim.
  it('refuses to spawn a task pinned to another instance, before the lease check', () => {
    const targetIdx = RUN_SPAWN_BODY.indexOf('isTargetedElsewhere(task.metadata, instanceId)');
    const leaseIdx = RUN_SPAWN_BODY.indexOf('isClaimableBy(task.metadata, instanceId)');
    const registerIdx = RUN_SPAWN_BODY.indexOf('registerAgent(agentId, task.id, {');
    expect(targetIdx, 'must gate the spawn on isTargetedElsewhere').toBeGreaterThan(-1);
    expect(targetIdx, 'the pin guard must run BEFORE the lease guard').toBeLessThan(leaseIdx);
    expect(targetIdx, 'the pin guard must run BEFORE registering the agent').toBeLessThan(registerIdx);
  });

  it('re-checks the pin against the freshest task, before claiming it', () => {
    const rereadIdx = RUN_SPAWN_BODY.indexOf('await getTaskById(task.id)');
    const recheckIdx = RUN_SPAWN_BODY.indexOf('isTargetedElsewhere(freshTask.metadata, instanceId)');
    const acquireIdx = RUN_SPAWN_BODY.indexOf('metadata: buildClaim(instanceId)');
    expect(recheckIdx, 'must re-check the pin against the fresh metadata').toBeGreaterThan(rereadIdx);
    expect(recheckIdx, 'the fresh pin re-check must precede taking the claim').toBeLessThan(acquireIdx);
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

  // The hold keeps this instance's OWN lease (updateTask only releases it when a
  // status other than in_progress is written), so the claim re-check above passes
  // for a held task. A `task:ready` emitted before the failure — or a stale
  // generator snapshot — would otherwise spawn the retry while the pointer naming
  // its predecessor's branch is still being resolved (#3373).
  it('refuses to spawn a task whose retry is held for its resume pointer', () => {
    const rereadIdx = RUN_SPAWN_BODY.indexOf('await getTaskById(task.id)');
    const holdIdx = RUN_SPAWN_BODY.indexOf('isRetryHeld(freshTask.metadata)');
    const registerIdx = RUN_SPAWN_BODY.indexOf('registerAgent(agentId, task.id, {');
    expect(holdIdx, 'must check the retry hold on the fresh metadata').toBeGreaterThan(rereadIdx);
    expect(holdIdx, 'the hold guard must run BEFORE registering the agent').toBeLessThan(registerIdx);
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

  it('records claimFlow separately from CoS-managed PR/worktree flags', () => {
    const registerIdx = AGENT_LIFECYCLE_SRC.indexOf('registerAgent(agentId, task.id, {');
    // Slice to the END of the call, not a fixed byte window: the projected keys
    // sit near the bottom of a growing metadata object, so a magic-number window
    // makes an unrelated comment above them read as a missing key.
    const metaSlice = AGENT_LIFECYCLE_SRC.slice(registerIdx, AGENT_LIFECYCLE_SRC.indexOf('\n  });', registerIdx));
    expect(metaSlice).toContain('configOpenPR: isTruthyMeta(task.metadata?.openPR)');
    expect(metaSlice).toContain('configClaimFlow: isClaimFlowTask(task, isTruthyMeta)');
    expect(metaSlice.indexOf('configClaimFlow')).toBeGreaterThan(metaSlice.indexOf('configOpenPR'));
  });

  it('projects the public-review posture so the UI can explain the missing shell link', () => {
    // `spawnHeadless` forces a public-review stage headless even on a TUI
    // provider — unless it is the sandboxed-actions stage on a vendor with an
    // attachable recipe (#6062) — so its card usually gets no "Open Shell"
    // link. Without this projection the card cannot tell that apart from a PTY
    // that failed to attach, and the run reads as wedged.
    const registerIdx = RUN_SPAWN_BODY.indexOf('registerAgent(agentId, task.id, {');
    const metaSlice = RUN_SPAWN_BODY.slice(registerIdx, RUN_SPAWN_BODY.indexOf('\n  });', registerIdx));
    expect(metaSlice).toMatch(/^\s*publicReviewPosture,$/m);
  });
});

// These used to be three source-regex assertions pinning a hand-spread env
// literal (`...forgeTokenEnv, ...provider.envVars, ...opencodeEnv`) inside
// spawnViaRunner. The layering now lives in `lib/cliChildEnv.js#composeProviderEnv`,
// where `cliChildEnv.test.js` asserts the ORDER against the real function instead
// of against source text — which is the point of #3194: a grep-shaped guard was
// what let this exact site miss the #2243/#2190 sweep in the first place.
//
// What is still worth pinning HERE is the wiring: that spawnViaRunner routes
// through the shared composer and feeds it the right inputs.
describe('agentLifecycle — runner OpenCode Ollama env (#2243 / #2190)', () => {
  const runnerBody = () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnViaRunner');
    expect(fnStart, 'spawnViaRunner must exist').toBeGreaterThan(-1);
    return AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 4000);
  };

  it('source: composes the runner envVars through the shared composeProviderEnv', () => {
    expect(AGENT_LIFECYCLE_SRC).toMatch(
      /import\s*\{\s*composeProviderEnv\s*\}\s*from\s*'\.\.\/lib\/cliChildEnv\.js';/
    );
    // The payload must BE the composed env — not a literal that re-spreads it,
    // which is how the layer order drifted from the other spawn sites before.
    expect(runnerBody()).toMatch(/envVars:\s*composeProviderEnv\(\{/);
  });

  it('source: feeds the composer the provider + per-call model so --model ollama/<id> is accepted', () => {
    const fnBody = runnerBody();
    const call = fnBody.slice(fnBody.indexOf('composeProviderEnv({'), fnBody.indexOf('composeProviderEnv({') + 300);
    expect(call, 'the OpenCode declared-models map is built from provider+model').toContain('provider,');
    expect(call).toContain('model,');
  });

  it("source: pins GH_TOKEN via resolveForgeTokenEnv so the runner-spawned agent's `gh` uses the repo-owner account", () => {
    const fnBody = runnerBody();
    expect(fnBody).toContain('resolveForgeTokenEnv(workspacePath)');
    // `before` is the slot that sits UNDER provider.envVars, so an explicit
    // provider GH_TOKEN still wins — passing it as `extra` would invert that.
    expect(fnBody).toMatch(/before:\s*\{[^}]*\.\.\.forgeTokenEnv[^}]*\}/);
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

// #6117: a public-review Stage 3 dispatch inlines the whole screened envelope —
// ~100K tokens — and a model server on this box spends minutes prefilling it
// before the child emits a line. Nothing compared the assembled prompt against
// the endpoint it was aimed at, so the run's duration estimate carried none of
// that cost and the card was indistinguishable from a wedged run. The budget has
// no behavioral seam inside runAgentSpawn, so pin the two orderings that make it
// correct.
describe('runAgentSpawn source — local prompt/prefill budget (#6117)', () => {
  it('measures the FULLY assembled prompt, after the public-review envelope is appended', () => {
    // Measuring `basePrompt` would miss the envelope, which IS the ~100K tokens.
    const promptIdx = RUN_SPAWN_BODY.indexOf('formatPublicReviewInputPrompt(publicReviewPromptData)');
    const planIdx = RUN_SPAWN_BODY.indexOf('planLocalPromptBudget({');
    expect(promptIdx, 'the public-review envelope must still be appended to the prompt').toBeGreaterThan(-1);
    expect(planIdx, '`planLocalPromptBudget({` must exist inside runAgentSpawn').toBeGreaterThan(-1);
    expect(promptIdx, 'the budget must be planned AFTER the envelope is appended').toBeLessThan(planIdx);
  });

  it('only asks the question for an endpoint on this machine, and never refuses the dispatch', () => {
    // A cloud provider prefills in seconds and must take no async hop; and the
    // decision on this issue was explicitly to RAISE the estimate rather than
    // block a provider the user deliberately configured.
    expect(RUN_SPAWN_BODY).toMatch(/const\s+localEndpoint\s*=\s*localEndpointOfProvider\(provider\)\s*;/);
    expect(RUN_SPAWN_BODY).toMatch(/localEndpoint\s*\r?\n?\s*\?\s*planLocalPromptBudget\(\{/);
    expect(RUN_SPAWN_BODY, 'the budget must never turn into a blocked task')
      .not.toMatch(/localPromptBudget[\s\S]{0,200}blockedReason/);
  });

  it('stamps the budget onto the agent record so the card can explain the silence', () => {
    const registerIdx = AGENT_LIFECYCLE_SRC.indexOf('registerAgent(agentId, task.id, {');
    const metaSlice = AGENT_LIFECYCLE_SRC.slice(registerIdx, AGENT_LIFECYCLE_SRC.indexOf('\n  });', registerIdx));
    expect(metaSlice).toMatch(/\blocalPromptBudget,/);
  });
});
