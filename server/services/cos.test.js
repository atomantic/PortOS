/**
 * Tests for cos.js — focused on the two hot-spot internals that gate every
 * agent spawn but have no full-function test sibling:
 *
 * 1. `evaluateTasks` priority ordering — Priority 0 (on-demand) > Priority 1
 *    (user) > Priority 2 (auto-approved system) > Priority 3 (mission /
 *    feature agent) > Priority 4 (idle review). Within a priority bucket
 *    tasks are taken in the order they appear in TASKS.md (the parser sorts
 *    nothing for the pending slice — file order is the tie-breaker).
 *
 * 2. `dequeueNextTask` capacity guards — global `maxConcurrentAgents` cap
 *    and per-project `maxConcurrentAgentsPerProject` cap. The function must
 *    short-circuit when no slots are available and must skip tasks whose
 *    project bucket is already saturated even if the global slot count
 *    permits one more spawn.
 *
 * `evaluateTasks` and `dequeueNextTask` are 250+ LOC each and pull in 40+
 * imported helpers (loadState, getAllTasks, addTask, getActiveApps, mission
 * generation, taskSchedule, etc.). Mocking the full graph would be a brittle
 * test of mocks rather than logic, so we follow the established
 * inline-function-copy pattern from `subAgentSpawner.test.js` and
 * `agentLifecycle.test.js`: lift the priority/capacity slice into a pure
 * function that mirrors the production loop and exercise it with test data.
 *
 * A source-level regression check at the bottom asserts the priority order
 * and the capacity-guard early return are still in place in `cos.js`, so a
 * future refactor that reorders priorities or removes the
 * `availableSlots <= 0` short-circuit flips a clear red flag.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { firstLine, isPerpetualRefillCandidate } from './cos.js';
import { canQueueImprovementTasks } from './cosState.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COS_SRC = readFileSync(join(__dirname, 'cos.js'), 'utf-8');
// The task-generation engine (evaluateTasks + the improvement/idle generators
// + applyPlanIdMetadata) was extracted to cosTaskGenerator.js (issue-741). The
// spawn-side scheduler (dequeueNextTask, tryImmediateSpawn, the tasks:changed
// listener) stays in cos.js. Source-level guards below read each invariant from
// whichever module now owns it.
const GEN_SRC = readFileSync(join(__dirname, 'cosTaskGenerator.js'), 'utf-8');
const SCHED_SRC = readFileSync(join(__dirname, 'cosJobScheduler.js'), 'utf-8');

// ─── Inline replicas of the cos.js priority + capacity slice ───────────────

/**
 * Replica of the capacity-tracking closure used in `evaluateTasks` (lines
 * 633–666) and `dequeueNextTask` (lines 2329–2349). These are the exact
 * guards that decide whether a task can spawn now or must wait.
 */
function makeCapacityTracker(state, agentsByProject = {}) {
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;
  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;

  const spawnProjectCounts = { ...agentsByProject };
  const spawned = [];

  const canSpawn = (task) => {
    if (spawned.length >= availableSlots) return false;
    const project = task.metadata?.app || '_self';
    return (spawnProjectCounts[project] || 0) < perProjectLimit;
  };

  const trackSpawn = (task) => {
    const project = task.metadata?.app || '_self';
    spawnProjectCounts[project] = (spawnProjectCounts[project] || 0) + 1;
    spawned.push(task);
  };

  return { availableSlots, perProjectLimit, canSpawn, trackSpawn, spawned, spawnProjectCounts };
}

/**
 * Replica of the priority-bucket loop in `evaluateTasks` / `dequeueNextTask`.
 * The production code merges five buckets in this exact order:
 *
 *   0. onDemand    — explicit user requests (highest)
 *   1. user        — user-authored pending tasks
 *   2. autoSystem  — auto-approved system / improvement tasks
 *   3. mission     — proactive mission tasks (only when no pending user)
 *   4. idle        — generated idle-review task (only when nothing else
 *                    has been queued/spawned in this cycle)
 *
 * Within a bucket the iteration order is whatever the source array provides
 * (file order for parsed TASKS.md; arrival order for the on-demand request
 * queue). The dequeue loop does NOT re-sort by priorityValue at this layer
 * — it relies on the upstream parser/writer to keep CRITICAL/HIGH tasks
 * positioned earlier in the file. This is the contract these tests pin.
 *
 * Idle gating: production is stricter than just `!hasPendingUserTasks`. In
 * `dequeueNextTask` the idle generator is fenced by `if (spawned === 0 &&
 * state.config.idleReviewEnabled && !hasPendingUserTasks)` (cos.js:2480) —
 * i.e. NOTHING else (autoSystem, mission) may have spawned this cycle.
 * `evaluateTasks` mirrors this at cos.js:862 with `tasksToSpawn.length === 0`.
 * The replica enforces the same `spawned === 0` precondition.
 */
function priorityDequeue(buckets, capacity, { paused = false } = {}) {
  const order = ['onDemand', 'user', 'autoSystem', 'mission', 'idle'];

  // Mission / idle only run when no pending user tasks exist, mirroring the
  // production `hasPendingUserTasks` gate at lines 795 / 2450.
  const hasPendingUserTasks = (buckets.user || []).length > 0;

  for (const bucketName of order) {
    // Global pause: on-demand (explicit user "Run") still drains, but every
    // autonomous/scheduled/user tier below is skipped — mirrors the
    // `if (paused) return;` gate in dequeueNextTask after Priority 0.
    if (paused && bucketName !== 'onDemand') break;
    if ((bucketName === 'mission' || bucketName === 'idle') && hasPendingUserTasks) continue;
    // Idle is stricter: only fires when no other bucket has spawned yet.
    if (bucketName === 'idle' && capacity.spawned.length > 0) continue;
    const bucket = buckets[bucketName] || [];
    for (const task of bucket) {
      if (capacity.spawned.length >= capacity.availableSlots) return capacity.spawned;
      if (!capacity.canSpawn(task)) continue;
      capacity.trackSpawn({ ...task, _bucket: bucketName });
    }
  }
  return capacity.spawned;
}

// ─── Fixture helpers ───────────────────────────────────────────────────────

function makeState({ maxConcurrentAgents = 3, maxConcurrentAgentsPerProject = null, runningAgents = [] } = {}) {
  return {
    config: { maxConcurrentAgents, maxConcurrentAgentsPerProject },
    agents: Object.fromEntries(runningAgents.map((a, i) => [`agent-${i}`, a])),
  };
}

function makeRunningAgent(app = '_self') {
  return { status: 'running', metadata: { taskApp: app, app } };
}

const task = (id, priority = 'MEDIUM', { app } = {}) => ({
  id,
  priority,
  status: 'pending',
  metadata: app !== undefined ? { app } : {},
});

// ─── evaluateTasks: priority ordering ──────────────────────────────────────

