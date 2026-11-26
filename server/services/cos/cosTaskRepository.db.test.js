/**
 * PostgreSQL backend of the CoS task queues, against the shared contract in
 * _cosTaskRepositoryContract.js. Runs via `npm run test:db` (→ `portos_test`)
 * ONLY; skips cleanly when no database is reachable.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { __makePgCosTaskBackend } from './cosTaskRepository.js';
import { __runCosTaskRepositoryContract } from '../_cosTaskRepositoryContract.js';
import { planListSave } from '../../lib/cos/cosTaskRows.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('services/cos/cosTaskRepository.db.test', health.connected, 'disposable PostgreSQL unavailable');

afterAll(async () => {
  if (runDb) { await query('DELETE FROM cos_tasks'); await query('DELETE FROM cos_task_lists'); }
  if (health.connected) await close();
});

describe.skipIf(!runDb)('cos_tasks repository on PostgreSQL', () => {
  __runCosTaskRepositoryContract({
    name: 'postgres',
    makeBackend: async () => {
      await query('DELETE FROM cos_tasks');
      await query('DELETE FROM cos_task_lists');
      return __makePgCosTaskBackend({ query, withTransaction });
    },
  });
});

describe.skipIf(!runDb)('cos_tasks repository query plans', () => {
  it('uses the primary key for source-less access and the partial index for ordered history', async () => {
    await withTransaction(async (client) => {
      // Shadow the shared tables with fixed statistics and the shipped indexes.
      await client.query('CREATE TEMP TABLE cos_tasks (LIKE public.cos_tasks INCLUDING ALL) ON COMMIT DROP');
      await client.query('CREATE TEMP TABLE cos_task_lists (LIKE public.cos_task_lists INCLUDING ALL) ON COMMIT DROP');
      await client.query(`INSERT INTO cos_tasks (source, task_id, status, position, task)
        SELECT source, lpad(n::text, 5, '0'),
               CASE WHEN n % 4 = 0 THEN 'pending' ELSE 'completed' END, n, '{}'
        FROM unnest(ARRAY['user', 'internal']) AS sources(source), generate_series(1, 6000) AS ids(n)`);
      await client.query('ANALYZE cos_tasks');

      const plans = [];
      const explainAndQuery = async (sql, params) => {
        if (sql.includes('FROM cos_tasks ')) {
          const { rows: [{ 'QUERY PLAN': [{ Plan }] }] } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
          plans.push(Plan);
        }
        return client.query(sql, params);
      };
      const backend = __makePgCosTaskBackend({
        query: explainAndQuery,
        withTransaction: (fn) => fn({ query: explainAndQuery }),
      });

      expect(await backend.getTask('00001', null)).toMatchObject({ source: 'user' });
      expect(await backend.deleteById('00001', null)).toBe(2);
      expect(await backend.pageCompleted('user', { before: '05000', offset: 0, limit: 25 })).toHaveLength(25);

      const planNodes = (node) => [node, ...(node.Plans ?? []).flatMap(planNodes)];
      const { rows: [{ indexrelid: primaryIndex }] } = await client.query(
        "SELECT indexrelid::regclass::text AS indexrelid FROM pg_index WHERE indrelid = 'pg_temp.cos_tasks'::regclass AND indisprimary",
      );
      for (const plan of plans.slice(0, 2)) {
        const nodes = planNodes(plan);
        expect(nodes).toContainEqual(expect.objectContaining({
          'Node Type': expect.stringMatching(/^(?:Bitmap )?Index Scan$/),
          'Index Name': primaryIndex,
          'Index Cond': expect.stringMatching(/source.*task_id/),
        }));
        expect(nodes).not.toContainEqual(expect.objectContaining({ 'Node Type': 'Seq Scan' }));
      }

      expect(plans).toHaveLength(3);
      const pagingNodes = planNodes(plans[2]);
      const { rows: [{ indexname: pagingIndex }] } = await client.query(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema())
          AND tablename = 'cos_tasks'
          AND indexdef LIKE '%(source, task_id DESC) WHERE (status = %'`);
      expect(pagingNodes).toContainEqual(expect.objectContaining({
        'Node Type': 'Index Scan',
        'Index Name': pagingIndex,
      }));
      expect(pagingNodes).not.toContainEqual(expect.objectContaining({ 'Node Type': expect.stringMatching(/Sort$/) }));
    });
  });
});

// PostgreSQL refuses a lone surrogate in jsonb and NUL in jsonb/text; the file
// stores these queues came from accepted both (#12815).
describe.skipIf(!runDb)('cos_tasks repository text PostgreSQL would refuse', () => {
  const task = (n, description) => ({
    id: `task-example-${n}`, status: 'pending', priority: 'MEDIUM', priorityValue: 2, description,
    approvalRequired: false, autoApproved: true, metadata: {},
  });

  it('repairs a split emoji and a NUL to U+FFFD instead of failing the save', async () => {
    await query('DELETE FROM cos_tasks');
    await query('DELETE FROM cos_task_lists');
    const backend = __makePgCosTaskBackend({ query, withTransaction });
    // The cut askPromote makes: 279 characters, then half of an emoji's surrogate pair.
    const split = `${'a'.repeat(279)}${'😀'.slice(0, 1)}`;
    const next = [task(1, split), task(2, 'before\0after')];
    const { rows, version } = await backend.loadWorkingSet('user');
    const plan = planListSave({ previous: rows, next, source: 'user' });
    await backend.apply('user', { ...plan, expectedVersions: { user: version } });

    const saved = Object.fromEntries((await backend.loadWorkingSet('user')).rows.map((row) => [row.task.id, row.task]));
    expect(saved['task-example-1'].description).toBe(`${'a'.repeat(279)}\uFFFD`);
    expect(saved['task-example-2'].description).toBe('before\uFFFDafter');
    const { rows: [column] } = await query('SELECT description FROM cos_tasks WHERE task_id = $1', ['task-example-2']);
    expect(column.description).toBe('before\uFFFDafter');
  });
});

// #16407: the stored form keeps JSON types, nulls and newlines; JSONB must hand them back unchanged.
describe.skipIf(!runDb)('cos_tasks repository keeps typed metadata on PostgreSQL', () => {
  it('reads { flag: true, n: 3, note: null } and a multi-line description back as written', async () => {
    await query('DELETE FROM cos_tasks');
    await query('DELETE FROM cos_task_lists');
    const backend = __makePgCosTaskBackend({ query, withTransaction });
    const next = [{ id: 'task-typed', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Line one\nLine two',
      approvalRequired: false, autoApproved: true, metadata: { flag: true, n: 3, note: null } }];
    const { rows, version } = await backend.loadWorkingSet('user');
    const plan = planListSave({ previous: rows, next, source: 'user' });
    await backend.apply('user', { ...plan, expectedVersions: { user: version } });
    const [saved] = (await backend.loadWorkingSet('user')).rows.map((row) => row.task);
    expect(saved.metadata).toStrictEqual({ flag: true, n: 3, note: null });
    expect(saved.description).toBe('Line one\nLine two');
    const { rows: [column] } = await query('SELECT description FROM cos_tasks WHERE task_id = $1', ['task-typed']);
    expect(column.description).toBe('Line one\nLine two');
  });
});

// Two independently loaded stores have separate caches. The lock double does
// not serialize them, just as two service processes cannot share a JS lock.
// All task persistence below still uses real transactions in portos_test.
describe.skipIf(!runDb)('independent task writers', () => {
  let helper;
  let daemon;
  let beforeApply;
  let beforeLookup;
  const events = [];
  const notifications = [];
  const backend = __makePgCosTaskBackend({ query, withTransaction });
  const gate = () => Promise.withResolvers();
  const holdNextWrite = ({ afterRead = false } = {}) => {
    const entered = gate();
    const release = gate();
    const hook = async () => { entered.resolve(); await release.promise; };
    if (afterRead) beforeLookup = hook; else beforeApply = hook;
    return { entered: entered.promise, release: release.resolve };
  };

  beforeEach(async () => {
    await query('DELETE FROM cos_tasks');
    await query('DELETE FROM cos_task_lists');
    beforeApply = null;
    beforeLookup = null;
    events.length = 0;
    notifications.length = 0;
    vi.doMock('./cosState.js', () => ({ withStateLock: fn => fn(), loadState: async () => ({ agents: {} }) }));
    vi.doMock('./cosEvents.js', () => ({ cosEvents: { emit: (name, payload) => events.push({ name, ...payload }) } }));
    vi.doMock('../notifications.js', () => ({ removeByMetadata: async (...args) => notifications.push(args) }));
    vi.doMock('../codeReview.js', () => ({ runLocalCodeReview: vi.fn(), getCodeReviewDefaults: vi.fn() }));
    vi.doMock('./cosTaskRepository.js', () => ({
      readTaskListVersion: source => backend.readVersion(source),
      loadTaskWorkingSet: source => backend.loadWorkingSet(source),
      getStoredTask: async (id, source = null) => {
        const hook = beforeLookup;
        beforeLookup = null;
        if (hook) await hook();
        return backend.getTask(id, source);
      },
      deleteStoredTask: (id, source = null) => backend.deleteById(id, source),
      getCompletedTaskIds: (source, ids) => backend.completedIds(source, ids),
      countCompletedTasks: source => backend.countCompleted(source),
      pageCompletedTasks: (source, options) => backend.pageCompleted(source, options),
      applyTaskListSave: async (source, plan) => {
        const hook = beforeApply;
        beforeApply = null;
        if (hook) await hook();
        return backend.apply(source, plan);
      },
    }));
    vi.resetModules();
    helper = await import('./cosTaskStore.js');
    vi.resetModules();
    daemon = await import('./cosTaskStore.js');
    expect(helper.addTask).not.toBe(daemon.addTask);
  });

  it('recomputes a stale addition, preserving concurrent additions and edits with one event per commit', async () => {
    const a = await daemon.addTask({ description: 'A' });
    const pause = holdNextWrite({ afterRead: true });
    const adding = helper.addTask({ description: 'C' });
    await pause.entered;
    await daemon.updateTask(a.id, { description: 'Newer A' });
    const b = await daemon.addTask({ description: 'B' });
    pause.release();
    const c = await adding;
    expect((await helper.getUserTasks()).tasks.map(task => task.description)).toEqual(['Newer A', 'B', 'C']);
    expect(events.filter(event => event.action === 'added' && event.task.id === c.id)).toHaveLength(1);
    await helper.deleteTask(b.id);
    expect((await daemon.getUserTasks()).tasks.map(task => task.id)).toEqual([a.id, c.id]);
  });

  it('rechecks a follow-up work identity in the other queue and emits no duplicate notification', async () => {
    const metadata = { app: 'example', reviewLoopPRUrl: 'https://github.com/example/example/pull/42' };
    const pause = holdNextWrite({ afterRead: true });
    const adding = helper.addTask({ description: 'Scheduled follow-up', metadata }, 'internal');
    await pause.entered;
    const existing = await daemon.addTask({ description: 'Manual follow-up', metadata });
    pause.release();
    expect(await adding).toMatchObject({ id: existing.id, duplicate: true });
    expect((await helper.getCosTasks()).tasks).toEqual([]);
    expect(events.filter(event => event.action === 'added')).toHaveLength(1);
  });

  it('rejects a stale approval before emitting or removing its notification', async () => {
    const task = await daemon.addTask({ description: 'Approval', approvalRequired: true }, 'internal');
    const pause = holdNextWrite();
    const approval = helper.approveTask(task.id);
    const rejected = expect(approval).rejects.toMatchObject({ code: 'COS_TASK_LIST_CONFLICT' });
    await pause.entered;
    await daemon.updateTask(task.id, { description: 'Changed before approval' }, 'internal');
    pause.release();
    await rejected;
    expect(events.filter(event => event.action === 'approved')).toEqual([]);
    expect(notifications).toEqual([]);
    expect((await daemon.getCosTasks()).tasks[0]).toMatchObject({ description: 'Changed before approval', approvalRequired: true });
    await helper.approveTask(task.id);
    expect(events.filter(event => event.action === 'approved')).toHaveLength(1);
    expect(notifications).toEqual([['taskId', task.id]]);
  });
});
