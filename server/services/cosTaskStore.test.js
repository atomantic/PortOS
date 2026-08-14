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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync as realReadFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const mock = vi.hoisted(() => ({
  files: new Map(),
  // Mocked mtimes for the parsed-task cache (#3497). Each mocked write bumps the
  // path's stamp; a test that wants to simulate an EXTERNAL edit sets it itself.
  mtimes: new Map(),
  // Counts real parses so the cache tests can prove a hit did no work.
  parseCalls: 0,
  state: null,
  events: [],
  // Controls the mocked codeReview.js for resolveTaskChallengeWithRecheck (#2471).
  review: { ok: true, findings: 'No findings.' },
  reviewDefaults: { lmstudioModel: 'default-lmstudio', ollamaModel: 'default-ollama' },
  reviewCalls: [],
  // Captures cross-peer LI execution verdicts consumed by mergePeerTasks (#2779).
  liVerdicts: []
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
  writeFile: vi.fn(async (p, content) => {
    mock.files.set(p, content);
    mock.mtimes.set(p, (mock.mtimes.get(p) || 0) + 1000);
  }),
  // The parsed-task cache stamps on mtimeMs + size, so the mock must model both.
  stat: vi.fn(async (p) => {
    if (!mock.files.has(p)) throw new Error(`ENOENT: ${p}`);
    return { mtimeMs: mock.mtimes.get(p) || 0, size: mock.files.get(p).length };
  })
}));

// Counts parseTasksMarkdown calls (cache-hit assertions) while keeping every
// other taskParser export real — the store's whole read path depends on them.
vi.mock('../lib/taskParser.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    parseTasksMarkdown: (content) => { mock.parseCalls += 1; return actual.parseTasksMarkdown(content); }
  };
});

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => mock.state),
  withStateLock: async (fn) => fn(),
  ROOT_DIR: '/root'
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: (name, payload) => mock.events.push({ name, payload }) }
}));

vi.mock('./codeReview.js', () => ({
  runLocalCodeReview: vi.fn(async (opts) => { mock.reviewCalls.push(opts); return mock.review; }),
  getCodeReviewDefaults: vi.fn(async () => mock.reviewDefaults)
}));