describe('evaluateTasks — priority ordering', () => {
  it('drains buckets in order: onDemand > user > autoSystem > mission > idle', () => {
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [task('task-onDemand-1')],
      user: [task('task-user-1')],
      autoSystem: [task('sys-auto-1')],
      // Mission/idle should be SKIPPED here because user bucket is non-empty
      // (matches production line 795 `hasPendingUserTasks` gate).
      mission: [task('sys-mission-1')],
      idle: [task('sys-idle-1')],
    };

    const spawned = priorityDequeue(buckets, capacity);

    // Order is: onDemand, user, autoSystem (mission/idle blocked by user-pending gate)
    expect(spawned.map(t => t.id)).toEqual([
      'task-onDemand-1',
      'task-user-1',
      'sys-auto-1',
    ]);
    expect(spawned.map(t => t._bucket)).toEqual(['onDemand', 'user', 'autoSystem']);
  });

  it('when globally paused, only the on-demand bucket drains (manual Run bypasses pause)', () => {
    // A global pause stops scheduled/autonomous/user spawning, but an explicit
    // user "Run" pushes an on-demand request that must still fire. Mirrors the
    // production gate: Priority 0 (on-demand) is processed, then `if (paused) return;`.
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [task('task-onDemand-1')],
      user: [task('task-user-1')],
      autoSystem: [task('sys-auto-1')],
      mission: [task('sys-mission-1')],
      idle: [task('sys-idle-1')],
    };

    const spawned = priorityDequeue(buckets, capacity, { paused: true });

    // Only the on-demand request spawns; everything else stays paused.
    expect(spawned.map(t => t.id)).toEqual(['task-onDemand-1']);
    expect(spawned.map(t => t._bucket)).toEqual(['onDemand']);
  });

  it('mission + idle fire only when there are NO pending user tasks', () => {
    // Idle is fenced behind `spawned === 0` in production (cos.js:2480), so
    // when autoSystem and mission are both non-empty, idle does NOT fire.
    // This test pins the user-pending gate; the next test pins the idle
    // `spawned === 0` gate.
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [], // ← critical: no pending user tasks
      autoSystem: [task('sys-auto-1')],
      mission: [task('sys-mission-1')],
      idle: [task('sys-idle-1')],
    };

    const spawned = priorityDequeue(buckets, capacity);
    // autoSystem + mission spawn; idle is SUPPRESSED because earlier buckets
    // already produced spawns (mirrors cos.js:2480 `spawned === 0` guard).
    expect(spawned.map(t => t._bucket)).toEqual(['autoSystem', 'mission']);
  });

  it('idle fires only when nothing else has spawned (spawned === 0 gate, cos.js:2480)', () => {
    // When autoSystem and mission are both empty AND no user-pending, idle
    // gets to run. This is the only path through which the idle bucket
    // actually drains in production.
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [],
      autoSystem: [],
      mission: [],
      idle: [task('sys-idle-1')],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t._bucket)).toEqual(['idle']);
  });

  it('idle suppressed when only autoSystem spawned (no user, no mission)', () => {
    // Pin the asymmetry: even a SINGLE autoSystem spawn is enough to suppress
    // idle on the same cycle. This is the production behavior at cos.js:862
    // (`tasksToSpawn.length === 0`) and cos.js:2480 (`spawned === 0`).
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [],
      autoSystem: [task('sys-auto-1')],
      mission: [],
      idle: [task('sys-idle-1')],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t._bucket)).toEqual(['autoSystem']);
  });

  it('within a single bucket, file/arrival order wins (no in-bucket priority re-sort)', () => {
    // The dequeue loop does NOT sort by priorityValue at this layer. The
    // parsed-tasks slice preserves file order, so a HIGH task placed AFTER
    // a LOW task in TASKS.md is taken AFTER the LOW task. This is the
    // documented contract: callers using `addTask({ position: 'top' })` are
    // expected to control ordering at write time.
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [
        task('task-low-first', 'LOW'),
        task('task-high-second', 'HIGH'),
        task('task-critical-third', 'CRITICAL'),
      ],
      autoSystem: [],
      mission: [],
      idle: [],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t.id)).toEqual([
      'task-low-first',
      'task-high-second',
      'task-critical-third',
    ]);
  });

  it('stops issuing spawns once availableSlots is exhausted (cross-bucket)', () => {
    // Only 2 free slots — onDemand fills slot 1, user fills slot 2, the rest
    // of the queues are left untouched.
    const state = makeState({ maxConcurrentAgents: 2 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [task('task-onDemand-1')],
      user: [task('task-user-1'), task('task-user-2')],
      autoSystem: [task('sys-auto-1')],
      mission: [],
      idle: [],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned).toHaveLength(2);
    expect(spawned.map(t => t.id)).toEqual(['task-onDemand-1', 'task-user-1']);
  });

  it('returns no spawns when buckets are empty (idle queue)', () => {
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);
    const buckets = { onDemand: [], user: [], autoSystem: [], mission: [], idle: [] };
    expect(priorityDequeue(buckets, capacity)).toEqual([]);
  });
});

// ─── dequeueNextTask: capacity guards ──────────────────────────────────────

describe('dequeueNextTask — capacity guards', () => {
  it('returns zero spawns when running agents already saturate the global cap', () => {
    // 3-slot cap, 3 already running — no headroom.
    const state = makeState({
      maxConcurrentAgents: 3,
      runningAgents: [makeRunningAgent(), makeRunningAgent(), makeRunningAgent()],
    });
    const capacity = makeCapacityTracker(state);
    expect(capacity.availableSlots).toBe(0);

    const buckets = {
      onDemand: [task('task-onDemand-1')],
      user: [task('task-user-1')],
      autoSystem: [],
      mission: [],
      idle: [],
    };
    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned).toEqual([]);
  });

  it('returns zero spawns when running agents OVER-saturate the cap (>= guard, not ==)', () => {
    // Defensive: if some path registered more agents than the cap (e.g. a
    // config change shrunk the cap below current load), availableSlots goes
    // negative — the guard must still block, not let `< 0` slip through as
    // "infinite slots".
    const state = makeState({
      maxConcurrentAgents: 2,
      runningAgents: [makeRunningAgent(), makeRunningAgent(), makeRunningAgent()],
    });
    const capacity = makeCapacityTracker(state);
    expect(capacity.availableSlots).toBeLessThan(0);

    const buckets = { onDemand: [], user: [task('task-user-1')], autoSystem: [], mission: [], idle: [] };
    expect(priorityDequeue(buckets, capacity)).toEqual([]);
  });

  it('respects per-project cap: project saturated → task skipped, other-project task still fills', () => {
    // Global cap 5, but per-project cap 1. App "alpha" already has 1
    // running agent, so its pending user task must be skipped. The pending
    // task for app "beta" should still spawn (different bucket of the
    // per-project counter).
    const state = makeState({
      maxConcurrentAgents: 5,
      maxConcurrentAgentsPerProject: 1,
      runningAgents: [makeRunningAgent('alpha')],
    });
    const agentsByProject = { alpha: 1 };
    const capacity = makeCapacityTracker(state, agentsByProject);

    const buckets = {
      onDemand: [],
      user: [
        task('task-alpha-1', 'HIGH', { app: 'alpha' }),
        task('task-beta-1', 'MEDIUM', { app: 'beta' }),
      ],
      autoSystem: [],
      mission: [],
      idle: [],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t.id)).toEqual(['task-beta-1']);
  });

  it('per-project cap counts in-batch spawns too (not just pre-existing runners)', () => {
    // Per-project cap 2, none running. Three user tasks all on app "alpha".
    // First two must spawn, third must be skipped (in-batch spawn count
    // pushed alpha to the per-project cap).
    const state = makeState({
      maxConcurrentAgents: 10,
      maxConcurrentAgentsPerProject: 2,
    });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [
        task('task-alpha-1', 'HIGH', { app: 'alpha' }),
        task('task-alpha-2', 'HIGH', { app: 'alpha' }),
        task('task-alpha-3', 'HIGH', { app: 'alpha' }),
      ],
      autoSystem: [],
      mission: [],
      idle: [],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t.id)).toEqual(['task-alpha-1', 'task-alpha-2']);
    expect(capacity.spawnProjectCounts.alpha).toBe(2);
  });

  it('per-project cap defaults to global cap when null/0', () => {
    // When maxConcurrentAgentsPerProject is null, production lines 638 +
    // 2334 fall through to the global cap, so the per-project guard is
    // effectively disabled.
    const state = makeState({
      maxConcurrentAgents: 3,
      maxConcurrentAgentsPerProject: null,
    });
    const capacity = makeCapacityTracker(state);
    expect(capacity.perProjectLimit).toBe(3);

    const buckets = {
      onDemand: [],
      user: [
        task('task-alpha-1', 'HIGH', { app: 'alpha' }),
        task('task-alpha-2', 'HIGH', { app: 'alpha' }),
        task('task-alpha-3', 'HIGH', { app: 'alpha' }),
      ],
      autoSystem: [],
      mission: [],
      idle: [],
    };

    expect(priorityDequeue(buckets, capacity)).toHaveLength(3);
  });

  it('null app metadata buckets into the `_self` project key (PortOS work)', () => {
    // PortOS-on-itself tasks have no app metadata. The `_self` bucket is a
    // sentinel that prevents app-less tasks from bypassing the per-project
    // cap (which is a real production guarantee — see line 659).
    const state = makeState({
      maxConcurrentAgents: 5,
      maxConcurrentAgentsPerProject: 1,
    });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [
        task('task-self-1', 'HIGH'),
        task('task-self-2', 'HIGH'),
      ],
      autoSystem: [],
      mission: [],
      idle: [],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t.id)).toEqual(['task-self-1']);
    expect(capacity.spawnProjectCounts._self).toBe(1);
  });
});

