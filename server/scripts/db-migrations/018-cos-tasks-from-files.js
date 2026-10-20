/**
 * Move the CoS task queues into PostgreSQL.
 *
 * Until now the queues were two Markdown files (`data/TASKS.md`,
 * `data/COS-TASKS.md`), plus, on installs that ran the interim completed-task
 * archive, a `cos_task_archive` table. Both now live in `cos_tasks`, one row per
 * task. This migration is the only code that still reads the Markdown format.
 *
 * Input-derived, so it ships no `data.reference` seed and gates on its INPUT (the
 * files, and the archive table when present), never on the absence of its output.
 * A task already in `cos_tasks` is left alone (`DO NOTHING`), which keeps a re-run
 * and a file-plus-archive duplicate (the archive sweep's crash window) harmless;
 * the file copy is inserted first, so it wins. Counts are verified before commit:
 * every task parsed from a file must exist as a row, or the migration throws and
 * the whole transaction rolls back to be retried on the next boot.
 *
 * The files are retired separately by 019, only after this one has committed.
 */
import { readFile } from 'node:fs/promises';
import { parseTasksMarkdown } from '../../lib/taskParser.js';
import { resolveCosTaskFiles } from './_cosTaskFiles.js';

const POSITION_STEP = 1024;
const BATCH = 100;

// Frozen copy of the projection columns the repository derives from a stored task.
function rowColumns(task) {
  const stamp = task.status === 'completed' ? Date.parse(task.metadata?.completedAt || task.metadata?.updatedAt || '') : NaN;
  return {
    status: task.status,
    priorityValue: Number.isFinite(task.priorityValue) ? task.priorityValue : 2,
    completedAt: Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString() : null,
    description: typeof task.description === 'string' ? task.description : '',
  };
}

async function insertTasks(client, source, tasks) {
  for (let start = 0; start < tasks.length; start += BATCH) {
    const rows = tasks.slice(start, start + BATCH).map((task, offset) => ({ task, position: (start + offset) * POSITION_STEP, ...rowColumns(task) }));
    await client.query(
      `INSERT INTO cos_tasks (source, task_id, status, priority_value, position, completed_at, description, task)
       SELECT $1, u.task_id, u.status, u.priority_value, u.position, u.completed_at, u.description, u.task::jsonb
       FROM unnest($2::text[], $3::text[], $4::int[], $5::float8[], $6::timestamptz[], $7::text[], $8::text[])
         AS u(task_id, status, priority_value, position, completed_at, description, task)
       ON CONFLICT (source, task_id) DO NOTHING`,
      [source, rows.map((r) => r.task.id), rows.map((r) => r.status), rows.map((r) => r.priorityValue),
        rows.map((r) => r.position), rows.map((r) => r.completedAt), rows.map((r) => r.description),
        rows.map((r) => JSON.stringify(r.task))],
    );
  }
}

async function importFile(client, { source, path }) {
  const text = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (text === null) return 0;
  const tasks = parseTasksMarkdown(text);
  await insertTasks(client, source, tasks);
  const ids = tasks.map((task) => task.id);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM cos_tasks WHERE source = $1 AND task_id = ANY($2::text[])', [source, ids]);
  if (rows[0].n !== ids.length) {
    throw new Error(`CoS task import verification failed for ${source}: ${rows[0].n} of ${ids.length} tasks are stored`);
  }
  return ids.length;
}

async function foldInArchive(client) {
  const { rows } = await client.query(`SELECT to_regclass('cos_task_archive') AS archive`);
  if (!rows[0]?.archive) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO cos_tasks (source, task_id, status, priority_value, position, completed_at, description, task)
     SELECT source, task_id, COALESCE(task->>'status', 'completed'), COALESCE((task->>'priorityValue')::int, 2), 0,
            completed_at, description, task
     FROM cos_task_archive
     ON CONFLICT (source, task_id) DO NOTHING`,
  );
  await client.query('DROP TABLE cos_task_archive');
  return rowCount;
}

export async function up(client) {
  let fromFiles = 0;
  for (const file of await resolveCosTaskFiles()) fromFiles += await importFile(client, file);
  const fromArchive = await foldInArchive(client);
  await client.query(
    `INSERT INTO cos_task_lists (source, version) VALUES ('user', 1), ('internal', 1)
     ON CONFLICT (source) DO UPDATE SET version = cos_task_lists.version + 1`,
  );
  console.log(`🗄️ CoS tasks: imported ${fromFiles} from the task files and ${fromArchive} from the archive table`);
}
