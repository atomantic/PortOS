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
 * function that mirrors the production loop and exercise IT with test data.
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
 *   4. idle        — generated idle-review task (only when nothing else)
 *
 * Within a bucket the iteration order is whatever the source array provides
 * (file order for parsed TASKS.md; arrival order for the on-demand request
 * queue). The dequeue loop does NOT re-sort by priorityValue at this layer
 * — it relies on the upstream parser/writer to keep CRITICAL/HIGH tasks
 * positioned earlier in the file. This is the contract these tests pin.
 */
function priorityDequeue(buckets, capacity) {
  const order = ['onDemand', 'user', 'autoSystem', 'mission', 'idle'];

  // Mission / idle only run when no pending user tasks exist, mirroring the
  // production `hasPendingUserTasks` gate at lines 795 / 2450.
  const hasPendingUserTasks = (buckets.user || []).length > 0;

  for (const bucketName of order) {
    if ((bucketName === 'mission' || bucketName === 'idle') && hasPendingUserTasks) continue;
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
    expect(spawned.map(t => t._bucket)).toEqual(['autoSystem', 'mission', 'idle']);
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
 * Skips brace characters inside string literals and line/block comments so
 * a stray `{` in a string doesn't unbalance the scanner. (Template literals
 * and regex literals aren't handled — neither appears in the production
 * functions this helper extracts, but if that changes the assertions will
 * fail loudly before any data corruption can leak through.)
 */
function extractFnBody(src, fnStart) {
  const openIdx = src.indexOf('{', fnStart);
  if (openIdx === -1) return '';
  let depth = 0;
  let i = openIdx;
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
    // String literals — skip to matching unescaped quote
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(fnStart, i + 1);
    }
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
    expect(fnBody).toMatch(/if\s*\(\s*availableSlots\s*<=\s*0\s*\)\s*return\s*;/);
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

    // The five priority-section comments appear in this exact order. If a
    // refactor inverts them (e.g. promotes mission above user) this guard
    // catches it before the behavioral test does.
    const onDemandIdx = fnBody.indexOf('Priority 0');
    const userIdx     = fnBody.indexOf('Priority 1');
    const autoSysIdx  = fnBody.indexOf('Priority 2');
    const missionIdx  = fnBody.indexOf('Priority 3');
    const idleIdx     = fnBody.indexOf('Priority 4');

    expect(onDemandIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(onDemandIdx);
    expect(autoSysIdx).toBeGreaterThan(userIdx);
    expect(missionIdx).toBeGreaterThan(autoSysIdx);
    expect(idleIdx).toBeGreaterThan(missionIdx);
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
});
