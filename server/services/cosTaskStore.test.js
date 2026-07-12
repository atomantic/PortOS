/**
 * Tests for cosTaskStore.js — task CRUD + queue persistence extracted from
 * cos.js. Two layers:
 *
 * 1. Behavioral tests with the file/state/event deps mocked (in-memory file
 *    map) — exercise the real read/write round-trip, dedup, ID generation,
 *    metadata normalization, and the `tasks:changed` emissions.
 * 2. Source-level regression guards (moved here from cos.test.js when addTask
 *    was extracted) that pin the first-line dedup + per-app dedup scope.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync as realReadFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const mock = vi.hoisted(() => ({
  files: new Map(),
  state: null,
  events: []
}));

// existsSync is driven by the in-memory file map; readFileSync stays real so
// the source-level regression guards below can read cosTaskStore.js off disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: (p) => mock.files.has(p)
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p) => {
    if (!mock.files.has(p)) throw new Error(`ENOENT: ${p}`);
    return mock.files.get(p);
  }),
  writeFile: vi.fn(async (p, content) => { mock.files.set(p, content); })
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => mock.state),
  withStateLock: async (fn) => fn(),
  ROOT_DIR: '/root'
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: (name, payload) => mock.events.push({ name, payload }) }
}));

import {
  firstLine,
  PRIORITY_VALUES,
  getUserTasks,
  getCosTasks,
  getAllTasks,
  getTasks,
  getTaskById,
  addTask,
  updateTask,
  deleteTask,
  reorderTasks,
  approveTask,
  mergePeerTasks,
  challengeTask,
  resolveTaskChallenge
} from './cosTaskStore.js';

const USER_FILE = '/root/TASKS.md';
const COS_FILE = '/root/COS-TASKS.md';

const baseState = () => ({
  config: { userTasksFile: 'TASKS.md', cosTasksFile: 'COS-TASKS.md' }
});

beforeEach(() => {
  mock.files = new Map();
  mock.state = baseState();
  mock.events = [];
});

describe('cosTaskStore.firstLine', () => {
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
});

describe('cosTaskStore.getUserTasks / getCosTasks', () => {
  it('returns an empty, non-existent result when the file is missing', async () => {
    const result = await getUserTasks();
    expect(result.exists).toBe(false);
    expect(result.tasks).toEqual([]);
    expect(result.type).toBe('user');
    expect(result.file).toBe(USER_FILE);
  });

  it('parses an existing user task file', async () => {
    await addTask({ description: 'do a thing', priority: 'HIGH' }, 'user');
    const result = await getUserTasks();
    expect(result.exists).toBe(true);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].description).toBe('do a thing');
    expect(result.tasks[0].priority).toBe('HIGH');
  });

  it('surfaces autoApproved + awaitingApproval buckets for internal tasks', async () => {
    await addTask({ description: 'auto sys', approvalRequired: false }, 'internal');
    await addTask({ description: 'needs approval', approvalRequired: true }, 'internal');
    const result = await getCosTasks();
    expect(result.type).toBe('internal');
    expect(result.autoApproved.some(t => t.description === 'auto sys')).toBe(true);
    expect(result.awaitingApproval.some(t => t.description === 'needs approval')).toBe(true);
  });
});

describe('cosTaskStore.getAllTasks / getTasks / getTaskById', () => {
  it('getTasks aliases getUserTasks', () => {
    expect(getTasks).toBe(getUserTasks);
  });

  it('getAllTasks merges user + internal sources', async () => {
    await addTask({ description: 'u1' }, 'user');
    await addTask({ description: 's1', approvalRequired: false }, 'internal');
    const all = await getAllTasks();
    expect(all.user.tasks).toHaveLength(1);
    expect(all.cos.tasks).toHaveLength(1);
  });

  it('getTaskById finds a user task and tags taskType', async () => {
    const created = await addTask({ description: 'find me', id: 'task-find' }, 'user');
    const found = await getTaskById(created.id);
    expect(found.id).toBe(created.id);
    expect(found.taskType).toBe('user');
  });

  it('getTaskById finds an internal task and tags taskType', async () => {
    const created = await addTask({ description: 'sys task', id: 'sys-task', approvalRequired: false }, 'internal');
    const found = await getTaskById(created.id);
    expect(found.taskType).toBe('internal');
  });

  it('getTaskById returns null when no source has the id', async () => {
    expect(await getTaskById('nope')).toBeNull();
  });
});

describe('cosTaskStore.addTask', () => {
  it('generates a prefixed id, default MEDIUM priority, and emits tasks:changed', async () => {
    const task = await addTask({ description: 'plain' }, 'user');
    expect(task.id.startsWith('task-')).toBe(true);
    expect(task.priority).toBe('MEDIUM');
    expect(task.priorityValue).toBe(PRIORITY_VALUES.MEDIUM);
    expect(task.status).toBe('pending');
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'added' && e.payload.type === 'user')).toBe(true);
  });

  it('persists structured auto-fix diagnostics into metadata and round-trips them through markdown (#2328)', async () => {
    const diagnostics = {
      triggerEvent: 'AI_PROVIDER_EXECUTION_FAILED',
      target: 'Claude Code CLI (opus)',
      errorType: 'rate-limit',
      category: 'rate-limit',
      tier: 3,
      fixStrategy: 'constrained-agent-retry',
      failureReason: 'HTTP 429 from provider',
    };
    const created = await addTask(
      { description: 'Investigate AI provider failure', approvalRequired: true, diagnostics },
      'internal'
    );
    // Attached to the returned task's metadata (not silently dropped).
    expect(created.metadata.diagnostics).toEqual(diagnostics);
    // Survives the markdown serialize → parse round-trip via the JSON sentinel.
    const { tasks } = await getCosTasks();
    const reloaded = tasks.find(t => t.id === created.id);
    expect(reloaded.metadata.diagnostics).toEqual(diagnostics);
  });

  it('omits diagnostics metadata when none is supplied and ignores a non-object / array value', async () => {
    const created = await addTask({ description: 'no diagnostics here' }, 'user');
    expect(created.metadata.diagnostics).toBeUndefined();
    const bad = await addTask({ description: 'bad diagnostics', diagnostics: 'not-an-object' }, 'user');
    expect(bad.metadata.diagnostics).toBeUndefined();
    const arr = await addTask({ description: 'array diagnostics', diagnostics: ['nope'] }, 'user');
    expect(arr.metadata.diagnostics).toBeUndefined();
  });

  it('rejects a duplicate with the same first-line description and app scope', async () => {
    await addTask({ description: 'dupe me', app: 'portos' }, 'user');
    const second = await addTask({ description: 'dupe me\nextra body', app: 'portos' }, 'user');
    expect(second.duplicate).toBe(true);
    const { tasks } = await getUserTasks();
    expect(tasks).toHaveLength(1);
  });

  it('does NOT treat same description against different apps as a duplicate', async () => {
    await addTask({ description: 'shared', app: 'portos' }, 'user');
    const second = await addTask({ description: 'shared', app: 'bookloom' }, 'user');
    expect(second.duplicate).toBeUndefined();
    const { tasks } = await getUserTasks();
    expect(tasks).toHaveLength(2);
  });

  it('rejects a raw duplicate whose app lives in metadata.app (queue-path improvement tasks)', async () => {
    // Queue-path improvement tasks (generateManagedAppImprovementTaskForType) arrive
    // pre-built with `raw: true` and carry the app in `metadata.app`, NOT top-level
    // `taskData.app`. Two concurrent queueEligibleImprovementTasks snapshots each add
    // an identical `[Improvement: PortOS] …` task; the second must be rejected as a
    // duplicate (regression for the overlapping-duplicate-runs bug).
    const rawTask = (id) => ({
      id, description: '[Improvement: PortOS] Performance Analysis', status: 'pending',
      priority: 'LOW', priorityValue: PRIORITY_VALUES.LOW, taskType: 'internal', autoApproved: true,
      metadata: { app: 'portos', analysisType: 'performance' }
    });
    const first = await addTask(rawTask('sys-perf-1'), 'internal', { raw: true });
    expect(first.duplicate).toBeUndefined();
    const second = await addTask(rawTask('sys-perf-2'), 'internal', { raw: true });
    expect(second.duplicate).toBe(true);
    const { tasks } = await getCosTasks();
    expect(tasks.filter(t => firstLine(t.description) === '[Improvement: PortOS] Performance Analysis')).toHaveLength(1);
  });

  it('does NOT treat raw tasks with the same description against different metadata.app as duplicates', async () => {
    const rawTask = (id, app) => ({
      id, description: 'shared raw', status: 'pending',
      priority: 'LOW', priorityValue: PRIORITY_VALUES.LOW, taskType: 'internal', autoApproved: true,
      metadata: { app }
    });
    await addTask(rawTask('sys-a', 'portos'), 'internal', { raw: true });
    const second = await addTask(rawTask('sys-b', 'bookloom'), 'internal', { raw: true });
    expect(second.duplicate).toBeUndefined();
    const { tasks } = await getCosTasks();
    expect(tasks.filter(t => firstLine(t.description) === 'shared raw')).toHaveLength(2);
  });

  it('ignoreTaskId excludes one in-flight task from the dedup scan (perpetual drain-on-completion)', async () => {
    // The just-completed perpetual task is still in_progress on disk when the
    // refill re-queues an identical first-line for the same app. Passing its id
    // as ignoreTaskId must let the new task through instead of colliding with it.
    const first = await addTask({ description: 'claim issue', app: 'portos', id: 'sys-old' }, 'internal');
    // Without ignoreTaskId the identical task collides...
    const blocked = await addTask({ description: 'claim issue', app: 'portos' }, 'internal');
    expect(blocked.duplicate).toBe(true);
    // ...but excluding the still-in-flight task lets the refill queue the next one.
    const allowed = await addTask({ description: 'claim issue', app: 'portos' }, 'internal', { raw: false, ignoreTaskId: first.id });
    expect(allowed.duplicate).toBeUndefined();
    const { tasks } = await getCosTasks();
    expect(tasks.filter(t => firstLine(t.description) === 'claim issue')).toHaveLength(2);
  });

  it('persists boolean override flags (true and false) into metadata', async () => {
    const task = await addTask({ description: 'flagged', useWorktree: false, openPR: true }, 'user');
    expect(task.metadata.useWorktree).toBe(false);
    expect(task.metadata.openPR).toBe(true);
  });

  it('defaults a worktree USER task to openPR:true when openPR is unspecified', async () => {
    const task = await addTask({ description: 'wt default pr', useWorktree: true }, 'user');
    expect(task.metadata.useWorktree).toBe(true);
    expect(task.metadata.openPR).toBe(true);
  });

  it('does NOT default openPR for a worktree INTERNAL task (automation keeps auto-merge)', async () => {
    const task = await addTask({ description: 'wt internal', useWorktree: true }, 'internal');
    expect(task.metadata.useWorktree).toBe(true);
    expect(task.metadata.openPR).toBeUndefined();
  });

  it('respects an explicit openPR:false on a worktree task (no default override)', async () => {
    const task = await addTask({ description: 'wt no pr', useWorktree: true, openPR: false }, 'user');
    expect(task.metadata.openPR).toBe(false);
  });

  it('does not set openPR for a non-worktree task', async () => {
    const task = await addTask({ description: 'no wt', useWorktree: false }, 'user');
    expect(task.metadata.openPR).toBeUndefined();
  });

  it('raw=true stores the pre-built object verbatim', async () => {
    const raw = { id: 'sys-raw', description: 'raw\nmultiline', status: 'pending', metadata: { context: 'ctx' } };
    const task = await addTask(raw, 'internal', { raw: true });
    expect(task).toBe(raw);
    expect(task.description).toBe('raw\nmultiline');
  });

  it('position:top unshifts the task to the front', async () => {
    await addTask({ description: 'first', id: 'task-a' }, 'user');
    await addTask({ description: 'second', id: 'task-b', position: 'top' }, 'user');
    const { tasks } = await getUserTasks();
    expect(tasks[0].description).toBe('second');
  });

  it('stamps a content-edit timestamp (updatedAt) from the injectable clock (#1714)', async () => {
    const NOW = Date.parse('2026-06-25T12:00:00.000Z');
    const created = await addTask({ description: 'stamped', id: 'task-stamp' }, 'user', { now: NOW });
    expect(created.metadata.updatedAt).toBe(new Date(NOW).toISOString());
  });
});

describe('cosTaskStore.updateTask', () => {
  it('updates status + priority and emits tasks:changed updated', async () => {
    const created = await addTask({ description: 'upd', id: 'task-upd' }, 'user');
    const updated = await updateTask(created.id, { status: 'in_progress', priority: 'critical' }, 'user');
    expect(updated.status).toBe('in_progress');
    expect(updated.priority).toBe('CRITICAL');
    expect(updated.priorityValue).toBe(PRIORITY_VALUES.CRITICAL);
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'updated')).toBe(true);
  });

  it('clears blocked metadata when transitioning out of blocked', async () => {
    await addTask({ description: 'blk', id: 'task-blk' }, 'user');
    await updateTask('task-blk', { status: 'blocked', metadata: { blockedReason: 'x', blockedCategory: 'y' } }, 'user');
    const reopened = await updateTask('task-blk', { status: 'pending' }, 'user');
    expect(reopened.metadata.blockedReason).toBeUndefined();
    expect(reopened.metadata.blockedCategory).toBeUndefined();
  });

  it('releases the federation claim/lease when a task leaves in_progress (#1563)', async () => {
    await addTask({ description: 'claimed', id: 'task-claimed' }, 'user');
    // Spawn-time claim: status in_progress carries the claim metadata.
    const claimed = await updateTask('task-claimed', {
      status: 'in_progress',
      metadata: { claimedBy: 'instance-a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T00:30:00.000Z' }
    }, 'user');
    expect(claimed.metadata.claimedBy).toBe('instance-a');
    // Completing the task strips the claim so it is freely re-claimable.
    const done = await updateTask('task-claimed', { status: 'completed' }, 'user');
    expect(done.metadata.claimedBy).toBeUndefined();
    expect(done.metadata.claimedAt).toBeUndefined();
    expect(done.metadata.leaseExpiresAt).toBeUndefined();
  });

  it('keeps the claim while the task stays in_progress (lease renewal, no status change) (#1563)', async () => {
    await addTask({ description: 'renew', id: 'task-renew' }, 'user');
    await updateTask('task-renew', {
      status: 'in_progress',
      metadata: { claimedBy: 'instance-a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T00:30:00.000Z' }
    }, 'user');
    // A heartbeat renewal passes no status — the claim must survive and update.
    const renewed = await updateTask('task-renew', {
      metadata: { claimedBy: 'instance-a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T01:00:00.000Z' }
    }, 'user');
    expect(renewed.metadata.claimedBy).toBe('instance-a');
    expect(renewed.metadata.leaseExpiresAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('bumps updatedAt on a content edit from the injectable clock (#1714)', async () => {
    const T0 = Date.parse('2026-06-25T00:00:00.000Z');
    const T1 = Date.parse('2026-06-25T06:00:00.000Z');
    await addTask({ description: 'edit me', id: 'task-edit' }, 'user', { now: T0 });
    const updated = await updateTask('task-edit', { priority: 'HIGH' }, 'user', { now: T1 });
    expect(updated.metadata.updatedAt).toBe(new Date(T1).toISOString());
  });

  it('does NOT bump updatedAt on a lease-renewal heartbeat that re-includes existing metadata (#1714)', async () => {
    const T0 = Date.parse('2026-06-25T00:00:00.000Z');
    const T1 = Date.parse('2026-06-25T06:00:00.000Z');
    const T2 = Date.parse('2026-06-25T12:00:00.000Z');
    // Task carries real non-claim content (context) so the heartbeat spread below
    // actually re-includes a content key — the shape that broke the naive detector.
    await addTask({ description: 'beat', id: 'task-beat', context: 'working on it' }, 'user', { now: T0 });
    // Claiming the task is a content edit (status change) → stamp advances to T1.
    await updateTask('task-beat', {
      status: 'in_progress',
      metadata: { claimedBy: 'a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T00:30:00.000Z' }
    }, 'user', { now: T1 });
    // Real heartbeat shape (cos.js processOrphanedTasks once spread the whole
    // metadata): { ...existing, ...freshLease }. The re-included unchanged keys
    // (context, updatedAt) must NOT count as an edit — else every ~15min heartbeat
    // bumps the stamp and a lease-renewing peer spuriously wins content ties.
    const current = await getTaskById('task-beat');
    const renewed = await updateTask('task-beat', {
      metadata: { ...current.metadata, claimedBy: 'a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T01:00:00.000Z' }
    }, 'user', { now: T2 });
    expect(renewed.metadata.leaseExpiresAt).toBe('2026-01-01T01:00:00.000Z');
    expect(renewed.metadata.updatedAt).toBe(new Date(T1).toISOString()); // NOT bumped to T2
  });

  it('DOES bump updatedAt when a spread metadata patch actually changes a non-claim value (#1714)', async () => {
    const T0 = Date.parse('2026-06-25T00:00:00.000Z');
    const T1 = Date.parse('2026-06-25T06:00:00.000Z');
    await addTask({ description: 'meta edit', id: 'task-meta', context: 'old' }, 'user', { now: T0 });
    const current = await getTaskById('task-meta');
    // Same spread shape as the heartbeat, but context genuinely changes → real edit.
    const updated = await updateTask('task-meta', {
      metadata: { ...current.metadata, context: 'new' }
    }, 'user', { now: T1 });
    expect(updated.metadata.context).toBe('new');
    expect(updated.metadata.updatedAt).toBe(new Date(T1).toISOString());
  });

  it('preserves a legacy direct field cleared to empty string (absent-vs-cleared, #1826)', async () => {
    // `context` is a LEGACY_DIRECT_FIELD. Clearing it to "" is an intentional edit
    // and must persist as "" — the `|| undefined` form mapped "" to undefined and
    // the cleanup pass then deleted the key, conflating "cleared" with "absent".
    await addTask({ description: 'ctx', id: 'task-ctx', context: 'original context' }, 'user');
    const updated = await updateTask('task-ctx', { context: '' }, 'user');
    expect(updated.metadata.context).toBe('');
    // And it survives a round-trip through markdown serialization.
    const reloaded = await getTaskById('task-ctx');
    expect(reloaded.metadata.context).toBe('');
  });

  it('still drops a legacy direct field set to null', async () => {
    await addTask({ description: 'ctx2', id: 'task-ctx2', context: 'original' }, 'user');
    const updated = await updateTask('task-ctx2', { context: null }, 'user');
    expect(updated.metadata.context).toBeUndefined();
  });

  it('returns an error object when the file is missing', async () => {
    const result = await updateTask('task-x', { status: 'completed' }, 'user');
    expect(result.error).toBe('Task file not found');
  });

  it('returns an error object when the task id is absent', async () => {
    await addTask({ description: 'present' }, 'user');
    const result = await updateTask('task-missing', { status: 'completed' }, 'user');
    expect(result.error).toBe('Task not found');
  });
});

describe('cosTaskStore.deleteTask', () => {
  it('removes the task and emits tasks:changed deleted', async () => {
    const created = await addTask({ description: 'del', id: 'task-del' }, 'user');
    const result = await deleteTask(created.id, 'user');
    expect(result.success).toBe(true);
    const { tasks } = await getUserTasks();
    expect(tasks).toHaveLength(0);
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'deleted')).toBe(true);
  });

  it('returns an error when the task is absent', async () => {
    await addTask({ description: 'keep' }, 'user');
    expect((await deleteTask('nope', 'user')).error).toBe('Task not found');
  });
});

describe('cosTaskStore.reorderTasks', () => {
  it('reorders by id and appends any not listed', async () => {
    await addTask({ description: 'one', id: 'task-1' }, 'user');
    await addTask({ description: 'two', id: 'task-2' }, 'user');
    await addTask({ description: 'three', id: 'task-3' }, 'user');
    const result = await reorderTasks(['task-3', 'task-1']);
    expect(result.success).toBe(true);
    expect(result.order).toEqual(['task-3', 'task-1', 'task-2']);
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'reordered')).toBe(true);
  });
});

describe('cosTaskStore.approveTask', () => {
  it('flips approvalRequired→false / autoApproved→true and emits approved', async () => {
    await addTask({ description: 'need approve', id: 'sys-ap', approvalRequired: true }, 'internal');
    const approved = await approveTask('sys-ap');
    expect(approved.approvalRequired).toBe(false);
    expect(approved.autoApproved).toBe(true);
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'approved')).toBe(true);
  });

  it('bumps the updatedAt LWW stamp on approval (approval is content) (#1714)', async () => {
    const T0 = Date.parse('2026-06-25T00:00:00.000Z');
    const T1 = Date.parse('2026-06-25T06:00:00.000Z');
    await addTask({ description: 'need approve', id: 'sys-ap2', approvalRequired: true }, 'internal', { now: T0 });
    const approved = await approveTask('sys-ap2', { now: T1 });
    expect(approved.metadata.updatedAt).toBe(new Date(T1).toISOString());
  });

  it('rejects a task that does not require approval', async () => {
    await addTask({ description: 'auto', id: 'sys-auto', approvalRequired: false }, 'internal');
    expect((await approveTask('sys-auto')).error).toBe('Task does not require approval');
  });

  it('returns an error when the cos task file is missing', async () => {
    expect((await approveTask('sys-x')).error).toBe('CoS task file not found');
  });
});

// ─── Source-level regression guards (moved from cos.test.js) ───────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_SRC = realReadFileSync(join(__dirname, 'cosTaskStore.js'), 'utf-8');

describe('addTask — first-line dedup (source guards)', () => {
  it('addTask uses firstLine for dedup', () => {
    // addTask's signature destructuring (`{ raw = false } = {}`) confuses a
    // brace-balanced scanner — slice from the declaration to the next top-level
    // function instead.
    const start = STORE_SRC.indexOf('export async function addTask');
    expect(start, 'addTask must exist').toBeGreaterThan(-1);
    const end = STORE_SRC.indexOf('export async function', start + 1);
    const fnBody = STORE_SRC.slice(start, end === -1 ? undefined : end);
    expect(fnBody).toMatch(/firstLine\(taskData\.description\)/);
    expect(fnBody).toMatch(/firstLine\(t\.description\)/);
  });

  it('addTask scopes dedup by metadata.app', () => {
    // Same description against two different apps must NOT trip the duplicate
    // check — the dedup predicate compares the existing task's `metadata?.app`
    // (or null) against the candidate's app, which for raw tasks lives in
    // `taskData.metadata?.app` (top-level `taskData.app` is non-raw only).
    const start = STORE_SRC.indexOf('export async function addTask');
    const end = STORE_SRC.indexOf('export async function', start + 1);
    const fnBody = STORE_SRC.slice(start, end === -1 ? undefined : end);
    expect(fnBody).toMatch(/t\.metadata\?\.app\s*\|\|\s*null/);
    expect(fnBody).toMatch(/taskData\.metadata\?\.app/);
  });
});

// Receiver side of CoS task federation (#1712). Runs the REAL cosTaskMerge
// against the in-memory file map so the read-merge-write round-trip + write-skip
// are covered end-to-end (the merge rules themselves are unit-tested in
// cosTaskMerge.test.js).
describe('cosTaskStore.mergePeerTasks', () => {
  const NOW = Date.parse('2026-06-25T12:00:00.000Z');
  const future = (ms) => new Date(NOW + ms).toISOString();

  it('adopts a remote-only task into the file and emits tasks:changed', async () => {
    await addTask({ description: 'local task', priority: 'LOW', id: 'task-local' }, 'user');
    mock.events = [];
    const remote = [{ id: 'task-remote', taskType: 'user', status: 'pending', priority: 'HIGH', description: 'peer task', metadata: {} }];
    const res = await mergePeerTasks('user', remote, { now: NOW });
    expect(res.changed).toBe(true);
    const after = await getUserTasks();
    expect(after.tasks.map(t => t.id).sort()).toEqual(['task-local', 'task-remote']);
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'peer-merged')).toBe(true);
  });

  it('is a no-op (no write, no event) when the peer payload changes nothing', async () => {
    await addTask({ description: 'same', priority: 'MEDIUM', id: 'task-same' }, 'user');
    mock.events = [];
    const writeSpy = (await import('fs/promises')).writeFile;
    writeSpy.mockClear();
    const remote = [{ id: 'task-same', taskType: 'user', status: 'pending', priority: 'MEDIUM', description: 'same', metadata: {} }];
    const res = await mergePeerTasks('user', remote, { now: NOW });
    expect(res).toEqual({ changed: false });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(mock.events.some(e => e.name === 'tasks:changed')).toBe(false);
  });

  it("never clobbers the local peer's live claim with a remote pending copy", async () => {
    // Local task is claimed + in_progress (this instance is working it).
    await addTask({ description: 'claimed work', id: 'task-c', priority: 'HIGH' }, 'user');
    await updateTask('task-c', { status: 'in_progress', metadata: { claimedBy: 'instance-A', claimedAt: future(-1000), leaseExpiresAt: future(60_000) } }, 'user');
    // Peer still thinks it's pending + unclaimed.
    const remote = [{ id: 'task-c', taskType: 'user', status: 'pending', priority: 'HIGH', description: 'claimed work', metadata: {} }];
    await mergePeerTasks('user', remote, { now: NOW });
    const after = await getUserTasks();
    const merged = after.tasks.find(t => t.id === 'task-c');
    expect(merged.status).toBe('in_progress');
    expect(merged.metadata.claimedBy).toBe('instance-A');
  });

  it('creates the file when it does not exist yet and the peer has tasks', async () => {
    const remote = [{ id: 'sys-x', taskType: 'internal', status: 'pending', priority: 'MEDIUM', description: 'new', metadata: {} }];
    const res = await mergePeerTasks('internal', remote, { now: NOW });
    expect(res.changed).toBe(true);
    const after = await getCosTasks();
    expect(after.tasks.map(t => t.id)).toContain('sys-x');
  });

  it('adopts a metadata-less remote task through the real markdown generator without throwing', async () => {
    // A cross-version/forked peer may advertise a task with no `metadata` (the
    // wire schema marks it optional). generateTasksMarkdown does
    // Object.entries(metadata) — undefined would throw and fail the whole merge.
    const remote = [{ id: 'task-nometa', taskType: 'user', status: 'pending', priority: 'HIGH', description: 'no metadata here' }];
    const res = await mergePeerTasks('user', remote, { now: NOW });
    expect(res.changed).toBe(true);
    const after = await getUserTasks();
    const adopted = after.tasks.find(t => t.id === 'task-nometa');
    expect(adopted).toBeTruthy();
    expect(adopted.description).toBe('no metadata here');
  });
});

describe('cosTaskStore.challengeTask / resolveTaskChallenge (#2441)', () => {
  async function seedTask(desc = 'work under dispute') {
    const created = await addTask({ description: desc, priority: 'HIGH' }, 'user');
    return created.id;
  }

  it('parks a task in challenged and records the worker case', async () => {
    const id = await seedTask();
    const result = await challengeTask(id, { reason: 'reviewer misread the diff', reviewer: 'ollama' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('challenged');
    expect(String(result.metadata.challengeCount)).toBe('1');
    expect(result.metadata.challenge.reason).toBe('reviewer misread the diff');
    expect(result.metadata.challenge.reviewer).toBe('ollama');
    expect(mock.events.some(e => e.name === 'task:challenged')).toBe(true);
  });

  it('refuses a second dispute on the same task (bounded to one)', async () => {
    const id = await seedTask();
    await challengeTask(id, { reason: 'first' });
    const second = await challengeTask(id, { reason: 'second' });
    expect(second.code).toBe('CHALLENGE_EXHAUSTED');
  });

  it('returns NOT_FOUND for an unknown task', async () => {
    const result = await challengeTask('task-nope', { reason: 'x' });
    expect(result.code).toBe('NOT_FOUND');
  });

  it('refuses to challenge a completed task', async () => {
    const id = await seedTask('already done');
    await updateTask(id, { status: 'completed' }, 'user');
    const result = await challengeTask(id, { reason: 'too late' });
    expect(result.code).toBe('CANNOT_CHALLENGE_COMPLETED');
  });

  it('upheld resolution overturns the rejection → pending', async () => {
    const id = await seedTask();
    await challengeTask(id, { reason: 'wrong verdict' });
    const resolved = await resolveTaskChallenge(id, { outcome: 'upheld', resolvedBy: 'user' });
    expect(resolved.status).toBe('pending');
    expect(resolved.metadata.challengeResolution.outcome).toBe('upheld');
  });

  it('escalated resolution blocks the task AND files an approval-required arbitration task', async () => {
    const id = await seedTask('escalate me');
    await challengeTask(id, { reason: 'still disputed', reviewer: 'codex' });
    const resolved = await resolveTaskChallenge(id, { outcome: 'escalated', note: 'need a human' });
    expect(resolved.status).toBe('blocked');
    expect(resolved.metadata.blockedCategory).toBe('challenge-escalation');
    expect(resolved.metadata.challengeResolution.outcome).toBe('escalated');
    // The escalation surfaces to the user as an internal approval-required task.
    const internal = await getCosTasks();
    const arbitration = internal.tasks.find(t => t.description.includes(`Arbitrate disputed rejection on ${id}`));
    expect(arbitration).toBeTruthy();
    expect(arbitration.approvalRequired).toBe(true);
  });

  it('refuses to resolve a task that is not under challenge', async () => {
    const id = await seedTask();
    const result = await resolveTaskChallenge(id, { outcome: 'upheld' });
    expect(result.code).toBe('NOT_CHALLENGED');
  });

  it('rejects an invalid outcome', async () => {
    const id = await seedTask();
    await challengeTask(id, { reason: 'x' });
    const result = await resolveTaskChallenge(id, { outcome: 'bogus' });
    expect(result.code).toBe('INVALID_OUTCOME');
  });
});
