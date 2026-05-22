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
import { firstLine } from './cos.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COS_SRC = readFileSync(join(__dirname, 'cos.js'), 'utf-8');

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
function priorityDequeue(buckets, capacity) {
  const order = ['onDemand', 'user', 'autoSystem', 'mission', 'idle'];

  // Mission / idle only run when no pending user tasks exist, mirroring the
  // production `hasPendingUserTasks` gate at lines 795 / 2450.
  const hasPendingUserTasks = (buckets.user || []).length > 0;

  for (const bucketName of order) {
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
  const openIdx = src.indexOf('{', fnStart);
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
    const fnStart = COS_SRC.indexOf('export async function evaluateTasks');
    expect(fnStart, 'evaluateTasks must exist').toBeGreaterThan(-1);
    const fnBody = extractFnBody(COS_SRC, fnStart);

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

  it('per-project cap defaults to global cap when unset', () => {
    // The fallback `state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents`
    // is the safety net for older state.json files that pre-date the
    // per-project cap. Both dequeueNextTask and evaluateTasks must keep it.
    const dequeueFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function dequeueNextTask'));
    const evalFn    = extractFnBody(COS_SRC, COS_SRC.indexOf('export async function evaluateTasks'));

    const pattern = /maxConcurrentAgentsPerProject\s*\|\|\s*state\.config\.maxConcurrentAgents/;
    expect(dequeueFn).toMatch(pattern);
    expect(evalFn).toMatch(pattern);
  });

  it('idle generator is fenced by spawned===0 / tasksToSpawn.length===0', () => {
    // Pin the strict-idle gate that the replica enforces. If a refactor
    // drops either fence, idle could spawn alongside autoSystem/mission and
    // double-load the agent pool.
    const dequeueFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function dequeueNextTask'));
    const evalFn    = extractFnBody(COS_SRC, COS_SRC.indexOf('export async function evaluateTasks'));

    expect(dequeueFn).toMatch(/spawned\s*===\s*0\s*&&\s*state\.config\.idleReviewEnabled/);
    expect(evalFn).toMatch(/tasksToSpawn\.length\s*===\s*0\s*&&\s*state\.config\.idleReviewEnabled/);
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
    const fnStart = COS_SRC.indexOf('async function queueEligibleImprovementTasks');
    expect(fnStart, 'queueEligibleImprovementTasks must exist').toBeGreaterThan(-1);
    const fnBody = extractFnBody(COS_SRC, fnStart);

    expect(
      fnBody,
      'queue path must call generateManagedAppImprovementTaskForType so applyPlanIdMetadata runs + the full prompt is used'
    ).toMatch(/generateManagedAppImprovementTaskForType\s*\(/);

    // Match the call shape, not the specific variable name — `task` could
    // legitimately be renamed (e.g. `queuedTask`) in a behavior-preserving
    // refactor. The contract being pinned is "raw:true addTask call to the
    // internal lane," not the identifier.
    expect(
      fnBody,
      'queue path must persist via addTask with raw:true so the enriched task object survives serialization'
    ).toMatch(/addTask\s*\(\s*\w+\s*,\s*['"]internal['"]\s*,\s*\{\s*raw:\s*true\s*\}/);

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
    ).toMatch(/getNextTaskType\(app\.id,\s*\w+\s*\)/);

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
    const fnStart = COS_SRC.indexOf('async function generateManagedAppImprovementTaskForType');
    expect(fnStart, 'generateManagedAppImprovementTaskForType must exist').toBeGreaterThan(-1);
    const fnEnd = COS_SRC.indexOf('\nasync function ', fnStart + 1);
    const fnBody = COS_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

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

  it('addTask uses firstLine for dedup (regression guard)', () => {
    // addTask's signature destructuring (`{ raw = false } = {}`) confuses the
    // brace-balanced extractFnBody scanner — slice from the declaration to
    // the next top-level function instead.
    const start = COS_SRC.indexOf('export async function addTask');
    expect(start, 'addTask must exist').toBeGreaterThan(-1);
    const end = COS_SRC.indexOf('export async function', start + 1);
    const fnBody = COS_SRC.slice(start, end === -1 ? undefined : end);
    expect(fnBody).toMatch(/firstLine\(taskData\.description\)/);
    expect(fnBody).toMatch(/firstLine\(t\.description\)/);
  });
});
