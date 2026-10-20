/**
 * Machine-local archive of completed CoS tasks.
 *
 * `TASKS.md` / `COS-TASKS.md` keep the open queue plus a recent window of
 * completed tasks; older completed tasks move here with their full records
 * (prompt bodies were ~99% of those files). PostgreSQL is authoritative in a
 * normal install; the JSON backend exists only for the documented
 * development/test escape hatch. Never federated: peers advertise and merge
 * only what their own task files hold.
 *
 * Task ids sort with JavaScript's code-unit order everywhere (`byIdDesc` in
 * cosTaskStore), so the table's key column is `COLLATE "C"` to match.
 */

import { join } from 'node:path';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createPgFileFacade, resolvePgBackend } from '../lib/pgFileFacade.js';

const SOURCES = ['user', 'internal'];
const archiveFile = () => join(PATHS.data, 'cos-task-archive.json');
const queueFileWrite = createFileWriteQueue();

const completedAtOf = (task) => {
  const stamp = Date.parse(task?.metadata?.completedAt || task?.metadata?.updatedAt || '');
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
};
const descriptionOf = (task) => (typeof task?.description === 'string' ? task.description : '');
const byIdDesc = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

async function readFileArchive() {
  const raw = await readJSONFile(archiveFile(), {}, { logError: false, strict: true });
  return Object.fromEntries(SOURCES.map((source) => [source, raw?.[source] && typeof raw[source] === 'object' ? raw[source] : {}]));
}

function makeFileBackend() {
  return {
    name: 'file',
    archive: (source, tasks) => queueFileWrite(async () => {
      const archive = await readFileArchive();
      for (const task of tasks) archive[source][task.id] = task;
      await atomicWrite(archiveFile(), archive);
    }),
    async get(taskId, source) {
      const archive = await readFileArchive();
      for (const candidate of source ? [source] : SOURCES) {
        if (archive[candidate][taskId]) return { source: candidate, task: archive[candidate][taskId] };
      }
      return null;
    },
    async existingIds(source, ids) {
      const archive = await readFileArchive();
      return new Set(ids.filter((id) => archive[source][id]));
    },
    async list(source, { before, offset, limit }) {
      const archive = await readFileArchive();
      return Object.values(archive[source])
        .filter((task) => before == null || task.id < before)
        .sort(byIdDesc)
        .slice(offset, offset + limit);
    },
    async count(source) {
      return Object.keys((await readFileArchive())[source]).length;
    },
    async summaries() {
      const archive = await readFileArchive();
      return SOURCES.flatMap((source) => Object.values(archive[source]).map((task) => ({ source, id: task.id, description: descriptionOf(task) })));
    },
    remove: (taskId, source) => queueFileWrite(async () => {
      const archive = await readFileArchive();
      let removed = false;
      for (const candidate of source ? [source] : SOURCES) {
        if (archive[candidate][taskId]) { delete archive[candidate][taskId]; removed = true; }
      }
      if (removed) await atomicWrite(archiveFile(), archive);
      return removed;
    }),
  };
}

/** The PostgreSQL backend over a `{ query }` handle. Exported so the DB suite can drive it directly. */
export function __makePgCosTaskArchiveBackend(db) {
  return {
    name: 'postgres',
    async archive(source, tasks) {
      for (const task of tasks) {
        await db.query(
          `INSERT INTO cos_task_archive (source, task_id, description, completed_at, task)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (source, task_id) DO UPDATE
             SET description = EXCLUDED.description, completed_at = EXCLUDED.completed_at, task = EXCLUDED.task`,
          [source, task.id, descriptionOf(task), completedAtOf(task), JSON.stringify(task)],
        );
      }
    },
    async get(taskId, source) {
      const { rows } = await db.query(
        // User queue first, matching findTaskWithSource's file precedence on an id collision.
        `SELECT source, task FROM cos_task_archive WHERE task_id = $1 AND ($2::text IS NULL OR source = $2)
         ORDER BY (source = 'user') DESC LIMIT 1`,
        [taskId, source],
      );
      return rows[0] ? { source: rows[0].source, task: rows[0].task } : null;
    },
    async existingIds(source, ids) {
      if (ids.length === 0) return new Set();
      const { rows } = await db.query('SELECT task_id FROM cos_task_archive WHERE source = $1 AND task_id = ANY($2::text[])', [source, ids]);
      return new Set(rows.map((row) => row.task_id));
    },
    async list(source, { before, offset, limit }) {
      const { rows } = await db.query(
        `SELECT task FROM cos_task_archive WHERE source = $1 AND ($2::text IS NULL OR task_id < $2)
         ORDER BY task_id DESC LIMIT $3 OFFSET $4`,
        [source, before ?? null, limit, offset],
      );
      return rows.map((row) => row.task);
    },
    async count(source) {
      const { rows } = await db.query('SELECT count(*)::int AS n FROM cos_task_archive WHERE source = $1', [source]);
      return rows[0].n;
    },
    async summaries() {
      const { rows } = await db.query('SELECT source, task_id, description FROM cos_task_archive');
      return rows.map((row) => ({ source: row.source, id: row.task_id, description: row.description }));
    },
    async remove(taskId, source) {
      const { rowCount } = await db.query('DELETE FROM cos_task_archive WHERE task_id = $1 AND ($2::text IS NULL OR source = $2)', [taskId, source]);
      return rowCount > 0;
    },
  };
}

const backendFacade = createPgFileFacade({
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: 'The CoS task archive requires PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the file escape hatch)',
    loadDb: () => import('../lib/db.js'),
    makePg: __makePgCosTaskArchiveBackend,
  }),
});
const backend = async () => backendFacade.getBackend();

/** Upsert full task records for one source. Idempotent: a retried sweep rewrites the same rows. */
export async function archiveTasks(source, tasks) {
  if (!SOURCES.includes(source) || tasks.length === 0) return;
  await (await backend()).archive(source, tasks);
}

/** One archived task as `{ source, task }`, or null. Omit `source` to search both. */
export async function getArchivedTask(taskId, source = null) {
  return (await backend()).get(taskId, source);
}

/** The subset of `ids` already archived for `source`. */
export async function getArchivedIds(source, ids) {
  return (await backend()).existingIds(source, ids);
}

/** Up to `limit` archived tasks newest id first, strictly before `before`, skipping `offset`. */
export async function listArchivedTasks(source, { before = null, offset = 0, limit = 25 } = {}) {
  return (await backend()).list(source, { before, offset, limit });
}

export async function countArchivedTasks(source) {
  return (await backend()).count(source);
}

/** `{ source, id, description }` for every archived task, without the prompt bodies. */
export async function listArchivedSummaries() {
  return (await backend()).summaries();
}

export async function deleteArchivedTask(taskId, source = null) {
  return (await backend()).remove(taskId, source);
}

/** Test seam for suites that swap the file data root between cases. */
export function __resetCosTaskArchive() {
  backendFacade.reset();
}
