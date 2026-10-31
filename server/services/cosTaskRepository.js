/**
 * Persistence for the CoS task queues (`cos_tasks`): one row per task, per
 * queue ('user' = the human's task list, 'internal' = the system's).
 *
 * PostgreSQL is authoritative. The in-memory backend exists only for the
 * documented development/test escape hatch (it persists to `data/cos-tasks.json`
 * outside the test runner so a database-less dev run survives a restart).
 *
 * Callers work with the WORKING SET: every open task plus recently completed
 * ones (see lib/cosTaskRows.js), which is what the old task files held. Older
 * completed tasks are reached by id or history paging, never loaded wholesale.
 * `version` bumps on every write so a cached working set can be checked with a
 * single-row read.
 */

import { join } from 'node:path';
import { atomicWrite, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { createPgFileFacade, resolvePgBackend, POSTGRES_SETUP_HINT } from '../lib/pgFileFacade.js';
import { isTestRunner } from '../lib/runtimeEnv.js';
import {
  WORKING_SET_COMPLETED_WINDOW_MS, WORKING_SET_KEEP_COMPLETED, completionStamp, rowColumns, selectWorkingSet,
} from '../lib/cosTaskRows.js';
import { toPgJson } from '../lib/pgJson.js';

const SOURCES = ['user', 'internal'];
// Bounds a single statement's parameter payload (prompts can be MBs).
const UPSERT_BATCH = 100;
const conflict = () => Object.assign(new Error('Task queue changed; reload and retry the operation'), {
  code: 'COS_TASK_LIST_CONFLICT', status: 409,
});

function checkExpectedVersions(source, expectedVersions, versions) {
  if (!Number.isSafeInteger(expectedVersions?.[source]) || expectedVersions[source] < 0
    || Object.entries(expectedVersions).some(([key, value]) => !SOURCES.includes(key) || !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Task saves require the versions of the snapshots they read');
  }
  if (Object.entries(expectedVersions).some(([key, value]) => versions[key] !== value)) throw conflict();
}

// Every writer locks the same version rows before touching tasks. The fixed
// order also makes a save conditional on both queues safe for cross-queue dedup.
async function lockVersions(client) {
  await client.query(`INSERT INTO cos_task_lists (source, version) VALUES ('user', 0), ('internal', 0) ON CONFLICT DO NOTHING`);
  const { rows } = await client.query('SELECT source, version FROM cos_task_lists ORDER BY source FOR UPDATE');
  return Object.fromEntries(rows.map((row) => [row.source, Number(row.version)]));
}

const tasksFile = () => join(PATHS.data, 'cos-tasks.json');
const byIdDesc = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function makePgBackend(db) {
  const { query, withTransaction } = db;
  return {
    name: 'postgres',
    async readVersion(source) {
      const { rows } = await query('SELECT version FROM cos_task_lists WHERE source = $1', [source]);
      return rows[0] ? Number(rows[0].version) : 0;
    },
    async loadWorkingSet(source, { now = Date.now() } = {}) {
      // One MVCC snapshot binds the version to the rows, including an empty list.
      const { rows } = await query(
        `WITH newest AS (
           SELECT task_id FROM cos_tasks WHERE source = $1 AND status = 'completed'
           ORDER BY completed_at DESC NULLS LAST, task_id DESC LIMIT $3
         ), working AS (
         SELECT task, position FROM cos_tasks
         WHERE source = $1 AND (status <> 'completed' OR completed_at >= $2 OR task_id IN (SELECT task_id FROM newest))
         ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'challenged' THEN 2
                              WHEN 'blocked' THEN 3 ELSE 4 END,
                  priority_value DESC, position, task_id
         )
         SELECT COALESCE((SELECT version FROM cos_task_lists WHERE source = $1), 0) AS version,
                COALESCE(json_agg(working), '[]'::json) AS rows FROM working`,
        [source, new Date(now - WORKING_SET_COMPLETED_WINDOW_MS).toISOString(), WORKING_SET_KEEP_COMPLETED],
      );
      return { version: Number(rows[0].version), rows: rows[0].rows };
    },
    async apply(source, { upserts, deletes, expectedVersions }) {
      return withTransaction(async (client) => {
        checkExpectedVersions(source, expectedVersions, await lockVersions(client));
        if (deletes.length > 0) await client.query('DELETE FROM cos_tasks WHERE source = $1 AND task_id = ANY($2::text[])', [source, deletes]);
        for (let start = 0; start < upserts.length; start += UPSERT_BATCH) {
          const columns = upserts.slice(start, start + UPSERT_BATCH).map(({ task, position }) => ({ task, position, ...rowColumns(task) }));
          await client.query(
            `INSERT INTO cos_tasks (source, task_id, status, priority_value, position, completed_at, description, task)
             SELECT $1, u.task_id, u.status, u.priority_value, u.position, u.completed_at, u.description, u.task::jsonb
             FROM unnest($2::text[], $3::text[], $4::int[], $5::float8[], $6::timestamptz[], $7::text[], $8::text[])
               AS u(task_id, status, priority_value, position, completed_at, description, task)
             ON CONFLICT (source, task_id) DO UPDATE SET status = EXCLUDED.status, priority_value = EXCLUDED.priority_value,
               position = EXCLUDED.position, completed_at = EXCLUDED.completed_at, description = EXCLUDED.description, task = EXCLUDED.task`,
            [source, columns.map((c) => c.task.id), columns.map((c) => c.status), columns.map((c) => c.priorityValue),
              columns.map((c) => c.position), columns.map((c) => c.completedAt), columns.map((c) => c.description),
              columns.map((c) => toPgJson(c.task))],
          );
        }
        return bumpVersions(client, [source]);
      });
    },
    async getTask(taskId, source) {
      const { rows } = await query(
        `SELECT source, task, position FROM cos_tasks WHERE task_id = $1 AND ($2::text IS NULL OR source = $2)
         ORDER BY (source = 'user') DESC LIMIT 1`,
        [taskId, source],
      );
      return rows[0] ? { source: rows[0].source, task: rows[0].task, position: rows[0].position } : null;
    },
    async completedIds(source, ids) {
      if (ids.length === 0) return new Set();
      const { rows } = await query(
        `SELECT task_id FROM cos_tasks WHERE source = $1 AND status = 'completed' AND task_id = ANY($2::text[])`,
        [source, ids],
      );
      return new Set(rows.map((row) => row.task_id));
    },
    async pageCompleted(source, { before, offset, limit }) {
      const { rows } = await query(
        `SELECT task FROM cos_tasks WHERE source = $1 AND status = 'completed' AND ($2::text IS NULL OR task_id < $2)
         ORDER BY task_id DESC LIMIT $3 OFFSET $4`,
        [source, before ?? null, limit, offset],
      );
      return rows.map((row) => row.task);
    },
    async countCompleted(source) {
      const { rows } = await query(`SELECT count(*)::int AS n FROM cos_tasks WHERE source = $1 AND status = 'completed'`, [source]);
      return rows[0].n;
    },
    async completedSummaries() {
      const { rows } = await query(`SELECT source, task_id, description FROM cos_tasks WHERE status = 'completed'`);
      return rows.map((row) => ({ source: row.source, id: row.task_id, description: row.description }));
    },
    async deleteById(taskId, source) {
      return withTransaction(async (client) => {
        await lockVersions(client);
        const { rows } = await client.query(
          'DELETE FROM cos_tasks WHERE task_id = $1 AND ($2::text IS NULL OR source = $2) RETURNING source',
          [taskId, source],
        );
        if (rows.length > 0) await bumpVersions(client, [...new Set(rows.map((row) => row.source))]);
        return rows.length;
      });
    },
  };
}

// Bumps each source's version and returns the last one (callers pass one source for a save).
async function bumpVersions(client, sources) {
  let version = 0;
  for (const source of sources) {
    const { rows } = await client.query(
      `INSERT INTO cos_task_lists (source, version) VALUES ($1, 1)
       ON CONFLICT (source) DO UPDATE SET version = cos_task_lists.version + 1 RETURNING version`,
      [source],
    );
    version = Number(rows[0].version);
  }
  return version;
}

async function makeMemoryBackend({ persist }) {
  const lists = Object.fromEntries(SOURCES.map((source) => [source, new Map()]));
  const versions = Object.fromEntries(SOURCES.map((source) => [source, 0]));
  if (persist) {
    // readJSONFileStrict returns `{ ok, value }`; never start empty over an unreadable file.
    const { ok, value: saved } = await readJSONFileStrict(tasksFile(), {}, { logError: false });
    if (!ok) throw new Error(`Unreadable ${tasksFile()} — repair or remove it before starting the dev file backend`);
    for (const source of SOURCES) {
      for (const row of saved?.[source]?.rows ?? []) lists[source].set(row.task.id, row);
      versions[source] = saved?.[source]?.version ?? 0;
    }
  }
  const flush = () => (persist
    ? atomicWrite(tasksFile(), Object.fromEntries(SOURCES.map((source) => [source, { version: versions[source], rows: [...lists[source].values()] }])))
    : Promise.resolve());
  // Plain JSON, like a database round trip; also keeps structuredClone spies in tests measuring only the store.
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const completed = (source) => [...lists[source].values()].map((row) => row.task).filter((task) => task.status === 'completed');

  return {
    name: 'memory',
    async readVersion(source) { return versions[source]; },
    async loadWorkingSet(source, { now = Date.now() } = {}) {
      return { version: versions[source], rows: clone(selectWorkingSet([...lists[source].values()], { now })) };
    },
    async apply(source, { upserts, deletes, expectedVersions }) {
      checkExpectedVersions(source, expectedVersions, versions);
      for (const id of deletes) lists[source].delete(id);
      for (const { task, position } of upserts) lists[source].set(task.id, clone({ task, position }));
      versions[source] += 1;
      await flush();
      return versions[source];
    },
    async getTask(taskId, source) {
      for (const candidate of source ? [source] : SOURCES) {
        const row = lists[candidate].get(taskId);
        if (row) return { source: candidate, ...clone(row) };
      }
      return null;
    },
    async completedIds(source, ids) {
      return new Set(completed(source).map((task) => task.id).filter((id) => ids.includes(id)));
    },
    async pageCompleted(source, { before, offset, limit }) {
      return clone(completed(source).filter((task) => before == null || task.id < before).sort(byIdDesc).slice(offset, offset + limit));
    },
    async countCompleted(source) { return completed(source).length; },
    async completedSummaries() {
      return SOURCES.flatMap((source) => completed(source).map((task) => ({ source, id: task.id, description: rowColumns(task).description })));
    },
    async deleteById(taskId, source) {
      let removed = 0;
      for (const candidate of source ? [source] : SOURCES) {
        if (lists[candidate].delete(taskId)) { removed += 1; versions[candidate] += 1; }
      }
      if (removed > 0) await flush();
      return removed;
    },
  };
}

const backendFacade = createPgFileFacade({
  makeFile: () => makeMemoryBackend({ persist: !isTestRunner() }),
  makePg: () => resolvePgBackend({
    requirement: `The CoS task queues require PostgreSQL — ${POSTGRES_SETUP_HINT}`,
    loadDb: () => import('../lib/db.js'),
    makePg: makePgBackend,
  }),
});
const backend = async () => backendFacade.getBackend();

/** Queue version: changes whenever a write lands, so a cached working set can be revalidated cheaply. */
export async function readTaskListVersion(source) { return (await backend()).readVersion(source); }

/** `{ version, rows: [{ task, position }] }` in queue order for one queue's working set. */
export async function loadTaskWorkingSet(source) { return (await backend()).loadWorkingSet(source); }

/** Persist a plan with expectedVersions in one transaction; stale snapshots fail with COS_TASK_LIST_CONFLICT. */
export async function applyTaskListSave(source, plan) { return (await backend()).apply(source, plan); }

/** One task as `{ source, task, position }` whatever its status or age, user queue first. Omit `source` to search both. */
export async function getStoredTask(taskId, source = null) { return (await backend()).getTask(taskId, source); }

/** The subset of `ids` already stored as completed in `source`, including ones outside the working set. */
export async function getCompletedTaskIds(source, ids) { return (await backend()).completedIds(source, ids); }

/** Completed history, newest id first: strictly before `before`, skipping `offset`, at most `limit`. */
export async function pageCompletedTasks(source, { before = null, offset = 0, limit = 25 } = {}) {
  return (await backend()).pageCompleted(source, { before, offset, limit });
}

export async function countCompletedTasks(source) { return (await backend()).countCompleted(source); }

/** `{ source, id, description }` for every completed task, without prompt bodies. */
export async function listCompletedTaskSummaries() { return (await backend()).completedSummaries(); }

/** Remove a task wherever it is stored; returns how many rows went. */
export async function deleteStoredTask(taskId, source = null) { return (await backend()).deleteById(taskId, source); }

/** Test seam: drop the selected backend (and, for the in-memory one, everything in it). */
export function __resetCosTaskRepository() { backendFacade.reset(); }

/** Test seam: the PostgreSQL backend over a `{ query, withTransaction }` handle, for the DB suite. */
export const __makePgCosTaskBackend = makePgBackend;
/** Test seam: a fresh in-memory backend; it touches disk only with `persist: true`. */
export const __makeMemoryCosTaskBackend = ({ persist = false } = {}) => makeMemoryBackend({ persist });