// ─── Source-level regression guards ────────────────────────────────────────
//
// These pin two structural invariants of the production code that the
// inline-copy tests can't catch on their own. If a future refactor moves
// the early-return out of `dequeueNextTask` or shuffles the priority order,
// these assertions flip red.

/**
 * Extract a function body from `src` starting at signature offset `fnStart`
 * by scanning braces (depth-tracked) until the matching closing `}`. This is
 * more robust than a fixed-length slice — large functions like
 * `dequeueNextTask` (~250 LOC) can grow past any chosen window and silently
 * drop priority markers, making ordering assertions pass on empty matches.
 *
 * Skips brace characters inside string literals (single/double quote AND
 * template literals, including nested `${...}` interpolations), regex
 * literals, and line/block comments so stray `{`/`}` characters don't
 * unbalance the scanner. `evaluateTasks` and `dequeueNextTask` both contain
 * template literals like `emitLog(`...${task.id}...`)` whose `${...}` braces
 * would otherwise be counted as structural braces.
 *
 * Regex disambiguation uses a "previous significant token" heuristic — a `/`
 * is a regex literal when the preceding non-whitespace token is not an
 * identifier/number/closing-bracket. This handles the patterns used in cos.js
 * (assignment, return, function-arg position) but isn't a full JS tokenizer;
 * if a future refactor introduces edge cases the source-level assertions
 * will fail loudly rather than silently miss matches.
 */
function extractFnBody(src, fnStart) {
  // Skip the parameter list before locating the body brace: a destructured /
  // defaulted param (e.g. `(state, data, { x = null } = {})`) contains `{`
  // braces, so the body `{` is the first one AFTER the signature's closing `)`,
  // not the first `{` after fnStart. Paren-match the signature first.
  const parenIdx = src.indexOf('(', fnStart);
  let searchFrom = fnStart;
  if (parenIdx !== -1) {
    let pdepth = 0;
    for (let j = parenIdx; j < src.length; j++) {
      if (src[j] === '(') pdepth++;
      else if (src[j] === ')') { pdepth--; if (pdepth === 0) { searchFrom = j + 1; break; } }
    }
  }
  const openIdx = src.indexOf('{', searchFrom);
  if (openIdx === -1) return '';
  let depth = 0;
  let i = openIdx;
  // Stack tracks nested template-literal `${...}` interpolation depth so the
  // scanner returns to template-string mode after a `}` closes an expression.
  const tplStack = [];
  // Last significant (non-whitespace, non-comment) character — used to decide
  // whether `/` starts a regex literal or is the division operator.
  let lastSig = '';
  const setLastSig = (c) => { if (!/\s/.test(c)) lastSig = c; };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    // Line comment — skip to newline
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i + 2);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    // Block comment — skip to closing */
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    // Regex literal — `/` is a regex start when not preceded by an
    // identifier/number/closing-paren/closing-bracket (i.e. when it can't be
    // the division operator). Skip to matching unescaped `/` (and flags).
    if (ch === '/' && !/[\w)\]]/.test(lastSig)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break; // unterminated regex — bail
        j++;
      }
      // Skip trailing flags (g/i/m/s/u/y)
      j++;
      while (j < src.length && /[gimsuy]/.test(src[j])) j++;
      i = j;
      lastSig = '/';
      continue;
    }
    // Single/double-quoted string — skip to matching unescaped quote
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) break;
        if (src[j] === '\n') break; // unterminated — bail
        j++;
      }
      i = j + 1;
      lastSig = ch;
      continue;
    }
    // Template literal — scan until backtick or `${`. On `${` push depth and
    // resume normal scanning until matching `}` (tracked via tplStack).
    if (ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') { j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          // Enter interpolation; resume outer loop, push template marker.
          tplStack.push(depth);
          i = j + 2;
          depth++; // the `{` of ${
          lastSig = '{';
          break;
        }
        j++;
      }
      if (j >= i) { // either closed the template or entered interpolation
        if (src[i] === undefined) break;
        if (tplStack.length === 0 || tplStack[tplStack.length - 1] !== depth - 1) {
          // We closed the template entirely (didn't enter interpolation).
          i = j;
          lastSig = '`';
        }
      }
      continue;
    }
    if (ch === '{') { depth++; setLastSig(ch); i++; continue; }
    if (ch === '}') {
      depth--;
      // If we just closed a template interpolation, resume template scan.
      if (tplStack.length > 0 && tplStack[tplStack.length - 1] === depth) {
        tplStack.pop();
        // Resume template literal scan from i+1
        let j = i + 1;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '`') { j++; break; }
          if (src[j] === '$' && src[j + 1] === '{') {
            tplStack.push(depth);
            j += 2;
            depth++;
            break;
          }
          j++;
        }
        i = j;
        lastSig = '`';
        continue;
      }
      if (depth === 0) return src.slice(fnStart, i + 1);
      setLastSig(ch);
      i++;
      continue;
    }
    setLastSig(ch);
    i++;
  }
  return src.slice(fnStart); // unbalanced — return rest of file
}

