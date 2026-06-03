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
  approveTask
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

  it('persists boolean override flags (true and false) into metadata', async () => {
    const task = await addTask({ description: 'flagged', useWorktree: false, openPR: true }, 'user');
    expect(task.metadata.useWorktree).toBe(false);
    expect(task.metadata.openPR).toBe(true);
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
    // check — the dedup predicate compares the candidate's `metadata?.app` (or
    // null) against the new task's `taskData.app`.
    const start = STORE_SRC.indexOf('export async function addTask');
    const end = STORE_SRC.indexOf('export async function', start + 1);
    const fnBody = STORE_SRC.slice(start, end === -1 ? undefined : end);
    expect(fnBody).toMatch(/t\.metadata\?\.app\s*\|\|\s*null/);
    expect(fnBody).toMatch(/taskData\.app\s*\|\|\s*null/);
  });
});