// The LI cross-peer verdict consumer (#2779). Mocked so mergePeerTasks's post-lock
// consume never touches the real li-outcomes store, and so the tests can assert which
// verdicts were consumed. The key literal MUST mirror layeredIntelligenceOutcomes.js's
// LI_EXECUTION_VERDICT_KEY (a stamp/consume metadata contract).
vi.mock('./layeredIntelligenceOutcomes.js', () => ({
  LI_EXECUTION_VERDICT_KEY: 'liExecution',
  recordProposalExecutionFromVerdict: vi.fn(async (verdict) => { mock.liVerdicts.push(verdict); return true; })
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
  reviveBlockedTask,
  deleteTask,
  reorderTasks,
  approveTask,
  mergePeerTasks,
  challengeTask,
  resolveTaskChallenge,
  resolveTaskChallengeWithRecheck,
  blockedFailureAgeMs,
  isReapableBlockedFailure,
  isReapableInvestigation,
  sweepResolvedFailureTasks,
  DEFAULT_FAILURE_TASK_MAX_AGE_MS,
  __resetTaskCache
} from './cosTaskStore.js';
import { AGENT_PAUSED_CATEGORY, PAUSE_METADATA_KEYS, registerPauseReleaseAdapter, __resetPauseReleaseAdapter } from '../lib/taskPauseHold.js';
import { MAX_TOTAL_SPAWNS } from '../lib/cosValidation.js';

const USER_FILE = join('/root', 'TASKS.md');
const COS_FILE = join('/root', 'COS-TASKS.md');

const baseState = () => ({
  config: { userTasksFile: 'TASKS.md', cosTasksFile: 'COS-TASKS.md' }
});

beforeEach(() => {
  mock.files = new Map();
  mock.mtimes = new Map();
  mock.parseCalls = 0;
  // The parse cache is module-level state; a leftover entry from the previous
  // test would answer for a path this test just re-created from scratch.
  __resetTaskCache();
  mock.state = baseState();
  mock.events = [];
  mock.review = { ok: true, findings: 'No findings.' };
  mock.reviewDefaults = { lmstudioModel: 'default-lmstudio', ollamaModel: 'default-ollama' };
  mock.reviewCalls = [];
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

// Parsed-task cache (#3497). The daemon's evaluation tick re-reads both task
// files many times a minute; these pin that an unchanged file is parsed once,
// that every invalidation signal fires, and that a cached read can never leak a
// caller's in-place mutations into the next reader.
describe('cosTaskStore parsed-task cache (#3497)', () => {
  it('serves a cached parse while the file is unchanged', async () => {
    await addTask({ description: 'cached thing' }, 'user');
    mock.parseCalls = 0;

    const first = await getUserTasks();
    expect(mock.parseCalls).toBe(1);

    const second = await getUserTasks();
    expect(mock.parseCalls).toBe(1); // no re-parse — the file did not move
    expect(second.tasks).toEqual(first.tasks);
  });

  it('re-parses after an external edit bumps mtime', async () => {
    await addTask({ description: 'first' }, 'user');
    await getUserTasks();
    mock.parseCalls = 0;

    // Simulate an out-of-band write (user editing TASKS.md, a restore, a peer).
    mock.files.set(USER_FILE, mock.files.get(USER_FILE).replace('first', 'edited outside the store'));
    mock.mtimes.set(USER_FILE, mock.mtimes.get(USER_FILE) + 5000);

    const after = await getUserTasks();
    expect(mock.parseCalls).toBe(1);
    expect(after.tasks[0].description).toBe('edited outside the store');
  });

  it('re-parses after a write through the store even when the stamp has not moved', async () => {
    await addTask({ description: 'original' }, 'user');
    const created = (await getUserTasks()).tasks[0]; // primes the cache

    // Snapshot the EXACT stamp the cache is now holding, so it can be restored
    // byte-for-byte after the write below.
    const cachedContent = mock.files.get(USER_FILE);
    const cachedMtime = mock.mtimes.get(USER_FILE);

    await updateTask(created.id, { description: 'original' }, 'user');

    // Put back content of the identical LENGTH ('original' and 'REWRITTN' are
    // both 8 chars) at the identical mtime, so `mtimeMs:size` is bit-for-bit
    // what the cached entry carries. The stamp check therefore cannot save this
    // read — only writeTaskFile having dropped the entry itself can. Restoring
    // a different-length string instead would move `size`, the stamp would
    // differ anyway, and this test would pass with the write-side invalidation
    // deleted. That matters because the length-neutral rewrite is the COMMON
    // production case (a status flip, an `updatedAt` restamp), and on a
    // coarse-mtime filesystem two writes inside one tick stamp identically.
    mock.files.set(USER_FILE, cachedContent.replace('original', 'REWRITTN'));
    mock.mtimes.set(USER_FILE, cachedMtime);
    mock.parseCalls = 0;

    const after = await getUserTasks();
    expect(mock.parseCalls).toBe(1);
    expect(after.tasks[0].description).toBe('REWRITTN');
  });

  it('invalidates on deleteTask so the removed task never comes back cached', async () => {
    const created = await addTask({ description: 'doomed' }, 'user');
    expect((await getUserTasks()).tasks).toHaveLength(1);

    await deleteTask(created.id, 'user');
    expect((await getUserTasks()).tasks).toHaveLength(0);
  });

  it('invalidates on mergePeerTasks so a merged peer task is visible immediately', async () => {
    await addTask({ description: 'local one', id: 'task-local' }, 'user');
    await getUserTasks();

    await mergePeerTasks('user', [{
      id: 'task-remote',
      description: 'remote one',
      status: 'pending',
      priority: 'MEDIUM',
      metadata: { updatedAt: new Date(Date.now()).toISOString() }
    }]);

    const after = await getUserTasks();
    expect(after.tasks.some(t => t.id === 'task-remote')).toBe(true);
  });

  it('hands every reader its own copy, so mutating one result cannot poison the cache', async () => {
    await addTask({ description: 'pristine' }, 'user');

    const first = await getUserTasks();
    first.tasks[0].description = 'mutated in place';
    first.tasks[0].metadata.injected = 'nope';
    first.tasks.push({ id: 'task-ghost' });

    const second = await getUserTasks();
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0].description).toBe('pristine');
    expect(second.tasks[0].metadata.injected).toBeUndefined();
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

  it('persists the investigation guard markers into metadata and round-trips them through markdown (#2615)', async () => {
    const created = await addTask({
      description: '[Auto] Investigate agent failure: agent exited during startup',
      approvalRequired: true,
      isInvestigation: true,
      investigationFingerprint: 'startup-failure:user:none',
      affectedTasks: ['task-abc']
    }, 'internal');
    expect(created.metadata.isInvestigation).toBe(true);
    expect(created.metadata.investigationFingerprint).toBe('startup-failure:user:none');
    expect(created.metadata.affectedTasks).toEqual(['task-abc']);
    // Survives the markdown serialize → parse round-trip: the colon-bearing
    // fingerprint stays intact (parser splits on the FIRST colon only), the
    // boolean marker comes back as the string 'true' (isTruthyMeta territory),
    // and the affectedTasks array round-trips via the JSON sentinel.
    const { tasks } = await getCosTasks();
    const reloaded = tasks.find(t => t.id === created.id);
    expect(reloaded.metadata.investigationFingerprint).toBe('startup-failure:user:none');
    expect(reloaded.metadata.isInvestigation === true || reloaded.metadata.isInvestigation === 'true').toBe(true);
    expect(reloaded.metadata.affectedTasks).toEqual(['task-abc']);
  });

  it('persists a slashdo workflow as the BARE command name, never a rendered invocation (#3089)', async () => {
    const created = await addTask({ description: 'Plan the widget API', slashdoCommand: 'plan-task' }, 'user');
    expect(created.metadata.slashdoCommand).toBe('plan-task');
    // A literal `/do:plan-task` frozen in at form time would be Claude-only —
    // the provider select defaults to Auto, so the invocation shape must stay
    // unresolved until the scheduler picks one.
    expect(created.description).not.toContain('/do:');
    expect(JSON.stringify(created.metadata)).not.toContain('/do:');

    const { tasks } = await getUserTasks();
    expect(tasks.find(t => t.id === created.id).metadata.slashdoCommand).toBe('plan-task');
  });

  it('persists malware scan report ownership through the task markdown round-trip', async () => {
    const malwareScan = { linkId: 'a3d2c4e8-810a-4d1a-8ab1-94d3e0a13f8d', reportId: 'b38bdf75-3fe2-498c-9c36-7d512dc078d1' };
    const created = await addTask({ description: 'Malware scan: example/repo', malwareScan }, 'user');
    expect(created.metadata.malwareScan).toEqual(malwareScan);

    const { tasks } = await getUserTasks();
    expect(tasks.find(t => t.id === created.id).metadata.malwareScan).toEqual(malwareScan);
  });

  it('omits slashdo metadata when no workflow is pinned', async () => {
    const created = await addTask({ description: 'ordinary prose task' }, 'user');
    expect(created.metadata.slashdoCommand).toBeUndefined();
    expect(created.metadata.slashdoArgs).toBeUndefined();
  });

  it('omits investigation guard metadata when not supplied', async () => {
    const created = await addTask({ description: 'ordinary task' }, 'user');
    expect(created.metadata.isInvestigation).toBeUndefined();
    expect(created.metadata.investigationFingerprint).toBeUndefined();
  });

  it('persists quota-burn provenance and omits it for every other task', async () => {
    // `metadata` is an allowlist, so an unlisted key is silently dropped — and a
    // dropped `quotaBurnFamily` makes the queued burn indistinguishable from any
    // other system task at the cooldown gate and the completion continuation.
    const burn = await addTask(
      { description: '[Quota burn: agy] Perf', app: 'portos', quotaBurnFamily: 'agy' },
      'internal',
    );
    expect(burn.metadata.quotaBurnFamily).toBe('agy');
    const ordinary = await addTask({ description: 'not a burn' }, 'user');
    expect(ordinary.metadata.quotaBurnFamily).toBeUndefined();
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

  it('rejects a duplicate of a failure-blocked task (#2614)', async () => {
    // A task blocked by repeated failures still occupies its slot — without
    // this, a persistently-failing scheduled type minted one identical blocked
    // duplicate per cadence tick, forever.
    const first = await addTask({ description: 'keeps failing', app: 'portos', id: 'sys-fail' }, 'internal');
    await updateTask(first.id, { status: 'blocked', metadata: { blockedCategory: 'max-retries' } }, 'internal');
    const second = await addTask({ description: 'keeps failing', app: 'portos' }, 'internal');
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    const { tasks } = await getCosTasks();
    expect(tasks.filter(t => firstLine(t.description) === 'keeps failing')).toHaveLength(1);
  });

  it('rejects a duplicate of a user-terminated blocked task (#2614)', async () => {
    const first = await addTask({ description: 'killed on purpose', app: 'portos', id: 'sys-killed' }, 'internal');
    await updateTask(first.id, { status: 'blocked', metadata: { blockedCategory: 'user-terminated' } }, 'internal');
    const second = await addTask({ description: 'killed on purpose', app: 'portos' }, 'internal');
    expect(second.duplicate).toBe(true);
  });

  it('emits tasks:changed action "unblocked" on a blocked → pending flip (#2614)', async () => {
    // cos.init re-runs the dequeue on 'unblocked' (like 'approved') so a
    // revived task spawns without waiting for an unrelated event or timer.
    const task = await addTask({ description: 'revive me', app: 'portos', id: 'sys-revive' }, 'internal');
    await updateTask(task.id, { status: 'blocked', metadata: { blockedCategory: 'max-retries' } }, 'internal');
    mock.events.length = 0;
    await updateTask(task.id, { status: 'pending' }, 'internal');
    const evt = mock.events.find(e => e.name === 'tasks:changed');
    expect(evt.payload.action).toBe('unblocked');
    // A non-status edit still emits the plain 'updated' action.
    mock.events.length = 0;
    await updateTask(task.id, { priority: 'HIGH' }, 'internal');
    expect(mock.events.find(e => e.name === 'tasks:changed').payload.action).toBe('updated');
  });

  it('emits tasks:changed action "requeued" on an in_progress → pending flip (#3373)', async () => {
    // The retry-hold release and the orphan sweep both requeue this way, long
    // after the completion dequeue ran — without a wake signal the retry would
    // idle until an unrelated event or timer fired.
    const task = await addTask({ description: 'requeue me', app: 'portos', id: 'sys-requeue' }, 'internal');
    await updateTask(task.id, { status: 'in_progress' }, 'internal');
    mock.events.length = 0;
    await updateTask(task.id, { status: 'pending', metadata: { retryPendingCleanup: undefined } }, 'internal');
    expect(mock.events.find(e => e.name === 'tasks:changed').payload.action).toBe('requeued');
  });

  // The hold clear has to actually leave the disk: a `null` would serialize as
  // the string "null" and read back as a live marker on the next boot.
  it('drops undefined metadata keys entirely rather than persisting them (#3373)', async () => {
    const task = await addTask({ description: 'clear my marker', app: 'portos', id: 'sys-marker' }, 'internal');
    await updateTask(task.id, { status: 'in_progress', metadata: { retryPendingCleanup: true } }, 'internal');
    await updateTask(task.id, { status: 'pending', metadata: { retryPendingCleanup: undefined } }, 'internal');
    const { tasks } = await getCosTasks();
    const stored = tasks.find(t => t.id === task.id);
    expect(stored.status).toBe('pending');
    expect('retryPendingCleanup' in stored.metadata).toBe(false);
  });

  // A hold only means anything on an in_progress task waiting for its cleanup. Any
  // other status retires it, so a late cleanup (or the orphan sweep) can never act
  // on a marker left behind on a task that has since gone blocked or completed.
  it('strips a retry hold when the task leaves in_progress (#3373)', async () => {
    const task = await addTask({ description: 'hold retired', app: 'portos', id: 'sys-hold' }, 'internal');
    await updateTask(task.id, { status: 'in_progress', metadata: { retryPendingCleanup: 'agent-x', retryPendingSince: new Date().toISOString() } }, 'internal');
    const blocked = await updateTask(task.id, { status: 'blocked', metadata: { blockedCategory: 'user-terminated' } }, 'internal');
    expect(blocked.metadata.retryPendingCleanup).toBeUndefined();
    expect(blocked.metadata.retryPendingSince).toBeUndefined();
  });

  it('reviveBlockedTask flips to pending with a FRESH retry budget (#2614)', async () => {
    // A revived task must behave like a fresh one: without clearing the
    // spawn/orphan budgets it would immediately re-block on the exhausted
    // budget it blocked with. The reset also wins over caller metadata that
    // carries a stale budget forward (pipeline hand-offs spread the prior
    // stage's metadata).
    const task = await addTask({ description: 'budget reset', app: 'portos', id: 'sys-budget' }, 'internal');
    await updateTask(task.id, {
      status: 'blocked',
      metadata: { blockedCategory: 'max-spawns', totalSpawnCount: 99, orphanRetryCount: 3, lastOrphanedAt: '2026-01-01T00:00:00.000Z' }
    }, 'internal');
    const revived = await reviveBlockedTask(task.id, { metadata: { totalSpawnCount: 99, fresh: 'yes' } }, 'internal');
    expect(revived.status).toBe('pending');
    expect(revived.metadata.totalSpawnCount).toBeUndefined();
    expect(revived.metadata.orphanRetryCount).toBeUndefined();
    expect(revived.metadata.lastOrphanedAt).toBeUndefined();
    expect(revived.metadata.blockedCategory).toBeUndefined();
    expect(revived.metadata.fresh).toBe('yes');
  });

  it('resolving a blocked task re-opens the slot for an identical task (#2614)', async () => {
    const first = await addTask({ description: 'retry me', app: 'portos', id: 'sys-retry' }, 'internal');
    await updateTask(first.id, { status: 'blocked', metadata: { blockedCategory: 'max-retries' } }, 'internal');
    // Completed no longer occupies the slot...
    await updateTask(first.id, { status: 'completed' }, 'internal');
    const second = await addTask({ description: 'retry me', app: 'portos', id: 'sys-retry-2' }, 'internal');
    expect(second.duplicate).toBeUndefined();
    const { tasks } = await getCosTasks();
    expect(tasks.filter(t => firstLine(t.description) === 'retry me')).toHaveLength(2);
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
    expect(task.metadata.prCompletion).toBe('review-then-merge');
  });

  it('persists an explicit PR completion policy on new user tasks', async () => {
    const task = await addTask({ description: 'inspect first', useWorktree: true, openPR: true, prCompletion: 'leave-open' }, 'user');
    expect(task.metadata.prCompletion).toBe('leave-open');
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

  it('persists the throwaway-worktree posture so a non-raw caller can ask for it', async () => {
    // Load-bearing: `useWorktree` + `openPR:false` AUTO-MERGES onto the source
    // workspace's default branch. `discardWorktree` is the only thing standing
    // between an audit-style task and an unreviewed commit landing there, and
    // before this passthrough only the raw path could set it — a non-raw caller
    // silently got the auto-merge default instead.
    const task = await addTask({
      description: 'audit only', useWorktree: true, openPR: false,
      discardWorktree: true, worktreeChangesExpected: false, noCodeOutput: true,
    }, 'internal');
    expect(task.metadata.discardWorktree).toBe(true);
    expect(task.metadata.worktreeChangesExpected).toBe(false);
    expect(task.metadata.noCodeOutput).toBe(true);
  });

  it('leaves the throwaway keys absent when the caller did not ask for them', async () => {
    // Absent means "normal posture"; stamping `false` onto every task would put
    // an opt-in marker on records that never opted in.
    const task = await addTask({ description: 'ordinary', useWorktree: true }, 'internal');
    expect(task.metadata.discardWorktree).toBeUndefined();
    expect(task.metadata.noCodeOutput).toBeUndefined();
    expect(task.metadata.worktreeChangesExpected).toBeUndefined();
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

  // The pause hold goes with it, whatever un-blocked the task. `resumeAgent` is only
  // ONE of the paths back to pending — a dedupe revive, an autopilot re-dispatch, a
  // cooldown expiry and a human unblocking it all land here — and every one of them
  // used to leave a running task advertising a live pause, which made the paused
  // agent's own resume read as spent and queue a duplicate.
  it.each(['pending', 'in_progress'])('clears the pause hold when an unrelated path flips it to %s', async (status) => {
    await addTask({ description: 'paused', id: 'task-pz' }, 'user');
    await updateTask('task-pz', {
      status: 'blocked',
      metadata: {
        blockedCategory: AGENT_PAUSED_CATEGORY,
        pausedAt: '2026-08-10T00:00:00.000Z',
        pausedAgentId: 'agent-1',
        resumeWorkspacePath: '/w/agent-1',
        resumeRunId: 'run-1',
      },
    }, 'user');
    const revived = await updateTask('task-pz', { status }, 'user');
    for (const key of PAUSE_METADATA_KEYS) {
      expect(revived.metadata[key]).toBeUndefined();
    }
  });

  // ─── Resuming in place, from ANY door (#3730) ──────────────────────────────
  //
  // Clearing the hold above stops a revived task from advertising a pause it no
  // longer has, but a pause is not only bookkeeping: the run that paused left a
  // branch (usually a whole worktree) behind, and the resumed run has to be POINTED
  // at it or it starts clean and redoes the work. That resolve lived in
  // `resumeAgent`, so the Resume dialog resumed properly while the Tasks-tab status
  // toggle and `reviveBlockedTask` — the shared address for on-demand Run, pipeline
  // advance, Creative Director, manual job trigger and voice dispatch — still spawned
  // a second agent on a clean workspace. These drive each entry point.
  describe('releasing a user pause resumes in place', () => {
    let calls;
    const POINTER = { existingBranch: 'cos/task-p/agent-paused-1', resumeWorktreePath: '/tmp/wt', resumedFromAgentId: 'agent-paused-1' };

    const plantPausedTask = async (id) => {
      await addTask({ description: `paused ${id}`, id }, 'user');
      await updateTask(id, {
        status: 'blocked',
        metadata: {
          blockedCategory: AGENT_PAUSED_CATEGORY,
          blockedReason: 'Paused by user',
          pausedAt: '2026-08-10T00:00:00.000Z',
          pausedAgentId: 'agent-paused-1',
          resumeWorkspacePath: '/tmp/wt',
          resumeRunId: 'run-1',
        },
      }, 'user');
      return id;
    };

    const expectResumedInPlace = (task) => {
      expect(task.status).toBe('pending');
      expect(task.metadata).toMatchObject(POINTER);
      for (const key of [...PAUSE_METADATA_KEYS, 'blockedCategory']) {
        expect(task.metadata[key]).toBeUndefined();
      }
      expect(calls.retired).toEqual([['agent-paused-1', task.id, POINTER.existingBranch]]);
    };

    beforeEach(() => {
      calls = { resolved: [], retired: [], statusAtRetire: [] };
      registerPauseReleaseAdapter({
        resolvePausedTaskResume: async (task) => { calls.resolved.push(task.id); return POINTER; },
        retirePausedAgent: async (agentId, taskId, branchName) => {
          calls.retired.push([agentId, taskId, branchName]);
          calls.statusAtRetire.push((await getTaskById(taskId))?.status);
        },
      });
    });
    afterEach(() => __resetPauseReleaseAdapter());

    it('resumes on the preserved worktree from a bare status flip (the Tasks-tab toggle)', async () => {
      const id = await plantPausedTask('task-pause-toggle');
      expectResumedInPlace(await updateTask(id, { status: 'pending' }, 'user'));
    });

    it('resumes on the preserved worktree from reviveBlockedTask (the five dispatch paths)', async () => {
      const id = await plantPausedTask('task-pause-revive');
      expectResumedInPlace(await reviveBlockedTask(id, { metadata: { context: 'from the dispatcher' } }, 'user'));
    });

    it("keeps the caller's own metadata alongside the pointer", async () => {
      const id = await plantPausedTask('task-pause-overrides');
      const revived = await reviveBlockedTask(id, { metadata: { provider: 'claude', context: 'extra' } }, 'user');
      expect(revived.metadata).toMatchObject({ provider: 'claude', context: 'extra', existingBranch: POINTER.existingBranch });
    });

    // The task must never be `pending` (spawnable) without its pointer, and the
    // retirement — whose `agent:completed` triggers a dequeue — must not run until
    // the pointed task is on disk.
    it('resolves the pointer BEFORE the write and retires the record AFTER it', async () => {
      const id = await plantPausedTask('task-pause-order');
      await updateTask(id, { status: 'pending' }, 'user');
      expect(calls.resolved).toEqual([id]);
      expect(calls.statusAtRetire).toEqual(['pending']);
    });

    it('still un-blocks (clean) when the pointer cannot be resolved', async () => {
      registerPauseReleaseAdapter({
        resolvePausedTaskResume: async () => { throw new Error('git exploded'); },
        retirePausedAgent: async (agentId, taskId, branchName) => calls.retired.push([agentId, taskId, branchName]),
      });
      const id = await plantPausedTask('task-pause-boom');
      const revived = await updateTask(id, { status: 'pending' }, 'user');
      expect(revived.status).toBe('pending');
      expect(revived.metadata.existingBranch).toBeUndefined();
      expect(revived.metadata.pausedAgentId).toBeUndefined();
      expect(calls.retired).toEqual([['agent-paused-1', id, null]]);
    });

    it('leaves a differently-blocked task alone', async () => {
      await addTask({ description: 'not paused', id: 'task-not-paused' }, 'user');
      await updateTask('task-not-paused', { status: 'blocked', metadata: { blockedCategory: 'max-spawns' } }, 'user');
      await reviveBlockedTask('task-not-paused', {}, 'user');
      expect(calls.resolved).toEqual([]);
      expect(calls.retired).toEqual([]);
    });

    // Terminating a paused task is not a resume — nothing to point at, nothing to
    // continue, and the record's retirement belongs to whatever terminated it.
    it('leaves a paused task moving to a terminal status alone', async () => {
      const id = await plantPausedTask('task-pause-terminal');
      await updateTask(id, { status: 'completed' }, 'user');
      expect(calls.resolved).toEqual([]);
      expect(calls.retired).toEqual([]);
    });

    // The bookkeeping names the agent to resolve against and retire. Without it the
    // flip is an ordinary unblock, not a resume.
    it('treats a paused task with no pausedAgentId as an ordinary unblock', async () => {
      await addTask({ description: 'orphan pause', id: 'task-pause-noagent' }, 'user');
      await updateTask('task-pause-noagent', { status: 'blocked', metadata: { blockedCategory: AGENT_PAUSED_CATEGORY } }, 'user');
      const revived = await updateTask('task-pause-noagent', { status: 'pending' }, 'user');
      expect(revived.status).toBe('pending');
      expect(calls.resolved).toEqual([]);
      expect(calls.retired).toEqual([]);
    });
  });

  // The pointer is spent once a task is done or parked for a human: a PERPETUAL
  // task id gets re-queued for unrelated work later, and a stale existingBranch
  // would attach that fresh run to a long-merged branch.
  it('drops the resume pointer on a terminal status', async () => {
    await addTask({ description: 'res', id: 'task-res' }, 'user');
    await updateTask('task-res', {
      metadata: { existingBranch: 'cos/b', resumedFromAgentId: 'agent-x', resumeWorktreePath: '/w/agent-x' }
    }, 'user');
    const done = await updateTask('task-res', { status: 'completed' }, 'user');
    expect(done.metadata.existingBranch).toBeUndefined();
    expect(done.metadata.resumedFromAgentId).toBeUndefined();
    expect(done.metadata.resumeWorktreePath).toBeUndefined();
  });

  // ...but an orphan-cooldown block is a TIMED PAUSE that unblockExpiredOrphanCooldowns
  // flips back to pending on its own. Stripping the pointer there means the revived
  // task starts clean and abandons the worktree its dead agent left behind.
  it('keeps the resume pointer through an orphan-cooldown block', async () => {
    await addTask({ description: 'cool', id: 'task-cool' }, 'user');
    await updateTask('task-cool', {
      metadata: { existingBranch: 'cos/b', resumedFromAgentId: 'agent-x', resumeWorktreePath: '/w/agent-x' }
    }, 'user');
    const cooled = await updateTask('task-cool', {
      status: 'blocked',
      metadata: { blockedCategory: 'orphan-cooldown', cooldownUntil: '2026-01-01T00:30:00.000Z' }
    }, 'user');
    expect(cooled.metadata.existingBranch).toBe('cos/b');
    expect(cooled.metadata.resumedFromAgentId).toBe('agent-x');
    expect(cooled.metadata.resumeWorktreePath).toBe('/w/agent-x');
  });

  // A workspace block is a CONFIG pause on the same footing: the app's Repository
  // Path is missing/unreachable, the user fixes it and revives the task. Dropping
  // the pointer there abandons the uncommitted work in the leftover worktree for a
  // problem that had nothing to do with the task.
  it('keeps the resume pointer through an app-unresolved block', async () => {
    await addTask({ description: 'unrouted', id: 'task-unrouted' }, 'user');
    await updateTask('task-unrouted', {
      metadata: { existingBranch: 'cos/b', resumedFromAgentId: 'agent-x', resumeWorktreePath: '/w/agent-x' }
    }, 'user');
    const blocked = await updateTask('task-unrouted', {
      status: 'blocked',
      metadata: { blockedCategory: 'app-unresolved' }
    }, 'user');
    expect(blocked.metadata.existingBranch).toBe('cos/b');
    expect(blocked.metadata.resumeWorktreePath).toBe('/w/agent-x');
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

  it('stamps lastRequeuedAt only on in_progress → pending, and clears it on the next spawn (#3376)', async () => {
    await addTask({ description: 'requeue', id: 'task-requeue' }, 'user');
    // A plain content edit on a pending task is not a requeue.
    const edited = await updateTask('task-requeue', { description: 'requeue edited' }, 'user');
    expect(edited.metadata.lastRequeuedAt).toBeUndefined();

    await updateTask('task-requeue', { status: 'in_progress' }, 'user');
    // The orphan sweep / retry-hold release transition — this one IS a requeue.
    const requeued = await updateTask('task-requeue', { status: 'pending' }, 'user');
    expect(typeof requeued.metadata.lastRequeuedAt).toBe('string');

    // An edit while pending carries the stamp forward untouched…
    const stamp = requeued.metadata.lastRequeuedAt;
    const edit = await updateTask('task-requeue', { description: 'requeue again' }, 'user');
    expect(edit.metadata.lastRequeuedAt).toBe(stamp);
    // …and the next spawn retires it, so a peer's pre-spawn copy can't win on it.
    const respawned = await updateTask('task-requeue', { status: 'in_progress' }, 'user');
    expect(respawned.metadata.lastRequeuedAt).toBeUndefined();
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

describe('parsed-task cache — no bypass (source guards, #3497)', () => {
  // Everything outside the two cache accessors. Any fs call the rest of the
  // module makes to the task files is a bypass by definition.
  const ACCESSOR_START = 'async function readTaskFile';
  const ACCESSOR_END = '/** Test hook: forget every cached parse. */';
  const outsideAccessors = (() => {
    const start = STORE_SRC.indexOf(ACCESSOR_START);
    const end = STORE_SRC.indexOf(ACCESSOR_END);
    if (start === -1 || end <= start) return null; // asserted below, not thrown here
    return (STORE_SRC.slice(0, start) + STORE_SRC.slice(end))
      .split('\n')
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
  })();

  it('locates the cache accessors it is guarding', () => {
    // If this fails the two guards below are vacuous — the anchors drifted.
    expect(outsideAccessors, `anchors "${ACCESSOR_START}" / "${ACCESSOR_END}" not found in order`).not.toBeNull();
  });

  it('every task-file read goes through readTaskFile', () => {
    // A read path calling readFile + parseTasksMarkdown directly still works,
    // but pays the full parse the cache exists to avoid and skips the
    // copy-on-read that keeps a caller's in-place mutations out of the cache.
    const bypasses = outsideAccessors.filter(line => /\breadFile\(/.test(line));
    expect(bypasses, `direct readFile call(s): ${bypasses.join(' | ')}`).toEqual([]);
  });

  it('every task-file write goes through writeTaskFile', () => {
    // A write calling writeFile directly leaves the previous parse cached, and
    // mtime granularity is too coarse to be relied on to catch it — the next
    // read would serve pre-write tasks.
    const bypasses = outsideAccessors.filter(line => /\bwriteFile\(/.test(line));
    expect(bypasses, `direct writeFile call(s): ${bypasses.join(' | ')}`).toEqual([]);
  });
});

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

  describe('LI cross-peer execution verdict consume (#2779)', () => {
    const verdict = { appId: 'app-x', slug: 'add-metrics', scope: 'refactor', success: true, errorCategory: null, validationPassed: null };
    const handoff = (status, extraMeta = {}) => ([{
      id: 'task-handoff',
      taskType: 'internal',
      status,
      priority: 'HIGH',
      description: 'implement LI proposal',
      metadata: { liExecution: verdict, ...extraMeta }
    }]);

    beforeEach(() => { mock.liVerdicts = []; });

    it('derives recordProposalExecution when a terminal hand-off verdict is adopted', async () => {
      // Peer A holds the task in_progress (it filed + handed it off); peer B executed it
      // and its terminal state syncs back carrying the stamped verdict.
      await addTask({ description: 'implement LI proposal', id: 'task-handoff', priority: 'HIGH' }, 'internal');
      await updateTask('task-handoff', { status: 'in_progress' }, 'internal');
      const res = await mergePeerTasks('internal', handoff('completed'), { now: NOW });
      expect(res.changed).toBe(true);
      expect(mock.liVerdicts).toHaveLength(1);
      expect(mock.liVerdicts[0]).toMatchObject({ appId: 'app-x', slug: 'add-metrics', success: true });
    });

    it('re-offers the terminal verdict on EVERY sweep, including a no-op (durability replay, codex P2)', async () => {
      // The consumer owns durable, record-level idempotency, so mergePeerTasks re-offers every
      // terminal verdict each sweep — this catches a verdict a crash (or an old peer that stored
      // the terminal task before upgrading) left unconsumed, which a changed-only consume would
      // miss because the merge produces no change once the task is already terminal locally.
      await addTask({ description: 'implement LI proposal', id: 'task-handoff', priority: 'HIGH' }, 'internal');
      await updateTask('task-handoff', { status: 'completed', metadata: { liExecution: verdict } }, 'internal');
      mock.liVerdicts = [];
      const res = await mergePeerTasks('internal', handoff('completed'), { now: NOW });
      expect(res.changed).toBe(false); // already terminal locally → no file write
      expect(mock.liVerdicts).toHaveLength(1); // …but the verdict is still re-offered
      expect(mock.liVerdicts[0]).toMatchObject({ appId: 'app-x', slug: 'add-metrics' });
    });

    it('ignores a stale verdict on a NON-terminal synced task', async () => {
      // A verdict riding a pending/in_progress task (e.g. a failed attempt that will
      // retry) is not a settled execution — only a terminal adoption is consumed.
      const res = await mergePeerTasks('internal', handoff('in_progress'), { now: NOW });
      expect(res.changed).toBe(true); // task adopted
      expect(mock.liVerdicts).toHaveLength(0);
    });

    it('does not consume a terminal task that carries no verdict', async () => {
      const remote = [{ id: 'plain-done', taskType: 'internal', status: 'completed', priority: 'LOW', description: 'unrelated', metadata: {} }];
      const res = await mergePeerTasks('internal', remote, { now: NOW });
      expect(res.changed).toBe(true);
      expect(mock.liVerdicts).toHaveLength(0);
    });
  });
});

describe('cosTaskStore — stale failure-artifact reaper (#2619)', () => {
  const NOW = Date.parse('2026-06-25T12:00:00.000Z');
  const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

  describe('blockedFailureAgeMs / isReapableBlockedFailure (pure)', () => {
    const blocked = (category, blockedAt) => ({ status: 'blocked', metadata: { blockedCategory: category, blockedAt } });

    it('returns null for a non-blocked task', () => {
      expect(blockedFailureAgeMs({ status: 'pending', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(30) } }, NOW)).toBeNull();
    });

    it('returns null when there is no blockedCategory', () => {
      expect(blockedFailureAgeMs({ status: 'blocked', metadata: { blockedAt: daysAgo(30) } }, NOW)).toBeNull();
    });

    it('leaves user-intent / open-decision categories alone', () => {
      // The workspace blocks are an open decision too: the task waits for the
      // user to fix the app's Repository Path, so auto-completing it at 14 days
      // would silently retire work nobody decided to drop.
      for (const cat of ['user-terminated', 'agent-paused', 'challenge-escalation', 'app-unresolved', 'workspace-invalid']) {
        expect(blockedFailureAgeMs(blocked(cat, daysAgo(30)), NOW)).toBeNull();
        expect(isReapableBlockedFailure(blocked(cat, daysAgo(30)), { now: NOW })).toBe(false);
      }
    });

    it('computes age from blockedAt and reaps only past the threshold', () => {
      expect(blockedFailureAgeMs(blocked('max-retries', daysAgo(20)), NOW)).toBe(20 * 24 * 60 * 60 * 1000);
      expect(isReapableBlockedFailure(blocked('max-retries', daysAgo(20)), { now: NOW })).toBe(true);
      expect(isReapableBlockedFailure(blocked('max-retries', daysAgo(10)), { now: NOW })).toBe(false);
    });

    it('falls back to lastFailureAt then updatedAt when blockedAt is absent', () => {
      expect(blockedFailureAgeMs({ status: 'blocked', metadata: { blockedCategory: 'provider-config', lastFailureAt: daysAgo(20) } }, NOW)).toBe(20 * 24 * 60 * 60 * 1000);
      expect(blockedFailureAgeMs({ status: 'blocked', metadata: { blockedCategory: 'provider-config', updatedAt: daysAgo(20) } }, NOW)).toBe(20 * 24 * 60 * 60 * 1000);
    });

    it('never reaps an undated block (cannot prove it is old)', () => {
      expect(blockedFailureAgeMs({ status: 'blocked', metadata: { blockedCategory: 'max-retries' } }, NOW)).toBeNull();
      expect(isReapableBlockedFailure({ status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: 'not-a-date' } }, { now: NOW })).toBe(false);
    });
  });

  describe('isReapableInvestigation (pure)', () => {
    const investigation = (overrides = {}) => ({
      status: 'pending',
      description: '[Auto] Investigate agent failure [fp]: boom',
      metadata: { isInvestigation: true, affectedTasks: ['task-a'] },
      ...overrides
    });

    it('reaps when every originating task is completed or gone', () => {
      const byId = new Map([['task-a', { id: 'task-a', status: 'completed' }]]);
      expect(isReapableInvestigation(investigation(), byId)).toBe(true);
      // absent origin (already reaped/deleted) also counts as resolved
      expect(isReapableInvestigation(investigation(), new Map())).toBe(true);
    });

    it('does not reap while any originating task is still live', () => {
      const byId = new Map([['task-a', { id: 'task-a', status: 'blocked' }]]);
      expect(isReapableInvestigation(investigation(), byId)).toBe(false);
    });

    it('detects investigations by the legacy headline when the marker is absent', () => {
      const legacy = { status: 'pending', description: '[Auto] Investigate agent failure: legacy', metadata: { affectedTasks: ['task-a'] } };
      expect(isReapableInvestigation(legacy, new Map())).toBe(true);
    });

    it('leaves a non-investigation task and an already-completed investigation alone', () => {
      expect(isReapableInvestigation({ status: 'pending', description: 'ordinary', metadata: {} }, new Map())).toBe(false);
      expect(isReapableInvestigation(investigation({ status: 'completed' }), new Map())).toBe(false);
    });

    it('leaves a linkless investigation alone (cannot prove its cause is resolved)', () => {
      expect(isReapableInvestigation(investigation({ metadata: { isInvestigation: true } }), new Map())).toBe(false);
    });
  });

  describe('sweepResolvedFailureTasks (orchestration)', () => {
    it('flips a stale failure-blocked task to completed with an auto-expired marker, not deletion', async () => {
      await addTask({ description: 'failed thing', id: 'task-old', priority: 'HIGH' }, 'user', { now: NOW });
      await updateTask('task-old', { status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(20) } }, 'user', { now: NOW });
      mock.events = [];
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res).toMatchObject({ reaped: 1, staleBlocks: 1, investigations: 0 });
      const after = await getUserTasks();
      const task = after.tasks.find(t => t.id === 'task-old');
      expect(task).toBeTruthy(); // NOT deleted — federation-safe
      expect(task.status).toBe('completed');
      expect(task.metadata.resolution).toBe('auto-expired');
      expect(task.metadata.autoExpiredReason).toBe('stale-failure-block');
      // Leaving-blocked clears the failure metadata (existing updateTask behavior).
      expect(task.metadata.blockedCategory).toBeUndefined();
    });

    it('leaves a fresh failure block and a user-terminated block untouched', async () => {
      await addTask({ description: 'fresh', id: 'task-fresh', priority: 'LOW' }, 'user', { now: NOW });
      await updateTask('task-fresh', { status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(3) } }, 'user', { now: NOW });
      await addTask({ description: 'stopped', id: 'task-stop', priority: 'LOW' }, 'user', { now: NOW });
      await updateTask('task-stop', { status: 'blocked', metadata: { blockedCategory: 'user-terminated', blockedAt: daysAgo(60) } }, 'user', { now: NOW });
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res.reaped).toBe(0);
      const after = await getUserTasks();
      expect(after.tasks.find(t => t.id === 'task-fresh').status).toBe('blocked');
      expect(after.tasks.find(t => t.id === 'task-stop').status).toBe('blocked');
    });

    it('flips an investigation whose originating task has completed', async () => {
      await addTask({ description: 'origin work', id: 'task-origin', priority: 'HIGH' }, 'user', { now: NOW });
      await updateTask('task-origin', { status: 'completed' }, 'user', { now: NOW });
      await addTask({
        description: '[Auto] Investigate agent failure [fp]: boom',
        id: 'sys-inv',
        isInvestigation: true,
        affectedTasks: ['task-origin']
      }, 'internal', { now: NOW });
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res).toMatchObject({ reaped: 1, investigations: 1 });
      const after = await getCosTasks();
      const inv = after.tasks.find(t => t.id === 'sys-inv');
      expect(inv.status).toBe('completed');
      expect(inv.metadata.autoExpiredReason).toBe('investigation-resolved');
    });

    it('keeps an investigation whose originating task is still blocked', async () => {
      await addTask({ description: 'origin still broken', id: 'task-origin2', priority: 'HIGH' }, 'user', { now: NOW });
      await updateTask('task-origin2', { status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(1) } }, 'user', { now: NOW });
      await addTask({
        description: '[Auto] Investigate agent failure [fp]: boom',
        id: 'sys-inv2',
        isInvestigation: true,
        affectedTasks: ['task-origin2']
      }, 'internal', { now: NOW });
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res.reaped).toBe(0);
      const after = await getCosTasks();
      expect(after.tasks.find(t => t.id === 'sys-inv2').status).toBe('pending');
    });

    it('bounds the number of flips per sweep to the limit', async () => {
      for (let i = 0; i < 4; i++) {
        await addTask({ description: `old ${i}`, id: `task-b${i}`, priority: 'LOW' }, 'user', { now: NOW });
        await updateTask(`task-b${i}`, { status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(20) } }, 'user', { now: NOW });
      }
      const res = await sweepResolvedFailureTasks({ now: NOW, limit: 2 });
      expect(res.reaped).toBe(2);
      const after = await getUserTasks();
      expect(after.tasks.filter(t => t.status === 'completed')).toHaveLength(2);
      expect(after.tasks.filter(t => t.status === 'blocked')).toHaveLength(2);
    });

    it('is a no-op returning zeroed counts when nothing is reapable', async () => {
      await addTask({ description: 'plain pending', id: 'task-p', priority: 'LOW' }, 'user', { now: NOW });
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res).toEqual({ reaped: 0, staleBlocks: 0, investigations: 0 });
    });

    it('exposes a 14-day default threshold', () => {
      expect(DEFAULT_FAILURE_TASK_MAX_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000);
    });
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

  it('refuses a challenge once the shared retry budget is spent (#2471)', async () => {
    const id = await seedTask('out of retries');
    // Burn the total-spawn budget — a fresh challenge would only re-queue into a
    // task agentLifecycle will immediately re-block, so it is refused up front.
    await updateTask(id, { metadata: { totalSpawnCount: MAX_TOTAL_SPAWNS } }, 'user');
    const result = await challengeTask(id, { reason: 'let me back in' });
    expect(result.code).toBe('CHALLENGE_BUDGET_EXHAUSTED');
    expect(result.error).toMatch(/Retry budget exhausted/);
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

describe('cosTaskStore.resolveTaskChallengeWithRecheck (#2471)', () => {
  async function seedChallenged(reviewer = 'ollama') {
    const created = await addTask({ description: 'work under dispute' }, 'user');
    await challengeTask(created.id, { reason: 'reviewer misread the diff', reviewer });
    return created.id;
  }

  it('overturns (→ pending) when the re-check finds nothing blocking', async () => {
    const id = await seedChallenged();
    mock.review = { ok: true, findings: 'No findings.' };
    const resolved = await resolveTaskChallengeWithRecheck(id, { recheck: { backend: 'ollama', diff: 'diff --git a b' } });
    expect(resolved.status).toBe('pending');
    expect(resolved.metadata.challengeResolution.outcome).toBe('upheld');
    expect(resolved.metadata.challengeResolution.note).toContain('ollama');
    // The recheck used the Code Review Defaults model when none was passed.
    expect(mock.reviewCalls[0].model).toBe('default-ollama');
  });

  it('escalates (→ blocked) when the re-check still reports a blocking finding', async () => {
    const id = await seedChallenged('lmstudio');
    mock.review = { ok: true, findings: '## Blocking\n- foo.js:10 still broken' };
    const resolved = await resolveTaskChallengeWithRecheck(id, { recheck: { backend: 'lmstudio', model: 'coder-7b', diff: 'diff' } });
    expect(resolved.status).toBe('blocked');
    expect(resolved.metadata.challengeResolution.outcome).toBe('escalated');
    expect(mock.reviewCalls[0].model).toBe('coder-7b');
  });

  it('returns RECHECK_NO_MODEL (config problem, not 502) when no model is configured', async () => {
    const id = await seedChallenged();
    mock.reviewDefaults = { lmstudioModel: null, ollamaModel: null };
    const result = await resolveTaskChallengeWithRecheck(id, { recheck: { backend: 'ollama', diff: 'diff' } });
    expect(result.code).toBe('RECHECK_NO_MODEL');
    // No reviewer call attempted without a model.
    expect(mock.reviewCalls.length).toBe(0);
  });

  it('returns RECHECK_FAILED when the reviewer is unreachable', async () => {
    const id = await seedChallenged();
    mock.review = { ok: false, error: 'ollama request failed: ECONNREFUSED' };
    const result = await resolveTaskChallengeWithRecheck(id, { recheck: { backend: 'ollama', diff: 'diff' } });
    expect(result.code).toBe('RECHECK_FAILED');
  });

  it('refuses to re-check a task that is not under challenge', async () => {
    const created = await addTask({ description: 'not disputed' }, 'user');
    const result = await resolveTaskChallengeWithRecheck(created.id, { recheck: { backend: 'ollama', diff: 'diff' } });
    expect(result.code).toBe('NOT_CHALLENGED');
    // No wasted reviewer call for a non-challenged task.
    expect(mock.reviewCalls.length).toBe(0);
  });
});