describe('cos.js source — priority + capacity invariants', () => {
  it('dequeueNextTask early-returns when availableSlots <= 0', () => {
    const fnStart = COS_SRC.indexOf('async function dequeueNextTask');
    expect(fnStart, 'dequeueNextTask must exist').toBeGreaterThan(-1);
    const fnBody = extractFnBody(COS_SRC, fnStart);

    // `if (availableSlots <= 0) return;` (line 2332) is the cheap guard
    // that prevents spawning when the global cap is at or beyond capacity.
    // Regex tolerates optional braces, optional semicolon, and optional
    // single-line block (`{ return; }`) so a formatting refactor doesn't
    // trip this behavioral check.
    expect(fnBody).toMatch(
      /if\s*\(\s*availableSlots\s*<=\s*0\s*\)\s*(?:\{\s*)?return\s*;?\s*(?:\})?/
    );
  });

  it('evaluateTasks short-circuits when availableSlots <= 0', () => {
    const fnStart = GEN_SRC.indexOf('export async function evaluateTasks');
    expect(fnStart, 'evaluateTasks must exist').toBeGreaterThan(-1);
    const fnBody = extractFnBody(GEN_SRC, fnStart);

    expect(fnBody).toMatch(/if\s*\(\s*availableSlots\s*<=\s*0\s*\)/);
  });

  it('priority order in dequeueNextTask: onDemand → user → autoSystem → mission → idle', () => {
    const fnStart = COS_SRC.indexOf('async function dequeueNextTask');
    const fnBody = extractFnBody(COS_SRC, fnStart);

    // Anchor on the actual code markers (declarations / generator calls)
    // for each priority bucket — NOT the `// Priority N` comments. A comment
    // rename or rewording shouldn't fail this test; only an actual reorder
    // of the dequeue logic should.
    //
    //   Priority 0 (onDemand)    — `onDemandRequests` declaration + loop
    //   Priority 1 (user)        — `pendingUserTasks` declaration + loop
    //   Priority 2 (autoSystem)  — `autoApproved` declaration + loop
    //   Priority 3 (mission)     — `generateMissionTasks(` call
    //   Priority 4 (idle)        — `generateIdleReviewTask(` call
    const onDemandIdx = fnBody.indexOf('onDemandRequests');
    const userIdx     = fnBody.indexOf('pendingUserTasks');
    const autoSysIdx  = fnBody.indexOf('autoApproved');
    const missionIdx  = fnBody.indexOf('generateMissionTasks(');
    const idleIdx     = fnBody.indexOf('generateIdleReviewTask(');

    expect(onDemandIdx, 'onDemandRequests must appear').toBeGreaterThan(-1);
    expect(userIdx, 'pendingUserTasks must appear after onDemand').toBeGreaterThan(onDemandIdx);
    expect(autoSysIdx, 'autoApproved must appear after pendingUserTasks').toBeGreaterThan(userIdx);
    expect(missionIdx, 'generateMissionTasks must appear after autoApproved').toBeGreaterThan(autoSysIdx);
    expect(idleIdx, 'generateIdleReviewTask must appear after generateMissionTasks').toBeGreaterThan(missionIdx);
  });

  it('evaluateTasks orchestrates the spawnPriority* tiers in priority order', () => {
    // evaluateTasks (cosTaskGenerator.js) decomposes each priority tier into a
    // named helper (issue #1082). This pins that the orchestrator actually
    // INVOKES each tier helper, in order — so a helper carrying an autonomy/idle
    // fence can't drift out of the spawn path while the broader, module-scoped
    // gate guards below still match its (now-orphaned) fence text and pass green.
    const fnBody = extractFnBody(GEN_SRC, GEN_SRC.indexOf('export async function evaluateTasks'));

    const onDemandIdx = fnBody.indexOf('spawnPriority0OnDemand(ctx)');
    const userIdx     = fnBody.indexOf('spawnPriority1UserTasks(ctx)');
    const autoSysIdx  = fnBody.indexOf('spawnPriority2AutoApproved(ctx)');
    const queueIdx    = fnBody.indexOf('maybeQueueImprovementTasks(ctx)');
    const missionIdx  = fnBody.indexOf('spawnPriority3Missions(ctx)');
    const featureIdx  = fnBody.indexOf('spawnPriority36FeatureAgents(ctx)');
    const idleIdx     = fnBody.indexOf('spawnPriority4IdleReview(ctx)');

    expect(onDemandIdx, 'spawnPriority0OnDemand must be invoked').toBeGreaterThan(-1);
    expect(userIdx, 'spawnPriority1UserTasks must run after on-demand').toBeGreaterThan(onDemandIdx);
    expect(autoSysIdx, 'spawnPriority2AutoApproved must run after user tasks').toBeGreaterThan(userIdx);
    expect(queueIdx, 'maybeQueueImprovementTasks must run after auto-approved').toBeGreaterThan(autoSysIdx);
    expect(missionIdx, 'spawnPriority3Missions must run after improvement queueing').toBeGreaterThan(queueIdx);
    expect(featureIdx, 'spawnPriority36FeatureAgents must run after missions').toBeGreaterThan(missionIdx);
    expect(idleIdx, 'spawnPriority4IdleReview must run after feature agents').toBeGreaterThan(featureIdx);
  });

  it('on-demand (Priority 0) bypasses the global pause in BOTH engines', () => {
    // A global pause stops scheduled/autonomous/user spawning, but an explicit
    // user "Run" queues an on-demand request that must still fire. So in each
    // engine the pause gate must sit AFTER Priority 0, not at the top — moving it
    // back to the top is the regression this pins.
    const dequeueFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function dequeueNextTask'));
    const evalFn    = extractFnBody(GEN_SRC, GEN_SRC.indexOf('export async function evaluateTasks'));

    // dequeueNextTask: the `if (paused) return` gate appears AFTER the on-demand
    // loop (`onDemandRequests`), and `paused` is NOT returned-on before it.
    const dqOnDemandIdx = dequeueFn.indexOf('onDemandRequests');
    const dqPauseGateIdx = dequeueFn.search(/if\s*\(\s*paused\s*\)\s*return/);
    expect(dqOnDemandIdx, 'dequeueNextTask must process onDemandRequests').toBeGreaterThan(-1);
    expect(dqPauseGateIdx, 'dequeueNextTask must keep an `if (paused) return` gate').toBeGreaterThan(-1);
    expect(dqPauseGateIdx, 'pause gate must come AFTER the on-demand loop').toBeGreaterThan(dqOnDemandIdx);

    // evaluateTasks: Priority 0 runs unconditionally; Priorities 1+ are wrapped in
    // an `if (!paused)` block that begins after spawnPriority0OnDemand.
    const evOnDemandIdx = evalFn.indexOf('spawnPriority0OnDemand(ctx)');
    const evPauseGateIdx = evalFn.search(/if\s*\(\s*!\s*paused\s*\)/);
    const evUserIdx = evalFn.indexOf('spawnPriority1UserTasks(ctx)');
    expect(evOnDemandIdx, 'evaluateTasks must invoke spawnPriority0OnDemand').toBeGreaterThan(-1);
    expect(evPauseGateIdx, 'evaluateTasks must gate the lower tiers on !paused').toBeGreaterThan(evOnDemandIdx);
    expect(evUserIdx, 'user/autonomous tiers must sit inside the !paused gate').toBeGreaterThan(evPauseGateIdx);
  });

  it('per-project cap defaults to global cap when unset', () => {
    // The fallback `state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents`
    // is the safety net for older state.json files that pre-date the
    // per-project cap. Both dequeueNextTask and evaluateTasks must keep it.
    const dequeueFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function dequeueNextTask'));
    const evalFn    = extractFnBody(GEN_SRC, GEN_SRC.indexOf('export async function evaluateTasks'));

    const pattern = /maxConcurrentAgentsPerProject\s*\|\|\s*state\.config\.maxConcurrentAgents/;
    expect(dequeueFn).toMatch(pattern);
    expect(evalFn).toMatch(pattern);
  });

  it('idle generator is fenced by spawned===0 / tasksToSpawn.length===0', () => {
    // Pin the strict-idle gate that the replica enforces. If a refactor
    // drops either fence, idle could spawn alongside autoSystem/mission and
    // double-load the agent pool.
    const dequeueFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function dequeueNextTask'));
    // The generator engine's tiers are now decomposed into named spawnPriority*
    // helpers (issue #1082), so this gate lives in `spawnPriority4IdleReview`
    // rather than the `evaluateTasks` orchestrator body — scope to the whole
    // cosTaskGenerator module (the engine) instead of the single function.
    const evalFn    = GEN_SRC;

    expect(dequeueFn).toMatch(/spawned\s*===\s*0\s*&&\s*state\.config\.idleReviewEnabled/);
    expect(evalFn).toMatch(/tasksToSpawn\.length\s*===\s*0\s*&&\s*state\.config\.idleReviewEnabled/);
  });

  it('CoS auto-run domain gate (#711) fences autonomous spawns in BOTH engines', () => {
    // Per-domain autonomy: the `cos` guardrail must gate every AUTOMATIC internal
    // spawn path — not just the auto-approved loop. Both spawn engines
    // (dequeueNextTask in cos.js, evaluateTasks in cosTaskGenerator.js) must read
    // the cos mode and fence their mission / idle / auto-approved blocks on it,
    // or "off"/"dry-run" leaks autonomous agents through the un-gated engine.
    const dequeueFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function dequeueNextTask'));
    // evaluateTasks resolves the mode in `resolveAutonomyBudget` and fences each
    // autonomous tier inside its spawnPriority* helper (issue #1082) — both still
    // live in the cosTaskGenerator module, so scope to the whole engine source.
    const evalFn    = GEN_SRC;

    for (const [name, fnBody] of [['dequeueNextTask', dequeueFn], ['evaluateTasks (cosTaskGenerator)', evalFn]]) {
      expect(fnBody, `${name} must resolve the cos autonomy mode`).toMatch(/getDomainMode\(\s*state\.config\s*,\s*['"]cos['"]\s*\)/);
      // The mission/idle blocks must be fenced on execute so off/dry-run skip them.
      expect(fnBody, `${name} must fence autonomous spawns on cosAutonomyMode === 'execute'`).toMatch(/cosAutonomyMode\s*===\s*['"]execute['"]/);
    }
  });

  it('CoS auto-run domain gate (#711) covers the scheduled-job + improvement-check timers', () => {
    // executeScheduledJob and the cos-improvement-check timer are a THIRD
    // autonomous spawn path (outside dequeueNextTask / evaluateTasks). They must
    // also respect the cos guardrail, or off/dry-run leaks scheduled-job agents
    // and keeps mutating COS-TASKS.md via queueEligibleImprovementTasks.
    const execFn = extractFnBody(SCHED_SRC, SCHED_SRC.indexOf('export async function executeScheduledJob'));
    expect(execFn, 'executeScheduledJob must read the cos autonomy mode').toMatch(/getDomainMode\(\s*state\.config\s*,\s*['"]cos['"]\s*\)/);
    expect(execFn, 'executeScheduledJob must fence on execute').toMatch(/cosAutonomyMode\s*!==\s*['"]execute['"]/);
    // The autonomy-skip branch must record a gate-skip (advances lastRun) BEFORE
    // re-registering — otherwise a past-due job re-registers with stale lastRun
    // and refires every 1s while off/dry-run. Pin that the skip branch calls
    // recordJobGateSkip ahead of registerSingleJobSchedule.
    const skipBranch = execFn.slice(execFn.indexOf("cosAutonomyMode !== 'execute'"));
    const recordIdx = skipBranch.indexOf('recordJobGateSkip');
    const reregIdx = skipBranch.indexOf('registerSingleJobSchedule');
    expect(recordIdx, 'autonomy-skip must call recordJobGateSkip').toBeGreaterThan(-1);
    expect(recordIdx, 'recordJobGateSkip must precede re-registration (no 1s refire loop)').toBeLessThan(reregIdx);
    // The improvement-check timer must gate its queueEligibleImprovementTasks
    // call on the shared canQueueImprovementTasks predicate (idle-review +
    // cos===execute), which encapsulates the auto-run domain gate.
    expect(SCHED_SRC, 'improvement-check timer must gate queueing via canQueueImprovementTasks')
      .toMatch(/if\s*\(\s*canQueueImprovementTasks\(\s*state\s*\)\s*\)/);
  });

  it('both on-demand loops dedupe the cooldown stamp per app via reviewStartedApps set', () => {
    // Multiple on-demand requests targeting the same app should advance its
    // cooldown only once per cycle — without the guard, each request rewrites
    // the same record. BOTH on-demand loops carry the duplication: the
    // startup/manual `evaluateTasks` loop AND the event-driven `dequeueNextTask`
    // loop (the common "Run Now" path). Pin (a) the set is declared and (b) the
    // cooldown stamp is gated on it in each.
    // evaluateTasks now lives in cosTaskGenerator.js, and its Priority-0 on-demand
    // loop is the extracted `spawnPriority0OnDemand` helper (issue #1082);
    // dequeueNextTask stays monolithic in cos.js.
    for (const { fnName, src } of [
      { fnName: 'async function spawnPriority0OnDemand', src: GEN_SRC },
      { fnName: 'async function dequeueNextTask', src: COS_SRC },
    ]) {
      const fnBody = extractFnBody(src, src.indexOf(fnName));
      expect(
        fnBody,
        `${fnName} must declare a reviewStartedApps set to dedupe per-app marks`
      ).toMatch(/const\s+reviewStartedApps\s*=\s*new\s+Set\(/);
      expect(
        fnBody,
        `${fnName} must gate markAppReviewCooldown on !reviewStartedApps.has(targetApp.id)`
      ).toMatch(/if\s*\(\s*!\s*reviewStartedApps\.has\(\s*targetApp\.id\s*\)\s*\)/);
    }
  });

  it('on-demand loops defer bindAppReviewAgent until a task is produced (issue #978)', () => {
    // The phantom-active-agent bug: binding activeAgentId before the per-app
    // task generator runs strands the marker when the generator returns null.
    // Pin that both on-demand loops (a) advance the cooldown with
    // markAppReviewCooldown, NOT markAppReviewStarted, and (b) only bind the
    // active agent inside an `if (task)` guard after generation.
    for (const { fnName, src } of [
      { fnName: 'async function spawnPriority0OnDemand', src: GEN_SRC },
      { fnName: 'async function dequeueNextTask', src: COS_SRC },
    ]) {
      const fnBody = extractFnBody(src, src.indexOf(fnName));
      expect(
        fnBody,
        `${fnName} must advance cooldown via markAppReviewCooldown (not the conflated markAppReviewStarted)`
      ).toMatch(/markAppReviewCooldown\(\s*targetApp\.id\s*\)/);
      expect(
        fnBody,
        `${fnName} must NOT call markAppReviewStarted (conflates cooldown + bind, the #978 bug)`
      ).not.toMatch(/markAppReviewStarted\(/);
      expect(
        fnBody,
        `${fnName} must bind the active agent only after a task exists`
      ).toMatch(/if\s*\(\s*task\s*\)\s*\{\s*await\s+bindAppReviewAgent\(\s*targetApp\.id/);
    }
  });

  it('queueEligibleImprovementTasks runs HANDLER-BACKED types via the handler, never the agent path', () => {
    // #2322: layered-intelligence is a deterministic handler-backed task. When
    // getNextTaskType picks a handler-backed type for an app, the queue path MUST
    // dispatch the in-process handler and `continue` — BEFORE (and instead of)
    // calling generateManagedAppImprovementTaskForType. A bug here can only fail
    // to run the handler; it can never spawn a runaway coding agent.
    const fnStart = GEN_SRC.indexOf('async function queueEligibleImprovementTasks');
    const fnBody = extractFnBody(GEN_SRC, fnStart);

    // Imports HANDLER_BACKED_TASK_TYPES from the schedule and branches on it.
    expect(fnBody).toMatch(/HANDLER_BACKED_TASK_TYPES/);
    expect(fnBody).toMatch(/HANDLER_BACKED_TASK_TYPES\.has\(nextType\)/);

    // The handler-backed branch dispatches + continues BEFORE the agent-spawn call.
    const handlerIdx = fnBody.indexOf('HANDLER_BACKED_TASK_TYPES.has(nextType)');
    const dispatchIdx = fnBody.indexOf('dispatchHandlerBackedTask(');
    const generatorIdx = fnBody.indexOf('generateManagedAppImprovementTaskForType(');
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(handlerIdx);
    expect(dispatchIdx).toBeLessThan(generatorIdx); // handler dispatched before the agent path

    // The shared runner lazily imports the LI handler (no static import cycle).
    expect(GEN_SRC).toMatch(/export async function runHandlerBackedTaskForApp/);
    expect(GEN_SRC).toMatch(/import\(['"]\.\/autonomousJobs\/layeredIntelligenceHandler\.js['"]\)/);
    // And it never routes a handler-backed type through the agent generator.
    const runnerStart = GEN_SRC.indexOf('export async function runHandlerBackedTaskForApp');
    const runnerBody = extractFnBody(GEN_SRC, runnerStart);
    expect(runnerBody).not.toMatch(/generateManagedAppImprovementTaskForType/);
    expect(runnerBody).toMatch(/runLayeredIntelligenceForApp/);
  });

  it('queueEligibleImprovementTasks routes through generateManagedAppImprovementTaskForType', () => {
    // Regression guard: a 2026-05-21 incident saw two `plan-task` agents both
    // open PRs for the same PLAN.md slug because the queue path was writing
    // a one-line stub description with no `analysisType` / `planId`. The
    // agent it dispatched got the Phase 1-7 prompt (with in-flight scan)
    // stripped, picked the same slug as a sibling that already had an open
    // `claim/<slug>` PR, and produced a duplicate. The fix routes the queue
    // path through the shared generator so `applyPlanIdMetadata` runs and
    // the full prompt + planId metadata land on the queued task.
    const fnStart = GEN_SRC.indexOf('async function queueEligibleImprovementTasks');
    expect(fnStart, 'queueEligibleImprovementTasks must exist').toBeGreaterThan(-1);
    const fnBody = extractFnBody(GEN_SRC, fnStart);

    expect(
      fnBody,
      'queue path must call generateManagedAppImprovementTaskForType so applyPlanIdMetadata runs + the full prompt is used'
    ).toMatch(/generateManagedAppImprovementTaskForType\s*\(/);

    // Match the call shape, not the specific variable name — `task` could
    // legitimately be renamed (e.g. `queuedTask`) in a behavior-preserving
    // refactor. The contract being pinned is "raw:true addTask call to the
    // internal lane," not the identifier. The options object may carry siblings
    // beyond `raw:true` (e.g. `ignoreTaskId` for the perpetual refill), so don't
    // require `}` immediately after `raw: true`.
    expect(
      fnBody,
      'queue path must persist via addTask with raw:true so the enriched task object survives serialization'
    ).toMatch(/addTask\s*\(\s*\w+\s*,\s*['"]internal['"]\s*,\s*\{\s*raw:\s*true\b/);

    // The old buggy path called `getTaskDescription` to build a one-line
    // description and then passed app/context/approvalRequired fields to
    // addTask's non-raw constructor. Pin both as absent so we can't regress.
    expect(
      fnBody,
      'queue path must NOT use getTaskDescription (one-line stub bypasses prompt enrichment)'
    ).not.toMatch(/getTaskDescription\s*\(/);

    // The generator returns a multi-line `description` (the full Phase 1–7
    // prompt template). COS-TASKS.md serialization interpolates the whole
    // description onto a single `- [ ]` line and the parser only matches the
    // first line, so persisting a multi-line description corrupts the file
    // AND truncates the prompt on the next `dequeueNextTask` re-read. The
    // queue path must move the body to `metadata.context` (which IS
    // newline-escaped) so the agent prompt builder reconstitutes it on
    // dispatch. Pin both halves of the split.
    expect(
      fnBody,
      'queue path must move multi-line description body to metadata.context (survives markdown round-trip)'
    ).toMatch(/metadata\.context\s*=\s*\w+\.description/);
    expect(
      fnBody,
      'queue path must collapse description to a single line via firstLine()'
    ).toMatch(/\.description\s*=\s*firstLine\(/);

    // `getNextTaskType` falls back to ROTATION when nothing is time-due, and
    // the rotation pointer is derived from the `lastType` argument. The queue
    // path MUST thread the per-app `lastImprovementType` through, otherwise
    // every tick restarts the rotation at index 0 and starves every other
    // rotation type for the app. Mirrors the legacy direct-spawn caller.
    expect(
      fnBody,
      'queue path must pass the loaded lastType through to getNextTaskType so rotation advances'
    ).toMatch(/getNextTaskType\(app\.id,\s*\w+\s*(?:,|\))/);

    // appActivity helpers must come from the file-level static import (line ~23),
    // NOT a dynamic `await import('./appActivity.js')` *inside* the per-app
    // loop. Dynamic imports are cached but still add an extra microtask + a
    // promise allocation per iteration, and they hide the real dependency
    // graph at file scope.
    expect(
      fnBody,
      'queue path must not dynamically import ./appActivity.js inside the per-app loop'
    ).not.toMatch(/await\s+import\(['"]\.\/appActivity\.js['"]\)/);

    // The cooldown check + lastImprovementType lookup both come from the
    // same `data/app-activity.json` file. Before snapshotting, each app
    // paid two separate disk reads per tick (one via `isAppOnCooldown`, one
    // via `getAppActivityById`), so a 10-app install did 20 reads per
    // scheduler tick. The queue path must (a) call `loadAppActivity()`
    // exactly ONCE before the per-app loop and (b) drive the per-app
    // cooldown gate via the pure `isAppActivityOnCooldown` predicate
    // (which takes the per-app activity record from the snapshot), NOT
    // the async `isAppOnCooldown` (which re-reads the file).
    expect(
      fnBody,
      'queue path must hoist loadAppActivity() before the per-app loop'
    ).toMatch(/loadAppActivity\(\)/);
    expect(
      fnBody,
      'queue path must gate cooldown via the pure isAppActivityOnCooldown predicate, not the disk-reading isAppOnCooldown'
    ).toMatch(/isAppActivityOnCooldown\(/);
    expect(
      fnBody,
      'queue path must not call the disk-reading isAppOnCooldown per app'
    ).not.toMatch(/await\s+isAppOnCooldown\(/);

    // Perpetual (drain-until-done) picks must BYPASS the per-app review cooldown
    // — their work-detector park is the throttle, not the cooldown window. The
    // spawn-time `markAppReviewCooldown` stamp (on-demand manual trigger +
    // idle-review loop) writes `lastReviewedAt`, so without the bypass the
    // back-to-back refill after a perpetual completion reads its own app as
    // on-cooldown and stalls — a manually-triggered perpetual task then runs
    // once instead of continuing the drain. The bypass is implemented by
    // CONSTRAINING the pick to perpetual when the app is on cooldown: the
    // cooldown state is computed first and passed to getNextTaskType as
    // `perpetualOnly`, so in a MIXED schedule a due higher-priority cron/custom
    // type can't mask the perpetual drain (which would strand the whole app for
    // the window). Pin: (a) the cooldown is resolved BEFORE getNextTaskType, and
    // (b) getNextTaskType is asked for a perpetual-only pick gated on cooldown.
    const cooldownIdx = fnBody.indexOf('isAppActivityOnCooldown(');
    const nextTypeIdx = fnBody.indexOf('getNextTaskType(');
    expect(
      cooldownIdx,
      'queue path must compute cooldown via isAppActivityOnCooldown'
    ).toBeGreaterThan(-1);
    expect(
      cooldownIdx < nextTypeIdx,
      'cooldown must be resolved BEFORE getNextTaskType so it can constrain the pick to perpetual'
    ).toBe(true);
    expect(
      fnBody,
      'queue path must constrain the pick to perpetual when on cooldown (perpetualOnly gated on cooldown)'
    ).toMatch(/getNextTaskType\([^)]*\{\s*perpetualOnly:\s*onCooldown\s*\}/);
  });

  it('generateManagedAppImprovementTaskForType defers updateAppActivity until after gates', () => {
    // Regression guard: the rotation pointer + "Generating improvement task"
    // log must only advance when a real task is queued. The eager call at
    // the top of the function was tolerable when only the on-demand path
    // hit it (user explicitly picked the type), but now the per-tick queue
    // path routes through it too — so every plan-task skip (no available
    // slug), every precondition fail, and every reference-watch "no refs"
    // exit would silently rotate the pick + emit a misleading log. Pin
    // both the absence of the early call AND the presence of the gated
    // late call so a future refactor can't accidentally restore the
    // pre-gate ordering.
    //
    // Use sliceFn instead of extractFnBody because the function body
    // contains a `for (...) { try { ... } catch }` block and the
    // brace-balanced scanner doesn't always match the right closer when
    // there are template-literal braces nested inside.
    const fnStart = GEN_SRC.indexOf('async function generateManagedAppImprovementTaskForType');
    expect(fnStart, 'generateManagedAppImprovementTaskForType must exist').toBeGreaterThan(-1);
    const fnEnd = GEN_SRC.indexOf('\nasync function ', fnStart + 1);
    const fnBody = GEN_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    // The updateAppActivity call must appear AFTER applyPlanIdMetadata —
    // otherwise a `planMeta.skipReason` early-return still rotates the pointer.
    const planMetaIdx = fnBody.indexOf('applyPlanIdMetadata(');
    const updateActivityIdx = fnBody.indexOf('updateAppActivity(app.id,');
    expect(planMetaIdx, 'applyPlanIdMetadata must appear in the function').toBeGreaterThan(-1);
    expect(updateActivityIdx, 'updateAppActivity must appear in the function').toBeGreaterThan(-1);
    expect(
      updateActivityIdx,
      'updateAppActivity must run after applyPlanIdMetadata so rotation only advances on a real queue'
    ).toBeGreaterThan(planMetaIdx);

    // The "(on-demand)" suffix on the generation log was misleading once
    // the queue path started routing through this function. Pin the suffix
    // as absent.
    expect(
      fnBody,
      'Generation log must not claim "(on-demand)" — function is shared by queue + on-demand callers'
    ).not.toMatch(/Generating improvement task[^`'"\n]*\(on-demand\)/);
  });

  it('applyPlanIdMetadata does NOT pre-stamp planId for self-claiming task types', () => {
    // Regression guard: `plan-task` agents pick (and claim) their own slug at
    // execution time, mirroring `/claim`. A dispatch-time pre-pick stamps a
    // slug before the agent creates its `claim/<slug>` branch (the real lock),
    // so two near-simultaneous dispatches both target the same first-available
    // item — the exact race behind the 2026-05-21 duplicate-PR incident. The
    // in-flight scan in applyPlanIdMetadata must stay (it gates dispatch), but
    // the planId stamp must be fenced behind PLAN_SELF_CLAIM_TASK_TYPES.
    expect(
      GEN_SRC,
      'plan-task must be registered as a self-claiming task type'
    ).toMatch(/PLAN_SELF_CLAIM_TASK_TYPES\s*=\s*new Set\(\[\s*'plan-task'\s*\]\)/);

    const fnStart = GEN_SRC.indexOf('async function applyPlanIdMetadata');
    expect(fnStart, 'applyPlanIdMetadata must exist').toBeGreaterThan(-1);
    const fnBody = extractFnBody(GEN_SRC, fnStart);

    // The planId stamp must be guarded so self-claiming types never pre-pick.
    expect(
      fnBody,
      'metadata.planId stamp must be fenced behind a PLAN_SELF_CLAIM_TASK_TYPES check'
    ).toMatch(/if\s*\(\s*!PLAN_SELF_CLAIM_TASK_TYPES\.has\(taskType\)\s*\)\s*\{\s*metadata\.planId\s*=/);

    // The gate (skipReason) machinery must still run — we only dropped the stamp.
    expect(
      fnBody,
      'applyPlanIdMetadata must still scan in-flight slugs to gate dispatch'
    ).toMatch(/findInProgressIds\(/);
  });

  it('tasks:changed listener schedules dequeueNextTask before the user tryImmediateSpawn', () => {
    // When task CRUD moved to cosTaskStore.js (issue-741), the addTask→
    // tryImmediateSpawn and approveTask→dequeueNextTask direct calls were
    // replaced by a `tasks:changed` listener here. The original sequence for a
    // user-added task was: emit tasks:changed (which queued dequeueNextTask via
    // this listener) FIRST, then addTask called setImmediate(tryImmediateSpawn).
    // dequeue fills open slots in priority order before the just-added task's
    // immediate-spawn attempt runs — so the order must stay dequeue-then-spawn.
    const onIdx = COS_SRC.indexOf("cosEvents.on('tasks:changed'");
    expect(onIdx, 'tasks:changed listener must exist').toBeGreaterThan(-1);
    const handler = COS_SRC.slice(onIdx, COS_SRC.indexOf('});', onIdx) + 3);

    const dequeueIdx = handler.indexOf('dequeueNextTask()');
    const spawnIdx = handler.indexOf('tryImmediateSpawn(');
    expect(dequeueIdx, 'listener must schedule dequeueNextTask').toBeGreaterThan(-1);
    expect(spawnIdx, 'listener must schedule tryImmediateSpawn').toBeGreaterThan(-1);
    expect(
      dequeueIdx,
      'dequeueNextTask must be scheduled before the user-task tryImmediateSpawn'
    ).toBeLessThan(spawnIdx);

    // tryImmediateSpawn is user-task-only, matching the pre-extraction guard.
    expect(handler).toMatch(/data\.type\s*===\s*'user'/);
  });
});

describe('addTask — first-line dedup', () => {
  it('returns the first non-empty trimmed line', () => {
    expect(firstLine('hello\nworld')).toBe('hello');
    expect(firstLine('\n\n  first  \nsecond')).toBe('first');
    expect(firstLine('single')).toBe('single');
  });

  it('returns empty string for null/undefined/empty input', () => {
    expect(firstLine(null)).toBe('');
    expect(firstLine(undefined)).toBe('');
    expect(firstLine('')).toBe('');
    expect(firstLine('\n\n\n')).toBe('');
  });

  it('multi-line and single-line descriptions with the same first line collide', () => {
    // Repro: handleOrphanedTask builds a multi-line description, but
    // generateTasksMarkdown flattens it to one line. Without first-line
    // normalization, addTask's dedup compares the full multi-line input to
    // the stored single line and never matches — producing N duplicate
    // [Auto-Fix] tasks, each spawning its own agent.
    const multi = '[Auto-Fix] Investigate repeated agent orphaning for task X\n\n**Last Orphaned Agent**: agent-aaa';
    const stored = '[Auto-Fix] Investigate repeated agent orphaning for task X';
    expect(firstLine(multi).toLowerCase()).toBe(firstLine(stored).toLowerCase());
  });

  // The addTask source-level regression guards (firstLine dedup + per-app
  // dedup scope) moved to cosTaskStore.test.js when addTask was extracted into
  // cosTaskStore.js. The firstLine behavioral tests above stay here because
  // cos.js still re-exports firstLine for backward compat.
});

// ─── Perpetual re-queue on completion (drain back-to-back) ─────────────────
//
// Perpetual schedules (e.g. claim-issue) are documented as "drain actionable
// work back-to-back (re-queue on completion)" (taskSchedule.js), but the only
// thing that queues them is the ~hourly cos-improvement-check timer — the
// agent:completed handler (dequeueNextTask) merely drains already-queued tasks
// and never regenerates perpetual work. A "ready" perpetual task doesn't even
// shorten that timer (cosJobScheduler only gates the delay on status:'scheduled'
// tasks), so when claim-issue is the only enabled schedule the next run waits up
// to MAX_CHECK_INTERVAL (1h) instead of spawning immediately after the prior one.
//
// `isPerpetualRefillCandidate` is the pure gate that lets the completion handler
// decide whether the just-finished agent belongs to a perpetual schedule that
// should be refilled right now.
describe('isPerpetualRefillCandidate — perpetual drain on completion', () => {
  const schedule = {
    tasks: {
      'claim-issue': { type: 'perpetual', enabled: true },
      'claim-issue-disabled': { type: 'perpetual', enabled: false },
      'plan-task': { type: 'daily', enabled: true },
    },
  };
  const agentFor = (analysisType, key = 'taskAnalysisType') => ({
    metadata: analysisType == null ? {} : { [key]: analysisType },
  });

  it('is true for an enabled perpetual type matching the agent task', () => {
    expect(isPerpetualRefillCandidate(agentFor('claim-issue'), schedule)).toBe(true);
  });

  it('is false for a disabled perpetual type (toggled off after spawn)', () => {
    expect(isPerpetualRefillCandidate(agentFor('claim-issue-disabled'), schedule)).toBe(false);
  });

  it('is false for a non-perpetual schedule type', () => {
    expect(isPerpetualRefillCandidate(agentFor('plan-task'), schedule)).toBe(false);
  });

  it('is false for an unknown / unscheduled type', () => {
    expect(isPerpetualRefillCandidate(agentFor('ghost-type'), schedule)).toBe(false);
  });

  it('reads the analysis type from metadata.analysisType and selfImprovementType fallbacks', () => {
    expect(isPerpetualRefillCandidate(agentFor('claim-issue', 'analysisType'), schedule)).toBe(true);
    expect(isPerpetualRefillCandidate(agentFor('claim-issue', 'selfImprovementType'), schedule)).toBe(true);
  });

  it('is false for missing agent / metadata / schedule (no throw)', () => {
    expect(isPerpetualRefillCandidate(null, schedule)).toBe(false);
    expect(isPerpetualRefillCandidate(agentFor(null), schedule)).toBe(false);
    expect(isPerpetualRefillCandidate(agentFor('claim-issue'), null)).toBe(false);
    expect(isPerpetualRefillCandidate(agentFor('claim-issue'), { tasks: null })).toBe(false);
  });
});

// Source-level guard: the agent:completed handler must wire the perpetual
// refill so completion drains back-to-back instead of waiting for the hourly
// improvement-check timer.
describe('cos.js source — agent:completed triggers perpetual refill', () => {
  it("the agent:completed listener invokes the perpetual refill path", () => {
    const onIdx = COS_SRC.indexOf("cosEvents.on('agent:completed'");
    expect(onIdx, 'agent:completed listener must exist').toBeGreaterThan(-1);
    const handlerSlice = COS_SRC.slice(onIdx, onIdx + 1200);
    expect(
      handlerSlice.includes('refillPerpetualForCompletedAgent'),
      'agent:completed handler must call refillPerpetualForCompletedAgent'
    ).toBe(true);
  });

  it('the refill passes the completed task id as ignoreTaskId (avoids the completeAgent-before-updateTask dedup race)', () => {
    // agent:completed fires before the completion flow's updateTask marks the task
    // done, so the just-finished task can still read as in_progress — both in the
    // snapshot AND on disk when queueEligible's addTask re-reads COS-TASKS.md. A
    // perpetual schedule regenerates an identical first-line per app, so without
    // excluding the completing task the refill is rejected as a duplicate and the
    // drain stalls. Pin the ignoreTaskId thread so a refactor can't reintroduce it.
    const fnIdx = COS_SRC.indexOf('async function refillPerpetualForCompletedAgent');
    expect(fnIdx, 'refillPerpetualForCompletedAgent must exist').toBeGreaterThan(-1);
    const fnSlice = COS_SRC.slice(fnIdx, fnIdx + 2500);
    expect(
      /queueEligibleImprovementTasks\(\s*state\s*,\s*cosTaskData\s*,\s*\{\s*ignoreTaskId:\s*agent\?\.taskId\s*\}\s*\)/.test(fnSlice),
      'refill must forward { ignoreTaskId: agent?.taskId } to queueEligibleImprovementTasks'
    ).toBe(true);
  });

  it('the refill only fires on a SUCCESSFUL completion (no back-to-back spin on failures)', () => {
    // Perpetual completions skip the per-app cooldown, so refilling after a failed
    // run would spin the daemon through repeated failures (the work-detector still
    // sees the same issue as actionable). The refill must bail on a non-success
    // result and let task-retry/backoff + the recheck cadence handle failures.
    const fnIdx = COS_SRC.indexOf('async function refillPerpetualForCompletedAgent');
    const fnSlice = COS_SRC.slice(fnIdx, fnIdx + 2500);
    expect(
      /if\s*\(\s*!agent\?\.result\?\.success\s*\)\s*return/.test(fnSlice),
      'refill must early-return when the completed agent did not succeed'
    ).toBe(true);
  });

  it('refill is sequenced BEFORE dequeue in the handler (perpetual task queued before slots fill)', () => {
    // If generic dequeue ran first (or concurrently), it could claim the just-
    // freed slot with idle/mission work before the perpetual task is queued,
    // breaking the back-to-back drain. The handler must chain refill → dequeue.
    const onIdx = COS_SRC.indexOf("cosEvents.on('agent:completed'");
    const handlerSlice = COS_SRC.slice(onIdx, onIdx + 1400);
    expect(
      /refillPerpetualForCompletedAgent\(agent\)[\s\S]*\.then\(\s*\(\)\s*=>\s*dequeueNextTask\(\)\s*\)/.test(handlerSlice),
      'handler must run dequeueNextTask in a .then() AFTER the refill resolves'
    ).toBe(true);
    // The old standalone `setImmediate(() => dequeueNextTask())` must be gone —
    // its presence would race the refill.
    expect(
      handlerSlice.includes('setImmediate(() => dequeueNextTask())'),
      'the unconditional pre-refill dequeue must be removed'
    ).toBe(false);
  });
});

// Shared autonomous-queuing gate (cosState.canQueueImprovementTasks). Extracted
// from three drift-prone copies (post-startup queue, improvement-check timer,
// perpetual drain refill). Queuing requires BOTH idle-review on AND the CoS
// auto-run domain in `execute`.
describe('canQueueImprovementTasks — autonomous queuing gate', () => {
  const cfg = (idleReviewEnabled, cos) => ({
    config: { idleReviewEnabled, domainAutonomy: { cos } },
  });

  it('is true only when idle-review is on AND cos auto-run is execute', () => {
    expect(canQueueImprovementTasks(cfg(true, 'execute'))).toBe(true);
  });

  it('is false when cos auto-run is off or dry-run', () => {
    expect(canQueueImprovementTasks(cfg(true, 'off'))).toBe(false);
    expect(canQueueImprovementTasks(cfg(true, 'dry-run'))).toBe(false);
  });

  it('is false when idle-review is disabled, regardless of cos mode', () => {
    expect(canQueueImprovementTasks(cfg(false, 'execute'))).toBe(false);
  });

  it('coerces a falsy/undefined idleReviewEnabled to a boolean false', () => {
    expect(canQueueImprovementTasks(cfg(undefined, 'execute'))).toBe(false);
  });
});
